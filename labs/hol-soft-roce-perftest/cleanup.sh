#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hol-soft-roce-perftest: remove the Soft-RoCE device and unload the module.
# Usage: sudo ./cleanup.sh [rxe-name]
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

RXE=${1:-rxe0}

if rdma link show "$RXE/1" >/dev/null 2>&1; then
  echo "+ rdma link delete $RXE"
  rdma link delete "$RXE"
fi

if [[ -d /sys/module/rdma_rxe ]]; then
  echo "+ modprobe -r rdma_rxe"
  modprobe -r rdma_rxe || echo "Module still in use (another rxe device or a running test?); leaving it loaded."
fi

echo "Cleanup complete."
