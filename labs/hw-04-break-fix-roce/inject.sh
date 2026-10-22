#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (c) 2026 Juraj Liska. AI Networking Academy: noncommercial use only, see LICENSE.
# hw-04-break-fix-roce: inject one reversible RoCE fault on THIS host (host B), let the learner
# diagnose it from host A, then restore.
#
# Usage (on host B, as root):
#   sudo ./inject.sh --list            faults and whether they can be injected here
#   sudo ./inject.sh --random          inject a random applicable fault (not shown)
#   sudo ./inject.sh --fault <id>      inject a named fault (instructor mode)
#        ./inject.sh --status          injected / restored, diagnosed or not
#   sudo ./inject.sh --answer <id>     check a diagnosis without revealing the fault
#   sudo ./inject.sh --reveal          show the injected fault
#   sudo ./inject.sh --restore         undo the fault, restoring the saved state
#
# The fault id is stored salted and hashed so it is not shown by accident. That is obscurity, not
# security: this is a training tool. One fault at a time; --restore is always safe to run.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../hw-toolkit/lib.sh"
aina_load_env >/dev/null
export AINA_STATE=${AINA_STATE:-/var/lib/aina/state}
DIR=$(aina_state_dir hw-04-break-fix-roce)
ROLE=${AINA_ROLE:-B}
NETDEV=$(netdev_of "$ROLE")
IP=$(ip_of "$ROLE")
FAULTS=(mtu-mismatch pfc-off trust-pcp ip-missing port-down)

describe() {
  case "$1" in
    mtu-mismatch) echo "set the data netdev MTU to 1500" ;;
    pfc-off) echo "disable PFC on the lossless priority" ;;
    trust-pcp) echo "switch the NIC from DSCP trust to PCP trust" ;;
    ip-missing) echo "remove the data IPv4 address" ;;
    port-down) echo "administratively shut the data netdev" ;;
  esac
}

qos_tool_local() { if command -v mlnx_qos >/dev/null 2>&1; then echo mlnx_qos; elif command -v dcb >/dev/null 2>&1; then echo dcb; fi; }

# The data netdev must not be the path of this host's default route or of an SSH session.
netdev_is_ssh_path() {
  local local_ips ip
  ip -o -4 route show to default 2>/dev/null | grep -qw "dev $NETDEV" && return 0
  local_ips=$(ip -o -4 addr show dev "$NETDEV" 2>/dev/null | awk '{split($4, a, "/"); print a[1]}')
  for ip in $local_ips; do
    ss -Htn state established 2>/dev/null | awk '{print $3}' | grep -q "^$ip:22$" && return 0
  done
  return 1
}

# applicable FAULT -> 0 if it can be injected safely here, else prints the reason and returns 1
applicable() {
  case "$1" in
    pfc-off)
      case "$(qos_tool_local)" in
        mlnx_qos) mlnx_qos -i "$NETDEV" 2>/dev/null | awk '/PFC configuration/ {f = 1} f && $1 == "enabled" {for (i = 2; i <= NF; i++) if ($i == 1) e = 1; exit} END {exit !e}' ;;
        dcb) dcb pfc show dev "$NETDEV" prio-pfc 2>/dev/null | grep -q ':on' ;;
        *) echo "needs mlnx_qos or dcb"; return 1 ;;
      esac || { echo "PFC is not enabled on any priority (apply hw-03 first)"; return 1; } ;;
    trust-pcp)
      command -v mlnx_qos >/dev/null 2>&1 || { echo "needs mlnx_qos"; return 1; }
      mlnx_qos -i "$NETDEV" 2>/dev/null | grep -qiE 'trust state: *dscp' || { echo "trust is not DSCP (apply hw-03 first)"; return 1; } ;;
    ip-missing|port-down)
      if [[ $1 == ip-missing ]] && ! ip -o -4 addr show dev "$NETDEV" 2>/dev/null | grep -q " $IP/"; then echo "$IP is not on $NETDEV"; return 1; fi
      if netdev_is_ssh_path; then echo "$NETDEV carries the default route or an SSH session"; return 1; fi ;;
    mtu-mismatch) (( $(cat "/sys/class/net/$NETDEV/mtu" 2>/dev/null || echo 0) > 1500 )) || { echo "MTU is already 1500 or less"; return 1; } ;;
    *) echo "unknown fault"; return 1 ;;
  esac
  return 0
}

