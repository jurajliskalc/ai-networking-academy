#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-13-ibdiagnet-triage: verify a healthy InfiniBand fabric with ibdiagnet and iblinkinfo after the
# faults are restored: no ibdiagnet stage with errors, a master SM, every link at its best speed.
# Run on host A as your normal user (it runs ibdiagnet and iblinkinfo with sudo -n):
#   sudo -v && ../hw-toolkit/aina-hw check hw-13-ibdiagnet-triage
# One task only (resume):  ../hw-toolkit/aina-hw check hw-13-ibdiagnet-triage --task 3
# Read-only (ibdiagnet only reads the fabric; its reports go to a temporary directory).
set -uo pipefail
. "$(dirname "$0")/../hw-toolkit/lib.sh"
aina_load_env
aina_tasks 1 3
require 1 ibdiagnet "an ibdiagnet run whose summary shows no stage with errors"
require 1 master "a master SM found by ibdiagnet"
require 3 speeds "iblinkinfo shows every link at its best common speed and width"

need_cmd ibdiagnet iblinkinfo || aina_finish
check_ssh B || aina_finish
SUDO=(); [[ $EUID -eq 0 ]] || SUDO=(sudo -n)

# Faults 2 and 3 (Tasks 4 and 5) leave a port down or in INIT: every task needs both ports ACTIVE.
for r in A B; do
  state=$(port_attr "$r" state); phys=$(port_attr "$r" phys_state)
  if [[ "$state" == *ACTIVE* ]]; then pass "host $r: $(rdma_of "$r")/$RDMA_PORT ACTIVE ($phys), rate $(port_attr "$r" rate)"
  else fail "host $r: $(rdma_of "$r")/$RDMA_PORT is '${state:-missing}' / '${phys:-?}' (fault still injected? SM running?)"; fi
done

if task 1 "A healthy fabric through ibdiagnet's eyes"; then
  out=$(mktemp -d); log=$out/stdout.txt
  if "${SUDO[@]}" ibdiagnet -i "$A_RDMA_DEV" -p "$RDMA_PORT" -o "$out" >"$log" 2>&1; then
    pass "ibdiagnet ran (reports in a temporary directory)"
    # Summary rows: "-I- <Stage>   <warnings>   <errors>". ibdiagnet exits 0 even when stages report errors.
    if grep -qE '^-I- Stage +Warnings +Errors' "$log"; then
      bad=$(awk '/^-I- Stage +Warnings +Errors/ {s = 1; next} s && /^-I- / {n = split($0, f, / {2,}/); if (n >= 3 && f[3] + 0 > 0) print f[1] " (" f[3] " errors)"} s && /^$/ {s = 0}' "$log" | sed 's/^-I- //')
      if [[ -z "$bad" ]]; then pass_met ibdiagnet "no ibdiagnet stage reports errors"
      else fail "ibdiagnet stages with errors: $(tr '\n' ';' <<<"$bad") (-E- lines follow; run ibdiagnet yourself for the report files)"; grep '^-E- ' "$log" | head -5 | sed 's/^/INFO: /'; fi
    else
      warn "ibdiagnet printed no stage summary table, so its result could not be read"
    fi
    w=$(grep -c '^-W- ' "$log"); info "ibdiagnet printed $w warning line(s) (mixed firmware and SM configuration warnings are normal on a lab pair)"
    if grep -q '^Master SM: ' "$log"; then pass_met master "$(grep -m1 '^Master SM: ' "$log" | cut -c1-120)"; else fail "ibdiagnet found no master SM"; fi
    grep -m1 '^Links at ' "$log" | sed 's/^/INFO: /'
  else
    fail "ibdiagnet failed or could not run as root (run 'sudo -v' first): $(excerpt "$log")"
  fi
  rm -rf "$out"
fi

if task 3 'Fault 1, "the job got slower"'; then
  li=$("${SUDO[@]}" iblinkinfo -C "$A_RDMA_DEV" -P "$RDMA_PORT" 2>&1)
  if [[ "$li" == *"==("* ]]; then
    if grep -q 'Could be' <<<"$li"; then fail "iblinkinfo: a link runs below its capability: $(grep -m1 -o 'Could be[^)]*' <<<"$li")"
    else pass_met speeds "iblinkinfo: every link at its best common speed and width"; fi
  else
    fail "iblinkinfo printed no links: $(head -c 160 <<<"$li")"
  fi
fi

aina_finish
