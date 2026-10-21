#!/usr/bin/env bash
# hol-evpn-vxlan: verify the EVPN control plane and the VXLAN data plane.
#
# Usage: sudo ./check.sh
set -euo pipefail

LAB=hol-evpn
FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

if [[ $EUID -ne 0 ]]; then
  echo "FAIL: run as root (sudo $0)"
  exit 1
fi
for tool in docker python3 nsenter bridge; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: $tool not installed"; exit 1; }
done

c() { echo "clab-${LAB}-$1"; }
vt() { docker exec "$(c "$1")" vtysh -c "$2" 2>/dev/null || true; }
cnet() {
  local pid
  pid=$(docker inspect -f '{{.State.Pid}}' "$(c "$1")" 2>/dev/null) || return 1
  nsenter -t "$pid" -n "${@:2}"
}

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

for n in spine1 leaf1 leaf2 h1 h2; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$(c "$n")" 2>/dev/null || true)" == "true" ]]; then
    pass "container $(c "$n") is running"
  else
    fail "container $(c "$n") is not running"
  fi
done

est=$(vt spine1 "show bgp l2vpn evpn summary json" | count_established)
if [[ $est -eq 2 ]]; then pass "spine1 has 2/2 EVPN sessions Established"; else fail "spine1 has $est/2 EVPN sessions Established"; fi
for n in leaf1 leaf2; do
  est=$(vt "$n" "show bgp l2vpn evpn summary json" | count_established)
  if [[ $est -eq 1 ]]; then pass "$n EVPN session Established"; else fail "$n has $est/1 EVPN sessions Established"; fi
done

for pair in "leaf1 10.0.0.12" "leaf2 10.0.0.11"; do
  # shellcheck disable=SC2086
  set -- $pair
  if cnet "$1" ip -d link show vxlan100 2>/dev/null | grep -q "vxlan id 100"; then
    pass "$1 has vxlan100 (VNI 100)"
  else
    fail "$1 has no vxlan100 (run sudo ./vxlan-setup.sh)"
  fi
  if vt "$1" "show evpn vni 100" | grep -q "$2"; then
    pass "$1 knows remote VTEP $2 for VNI 100 (from a type-3 route)"
  else
    fail "$1 does not list remote VTEP $2 for VNI 100"
  fi
done

if docker exec "$(c h1)" ping -c 3 -W 2 192.168.100.12 >/dev/null 2>&1; then
  pass "h1 can ping h2 across the VXLAN overlay"
else
  fail "h1 cannot ping h2"
fi

if vt leaf1 "show bgp l2vpn evpn route type macip" | grep -q '\[2\]'; then
  pass "leaf1 has EVPN type-2 (MAC/IP) routes"
else
  fail "leaf1 has no EVPN type-2 routes"
fi
if vt leaf1 "show bgp l2vpn evpn route type multicast" | grep -q '\[3\]'; then
  pass "leaf1 has EVPN type-3 (IMET) routes"
else
  fail "leaf1 has no EVPN type-3 routes"
fi

if cnet leaf1 bridge fdb show dev vxlan100 2>/dev/null | grep -q "dst 10.0.0.12"; then
  pass "leaf1 vxlan100 FDB has entries pointing to VTEP 10.0.0.12"
else
  fail "leaf1 vxlan100 FDB has no entries for 10.0.0.12"
fi

echo
if [[ $FAILS -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed."
  exit 1
fi
