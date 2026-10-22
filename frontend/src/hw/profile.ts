// The learner's lab profile: the values that personalise every hardware lab and generate lab.env.
// Pure functions only (unit-tested); persistence lives in hw/store.tsx.
import type { HwVariable } from '../types';

export type Profile = Record<string, string>;
export type Role = 'A' | 'B' | 'C';
export const ROLES: Role[] = ['A', 'B', 'C'];

/** Derived variables are computed, never edited. Keep in sync with lib.sh (`TCLASS=$((ROCE_DSCP * 4 + 2))`). */
export function derive(p: Profile): Profile {
  const dscp = Number.parseInt(p.ROCE_DSCP ?? '', 10);
  return { ...p, TCLASS: Number.isFinite(dscp) ? String(dscp * 4 + 2) : '' };
}

export function defaults(vars: HwVariable[]): Profile {
  const p: Profile = {};
  for (const v of vars) if (v.default !== undefined) p[v.name] = v.default;
  return derive(p);
}

/** Keep only known, editable variables as strings; fill gaps with defaults; recompute derived ones. */
export function sanitizeProfile(raw: unknown, vars: HwVariable[]): Profile {
  const base = defaults(vars);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  for (const v of vars) {
    if (v.derived || typeof r[v.name] !== 'string') continue;
    const val = (r[v.name] as string).trim();
    if (v.choices && !v.choices.includes(val)) continue;
    base[v.name] = val;
  }
  return derive(base);
}

/** Problems that would make generated files or lab commands wrong. Keyed by variable name. */
export function validateProfile(p: Profile): Record<string, string> {
  const e: Record<string, string> = {};
  const ipv4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const roles = ROLES.slice(0, p.HOST_COUNT === '3' ? 3 : 2);
  for (const r of roles) {
    if (!ipv4.test(p[`${r}_IP`] ?? '')) e[`${r}_IP`] = 'Not an IPv4 address';
    if (!/^[\w.@:-]+$/.test(p[`${r}_NETDEV`] ?? '')) e[`${r}_NETDEV`] = 'Interface names have no spaces';
    if (!/^[\w.-]+$/.test(p[`${r}_RDMA_DEV`] ?? '')) e[`${r}_RDMA_DEV`] = 'Device names look like mlx5_0';
    if (!/^[\w.-]+$/.test(p[`HOST_${r}`] ?? '')) e[`HOST_${r}`] = 'Hostname or IP, no spaces';
  }
  const ips = roles.map((r) => p[`${r}_IP`]);
  if (new Set(ips).size !== ips.length) e[`${roles[1]}_IP`] = 'Every host needs its own data IP';
  const num = (k: string, lo: number, hi: number, msg: string) => {
    const n = Number(p[k]);
    if (!/^\d+$/.test(p[k] ?? '') || n < lo || n > hi) e[k] = msg;
  };
  num('PREFIX_LEN', 8, 30, '8 to 30');
  num('MTU', 1280, 9216, '1280 to 9216');
  num('GID_INDEX', 0, 255, '0 to 255');
  num('ROCE_PRIO', 0, 7, 'A priority is 0 to 7');
  num('ROCE_DSCP', 0, 63, 'DSCP is 0 to 63');
  num('CNP_DSCP', 0, 63, 'DSCP is 0 to 63');
  num('RDMA_PORT', 1, 8, 'Usually 1 or 2');
  num('GPUS_PER_NODE', 1, 16, '1 to 16');
  num('GPU_INDEX', 0, 15, '0 to 15');
  if (p.ROCE_DSCP && p.ROCE_DSCP === p.CNP_DSCP) e.CNP_DSCP = 'CNPs need their own DSCP';
  return e;
}

/** Replace {{NAME}} placeholders (SHELL_CASE only, so docker's {{.State.Pid}} stays literal). */
export function fill(text: string, p: Profile): string {
  // An empty SSH user means "your current user": drop the "user@" prefix rather than printing "@host".
  const t = p.SSH_USER ? text : text.replace(/\{\{SSH_USER\}\}@/g, '');
  return t.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, name: string) => (p[name] !== undefined && p[name] !== '' ? p[name] : m));
}

