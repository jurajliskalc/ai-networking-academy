# shellcheck shell=bash
# hw-03-host-qos-pfc-ecn: QoS helpers shared by this lab's scripts (and by hw-04's checks).
# Source after ../hw-toolkit/lib.sh and aina_load_env.
#
# Two configuration paths are supported:
#   mlnx_qos  NVIDIA's tool (MLNX_OFED / DOCA-Host packages): trust, PFC and DSCP->priority in one place
#   dcb       iproute2's generic DCB tool: PFC (dcb pfc) and DSCP->priority APP entries (dcb app)
# Read helpers work on any role (A locally, B/C over SSH) and never change anything.

# Lab state (saved settings) lives outside $HOME so it is the same with and without sudo.
export AINA_STATE=${AINA_STATE:-/var/lib/aina/state}

# qos_tool ROLE -> mlnx_qos | dcb | (empty)
qos_tool() {
  on_host_sh "$1" 'if command -v mlnx_qos >/dev/null 2>&1; then echo mlnx_qos; elif command -v dcb >/dev/null 2>&1; then echo dcb; fi' 2>/dev/null
}

# qos_raw ROLE NETDEV -> raw output of the QoS show command for that tool
qos_raw() {
  local tool
  tool=$(qos_tool "$1")
  case "$tool" in
    mlnx_qos) on_host_sh "$1" "mlnx_qos -i $2 2>/dev/null" ;;
    dcb) on_host_sh "$1" "dcb pfc show dev $2 prio-pfc 2>/dev/null; dcb app show dev $2 dscp-prio 2>/dev/null" ;;
  esac
}

# Parsers read raw text on stdin.
# trust: "dscp" / "pcp" (mlnx_qos only; dcb has no portable trust read-out)
parse_trust() { awk -F: 'tolower($0) ~ /trust state/ {gsub(/[ \t]/, "", $2); print tolower($2); exit}'; }

# PFC-enabled priorities, space separated ("3"), from either tool's output. Empty if unreadable.
parse_pfc() {
  awk '
    /prio-pfc/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-7]:on$/) { split($i, a, ":"); out = out a[1] " " } found = 1 }
    /PFC configuration/ { inpfc = 1 }
    inpfc && $1 == "priority" { n = NF; for (i = 2; i <= NF; i++) p[i] = $i }
    inpfc && $1 == "enabled" { for (i = 2; i <= NF; i++) if ($i == 1) out = out p[i] " "; found = 1; inpfc = 0 }
    END { if (found) { sub(/ $/, "", out); print (out == "" ? "none" : out) } }'
}

# DSCP name used by dcb when it prints symbolic values (AF31 for 26 ...). Prints nothing if none.
dscp_name() {
  case "$1" in
    0) echo CS0 ;; 8) echo CS1 ;; 16) echo CS2 ;; 24) echo CS3 ;; 32) echo CS4 ;; 40) echo CS5 ;; 48) echo CS6 ;; 56) echo CS7 ;;
    10) echo AF11 ;; 12) echo AF12 ;; 14) echo AF13 ;; 18) echo AF21 ;; 20) echo AF22 ;; 22) echo AF23 ;;
    26) echo AF31 ;; 28) echo AF32 ;; 30) echo AF33 ;; 34) echo AF41 ;; 36) echo AF42 ;; 38) echo AF43 ;; 46) echo EF ;;
  esac
}

# parse_dscp_prio DSCP -> the priority that DSCP maps to (empty if no mapping is shown)
parse_dscp_prio() {
  local name
  name=$(dscp_name "$1")
  awk -v d="$1" -v n="$name" '
    /dscp-prio/ { for (i = 1; i <= NF; i++) { split($i, a, ":"); if ((a[1] == d || (n != "" && toupper(a[1]) == n)) && a[2] != "") { print a[2]; exit } } }
    /prio:[0-7]/ && /dscp:/ {
      match($0, /prio:[0-7]/); pr = substr($0, RSTART + 5, 1)
      s = substr($0, index($0, "dscp:") + 5); m = split(s, l, /[, \t]+/)
      for (i = 1; i <= m; i++) if (l[i] != "" && l[i] + 0 == d + 0) { print pr; exit }
    }'
}

# ecn_state ROLE NETDEV PRIO -> "np=1 rp=1" (values of the per-priority ECN switches) or "absent"
ecn_state() {
  on_host_sh "$1" "d=/sys/class/net/$2/ecn
    if [ -r \$d/roce_np/enable/$3 ] || [ -r \$d/roce_rp/enable/$3 ]; then
      echo \"np=\$(cat \$d/roce_np/enable/$3 2>/dev/null || echo ?) rp=\$(cat \$d/roce_rp/enable/$3 2>/dev/null || echo ?)\"
    else echo absent; fi"
}

# local_role -> A, B or C: which profile host owns one of this machine's IPv4 addresses
local_role() {
  local r ips
  ips=" $(ip -o -4 addr show 2>/dev/null | awk '{split($4, a, "/"); printf "%s ", a[1]}')"
  for r in A B C; do
    [[ "$ips" == *" $(ip_of $r) "* ]] && { echo "$r"; return 0; }
  done
  return 1
}

# pfc_csv PRIO -> "0,0,0,1,0,0,0,0" (mlnx_qos --pfc format) for a single lossless priority
pfc_csv() {
  local i out=()
  for i in 0 1 2 3 4 5 6 7; do if [[ $i == "$1" ]]; then out+=(1); else out+=(0); fi; done
  local IFS=,
  echo "${out[*]}"
}