hash_of() { printf '%s:%s' "$(cat "$DIR/salt")" "$1" | sha256sum | awk '{print $1}'; }

current_fault() {
  local f
  [[ -f $DIR/fault ]] || return 1
  for f in "${FAULTS[@]}"; do [[ "$(hash_of "$f")" == "$(cat "$DIR/fault")" ]] && { echo "$f"; return 0; }; done
  return 1
}

status_word() { cat "$DIR/status" 2>/dev/null || echo none; }

save_state() {
  ip -o -4 addr show dev "$NETDEV" | awk -v ip="$IP" '{split($4, a, "/"); if (a[1] == ip) print $4}' >"$DIR/addr"
  cat "/sys/class/net/$NETDEV/mtu" >"$DIR/mtu"
  case "$(qos_tool_local)" in
    mlnx_qos) mlnx_qos -i "$NETDEV" >"$DIR/qos.txt" 2>&1; echo mlnx_qos >"$DIR/qos_tool" ;;
    dcb) dcb pfc show dev "$NETDEV" prio-pfc >"$DIR/qos.txt" 2>&1; echo dcb >"$DIR/qos_tool" ;;
    *) : >"$DIR/qos.txt"; : >"$DIR/qos_tool" ;;
  esac
}

apply_fault() {
  case "$1" in
    mtu-mismatch) ip link set dev "$NETDEV" mtu 1500 ;;
    pfc-off)
      if [[ "$(qos_tool_local)" == mlnx_qos ]]; then mlnx_qos -i "$NETDEV" --pfc 0,0,0,0,0,0,0,0 >/dev/null
      else dcb pfc set dev "$NETDEV" prio-pfc all:off; fi ;;
    trust-pcp) mlnx_qos -i "$NETDEV" --trust pcp >/dev/null ;;
    ip-missing) ip addr del "$(cat "$DIR/addr")" dev "$NETDEV" ;;
    port-down) ip link set dev "$NETDEV" down ;;
  esac
}

restore_fault() {
  local mtu addr trust pfc csv p
  mtu=$(cat "$DIR/mtu"); addr=$(cat "$DIR/addr")
  case "$1" in
    mtu-mismatch) ip link set dev "$NETDEV" mtu "$mtu" ;;
    port-down) ip link set dev "$NETDEV" up ;;
    ip-missing) [[ -n "$addr" ]] && ip addr replace "$addr" dev "$NETDEV" ;;
    trust-pcp)
      trust=$(awk -F: 'tolower($0) ~ /trust state/ {gsub(/[ \t]/, "", $2); print tolower($2); exit}' "$DIR/qos.txt")
      mlnx_qos -i "$NETDEV" --trust "${trust:-dscp}" >/dev/null ;;
    pfc-off)
      if [[ "$(cat "$DIR/qos_tool")" == mlnx_qos ]]; then
        pfc=$(awk '/PFC configuration/ {f=1} f && $1 == "enabled" {for (i = 2; i <= NF; i++) printf "%s%s", (i > 2 ? "," : ""), $i; exit}' "$DIR/qos.txt")
        mlnx_qos -i "$NETDEV" --pfc "${pfc:-0,0,0,1,0,0,0,0}" >/dev/null
      else
        csv=$(grep -o 'prio-pfc.*' "$DIR/qos.txt")
        # shellcheck disable=SC2086
        if [[ -n "$csv" ]]; then dcb pfc set dev "$NETDEV" $csv; else p=$ROCE_PRIO; dcb pfc set dev "$NETDEV" prio-pfc all:off "$p:on"; fi
      fi ;;
  esac
}