/** Placeholders used by a text, in order of first appearance. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map((m) => m[1]))];
}

const shellValue = (v: string) => (/^[\w./:~,@+-]*$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

/** lab.env in bash syntax: sourced by lib.sh, parsed by aina_hw.py. */
export function toEnv(p: Profile, vars: HwVariable[], generated = new Date()): string {
  const groups: Record<string, string> = { lab: 'Lab', hosts: 'Hosts', qos: 'RoCE QoS', switch: 'Switch', gpu: 'GPU' };
  const lines = [
    '# AI Networking Academy lab profile (lab.env).',
    `# Generated ${generated.toISOString().slice(0, 10)} on the Connect page. Copy it to labs/hw-toolkit/lab.env on every host.`,
    '# Bash syntax: every hardware lab script sources it.',
  ];
  let group = '';
  for (const v of vars) {
    if (v.group !== group) {
      group = v.group;
      lines.push('', `# ${groups[group] ?? group}`);
    }
    const val = p[v.name] ?? '';
    lines.push(`${v.name}=${shellValue(val)}${v.derived ? `   # derived: ${v.derived}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Read one shell word: quotes concatenate ('a'\''b' is a'b), unquoted whitespace or a comment ends it. */
function shellWord(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      out += s.slice(i + 1, j < 0 ? undefined : j);
      i = j < 0 ? s.length : j;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) out += s[i] === '\\' && i + 1 < s.length ? s[++i] : s[i];
    } else if (c === '\\' && i + 1 < s.length) out += s[++i];
    else if (/\s/.test(c) || (c === '#' && out === '')) break;
    else out += c;
  }
  return out;
}

/** Parse a lab.env back into a profile (for import). Mirrors aina_hw.parse_env (shlex) for what we write. */
export function parseEnv(text: string): Profile {
  const out: Profile = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const m = line.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (m) out[m[1]] = shellWord(m[2]);
  }
  return out;
}

export const rolesOf = (p: Profile): Role[] => ROLES.slice(0, p.HOST_COUNT === '3' ? 3 : 2);

export function hostsFile(p: Profile): string {
  return `# Data-network names for the lab (append to /etc/hosts on every host)\n${rolesOf(p).map((r) => `${p[`${r}_IP`]}\t${p[`HOST_${r}`]}-rdma`).join('\n')}\n`;
}

export function netplan(p: Profile, r: Role): string {
  return `# /etc/netplan/60-aina-rdma.yaml on host ${r} (${p[`HOST_${r}`]}), mode 600. Apply with: sudo netplan try   (or: sudo netplan apply)
network:
  version: 2
  ethernets:
    ${p[`${r}_NETDEV`]}:
      dhcp4: false
      addresses: [${p[`${r}_IP`]}/${p.PREFIX_LEN}]
      mtu: ${p.MTU}
`;
}

export function nmcli(p: Profile, r: Role): string {
  return `# RHEL / Rocky / Alma (NetworkManager) on host ${r} (${p[`HOST_${r}`]})
sudo nmcli connection add type ethernet ifname ${p[`${r}_NETDEV`]} con-name aina-rdma \\
  ipv4.method manual ipv4.addresses ${p[`${r}_IP`]}/${p.PREFIX_LEN} ethernet.mtu ${p.MTU}
sudo nmcli connection up aina-rdma
`;
}

/** PFC vector for mlnx_qos --pfc: one flag per priority 0..7. */
export const pfcVector = (prio: string) => Array.from({ length: 8 }, (_, i) => (String(i) === prio ? '1' : '0')).join(',');

export function hostQos(p: Profile, r: Role): string {
  const nd = p[`${r}_NETDEV`];
  // With DSCP trust the default map is priority = DSCP >> 3 (26 -> 3); only a custom pair needs an explicit entry.
  const dscp = Number.parseInt(p.ROCE_DSCP ?? '', 10);
  const map = Number.isFinite(dscp) && String(dscp >> 3) !== p.ROCE_PRIO ? `sudo mlnx_qos -i ${nd} --dscp2prio set,${dscp},${p.ROCE_PRIO}\n` : '';
  return `# Host ${r}: lossless RoCE QoS on ${nd} (runtime only; the QoS lab shows how to save and restore it)
# NVIDIA ConnectX with mlnx_qos (from NVIDIA's tools):
sudo mlnx_qos -i ${nd} --trust dscp
${map}sudo mlnx_qos -i ${nd} --pfc ${pfcVector(p.ROCE_PRIO)}
mlnx_qos -i ${nd}
# Generic iproute2 alternative: see the hw-03-host-qos-pfc-ecn lab (dcb pfc / dcb app).
`;
}

