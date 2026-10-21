#!/usr/bin/env bash
# hol-ecmp-entropy: remove the lab namespaces and stop the iperf3 server.
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

if [[ -f /tmp/ecmp-iperf3.pid ]]; then
  echo "+ stopping iperf3 server (pid $(cat /tmp/ecmp-iperf3.pid))"
  kill "$(cat /tmp/ecmp-iperf3.pid)" 2>/dev/null || true
  rm -f /tmp/ecmp-iperf3.pid
fi

for ns in ecmp-h1 ecmp-leaf1 ecmp-sp1 ecmp-sp2 ecmp-leaf2 ecmp-h2; do
  if ip netns list | grep -qw "$ns"; then
    echo "+ ip netns del $ns"
    ip netns del "$ns"
  fi
done
ip link del ecmptmp1 2>/dev/null || true
echo "Cleanup complete."
