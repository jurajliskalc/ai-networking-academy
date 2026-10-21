#!/usr/bin/env bash
# hol-clos-bgp-unnumbered: verify the fabric after deployment (all links up).
#
# Usage: sudo ./check.sh
set -euo pipefail

LAB=hol-clos
FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

if [[ $EUID -ne 0 ]]; then
  echo "FAIL: run as root (sudo $0)"
  exit 1
fi
for tool in docker python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool not installed"; exit 1; }
done

c() { echo "clab-${LAB}-$1"; }
vtysh_json() { docker exec "$(c "$1")" vtysh -c "$2" 2>/dev/null || true; }

# Count BGP peers in state Established anywhere in an FRR JSON summary.
count_established() {
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(0); sys.exit(0)
n = 0
def walk(o):
    global n
    if isinstance(o, dict):
        peers = o.get("peers")
        if isinstance(peers, dict):
            n += sum(1 for p in peers.values() if isinstance(p, dict) and p.get("state") == "Established")
        for k, v in o.items():
            if k != "peers":
                walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)
walk(data)
print(n)
'
}

# Count active next hops of a prefix in "show ip route <prefix> json".
count_nexthops() {
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(0); sys.exit(0)
best = 0
for routes in data.values():
    for r in routes if isinstance(routes, list) else []:
        nhs = r.get("nexthops", [])
        active = sum(1 for nh in nhs if nh.get("active") or nh.get("fib"))
        best = max(best, active)
print(best)
'
}

nodes="spine1 spine2 leaf1 leaf2 leaf3 leaf4 h1 h2 h3 h4"
for n in $nodes; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$(c "$n")" 2>/dev/null || true)" == "true" ]]; then
    pass "container $(c "$n") is running"
  else
    fail "container $(c "$n") is not running (sudo containerlab deploy -t topology.clab.yml)"
  fi
done

for n in spine1 spine2; do
  est=$(vtysh_json "$n" "show bgp ipv4 unicast summary json" | count_established)
  if [[ $est -eq 4 ]]; then pass "$n has 4/4 BGP sessions Established"; else fail "$n has $est/4 BGP sessions Established"; fi
done
for n in leaf1 leaf2 leaf3 leaf4; do
  est=$(vtysh_json "$n" "show bgp ipv4 unicast summary json" | count_established)
  if [[ $est -eq 2 ]]; then pass "$n has 2/2 BGP sessions Established"; else fail "$n has $est/2 BGP sessions Established"; fi
done

for pfx in 10.0.0.14/32 192.168.14.0/24; do
  nh=$(vtysh_json leaf1 "show ip route $pfx json" | count_nexthops)
  if [[ $nh -ge 2 ]]; then
    pass "leaf1 reaches $pfx over $nh ECMP next hops"
  else
    fail "leaf1 reaches $pfx over $nh next hop(s), expected 2 (is a spine link down?)"
  fi
done

for dst in 192.168.12.10 192.168.13.10 192.168.14.10; do
  if docker exec "$(c h1)" ping -c 2 -W 2 "$dst" >/dev/null 2>&1; then
    pass "h1 can ping $dst"
  else
    fail "h1 cannot ping $dst"
  fi
done

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
