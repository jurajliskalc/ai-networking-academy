#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-12-ib-partitions: print an OpenSM partitions.conf for the lab (run on host A as your normal user;
# reads host B's port GUID over SSH). Redirect it to a file and pass that to lab-sm.sh --partitions.
#   ./gen-partitions.sh > /tmp/aina-partitions.conf
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
. "$HERE/partitions.env"
guid_of() { on_host_sh "$1" "sed 's/^fe80:0000:0000:0000://; s/://g' /sys/class/infiniband/$(rdma_of "$1")/ports/$RDMA_PORT/gids/0"; }
GA=0x$(guid_of A); GB=0x$(guid_of B)
[[ "$GA" =~ ^0x[0-9a-f]{16}$ && "$GB" =~ ^0x[0-9a-f]{16}$ ]] || { echo "could not read the port GUIDs (A='$GA' B='$GB')" >&2; exit 1; }
echo "# hw-12-ib-partitions, generated $(date -u +%Y-%m-%dT%H:%MZ). Host A port GUID $GA, host B $GB."
echo "# Default partition: every port a full member, IPoIB broadcast group with a 4096-byte MTU (mtu=5)."
echo "Default=0x7fff, ipoib, mtu=5 : ALL=full ;"
for p in "${PARTITIONS[@]}"; do
  IFS=: read -r pkey name ma mb _ <<<"$p"
  echo "$name=$pkey, ipoib, mtu=5 : $GA=$ma, $GB=$mb ;"
done