cmd=${1:---help}
case "$cmd" in
  --list)
    printf '%-14s %-12s %s\n' FAULT HERE WHAT
    for f in "${FAULTS[@]}"; do
      if why=$(applicable "$f"); then printf '%-14s %-12s %s\n' "$f" yes "$(describe "$f")"
      else printf '%-14s %-12s %s (%s)\n' "$f" no "$(describe "$f")" "$why"; fi
    done ;;
  --random|--fault)
    need_root
    [[ -d /sys/class/net/$NETDEV ]] || die "netdev $NETDEV (${ROLE}_NETDEV) does not exist on this host; run this on host $ROLE"
    if [[ "$(status_word)" == injected ]]; then die "a fault is already injected; run --restore first"; fi
    ip -o -4 addr show dev "$NETDEV" 2>/dev/null | grep -q " $IP/" || die "$IP is not configured on $NETDEV: run this on host $ROLE, with a healthy baseline"
    if [[ $cmd == --fault ]]; then
      F=${2:-}; why=$(applicable "$F") || die "cannot inject '$F' here: $why"
    else
      ok=(); for f in "${FAULTS[@]}"; do applicable "$f" >/dev/null && ok+=("$f"); done
      [[ ${#ok[@]} -gt 0 ]] || die "no fault is applicable on this host"
      F=${ok[RANDOM % ${#ok[@]}]}
    fi
    mkdir -p "$DIR"; chmod 755 "$DIR"
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DIR/salt"; chmod 600 "$DIR/salt"
    save_state
    hash_of "$F" >"$DIR/fault"
    rm -f "$DIR/diagnosed"; echo 0 >"$DIR/attempts"
    if apply_fault "$F"; then
      echo injected >"$DIR/status"; chmod 644 "$DIR/status" "$DIR/attempts"
      date -u +%FT%TZ >"$DIR/injected_at"
      echo "A fault is now active on $NETDEV. Go to host A and investigate. Answer with: sudo $0 --answer <fault-id>"
      [[ $cmd == --fault ]] && echo "(instructor mode: injected $F)"
    else
      echo restored >"$DIR/status"; die "injecting failed; nothing was changed permanently"
    fi ;;
  --answer)
    need_root
    [[ "$(status_word)" != none ]] || die "no fault has been injected yet"
    A=${2:-}; [[ -n "$A" ]] || die "usage: $0 --answer <fault-id> (see --list)"
    n=$(( $(cat "$DIR/attempts" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$DIR/attempts"
    if [[ "$(hash_of "$A")" == "$(cat "$DIR/fault")" ]]; then
      echo "correct $A $(date -u +%FT%TZ) attempts=$n" >"$DIR/diagnosed"; chmod 644 "$DIR/diagnosed"
      echo "Correct after $n attempt(s). Now fix it, or run: sudo $0 --restore"
    else
      echo "Not this one (attempt $n). Keep collecting evidence."
      exit 1
    fi ;;
  --reveal)
    need_root
    f=$(current_fault) || die "no fault recorded"
    echo "Injected fault: $f ($(describe "$f")), status $(status_word)" ;;
  --restore)
    need_root
    if [[ "$(status_word)" != injected ]]; then echo "Nothing to restore (status: $(status_word))."; exit 0; fi
    f=$(current_fault) || die "fault record unreadable; restore by hand: MTU $(cat "$DIR/mtu"), address $(cat "$DIR/addr"), link up"
    restore_fault "$f" || die "restoring $f failed; the fault is still marked as injected (a reboot of this host also clears it)"
    echo restored >"$DIR/status"
    date -u +%FT%TZ >"$DIR/restored_at"
    echo "Restored ($f). Diagnosis recorded: $(cut -d' ' -f1 "$DIR/diagnosed" 2>/dev/null || echo no)." ;;
  --status)
    echo "status: $(status_word)  diagnosed: $(cut -d' ' -f1 "$DIR/diagnosed" 2>/dev/null || echo no)  attempts: $(cat "$DIR/attempts" 2>/dev/null || echo 0)" ;;
  -h|--help|*)
    sed -n '2,16p' "$0" ;;
esac
