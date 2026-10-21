#!/usr/bin/env bash
# hol-ecn-congestion: fire a synchronized burst from all three senders at the receiver
# (a miniature incast), then print bottleneck and ECN statistics.
#
# Usage: sudo ./incast.sh [bytes-per-sender]     (default 4M)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

BYTES=${1:-4M}
logdir=$(mktemp -d)

echo "Before:"
ip netns exec ecn-r tc -s qdisc show dev to-rcv | sed 's/^/  /'

for i in 1 2 3; do
  ip netns exec "ecn-s$i" iperf3 -c 10.6.9.2 -p "520$i" -n "$BYTES" >"$logdir/s$i.log" 2>&1 &
done
wait

echo
for i in 1 2 3; do
  cc=$(ip netns exec "ecn-s$i" sysctl -n net.ipv4.tcp_congestion_control)
  line=$(grep -E 'sender$' "$logdir/s$i.log" | tail -1 || true)
  echo "s$i ($cc): ${line:-no result, see $logdir/s$i.log}"
done

echo
echo "After:"
ip netns exec ecn-r tc -s qdisc show dev to-rcv | sed 's/^/  /'
echo
echo "Receiver ECN counters (absolute since namespace creation):"
ip netns exec ecn-rcv nstat -saz IpExtInNoECTPkts IpExtInECT0Pkts IpExtInCEPkts | sed 's/^/  /'
rm -rf "$logdir"