export function switchConfig(p: Profile): string {
  const ports = rolesOf(p).map((r) => p[`${r}_SWITCH_PORT`]);
  if (p.SWITCH_OS === 'none') {
    return `# SWITCH_OS=none: hosts are cabled back to back, no switch configuration needed.
# Both NICs must still agree on MTU (${p.MTU}) and, for the QoS labs, on trust mode and PFC priority ${p.ROCE_PRIO}.
`;
  }
  if (p.SWITCH_OS === 'cumulus') {
    const custom = p.ROCE_DSCP !== '26' || p.ROCE_PRIO !== '3' || p.CNP_DSCP !== '48';
    return `# ${p.SWITCH} (Cumulus Linux, NVUE). Back up first:  nv config history   (and keep a copy of /etc/nvue.d/startup.yaml)
nv set interface ${ports.join(',')} bridge domain br_default
${ports.map((x) => `nv set interface ${x} link mtu 9216`).join('\n')}
nv set qos roce
nv set qos roce mode lossless
nv config diff        # review before applying
nv config apply
nv config save
# Verify:
nv show qos roce
${ports.map((x) => `nv show interface ${x} qos roce counters`).join('\n')}
${custom
    ? `# NOTE: your profile uses DSCP ${p.ROCE_DSCP} -> priority ${p.ROCE_PRIO} (CNP DSCP ${p.CNP_DSCP}). NVIDIA documents DSCP 26 -> priority 3 and
# CNP DSCP 48 -> priority 6 as the RoCE defaults; check "nv show qos roce" and the NVUE QoS documentation for your
# release to change the mapping, or align the profile with the switch.`
    : '# The NVUE RoCE defaults (DSCP 26 -> priority 3, CNP DSCP 48) match your profile; confirm with "nv show qos roce".'}
# NVUE syntax changes between releases: check the command reference for your Cumulus Linux version.
`;
  }
  if (p.SWITCH_OS === 'sonic') {
    return `# ${p.SWITCH} (SONiC). Configuration is platform- and release-specific: many platforms enable PFC on priorities
# 3 and 4 in their default QoS templates. Back up first:  sudo cp /etc/sonic/config_db.json ~/config_db.backup.json
# Check that DSCP ${p.ROCE_DSCP} maps to priority ${p.ROCE_PRIO} and that ${p.ROCE_PRIO} is lossless on the host ports:
sonic-cfggen -d --var-json DSCP_TO_TC_MAP
sonic-cfggen -d --var-json PORT_QOS_MAP
show pfc priority
# If not, change the mapping the way your platform's documentation describes and save with: sudo config save -y
# "sudo config qos reload" regenerates QoS from the platform templates: it OVERWRITES manual QoS edits and can
# disrupt traffic. Use it only to return to the platform defaults.
# Verify:
show interfaces status
show pfc counters
${ports.map((x) => `show queue counters ${x}`).join('\n')}
show priority-group watermark headroom
show pfcwd config
`;
  }
  return `# ${p.SWITCH}: vendor NOS. Configure, using your vendor's RoCE / lossless guide:
#  [ ] MTU 9216 (at least ${p.MTU} plus headers) on ${ports.join(', ')}
#  [ ] Trust DSCP on host-facing ports; DSCP ${p.ROCE_DSCP} -> priority/queue ${p.ROCE_PRIO}; CNP DSCP ${p.CNP_DSCP} -> a high-priority queue
#  [ ] PFC enabled on priority ${p.ROCE_PRIO} only, on every port that carries RoCE
#  [ ] ECN (WRED/ECN marking) on the RoCE queue, with thresholds from the vendor guide
#  [ ] Lossless buffer pool / headroom for priority ${p.ROCE_PRIO} sized for your cable lengths
#  [ ] PFC watchdog enabled
# Save the running configuration before you start so you can roll back.
`;
}

/** The commands a learner runs on host A to install, collect and connect. */
export function quickStart(p: Profile): string {
  return `# On every host
git clone https://github.com/jurajliskalc/ai-networking-academy.git ${p.AINA_DIR}
cd ${p.AINA_DIR}/labs/hw-toolkit
chmod +x aina-hw *.sh ../hw-*/*.sh            # if your checkout lost the executable bits
./setup-rdma-host.sh                       # installs tools and audits the host (uses sudo)
# save the lab.env from the Connect page here, as labs/hw-toolkit/lab.env

# On host A (${p.HOST_A})
./aina-hw env                              # validates lab.env
./aina-hw collect-all                      # inventories every host over SSH -> results/aina-report.json
./aina-hw serve                            # read-only agent on 127.0.0.1:8765

# On your laptop, to reach the agent from the browser
ssh -L 8765:127.0.0.1:8765 ${p.SSH_USER ? `${p.SSH_USER}@` : ''}${p.HOST_A}
`;
}
