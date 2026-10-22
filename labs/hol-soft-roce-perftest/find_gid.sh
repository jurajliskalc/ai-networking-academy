#!/usr/bin/env bash
# Print the GID table of an RDMA device port from sysfs and the index of the
# lowest-numbered IPv4-mapped (::ffff:a.b.c.d) RoCE v2 GID.
#
# Usage: ./find_gid.sh [device] [port]      (defaults: rxe0 1)
#        ./find_gid.sh -q [device] [port]   (print only the IPv4 GID index)
set -euo pipefail

QUIET=0
if [[ "${1:-}" == "-q" ]]; then QUIET=1; shift; fi
DEV=${1:-rxe0}
PORT=${2:-1}
BASE=/sys/class/infiniband/$DEV/ports/$PORT

if [[ ! -d "$BASE/gids" ]]; then
  echo "No such device/port: $BASE" >&2
  exit 1
fi

found=""
for idx in $(ls "$BASE/gids" | sort -n); do
  f=$BASE/gids/$idx
  gid=$(cat "$f" 2>/dev/null || true)
  # Unused entries are all zeros
  [[ -z "$gid" || "$gid" == "0000:0000:0000:0000:0000:0000:0000:0000" ]] && continue
  # gid_attrs files return an error for unused entries, hence the || true
  type=$(cat "$BASE/gid_attrs/types/$idx" 2>/dev/null || echo "?")
  ndev=$(cat "$BASE/gid_attrs/ndevs/$idx" 2>/dev/null || echo "?")
  [[ $QUIET -eq 0 ]] && printf 'index %-3s %s  type=%s  netdev=%s\n' "$idx" "$gid" "$type" "$ndev"
  # On hardware NICs each IP has a RoCE v1 and a v2 entry; rxe only lists v2
  if [[ -z "$found" && "$gid" == 0000:0000:0000:0000:0000:ffff:* && "$type" != *v1* ]]; then
    found=$idx
  fi
done

if [[ -z "$found" ]]; then
  [[ $QUIET -eq 0 ]] && echo "No IPv4-mapped GID found (does the netdev have an IPv4 address?)" >&2
  exit 1
fi

if [[ $QUIET -eq 1 ]]; then
  echo "$found"
else
  echo "IPv4-mapped GID index: $found"
fi
