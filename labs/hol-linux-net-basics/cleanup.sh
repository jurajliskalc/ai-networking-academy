#!/usr/bin/env bash
# hol-linux-net-basics: remove everything the lab created. Safe to run more than once.
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

# Deleting a namespace destroys the veth ends inside it; the peer ends in the
# host namespace disappear with them.
for ns in hol1-a hol1-b hol1-r hol1-c; do
  if ip netns list | grep -qw "$ns"; then
    echo "+ ip netns del $ns"
    ip netns del "$ns"
  fi
done

for dev in a-br b-br r-br br-hol1; do
  if ip link show "$dev" >/dev/null 2>&1; then
    echo "+ ip link del $dev"
    ip link del "$dev"
  fi
done

echo "Cleanup complete."
