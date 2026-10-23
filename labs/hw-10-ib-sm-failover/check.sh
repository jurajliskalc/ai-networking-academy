#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-10-ib-sm-failover: verify a redundant subnet manager pair (one MASTER, one STANDBY).
# Run on host A as your normal user, with OpenSM running on both hosts (lab-sm.sh start):
#   sudo -v && ../hw-toolkit/aina-hw check hw-10-ib-sm-failover
# One task only (resume):  ../hw-toolkit/aina-hw check hw-10-ib-sm-failover --task 2
# Read-only. sminfo needs root (MAD access); unless the check runs as root it uses `sudo -n sminfo`.
# The takeover itself (Tasks 3-5) is timed by hand in the lab: a read-only check does not kill an SM.
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
aina_tasks 1 2
require 1 sm-both "an OpenSM running on both hosts, both ports ACTIVE behind one SM LID"
require 2 pair "exactly one MASTER and one STANDBY seen with sminfo"

need_cmd sminfo || aina_finish
check_ssh B || aina_finish

# Read the port state of both hosts first: Task 2 needs the LIDs even when only it runs.
declare -A LID SMLID STATE LL OSM
for r in A B; do
  if on_host "$r" pgrep -x opensm >/dev/null 2>&1; then OSM[$r]=1; else OSM[$r]=0; fi
  STATE[$r]=$(port_attr "$r" state); LL[$r]=$(port_attr "$r" link_layer)
  if [[ "${LL[$r]}" == InfiniBand ]]; then LID[$r]=$(( $(port_attr "$r" lid) )); SMLID[$r]=$(( $(port_attr "$r" sm_lid) )); fi
done

if task 1 "Start the master and the standby"; then
  f0=$AINA_FAILS
  for r in A B; do
    dev=$(rdma_of "$r")
    if (( OSM[$r] )); then pass "host $r: an OpenSM process runs"
    else fail "host $r: no OpenSM runs (sudo ./lab-sm.sh start on that host)"; fi
    if [[ "${LL[$r]}" != InfiniBand ]]; then fail "host $r: $dev/$RDMA_PORT link layer is '${LL[$r]:-none}', not InfiniBand (check lab.env)"; continue; fi
    if [[ "${STATE[$r]}" == *ACTIVE* ]]; then pass "host $r: $dev/$RDMA_PORT is ACTIVE"; else fail "host $r: $dev/$RDMA_PORT state '${STATE[$r]}'"; fi
  done
  if (( ${SMLID[A]:-0} > 0 )) && [[ "${SMLID[A]}" == "${SMLID[B]:-}" ]]; then pass "both ports point at the same SM LID (${SMLID[A]})"
  else fail "SM LID A='${SMLID[A]:-}' B='${SMLID[B]:-}': both ports must see the same non-zero SM LID"; fi
  (( AINA_FAILS == f0 )) && met sm-both
fi

if task 2 "Master and standby with sminfo"; then
  SMINFO=(sminfo -C "$A_RDMA_DEV" -P "$RDMA_PORT"); [[ $EUID -eq 0 ]] || SMINFO=(sudo -n "${SMINFO[@]}")
  declare -A ST PRIO
  for r in A B; do
    [[ -n "${LID[$r]:-}" ]] || continue
    if s=$("${SMINFO[@]}" "${LID[$r]}" 2>/dev/null); then
      info "SM on host $r (LID ${LID[$r]}): $s"
      ST[$r]=$(awk '{print $NF}' <<<"$s"); PRIO[$r]=$(sed -n 's/.* priority \([0-9]*\) .*/\1/p' <<<"$s")
    else
      fail "sminfo at host $r's LID ${LID[$r]} gives no answer (no SM there, or sudo -n failed: run 'sudo -v')"
    fi
  done
  m=""; s=""
  for r in A B; do
    case "${ST[$r]:-}" in SMINFO_MASTER) m+=$r ;; SMINFO_STANDBY) s+=$r ;; esac
  done
  if [[ ${#m} -eq 1 && ${#s} -eq 1 ]]; then
    pass_met pair "one master (host $m, priority ${PRIO[$m]}) and one standby (host $s, priority ${PRIO[$s]})"
    if (( PRIO[$m] >= PRIO[$s] )); then pass "the master's priority is not lower than the standby's"
    else warn "the standby has the higher priority (${PRIO[$s]} > ${PRIO[$m]}): expect it to take over at its next poll"; fi
    if [[ "${SMLID[A]}" == "${LID[$m]}" ]]; then pass "the ports' SM LID is the master's LID"
    else fail "ports point at SM LID ${SMLID[A]}, but the master is at LID ${LID[$m]}"; fi
  else
    fail "expected exactly one SMINFO_MASTER and one SMINFO_STANDBY, got A='${ST[A]:-none}' B='${ST[B]:-none}'"
  fi
fi

aina_finish
