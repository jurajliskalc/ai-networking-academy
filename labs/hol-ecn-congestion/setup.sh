#!/usr/bin/env bash
# hol-ecn-congestion: three senders, one router with a bottleneck, one receiver.
#
#   ecn-s1 10.6.1.2 --\
#   ecn-s2 10.6.2.2 ---- ecn-r ==(bottleneck: to-rcv egress)==> ecn-rcv 10.6.9.2
#   ecn-s3 10.6.3.2 --/
#
# Offloads (TSO/GSO/GRO) are disabled on every veth so the bottleneck queue holds
# real MTU-sized packets, which makes queue lengths and marking thresholds meaningful.
#
# Usage: sudo ./setup.sh
#        sudo ./setup.sh --restart-servers   (only restart the three iperf3 servers; needed after
#        changing ecn-rcv's tcp_congestion_control, because a listening socket keeps the
#        congestion control it was created with, and Linux accepts ECN from a DCTCP sender,
#        whose SYN is ECT-marked, only if the listener itself uses DCTCP)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

run() { echo "+ $*"; "$@"; }

start_servers() {
  # One iperf3 server per sender (an iperf3 server handles one test at a time)
  for i in 1 2 3; do
    run ip netns exec ecn-rcv iperf3 -s -D -p "520$i" -I "/tmp/ecn-iperf3-$i.pid"
  done
}

if [[ "${1:-}" == "--restart-servers" ]]; then
  for i in 1 2 3; do
    f=/tmp/ecn-iperf3-$i.pid
    if [[ -f $f ]]; then
      echo "+ kill $(cat "$f")   (iperf3 server on port 520$i)"
      kill "$(cat "$f")" 2>/dev/null || true
      rm -f "$f"
    fi
  done
  sleep 1
  start_servers
  echo "iperf3 servers restarted with ecn-rcv congestion control: $(ip netns exec ecn-rcv sysctl -n net.ipv4.tcp_congestion_control)"
  exit 0
fi

for tool in ethtool tc iperf3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool (see labs/setup-ubuntu.sh)" >&2; exit 1; }
done

NSS="ecn-s1 ecn-s2 ecn-s3 ecn-r ecn-rcv"
for ns in $NSS; do
  if ip netns list | grep -qw "$ns"; then
    echo "Namespace $ns already exists. Run ./cleanup.sh first." >&2
    exit 1
  fi
done

run modprobe tcp_dctcp || echo "WARNING: tcp_dctcp module not available; DCTCP tasks will not work."

for ns in $NSS; do
  run ip netns add "$ns"
  run ip -n "$ns" link set lo up
  run ip netns exec "$ns" sysctl -q -w net.ipv6.conf.all.disable_ipv6=1
  run ip netns exec "$ns" sysctl -q -w net.ipv6.conf.default.disable_ipv6=1
done

link() { # ns1 if1 addr1 ns2 if2 addr2
  local ns1=$1 if1=$2 a1=$3 ns2=$4 if2=$5 a2=$6
  ip link del ecntmp1 2>/dev/null || true
  run ip link add ecntmp1 type veth peer name ecntmp2
  run ip link set ecntmp1 netns "$ns1"
  run ip link set ecntmp2 netns "$ns2"
  run ip -n "$ns1" link set ecntmp1 name "$if1"
  run ip -n "$ns2" link set ecntmp2 name "$if2"
  run ip -n "$ns1" addr add "$a1" dev "$if1"
  run ip -n "$ns2" addr add "$a2" dev "$if2"
  run ip -n "$ns1" link set "$if1" up
  run ip -n "$ns2" link set "$if2" up
  for side in "$ns1 $if1" "$ns2 $if2"; do
    # shellcheck disable=SC2086
    set -- $side
    ip netns exec "$1" ethtool -K "$2" tso off gso off gro off >/dev/null 2>&1 \
      || echo "WARNING: could not disable offloads on $2 in $1"
  done
}

for i in 1 2 3; do
  link "ecn-s$i" eth0 "10.6.$i.2/24" ecn-r "to-s$i" "10.6.$i.1/24"
  run ip -n "ecn-s$i" route add default via "10.6.$i.1"
done
link ecn-r to-rcv 10.6.9.1/24 ecn-rcv eth0 10.6.9.2/24
run ip -n ecn-rcv route add default via 10.6.9.1
run ip netns exec ecn-r sysctl -q -w net.ipv4.ip_forward=1

# Start every namespace with classic TCP: CUBIC, ECN only if the peer asks (kernel default 2)
for ns in $NSS; do
  run ip netns exec "$ns" sysctl -q -w net.ipv4.tcp_congestion_control=cubic
  run ip netns exec "$ns" sysctl -q -w net.ipv4.tcp_ecn=2
done

start_servers

echo
echo "Done. Next: sudo ./bottleneck.sh fifo   (see the lab instructions)"
