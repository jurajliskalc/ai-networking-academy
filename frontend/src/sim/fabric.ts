// Fabric Simulator: a deterministic model of a small rail-optimized RoCEv2 GPU cluster.
//
// Topology: 4 GPU nodes (node01-node04), each with 8 GPUs and 8 ConnectX-7-class NICs (one per rail).
// Rail r of every node connects to leaf0(r+1) (a rail leaf); every leaf has one uplink to each of
// two spines. The model is intentionally simple and is documented in docs/SIMULATOR.md: it reproduces
// the *symptoms* real faults produce (which counters move, which tests fail, how bandwidth drops), not
// exact numbers of any product.

export const NODES = ['node01', 'node02', 'node03', 'node04'] as const;
export const RAILS = 8;
// InfiniBand variant: the same ConnectX-7 adapters in IB mode expose IPoIB netdevs (predictable names).
export const IB_NETDEVS = ['ibp24s0', 'ibp41s0', 'ibp82s0', 'ibp99s0', 'ibp154s0', 'ibp170s0', 'ibp204s0', 'ibp220s0'];
export const NETDEVS = ['enp24s0np0', 'enp41s0np0', 'enp82s0np0', 'enp99s0np0', 'enp154s0np0', 'enp170s0np0', 'enp204s0np0', 'enp220s0np0'];
export const BDFS = ['18:00.0', '29:00.0', '52:00.0', '63:00.0', '9a:00.0', 'aa:00.0', 'cc:00.0', 'dc:00.0'];
export const LEAVES = Array.from({ length: RAILS }, (_, r) => `leaf0${r + 1}`);
export const SPINES = ['spine01', 'spine02'];
export const ROCE_PRIO = 3;
export const LINE_RATE_GBPS = 400;
const IB_MTUS = [256, 512, 1024, 2048, 4096];
const ROCE_IP_OVERHEAD = 60; // IPv4 20 + UDP 8 + BTH 12 + RETH 16 + ICRC 4 bytes on top of the RoCE payload
export const PER_RAIL_BUSBW = 46.5; // GB/s nominal all-reduce bus bandwidth contributed by one healthy 400G rail
// NET/Socket over the 25GbE management NIC (eno1): a few GB/s of bus bandwidth at best.
export const SOCKET_BUSBW = 2.6;

export type Trust = 'dscp' | 'pcp';
export type FabricMode = 'roce' | 'ib';
export type RoceMode = 'lossless' | 'lossy' | 'off';

export interface Nic {
  rail: number;
  dev: string;
  netdev: string;
  bdf: string;
  mtu: number;
  admin: boolean;
  trust: Trust;
  pfc: boolean[];
  pcieWidth: number;
  pcieSpeed: number; // GT/s
  counters: Record<string, number>;
  hw: Record<string, number>;
  /** Receive path stalled: the NIC keeps asserting PFC pause (a "stuck receiver"). */
  stalled?: boolean;
  /** InfiniBand PMA PortCounters of the HCA port (IB variant only). */
  ib?: Record<string, number>;
  /** Global 802.3x pause requested with `ethtool -A` (mlx5: only in effect while no priority has PFC; default on). */
  pause?: boolean;
  /** ETS per traffic class as `mlnx_qos --tsa/--tcbw` set it (absent: every TC `vendor`). */
  ets?: { tsa: ('vendor' | 'ets' | 'strict')[]; bw: number[] };
}
export interface Host { name: string; nics: Nic[]; files: Record<string, string>; dmesg: string[] }
export type Peer = { kind: 'host'; node: string; rail: number } | { kind: 'switch'; sw: string; port: string };
export interface Port {
  name: string; peer: Peer; mtu: number; admin: boolean; cable: 'ok' | 'unplugged'; ber: number; counters: Record<string, number>;
  /** Active lanes (4 = full width). A link that trained at 1X or 2X runs at a fraction of its rate. */
  lanes?: number;
  /** PFC watchdog enabled on this port (applied config) and its per-traffic-class state. */
  pfcwd?: boolean;
  wd?: { status: ('OK' | 'DEADLOCK')[]; deadlocks: number[] };
  /** InfiniBand PMA PortCounters of the switch port (IB variant only). */
  ib?: Record<string, number>;
  /** The switch this port belongs to is powered off. */
  dead?: boolean;
}
export interface PortCfg { mtu: number; admin: boolean; pfcwd?: boolean }
export interface SwitchCfg {
  roce: RoceMode;
  ports: Record<string, PortCfg>;
  /** Traffic classes whose ECN marking is disabled in the congestion-control profile. */
  ecnOff?: number[];
}
export interface Switch {
  name: string; role: 'leaf' | 'spine'; rail?: number; cfg: SwitchCfg; pending: SwitchCfg | null; ports: Record<string, Port>;
  /** Powered off (switch_down): every link on it is down and it does not answer SSH. */
  off?: boolean;
}
/** One OpenSM instance (IB variant). The master is elected among running instances: priority, then lower port GUID. */
export interface SmState { node: string; rail: number; running: boolean; enabled: boolean; priority?: number; failed?: boolean }
export interface FabricState {
  hosts: Record<string, Host>;
  switches: Record<string, Switch>;
  actions: string[];
  /** 'roce' (default, also when absent in an older saved state) or the 'ib' InfiniBand variant. */
  mode?: FabricMode;
  /** Older saved states: a single OpenSM instance. Read through smList(), which migrates it to `sms`. */
  sm?: SmState;
  /** IB variant: the OpenSM instances on the subnet (master and standbys). */
  sms?: SmState[];
  /** Simulated seconds since the lab started: every command adds 1 s, `sleep N` adds N, a collective 20 s. */
  clock?: number;
  /** IB variant: when the master SM stopped while a standby was running (the standby takes over SM_TAKEOVER_S later). */
  smLostAt?: number;
  /** IB variant: ports an SM has configured (ACTIVE, with a LID). They stay ACTIVE without an SM until their link drops. */
  ibConfigured?: string[];
  /** IB variant: the SM LID programmed into the ports by the last master. */
  ibSmLid?: number;
}

export type Fault = Record<string, unknown> & { type: string };

const zeroPfc = () => [false, false, false, true, false, false, false, false];
export const nodeIndex = (node: string) => NODES.indexOf(node as (typeof NODES)[number]);
export const hostIp = (node: string, rail: number) => `10.${rail}.${nodeIndex(node) + 1}.1`;
export const leafIp = (node: string, rail: number) => `10.${rail}.${nodeIndex(node) + 1}.0`;
export const leafPortFor = (node: string) => `swp${nodeIndex(node) + 1}`;

export const DEFAULT_NCCL_CONF = `# /etc/nccl.conf - managed by the nccl-tuning Ansible role
NCCL_SOCKET_IFNAME=eno1
NCCL_IB_HCA=mlx5
NCCL_IB_GID_INDEX=3
NCCL_IB_TC=106
NCCL_IB_QPS_PER_CONNECTION=4
NCCL_DEBUG=WARN
`;

/** Node/port GUID of an HCA (shared by the RoCE and InfiniBand commands so GIDs and GUIDs stay consistent). */
export const hcaGuid = (node: string, rail: number) =>
  `b83f${(0xd2 + rail).toString(16)}0300${(0x4a + nodeIndex(node)).toString(16)}c1${rail}${rail}`.slice(0, 16);

function emptyNicCounters(r: number): Record<string, number> {
  const c: Record<string, number> = {
    rx_packets_phy: 0, tx_packets_phy: 0, rx_bytes_phy: 0, tx_bytes_phy: 0,
    rx_crc_errors_phy: 0, rx_symbol_err_phy: 0, rx_pcs_symbol_err_phy: 0, rx_corrected_bits_phy: 0, rx_discards_phy: 0, tx_discards_phy: 0,
    rx_out_of_buffer: 0, link_down_events_phy: 0,
  };
  for (let p = 0; p < 8; p++) {
    c[`rx_prio${p}_packets`] = 0;
    c[`tx_prio${p}_packets`] = 0;
    c[`rx_prio${p}_pause`] = 0;
    c[`tx_prio${p}_pause`] = 0;
  }
  void r;
  return c;
}
/** A subset of the mlx5 RDMA hw_counters, in the order `rdma statistic show link` prints them. */
const emptyHw = () => ({
  rx_write_requests: 0, rx_read_requests: 0, out_of_sequence: 0, duplicate_request: 0, packet_seq_err: 0,
  implied_nak_seq_err: 0, local_ack_timeout_err: 0, rp_cnp_ignored: 0, rp_cnp_handled: 0, np_ecn_marked_roce_packets: 0, np_cnp_sent: 0,
});
/** InfiniBand PortCounters in perfquery order, with their width in bits (counters saturate at their maximum). */
export const IB_PC_FIELDS: [string, number][] = [
  ['SymbolErrorCounter', 16], ['LinkErrorRecoveryCounter', 8], ['LinkDownedCounter', 8], ['PortRcvErrors', 16],
  ['PortRcvRemotePhysicalErrors', 16], ['PortRcvSwitchRelayErrors', 16], ['PortXmitDiscards', 16],
  ['PortXmitConstraintErrors', 8], ['PortRcvConstraintErrors', 8], ['LocalLinkIntegrityErrors', 4],
  ['ExcessiveBufferOverrunErrors', 4], ['QP1Dropped', 16], ['VL15Dropped', 16],
  ['PortXmitData', 32], ['PortRcvData', 32], ['PortXmitPkts', 32], ['PortRcvPkts', 32], ['PortXmitWait', 32],
];
export const emptyIb = () => Object.fromEntries(IB_PC_FIELDS.map(([k]) => [k, 0])) as Record<string, number>;
const emptyPortCounters = () => ({
  rx_packets: 0, tx_packets: 0, rx_errors: 0, rx_crc: 0, rx_drops: 0, tx_drops: 0,
  rx_pfc_pause: 0, tx_pfc_pause: 0, ecn_marked: 0, link_flaps: 0,
});

export function createFabric(): FabricState {
  const hosts: Record<string, Host> = {};
  for (const node of NODES) {
    hosts[node] = {
      name: node,
      files: { '/etc/nccl.conf': DEFAULT_NCCL_CONF },
      dmesg: [],
      nics: Array.from({ length: RAILS }, (_, r) => ({
        rail: r, dev: `mlx5_${r}`, netdev: NETDEVS[r], bdf: BDFS[r], mtu: 9000, admin: true, trust: 'dscp' as Trust,
        pfc: zeroPfc(), pause: false, pcieWidth: 16, pcieSpeed: 32, counters: emptyNicCounters(r), hw: emptyHw(),
      })),
    };
  }
  const switches: Record<string, Switch> = {};
  const mkPort = (name: string, peer: Peer): Port => ({
    name, peer, mtu: 9216, admin: true, cable: 'ok', ber: 1e-15, counters: emptyPortCounters(), lanes: 4,
    pfcwd: true, wd: { status: Array(8).fill('OK'), deadlocks: Array(8).fill(0) },
  });
  LEAVES.forEach((leaf, r) => {
    const ports: Record<string, Port> = {};
    NODES.forEach((node) => (ports[leafPortFor(node)] = mkPort(leafPortFor(node), { kind: 'host', node, rail: r })));
    ports.swp31 = mkPort('swp31', { kind: 'switch', sw: 'spine01', port: `swp${r + 1}` });
    ports.swp32 = mkPort('swp32', { kind: 'switch', sw: 'spine02', port: `swp${r + 1}` });
    switches[leaf] = { name: leaf, role: 'leaf', rail: r, cfg: { roce: 'lossless', ports: {} }, pending: null, ports };
  });
  SPINES.forEach((spine, s) => {
    const ports: Record<string, Port> = {};
    LEAVES.forEach((leaf, r) => (ports[`swp${r + 1}`] = mkPort(`swp${r + 1}`, { kind: 'switch', sw: leaf, port: s === 0 ? 'swp31' : 'swp32' })));
    switches[spine] = { name: spine, role: 'spine', cfg: { roce: 'lossless', ports: {} }, pending: null, ports };
  });
  for (const sw of Object.values(switches)) syncCfg(sw);
  return { hosts, switches, actions: [], mode: 'roce' };
}

/** The NVUE-style config mirrors the port objects; this copies ports -> cfg. */
function syncCfg(sw: Switch) {
  sw.cfg.ports = Object.fromEntries(Object.values(sw.ports).map((p) => [p.name, { mtu: p.mtu, admin: p.admin, pfcwd: p.pfcwd !== false }]));
}

export function applyFaults(s: FabricState, faults: Fault[]): FabricState {
  for (const f of faults) {
    applyFault(s, f);
    ibSettle(s);
  }
  return s;
}

function nodesOf(f: Fault): string[] {
  return f.node === 'all' || f.node === undefined ? [...NODES] : [String(f.node)];
}

export function applyFault(s: FabricState, f: Fault) {
  const sw = f.switch ? s.switches[String(f.switch)] : undefined;
  const port = sw && f.port ? sw.ports[String(f.port)] : undefined;
  const nic = (node: string) => s.hosts[node].nics[Number(f.rail)];
  switch (f.type) {
    case 'switch_port_mtu': port!.mtu = Number(f.mtu); break;
    case 'switch_port_admin_down': port!.admin = false; break;
    case 'cable_unplugged': port!.cable = 'unplugged'; break;
    case 'bad_cable':
      port!.ber = Number(f.ber ?? 1e-5);
      if (port!.peer.kind === 'host') {
        const h = s.hosts[port!.peer.node];
        const n = h.nics[port!.peer.rail];
        n.counters.link_down_events_phy += 3;
        port!.counters.link_flaps += 3;
        for (const t of ['02:14:07', '02:14:09', '03:51:22', '03:51:25', '05:02:40', '05:02:43'])
          h.dmesg.push(`[Tue Oct 20 ${t} 2026] mlx5_core 0000:${n.bdf} ${n.netdev}: Link ${h.dmesg.length % 2 ? 'up' : 'down'}`);
      }
      break;
    case 'switch_roce': sw!.cfg.roce = f.mode as RoceMode; break;
    case 'host_mtu': for (const n of nodesOf(f)) nic(n).mtu = Number(f.mtu); break;
    case 'host_pfc': for (const n of nodesOf(f)) nic(n).pfc = Array.from({ length: 8 }, (_, p) => (f.prios as number[]).includes(p)); break;
    case 'host_trust': for (const n of nodesOf(f)) nic(n).trust = f.trust as Trust; break;
    case 'nic_admin_down': for (const n of nodesOf(f)) nic(n).admin = false; break;
    case 'pcie_downtrain':
      for (const n of nodesOf(f)) {
        const x = nic(n);
        x.pcieWidth = Number(f.width ?? 8);
        x.pcieSpeed = Number(f.speed ?? 32);
        const avail = pcieGbps(x).toFixed(3);
        s.hosts[n].dmesg.push(`[Tue Oct 20 00:00:41 2026] mlx5_core 0000:${x.bdf}: ${avail} Gb/s available PCIe bandwidth, limited by ${x.pcieSpeed.toFixed(1)} GT/s PCIe x${x.pcieWidth} link at 0000:${x.bdf.slice(0, 2)}:00.0 (capable of 504.112 Gb/s with 32.0 GT/s PCIe x16 link)`);
      }
      break;
    case 'switch_ecn': {
      // ECN marking disabled (or re-enabled) on one traffic class of a switch's congestion-control profile.
      const tc = Number(f.tc ?? ROCE_PRIO);
      const off = new Set(sw!.cfg.ecnOff ?? []);
      if (f.enabled === false) off.add(tc);
      else off.delete(tc);
      sw!.cfg.ecnOff = [...off].sort();
      break;
    }
    case 'nic_rx_stall':
      for (const n of nodesOf(f)) nic(n).stalled = true;
      seedStall(s, f);
      break;
    case 'pfcwd': port!.pfcwd = f.enabled !== false; break;
    case 'ib_fabric': toInfiniBand(s); break;
    case 'sm_down':
      // No SM runs, and the fabric has been power-cycled since (a patch window), so no port is configured.
      if (!smList(s).length) throw new Error('sm_down needs the ib_fabric variant first');
      for (const x of smList(s)) {
        x.running = false;
        x.enabled = f.enabled === true;
      }
      s.ibConfigured = [];
      break;
    case 'ib_sm': {
      // Add or change an OpenSM instance: { node, rail?, priority?, state?: running|stopped|failed, enabled? }.
      if (s.mode !== 'ib') throw new Error('ib_sm needs the ib_fabric variant first');
      const node = String(f.node);
      const before = masterSm(s);
      let x = smList(s).find((y) => y.node === node);
      if (!x) {
        x = { node, rail: 0, running: true, enabled: true, priority: 0 };
        s.sms!.push(x);
      }
      if (f.rail !== undefined) x.rail = Number(f.rail);
      if (f.priority !== undefined) x.priority = Number(f.priority);
      if (f.enabled !== undefined) x.enabled = f.enabled === true;
      const st = String(f.state ?? 'running');
      x.running = st === 'running';
      x.failed = st === 'failed';
      smStopped(s, x, before);
      break;
    }
    case 'ib_port_reset':
      // The links of a switch (or of one HCA) retrained, e.g. after a reboot: the ports wait in INIT for an SM.
      if (sw) unconfigure(s, Object.values(sw.ports).flatMap((p) => linkKeys(sw.name, p)).concat(sw.name));
      else unconfigure(s, [`${String(f.node)}:${Number(f.rail)}`, ...linkKeys(LEAVES[Number(f.rail)], s.switches[LEAVES[Number(f.rail)]].ports[leafPortFor(String(f.node))])]);
      break;
    case 'switch_down':
      sw!.off = true;
      for (const p of Object.values(sw!.ports)) p.dead = true;
      unconfigure(s, Object.values(sw!.ports).flatMap((p) => linkKeys(sw!.name, p)).concat(sw!.name));
      break;
    case 'link_degraded': {
      port!.lanes = Number(f.lanes ?? 1);
      if (f.ber !== undefined) port!.ber = Number(f.ber);
      // The link went down and retrained at reduced width: link-down events and symbol errors precede it.
      if (port!.peer.kind === 'host') {
        const n = s.hosts[port!.peer.node].nics[port!.peer.rail];
        n.counters.link_down_events_phy += 2;
        if (n.ib) { n.ib.LinkDownedCounter += 2; n.ib.LinkErrorRecoveryCounter += 5; n.ib.SymbolErrorCounter += 211; }
      }
      port!.counters.link_flaps += 2;
      if (port!.ib) { port!.ib.LinkDownedCounter += 2; port!.ib.LinkErrorRecoveryCounter += 5; port!.ib.SymbolErrorCounter += 187; }
      break;
    }
    case 'ib_counters': {
      // Pre-existing counter history, e.g. one LinkDowned from a planned reboot (a red herring).
      const add = (f.counters ?? {}) as Record<string, number>;
      const target = f.node !== undefined ? s.hosts[String(f.node)].nics[Number(f.rail)].ib : port?.ib;
      if (!target) throw new Error('ib_counters needs the ib_fabric variant first');
      for (const [k, v] of Object.entries(add)) target[k] = (target[k] ?? 0) + Number(v);
      break;
    }
    case 'nccl_conf':
      for (const n of nodesOf(f)) {
        let conf = s.hosts[n].files['/etc/nccl.conf'];
        for (const [k, v] of Object.entries((f.set ?? {}) as Record<string, unknown>)) conf = setConfKey(conf, k, v === null ? null : String(v));
        s.hosts[n].files['/etc/nccl.conf'] = conf;
      }
      break;
    default:
      throw new Error(`unknown fault type ${f.type}`);
  }
  if (sw) syncCfg(sw);
}

export const FAULT_TYPES = ['switch_port_mtu', 'switch_port_admin_down', 'cable_unplugged', 'bad_cable', 'switch_roce', 'host_mtu', 'host_pfc', 'host_trust', 'nic_admin_down', 'pcie_downtrain', 'nccl_conf',
  'switch_ecn', 'nic_rx_stall', 'pfcwd', 'ib_fabric', 'sm_down', 'link_degraded', 'ib_counters', 'ib_sm', 'ib_port_reset', 'switch_down'];

/** Convert a fresh cluster to the InfiniBand variant (NDR, one subnet, OpenSM on node01 mlx5_0). */
function toInfiniBand(s: FabricState) {
  s.mode = 'ib';
  s.sms = [{ node: 'node01', rail: 0, running: true, enabled: true, priority: 0 }];
  delete s.sm;
  for (const h of Object.values(s.hosts)) {
    for (const n of h.nics) {
      n.netdev = IB_NETDEVS[n.rail];
      n.ib = emptyIb();
    }
    // No RoCE knobs in an InfiniBand cluster's NCCL config (no GID index or traffic class, no ECMP entropy tuning).
    let conf = h.files['/etc/nccl.conf'];
    for (const k of ['NCCL_IB_GID_INDEX', 'NCCL_IB_TC', 'NCCL_IB_QPS_PER_CONNECTION']) conf = setConfKey(conf, k, null);
    h.files['/etc/nccl.conf'] = conf;
  }
  for (const sw of Object.values(s.switches)) for (const p of Object.values(sw.ports)) p.ib = emptyIb();
}

/** The job was already running when the ticket was filed, so the watchdog has tripped several times. */
function seedStall(s: FabricState, f: Fault) {
  for (const node of nodesOf(f)) {
    const r = Number(f.rail);
    const port = s.switches[LEAVES[r]].ports[leafPortFor(node)];
    const nic = s.hosts[node].nics[r];
    nic.counters[`tx_prio${ROCE_PRIO}_pause`] += 48_113_620;
    port.counters.rx_pfc_pause += 48_113_620;
    if (port.pfcwd !== false && port.wd) {
      port.counters.tx_drops += 1_204_377;
      port.wd.deadlocks[ROCE_PRIO] += 9;
      port.wd.status[ROCE_PRIO] = 'DEADLOCK';
    }
  }
}

export function setConfKey(conf: string, key: string, value: string | null): string {
  const lines = conf.split('\n');
  const i = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (value === null) {
    if (i >= 0) lines.splice(i, 1);
  } else if (i >= 0) lines[i] = `${key}=${value}`;
  else {
    const end = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, `${key}=${value}`);
  }
  return lines.join('\n');
}

export function parseConf(conf: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of conf.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------- evaluation

// Linux iboe_get_mtu(): the largest IB MTU that fits in the netdev MTU minus 96 bytes of RoCE headers.
export const roceMtu = (netdevMtu: number) => [...IB_MTUS].reverse().find((m) => netdevMtu - 96 >= m) ?? 256;
export const pcieGbps = (n: Nic) => {
  const perLane: Record<number, number> = { 8: 7.876, 16: 15.753, 32: 31.507, 64: 64 };
  return (perLane[n.pcieSpeed] ?? 31.507) * n.pcieWidth;
};

export interface Issue { fatal: boolean; underLoadOnly?: boolean; factor: number; kind: string; detail: string }

/** Physical link up: both ends enabled and powered, and a working cable. */
export function linkUp(s: FabricState, p: Port): boolean {
  if (!p.admin || p.cable !== 'ok' || p.dead) return false;
  if (p.peer.kind === 'host') return s.hosts[p.peer.node].nics[p.peer.rail].admin;
  const q = s.switches[p.peer.sw].ports[p.peer.port];
  return q.admin && q.cable === 'ok' && !q.dead;
}

// ---------------------------------------------------------------- InfiniBand subnet management

/** A standby declares the master dead after OpenSM's polling_timeout (10 s) x polling_retry_number (4) defaults. */
// Measured on two ConnectX-5 ports back to back with DOCA OpenSM defaults: the standby became master 53 s
// after the master was killed.
export const SM_TAKEOVER_S = 50;

/** The OpenSM instances of the subnet (migrates the single `sm` of older saved states). */
export function smList(s: FabricState): SmState[] {
  if (!s.sms && s.sm) {
    s.sms = [{ priority: 0, ...s.sm }];
    delete s.sm;
  }
  return s.sms ?? [];
}
const smPortOf = (s: FabricState, x: SmState) => s.switches[LEAVES[x.rail]].ports[leafPortFor(x.node)];
/** Election order: higher priority first, then the lower port GUID. */
const smOrder = (a: SmState, b: SmState) => (b.priority ?? 0) - (a.priority ?? 0) || (hcaGuid(a.node, a.rail) < hcaGuid(b.node, b.rail) ? -1 : 1);

/** The master SM, or null: none running, or the standbys are still polling a master that died. */
export function masterSm(s: FabricState): SmState | null {
  if (s.mode !== 'ib') return null;
  const up = smList(s).filter((x) => x.running && linkUp(s, smPortOf(s, x)));
  if (!up.length) return null;
  if (s.smLostAt !== undefined && (s.clock ?? 0) < s.smLostAt + SM_TAKEOVER_S) return null;
  return [...up].sort(smOrder)[0];
}

/** Bookkeeping after an SM stopped: if it was the master and a standby runs, the standby takes over later. */
export function smStopped(s: FabricState, x: SmState, before: SmState | null) {
  if (before === x && !x.running && smList(s).some((y) => y !== x && y.running)) s.smLostAt = s.clock ?? 0;
}

/** Ports the master SM reaches by sweeping the subnet from its own port over links that are physically up. */
export function smSweep(s: FabricState): Set<string> {
  const act = new Set<string>();
  const m = masterSm(s);
  if (!m) return act;
  const queue = [LEAVES[m.rail]];
  act.add(queue[0]);
  while (queue.length) {
    const sw = s.switches[queue.shift()!];
    for (const p of Object.values(sw.ports)) {
      if (!linkUp(s, p)) continue;
      act.add(`${sw.name}:${p.name}`);
      if (p.peer.kind === 'host') act.add(`${p.peer.node}:${p.peer.rail}`);
      else if (!act.has(p.peer.sw)) {
        act.add(p.peer.sw);
        queue.push(p.peer.sw);
      }
    }
  }
  return act;
}

/** Is a configured port (or switch) still physically up? */
function keyUp(s: FabricState, k: string): boolean {
  const [a, b] = k.split(':');
  if (b === undefined) return !!s.switches[a] && !s.switches[a].off;
  if (s.hosts[a]) return linkUp(s, s.switches[LEAVES[Number(b)]].ports[leafPortFor(a)]);
  const p = s.switches[a]?.ports[b];
  return !!p && linkUp(s, p);
}

/**
 * IB variant: the ports that are ACTIVE. The master SM configures every port it reaches; a configured port
 * stays ACTIVE without an SM (traffic keeps flowing) until its link drops, and then waits in INIT for an SM.
 * Keys: "node:rail" for HCA ports, "switch" and "switch:port" for switches.
 */
export function ibActive(s: FabricState): Set<string> {
  if (s.mode !== 'ib') return new Set<string>();
  const act = smSweep(s);
  for (const k of s.ibConfigured ?? []) if (keyUp(s, k)) act.add(k);
  return act;
}

/** Record which ports are configured now (called after every fault and command). */
export function ibSettle(s: FabricState) {
  if (s.mode !== 'ib') return;
  const act = ibActive(s);
  s.ibConfigured = [...act];
  const m = masterSm(s);
  if (m) s.ibSmLid = ibHcaLid(s, m.node, m.rail, act);
}

/** Both ends of a link, as ibActive keys. */
export function linkKeys(sw: string, p: Port): string[] {
  return [`${sw}:${p.name}`, p.peer.kind === 'host' ? `${p.peer.node}:${p.peer.rail}` : `${p.peer.sw}:${p.peer.port}`];
}
/** These ports retrained (or rebooted): they lose their configuration until an SM sweeps them again. */
export function unconfigure(s: FabricState, keys: string[]) {
  if (s.mode !== 'ib' || !s.ibConfigured) return;
  const drop = new Set(keys);
  s.ibConfigured = s.ibConfigured.filter((k) => !drop.has(k));
}

/** IB variant: LIDs the SM assigns (switches 1-10, HCAs from 11; the SM's own port gets 11). 0 = unassigned. */
export const SWITCH_ORDER = [...LEAVES, ...SPINES];
export const ibSwitchLid = (s: FabricState, sw: string, act = ibActive(s)) => (act.has(sw) ? SWITCH_ORDER.indexOf(sw) + 1 : 0);
export const ibHcaLid = (s: FabricState, node: string, rail: number, act = ibActive(s)) =>
  act.has(`${node}:${rail}`) ? 11 + nodeIndex(node) * RAILS + rail : 0;
/** The SM LID the ports report: the master's port, or (no master) the one the last master programmed. */
export const ibSmLid = (s: FabricState) => {
  const m = masterSm(s);
  return m ? ibHcaLid(s, m.node, m.rail) : (s.ibSmLid ?? 0);
};

/** Issues on the access link and NIC of (node, rail), independent of the far end. */
export function nicIssues(s: FabricState, node: string, rail: number): Issue[] {
  const nic = s.hosts[node].nics[rail];
  const leaf = s.switches[LEAVES[rail]];
  const port = leaf.ports[leafPortFor(node)];
  const issues: Issue[] = [];
  if (!nic.admin) issues.push({ fatal: true, factor: 0, kind: 'down', detail: `${nic.netdev} administratively down` });
  if (!port.admin) issues.push({ fatal: true, factor: 0, kind: 'down', detail: `${leaf.name} ${port.name} administratively down` });
  if (port.cable === 'unplugged') issues.push({ fatal: true, factor: 0, kind: 'down', detail: `no carrier between ${node} ${nic.netdev} and ${leaf.name} ${port.name}` });
  if (port.dead) issues.push({ fatal: true, factor: 0, kind: 'down', detail: `${leaf.name} is powered off` });
  if (s.mode === 'ib' && !issues.some((i) => i.fatal) && !ibActive(s).has(`${node}:${rail}`))
    issues.push({ fatal: true, factor: 0, kind: 'init', detail: `${nic.dev} port 1 is INIT: no subnet manager has configured it` });
  const lanes = port.lanes ?? 4;
  if (lanes < 4) issues.push({ fatal: false, factor: lanes / 4, kind: 'width', detail: `${leaf.name} ${port.name} link trained at ${lanes}X instead of 4X` });
  if (port.ber > 1e-8) issues.push({ fatal: false, factor: 0.55, kind: 'ber', detail: `high BER on ${leaf.name} ${port.name}` });
  const pcieCap = pcieGbps(nic) * 0.9;
  if (pcieCap < LINE_RATE_GBPS) issues.push({ fatal: false, factor: pcieCap / LINE_RATE_GBPS, kind: 'pcie', detail: `PCIe link x${nic.pcieWidth} ${nic.pcieSpeed}GT/s` });
  // InfiniBand is lossless by credit-based link-level flow control: no PFC, ECN or trust settings to get wrong.
  if (s.mode === 'ib') return issues;
  // Lossless config: switch must run RoCE lossless with PFC on prio 3; NIC must trust DSCP and enable PFC on prio 3 only.
  if (leaf.cfg.roce !== 'lossless') issues.push({ fatal: false, underLoadOnly: true, factor: 0.3, kind: 'lossy', detail: `${leaf.name} RoCE QoS ${leaf.cfg.roce}` });
  else if (nic.trust !== 'dscp') issues.push({ fatal: false, underLoadOnly: true, factor: 0.35, kind: 'trust', detail: `${nic.netdev} trusts PCP` });
  else if (!nic.pfc[ROCE_PRIO]) issues.push({ fatal: false, underLoadOnly: true, factor: 0.35, kind: 'pfc', detail: `${nic.netdev} PFC not enabled on priority ${ROCE_PRIO}` });
  // PFC still protects the class, but without ECN marks DCQCN never slows senders: congestion is handled
  // only by pausing, which spreads head-of-line blocking to every flow that shares a paused ingress port.
  else if ((leaf.cfg.ecnOff ?? []).includes(ROCE_PRIO)) issues.push({ fatal: false, underLoadOnly: true, factor: 0.55, kind: 'noecn', detail: `${leaf.name} ECN marking disabled on traffic class ${ROCE_PRIO}` });
  // A stuck receiver pauses its leaf port continuously. With the PFC watchdog the leaf drops that queue
  // (retransmissions); without it the pause storm spreads and stalls the whole rail.
  if (nic.stalled) issues.push({ fatal: false, underLoadOnly: true, factor: port.pfcwd !== false ? 0.15 : 0.04, kind: 'stall', detail: `${node} ${nic.netdev} receive path stalled (pause storm)` });
  return issues;
}

export interface PairResult { ok: boolean; gbps: number; error?: string; mtu: number; issues: Issue[]; path: Port[] }

/** One RC connection from (a, ra) to (b, rb), unloaded fabric (like ib_write_bw with one QP). */
export function evaluatePair(s: FabricState, a: string, ra: number, b: string, rb: number, gidIndex = 3): PairResult {
  const issues = [...nicIssues(s, a, ra), ...nicIssues(s, b, rb)];
  const na = s.hosts[a].nics[ra];
  const nb = s.hosts[b].nics[rb];
  const ib = s.mode === 'ib';
  // IB: the path MTU is the 4096-byte IB MTU, independent of the IPoIB netdev MTU.
  const mtu = ib ? 4096 : Math.min(roceMtu(na.mtu), roceMtu(nb.mtu));
  const path: Port[] = [s.switches[LEAVES[ra]].ports[leafPortFor(a)]];
  if (ra !== rb) {
    const up = (leaf: string) => ['swp31', 'swp32'].map((p) => s.switches[leaf].ports[p]).filter((p) => linkUp(s, p));
    const ua = up(LEAVES[ra]);
    const ub = up(LEAVES[rb]);
    const spineOf = (p: Port) => (p.peer.kind === 'switch' ? p.peer.sw : null);
    const viaSpine = ua.filter((p) => ub.some((q) => spineOf(q) !== null && spineOf(q) === spineOf(p)));
    if (!viaSpine.length) return { ok: false, gbps: 0, error: 'no route to host', mtu, issues, path };
    path.push(viaSpine[0]);
  }
  path.push(s.switches[LEAVES[rb]].ports[leafPortFor(b)]);
  const fatal = issues.find((i) => i.fatal);
  if (fatal) return { ok: false, gbps: 0, error: fatal.detail, mtu, issues, path };
  if (!ib && gidIndex !== 3) return { ok: false, gbps: 0, error: 'gid', mtu, issues, path };
  const tooSmall = ib ? undefined : path.find((p) => p.mtu < mtu + ROCE_IP_OVERHEAD);
  if (tooSmall) return { ok: false, gbps: 0, error: 'mtu', mtu, issues: [...issues, { fatal: true, factor: 0, kind: 'mtu-drop', detail: `${tooSmall.name} MTU ${tooSmall.mtu}` }], path };
  let factor = 1;
  for (const i of issues) if (!i.underLoadOnly) factor = Math.min(factor, i.factor);
  if (mtu < 4096) factor *= mtu >= 2048 ? 0.93 : 0.82;
  // Writing into a stuck receiver: the leaf watchdog drops the queue (or, without it, the flow just stalls).
  const recv = issues.find((i) => i.kind === 'stall' && nb.stalled);
  if (recv) factor = Math.min(factor, recv.factor);
  return { ok: true, gbps: Math.round(391.8 * factor * 100) / 100, mtu, issues, path };
}

export interface CollectiveResult {
  ok: boolean;
  busbw: number;
  error?: string;
  /** Node that logs the WARN line, and the NCCL source location printed with it. */
  errorNode?: string;
  errorSrc?: string;
  transport: 'IB' | 'Socket';
  rails: number[];
  warnings: string[];
  limiting?: Issue;
  conf: Record<string, string>;
  /** NCCL_CROSS_NIC=1: rings leave a node on a different NIC than they enter, so inter-node hops change rail. */
  crossRail?: boolean;
  /** Cross-rail runs: which leaf uplink and spine each flow (QP) hashed onto. */
  ecmp?: EcmpPlan;
}

// ---------------------------------------------------------------- ECMP over the leaf uplinks (cross-rail traffic)

/** Each NCCL connection opens NCCL_IB_QPS_PER_CONNECTION QPs (NCCL's documented default is 1; the variable accepts 1-128). */
export const qpsPerConnection = (c: Record<string, string>) => Math.min(128, Math.max(1, Math.floor(Number(c.NCCL_IB_QPS_PER_CONNECTION ?? 1)) || 1));

/**
 * UDP source port of a RoCEv2 QP. Modelled on the Linux helpers rdma_calc_flow_label() and
 * rdma_flow_label_to_udp_sport(): a 20-bit flow label hashed from the two QP numbers, folded into 0xC000-0xFFFF.
 * How a given NIC and firmware really derive the port varies; what matters is one fixed port per QP.
 */
export function roceUdpSport(lqpn: number, rqpn: number): number {
  const v = lqpn * rqpn; // below 2^48, exact in a double
  const fl = ((v % 0x100000) ^ (Math.floor(v / 0x100000) % 0x100000) ^ (Math.floor(v / 2 ** 40) & 0xff)) & 0xfffff;
  return ((fl & 0x3fff) ^ ((fl & 0xfc000) >> 14)) | 0xc000;
}

/** The ECMP hash seed every leaf uses (identical switches with default settings). */
export const ECMP_SEED = 49;

/**
 * Switch ECMP hash over the 5-tuple (source IP, destination IP, protocol 17, UDP source port, destination port 4791).
 * Switch ASICs use CRC-style functions with a configurable seed; this model uses FNV-1a plus a murmur3 finaliser so
 * that the result behaves like a well-mixed hash. Only the inputs and the seed decide the uplink, as on a real switch.
 */
export function ecmpHash(src: string, dst: string, sport: number, seed = ECMP_SEED): number {
  const bytes = [...src.split('.').map(Number), ...dst.split('.').map(Number), 17, sport >> 8, sport & 0xff, 4791 >> 8, 4791 & 0xff];
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const x of bytes) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export interface EcmpFlow { src: string; dst: string; sport: number; srcLeaf: string; up: string; spine: string; spinePort: string; dstLeaf: string; qps: number }
export interface EcmpPlan {
  flows: EcmpFlow[];
  /** Flows per directed link ("switch:port", egress side): leaf uplinks and spine ports toward the destination leaf. */
  load: Record<string, number>;
  /** Fair share of flows per link (flows the leaf sends or receives over the spines / usable uplinks). */
  fair: Record<string, number>;
  /** Worst link: fair share / flows on it (1 = perfectly spread). */
  efficiency: number;
  /** Pace of the slowest flow relative to the NIC's own share (0.5 = the 2:1 uplink bound). */
  pace: number;
  noRoute?: { a: string; ra: number; b: string; rb: number };
}

/**
 * Cross-rail rings: each of the 2 channels per rail makes 4 inter-node hops from NIC `last` of one node to NIC `c` of the
 * next, and every hop opens NCCL_IB_QPS_PER_CONNECTION QPs. RoCE: each QP is one flow with its own UDP source port and the
 * source leaf hashes it onto one uplink (static ECMP). InfiniBand: the SM's routing spreads destinations evenly.
 */
export function crossRailPlan(s: FabricState, rails: number[], confs: Record<string, string>[], seed = ECMP_SEED): EcmpPlan {
  const ib = s.mode === 'ib';
  const n = rails.length;
  const flows: EcmpFlow[] = [];
  const load: Record<string, number> = {};
  const fair: Record<string, number> = {};
  const out: Record<string, { flows: number; ups: number }> = {};
  const into: Record<string, { flows: number; spines: Set<string> }> = {};
  const paths: { keys: string[]; qps: number }[] = [];
  for (let k = 0; k < 2 * n; k++) {
    const c = rails[k % n];
    const last = rails[((k % n) + n - 1) % n];
    const srcLeaf = LEAVES[last];
    const dstLeaf = LEAVES[c];
    for (const [i, a] of NODES.entries()) {
      const b = NODES[(i + 1) % NODES.length];
      const qps = qpsPerConnection(confs[i]);
      const cands = ['swp31', 'swp32'].map((x) => s.switches[srcLeaf].ports[x])
        .filter((p) => linkUp(s, p) && p.peer.kind === 'switch' && linkUp(s, s.switches[p.peer.sw].ports[`swp${c + 1}`]));
      if (!cands.length) return { flows, load, fair, efficiency: 0, pace: 0, noRoute: { a, ra: last, b, rb: c } };
      out[srcLeaf] = { flows: (out[srcLeaf]?.flows ?? 0) + qps, ups: cands.length };
      into[dstLeaf] ??= { flows: 0, spines: new Set() };
      into[dstLeaf].flows += qps;
      for (const p of cands) if (p.peer.kind === 'switch') into[dstLeaf].spines.add(p.peer.sw);
      for (let q = 0; q < qps; q++) {
        // QP numbers are handed out in order on each device; the receiving side's QP is created when it accepts.
        const lqpn = 0x1c4 + 0x2d * last + 0x11 * i + k * 128 + q;
        const rqpn = 0x2a9 + 0x2d * c + 0x11 * ((i + 1) % NODES.length) + k * 128 + q;
        const sport = roceUdpSport(lqpn, rqpn);
        const src = hostIp(a, last);
        const dst = hostIp(b, c);
        const pick = cands[(ib ? k * qps + q + i : ecmpHash(src, dst, sport, seed)) % cands.length];
        const spine = pick.peer.kind === 'switch' ? pick.peer.sw : '';
        const f: EcmpFlow = { src, dst, sport, srcLeaf, up: pick.name, spine, spinePort: `swp${c + 1}`, dstLeaf, qps };
        flows.push(f);
        const keys = [`${srcLeaf}:${pick.name}`, `${spine}:${f.spinePort}`];
        for (const key of keys) load[key] = (load[key] ?? 0) + 1;
        paths.push({ keys, qps });
      }
    }
  }
  for (const key of Object.keys(load)) {
    const [sw, port] = key.split(':');
    if (LEAVES.includes(sw)) fair[key] = out[sw].flows / out[sw].ups;
    else {
      const leaf = LEAVES[Number(port.slice(3)) - 1];
      fair[key] = into[leaf].flows / into[leaf].spines.size;
    }
  }
  // Every NIC carries 2 channels x qps flows at line rate; a link shared by m flows gives each 1/m of it.
  let pace = 1;
  for (const p of paths) for (const key of p.keys) pace = Math.min(pace, (2 * p.qps) / load[key]);
  const efficiency = Math.min(1, ...Object.keys(load).map((key) => fair[key] / load[key]));
  return { flows, load, fair, efficiency, pace };
}

export function hcaSelected(spec: string | undefined, dev: string): boolean {
  if (!spec) return true;
  let s = spec.trim();
  const exclude = s.startsWith('^');
  if (exclude) s = s.slice(1);
  const exact = s.startsWith('=');
  if (exact) s = s.slice(1);
  const hit = s.split(',').map((x) => x.trim().split(':')[0]).filter(Boolean).some((p) => (exact ? dev === p : dev.startsWith(p)));
  return exclude ? !hit : hit;
}

/** all_reduce across all 32 GPUs. Ring/tree channels spread over rails; the slowest rail paces the job. */
export function evaluateAllReduce(s: FabricState): CollectiveResult {
  const confs = NODES.map((n) => parseConf(s.hosts[n].files['/etc/nccl.conf'] ?? ''));
  const conf = confs[0];
  const warnings: string[] = [];
  const base = { transport: 'IB' as const, rails: [] as number[], warnings, conf };
  for (const [i, c] of confs.entries()) {
    const ifn = c.NCCL_SOCKET_IFNAME;
    if (ifn && !['eno1', 'eno', '=eno1', '^lo,docker'].includes(ifn) && !NETDEVS.some((d) => d.startsWith(ifn.replace(/^=/, ''))))
      return { ...base, ok: false, busbw: 0, error: 'Bootstrap : no socket interface found', errorNode: NODES[i], errorSrc: 'misc/socket.cc' };
  }
  if (confs.some((c) => c.NCCL_IB_DISABLE === '1')) {
    warnings.push('NCCL_IB_DISABLE set by environment to 1.');
    return { ...base, ok: true, busbw: SOCKET_BUSBW, transport: 'Socket' };
  }
  const ib = s.mode === 'ib';
  const act = ibActive(s);
  // NCCL's IB plugin skips ports that are not ACTIVE (net_ib: portAttr.state != IBV_PORT_ACTIVE).
  const rails = Array.from({ length: RAILS }, (_, r) => r)
    .filter((r) => confs.every((c) => hcaSelected(c.NCCL_IB_HCA, `mlx5_${r}`)))
    .filter((r) => !ib || NODES.every((n) => act.has(`${n}:${r}`)));
  // No usable HCA (NCCL_IB_HCA matches nothing, or no IB port is ACTIVE): real NCCL logs this at INFO
  // level and silently falls back to sockets.
  if (!rails.length) {
    warnings.push('NET/IB : No device found.');
    return { ...base, ok: true, busbw: SOCKET_BUSBW, transport: 'Socket' };
  }
  const gids = confs.map((c) => Number(c.NCCL_IB_GID_INDEX ?? 3));
  const tcs = confs.map((c) => Number(c.NCCL_IB_TC ?? 0));
  let minFactor = 1;
  let limiting: Issue | undefined;
  for (const r of rails) {
    for (const [i, a] of NODES.entries()) {
      const b = NODES[(i + 1) % NODES.length];
      const pair = evaluatePair(s, a, r, b, r, gids[i]);
      if (!pair.ok) {
        const reason = pair.error === 'gid'
          ? `NET/IB : Call to ibv_modify_qp failed with 110 Connection timed out, on dev mlx5_${r}:1, curr state INIT, next state RTR, local GID index ${gids[i]}`
          // A dead link and an MTU black hole look the same to NCCL: the sender retries until the QP errors.
          : `NET/IB : Got completion from peer ${hostIp(b, r)}<${45000 + r * 7 + i}> with status=12 opcode=0 len=0 vendor err 129 (Send) localGid ::ffff:${hostIp(a, r)} remoteGid ::ffff:${hostIp(b, r)} hca mlx5_${r}`;
        return { ...base, rails, ok: false, busbw: 0, error: reason, errorNode: a, errorSrc: 'transport/net_ib.cc' };
      }
      for (const iss of pair.issues) if (iss.factor < minFactor) { minFactor = iss.factor; limiting = iss; }
      const pf = pair.gbps / 391.8;
      if (pf < minFactor) { minFactor = pf; limiting = pair.issues.find((x) => !x.underLoadOnly) ?? { fatal: false, factor: pf, kind: 'mtu-low', detail: `RoCE path MTU ${pair.mtu}` }; }
    }
  }
  // NCCL_CROSS_NIC=1 lets a ring enter a node on NIC n and leave on NIC m, so every inter-node hop goes
  // leaf -> spine -> leaf. Each leaf has 4 x 400G down and 2 x 400G up: at best half the bandwidth, and only if
  // the hash spreads the flows evenly over the uplinks (crossRailPlan); 0.97 is protocol and congestion overhead.
  const crossRail = confs.some((c) => c.NCCL_CROSS_NIC === '1') && rails.length > 1;
  let ecmp: EcmpPlan | undefined;
  if (crossRail) {
    ecmp = crossRailPlan(s, rails, confs);
    if (ecmp.noRoute) {
      const { a, ra, b, rb } = ecmp.noRoute;
      return { ...base, rails, ok: false, busbw: 0, errorNode: a, errorSrc: 'transport/net_ib.cc',
        error: `NET/IB : Got completion from peer ${hostIp(b, rb)}<${45000 + rb * 7}> with status=12 opcode=0 len=0 vendor err 129 (Send) localGid ::ffff:${hostIp(a, ra)} remoteGid ::ffff:${hostIp(b, rb)} hca mlx5_${ra}` };
    }
    const f = 0.97 * ecmp.pace;
    if (f < minFactor) {
      minFactor = f;
      limiting = ecmp.efficiency < 0.85
        ? { fatal: false, underLoadOnly: true, factor: f, kind: 'ecmp', detail: 'cross-rail flows collide on leaf uplinks (too few flows for ECMP to spread)' }
        : { fatal: false, underLoadOnly: true, factor: f, kind: 'cross-rail', detail: 'inter-node traffic crosses rails through the spines (NCCL_CROSS_NIC=1)' };
    }
  }
  // Traffic class: NCCL_IB_TC=106 is DSCP 26 (106 >> 2) with ECT. Anything else lands outside the lossless class.
  if (!ib && tcs.some((t) => t >> 2 !== 26)) {
    const f = 0.35;
    if (f < minFactor) { minFactor = f; limiting = { fatal: false, underLoadOnly: true, factor: f, kind: 'tc', detail: `NCCL_IB_TC=${tcs.find((t) => t >> 2 !== 26)} (DSCP ${tcs.find((t) => t >> 2 !== 26)! >> 2}) is not the lossless RoCE class` }; }
  }
  return { ...base, ok: true, rails, busbw: Math.round(PER_RAIL_BUSBW * rails.length * minFactor * 100) / 100, limiting, crossRail, ecmp };
}

/** Advance counters as if `kind` traffic ran. Deterministic so the same lab always tells the same story. */
export function accrueTraffic(s: FabricState, kind: 'collective' | 'pair', scope?: { nodes: string[]; rails: number[] }, ar?: CollectiveResult) {
  const nodes = scope?.nodes ?? [...NODES];
  const rails = scope?.rails ?? ar?.rails ?? [];
  const load = kind === 'collective';
  const ib = s.mode === 'ib';
  const tc = ar ? Number(ar.conf.NCCL_IB_TC ?? 0) : 106;
  const prio = ib || tc >> 2 === 26 ? ROCE_PRIO : 0;
  const stalledDrops: { rail: number; node: string; drops: number }[] = [];
  for (const node of nodes) {
    for (const r of rails) {
      const nic = s.hosts[node].nics[r];
      const port = s.switches[LEAVES[r]].ports[leafPortFor(node)];
      const issues = nicIssues(s, node, r);
      if (issues.some((i) => i.fatal)) continue;
      const pkts = load ? 52_000_000 : 6_100_000;
      const c = nic.counters;
      c.tx_packets_phy += pkts; c.rx_packets_phy += pkts;
      c.tx_bytes_phy += pkts * 4154; c.rx_bytes_phy += pkts * 4154;
      c[`tx_prio${prio}_packets`] += pkts; c[`rx_prio${prio}_packets`] += pkts;
      nic.hw.rx_write_requests += pkts;
      port.counters.rx_packets += pkts; port.counters.tx_packets += pkts;
      const kinds = new Set(issues.map((i) => i.kind));
      // FEC corrects bit errors on every PAM4 link; a healthy link shows a slow trickle of corrected bits.
      c.rx_corrected_bits_phy += kinds.has('ber') ? Math.round(pkts * 4154 * 8 * 3e-4) : Math.round(pkts * 4154 * 8 * 2e-8);
      if (kinds.has('ber')) {
        // Beyond the FEC limit: uncorrected symbols, and packets dropped for coding (symbol) or FCS errors.
        const errs = Math.round(pkts * port.ber * 400);
        c.rx_pcs_symbol_err_phy += errs * 37;
        c.rx_symbol_err_phy += Math.round(errs / 4); c.rx_crc_errors_phy += errs;
        port.counters.rx_crc += errs; port.counters.rx_errors += errs;
        nic.hw.out_of_sequence += errs; nic.hw.packet_seq_err += Math.round(errs / 3);
        nic.hw.local_ack_timeout_err += Math.round(errs / 50);
      }
      if (ib) {
        accrueIb(nic, port, pkts, kinds.has('ber'), load, r, nodeIndex(node));
        continue;
      }
      if (!load) continue;
      const lossy = kinds.has('lossy') || kinds.has('trust') || kinds.has('pfc') || prio !== ROCE_PRIO;
      if (lossy) {
        const drops = 1_840_000 + r * 7_919 + nodeIndex(node) * 3_301;
        port.counters.tx_drops += drops;
        nic.hw.out_of_sequence += Math.round(drops * 0.92);
        nic.hw.packet_seq_err += Math.round(drops * 0.3);
        nic.hw.local_ack_timeout_err += Math.round(drops / 900);
        // The switch keeps pausing priority 3 toward a NIC that does not honour it (and has no prio-3 pause counters).
        if (kinds.has('pfc')) port.counters.tx_pfc_pause += 412_377;
        if (kinds.has('trust')) { c.rx_prio0_packets += pkts; c[`rx_prio${ROCE_PRIO}_packets`] -= pkts; }
      } else {
        // Lossless class in place. Healthy: some ECN marking and CNPs under load, very little pausing.
        if (kinds.has('noecn')) {
          // No ECN marks and no CNPs: the only brake left is PFC. The leaf pauses the senders constantly.
          const storm = 1_650_000 + r * 911 + nodeIndex(node) * 37;
          c[`rx_prio${ROCE_PRIO}_pause`] += storm; c[`tx_prio${ROCE_PRIO}_pause`] += 85 + r;
          port.counters.rx_pfc_pause += 85 + r; port.counters.tx_pfc_pause += storm;
        } else {
          const marks = (9_400 + r * 113 + nodeIndex(node) * 57) * (ar?.crossRail ? 9 : 1);
          port.counters.ecn_marked += marks;
          nic.hw.np_ecn_marked_roce_packets += marks; nic.hw.np_cnp_sent += Math.round(marks * 0.97);
          nic.hw.rp_cnp_handled += Math.round(marks * 0.95);
          c[`rx_prio${ROCE_PRIO}_pause`] += 120 + r; c[`tx_prio${ROCE_PRIO}_pause`] += 85 + r;
          port.counters.rx_pfc_pause += 85 + r; port.counters.tx_pfc_pause += 120 + r;
        }
      }
      if (kinds.has('stall')) {
        // The stuck NIC pauses its leaf port continuously.
        const storm = 9_612_040 + r * 1_009;
        c[`tx_prio${ROCE_PRIO}_pause`] += storm;
        port.counters.rx_pfc_pause += storm;
        if (port.pfcwd !== false && port.wd) {
          // The watchdog trips: it ignores the pauses and discards what is queued for this port.
          const drops = 2_093_551 + r * 313;
          port.counters.tx_drops += drops;
          port.wd.deadlocks[ROCE_PRIO] += 7;
          port.wd.status[ROCE_PRIO] = 'DEADLOCK';
          nic.hw.out_of_sequence += Math.round(drops * 0.41);
          stalledDrops.push({ rail: r, node, drops });
        } else {
          // No watchdog: the leaf's own buffers fill and it pauses every other sender on the rail.
          for (const other of nodes) {
            if (other === node) continue;
            const op = s.switches[LEAVES[r]].ports[leafPortFor(other)];
            op.counters.tx_pfc_pause += Math.round(storm / 3);
            s.hosts[other].nics[r].counters[`rx_prio${ROCE_PRIO}_pause`] += Math.round(storm / 3);
          }
        }
      }
    }
  }
  // Senders toward a dropped queue see NAKs (sequence errors) and timeouts, then retransmit.
  for (const d of stalledDrops) {
    for (const other of nodes) {
      if (other === d.node) continue;
      const hw = s.hosts[other].nics[d.rail].hw;
      hw.packet_seq_err += Math.round((d.drops * 0.3) / 3);
      hw.local_ack_timeout_err += Math.round(d.drops / 2700);
    }
  }
  if (load && ar?.ecmp) accrueSpines(s, ar.ecmp);
}

/** InfiniBand PMA counters: data in 4-byte words, PortXmitWait in ticks spent waiting for credits. */
function accrueIb(nic: Nic, port: Port, pkts: number, errors: boolean, load: boolean, r: number, idx: number) {
  const words = Math.round((pkts * 4154) / 4);
  for (const pc of [nic.ib, port.ib]) {
    if (!pc) continue;
    pc.PortXmitData += words; pc.PortRcvData += words;
    pc.PortXmitPkts += pkts; pc.PortRcvPkts += pkts;
  }
  if (load) {
    if (nic.ib) nic.ib.PortXmitWait += 1_350_000 + r * 1_117 + idx * 211;
    if (port.ib) port.ib.PortXmitWait += 2_870_000 + r * 1_301 + idx * 97;
  }
  if (errors) {
    const e = load ? 4_812 : 690;
    if (nic.ib) { nic.ib.SymbolErrorCounter += e + r; nic.ib.PortRcvErrors += Math.round(e / 6); nic.ib.LinkErrorRecoveryCounter += 1; }
    if (port.ib) { port.ib.SymbolErrorCounter += e - 37; port.ib.PortRcvErrors += Math.round(e / 7); port.ib.LinkErrorRecoveryCounter += 1; }
  }
}

/** Cross-rail rings: the leaf uplinks and spines carry the inter-node traffic, flow by flow, and congest where flows pile up. */
function accrueSpines(s: FabricState, plan: EcmpPlan) {
  const ib = s.mode === 'ib';
  const add = (p: Port, dir: 'tx' | 'rx', pkts: number) => {
    p.counters[`${dir}_packets`] += pkts;
    if (p.ib) {
      p.ib[dir === 'tx' ? 'PortXmitData' : 'PortRcvData'] += Math.round((pkts * 4154) / 4);
      p.ib[dir === 'tx' ? 'PortXmitPkts' : 'PortRcvPkts'] += pkts;
    }
  };
  for (const f of plan.flows) {
    const r = LEAVES.indexOf(f.srcLeaf);
    const pkts = Math.round((10_400_000 + r * 222) / f.qps);
    const up = s.switches[f.srcLeaf].ports[f.up];
    const spineIn = up.peer.kind === 'switch' ? s.switches[up.peer.sw].ports[up.peer.port] : null;
    const spineOut = s.switches[f.spine].ports[f.spinePort];
    const down = spineOut.peer.kind === 'switch' ? s.switches[spineOut.peer.sw].ports[spineOut.peer.port] : null;
    add(up, 'tx', pkts);
    if (spineIn) add(spineIn, 'rx', pkts);
    add(spineOut, 'tx', pkts);
    if (down) add(down, 'rx', pkts);
  }
  // Egress queues mark (RoCE) or wait for credits (IB) in proportion to how far their load exceeds the fair share.
  for (const [key, flows] of Object.entries(plan.load)) {
    const [sw, port] = key.split(':');
    const p = s.switches[sw].ports[port];
    const x = flows / plan.fair[key];
    const leaf = LEAVES.includes(sw);
    const r = leaf ? LEAVES.indexOf(sw) : Number(port.slice(3)) - 1;
    if (ib) {
      if (p.ib) p.ib.PortXmitWait += Math.round((19_400_000 + r * 3_331) * x * x);
      continue;
    }
    p.counters.ecn_marked += Math.round((leaf ? 286_000 + r * 1_171 : 151_000 + r * 733) * x ** 3);
    // The receiving side pauses the sender of a hot link now and then (PFC still backs up ECN).
    const q = p.peer.kind === 'switch' ? s.switches[p.peer.sw].ports[p.peer.port] : null;
    const pause = Math.round((3_100 + r) * x * x);
    p.counters.rx_pfc_pause += pause;
    if (q) q.counters.tx_pfc_pause += pause;
  }
}

// ---------------------------------------------------------------- checks used by lab grading

export type CheckFn = (s: FabricState, args: Record<string, unknown>) => boolean;
const num = (v: unknown) => Number(v);
export const CHECKS: Record<string, CheckFn> = {
  allreduce_min_busbw: (s, a) => {
    const r = evaluateAllReduce(s);
    return r.ok && r.transport === 'IB' && r.busbw >= num(a.value);
  },
  ib_write_bw_min: (s, a) => {
    const p = evaluatePair(s, String(a.node), num(a.rail), String(a.peer), num(a.peer_rail ?? a.rail));
    return p.ok && p.gbps >= num(a.value);
  },
  port_mtu_min: (s, a) => s.switches[String(a.switch)].ports[String(a.port)].mtu >= num(a.value),
  port_up: (s, a) => {
    const p = s.switches[String(a.switch)].ports[String(a.port)];
    return p.admin && p.cable === 'ok';
  },
  link_clean: (s, a) => s.switches[String(a.switch)].ports[String(a.port)].ber <= 1e-12,
  host_mtu: (s, a) => nodesFrom(a).every((n) => s.hosts[n].nics[num(a.rail)].mtu === num(a.value)),
  host_pfc_only: (s, a) => nodesFrom(a).every((n) => s.hosts[n].nics[num(a.rail)].pfc.every((on, p) => on === (p === num(a.prio)))),
  host_trust: (s, a) => nodesFrom(a).every((n) => s.hosts[n].nics[num(a.rail)].trust === a.trust),
  nic_up: (s, a) => nodesFrom(a).every((n) => s.hosts[n].nics[num(a.rail)].admin),
  pcie_ok: (s, a) => nodesFrom(a).every((n) => s.hosts[n].nics[num(a.rail)].pcieWidth === 16 && s.hosts[n].nics[num(a.rail)].pcieSpeed === 32),
  switch_roce: (s, a) => s.switches[String(a.switch)].cfg.roce === a.mode,
  no_pending: (s, a) => s.switches[String(a.switch)].pending === null,
  nccl_conf: (s, a) => nodesFrom(a).every((n) => parseConf(s.hosts[n].files['/etc/nccl.conf'] ?? '')[String(a.key)] === String(a.value)),
  nccl_hca_all: (s, a) => nodesFrom(a).every((n) => {
    const spec = parseConf(s.hosts[n].files['/etc/nccl.conf'] ?? '').NCCL_IB_HCA;
    return Array.from({ length: RAILS }, (_, r) => `mlx5_${r}`).every((d) => hcaSelected(spec, d));
  }),
  nccl_conf_absent: (s, a) => nodesFrom(a).every((n) => !(String(a.key) in parseConf(s.hosts[n].files['/etc/nccl.conf'] ?? ''))),
  nccl_conf_not: (s, a) => nodesFrom(a).every((n) => parseConf(s.hosts[n].files['/etc/nccl.conf'] ?? '')[String(a.key)] !== String(a.value)),
  switch_ecn_on: (s, a) => !(s.switches[String(a.switch)].cfg.ecnOff ?? []).includes(num(a.tc ?? ROCE_PRIO)),
  pfcwd_on: (s, a) => s.switches[String(a.switch)].ports[String(a.port)].pfcwd !== false,
  nic_not_stalled: (s, a) => nodesFrom(a).every((n) => !s.hosts[n].nics[num(a.rail)].stalled),
  sm_running: (s) => smList(s).some((x) => x.running),
  sm_enabled: (s, a) => {
    const l = smList(s).filter((x) => a.node === undefined || x.node === String(a.node));
    return l.length > 0 && l.every((x) => x.enabled);
  },
  sm_count: (s, a) => smList(s).filter((x) => x.running).length >= num(a.value ?? 2),
  sm_master: (s, a) => masterSm(s)?.node === String(a.node),
  ib_switch_reachable: (s, a) => smSweep(s).has(String(a.switch)),
  nccl_conf_min: (s, a) => nodesFrom(a).every((n) => Number(parseConf(s.hosts[n].files['/etc/nccl.conf'] ?? '')[String(a.key)] ?? a.default ?? NaN) >= num(a.value)),
  ecmp_balanced: (s, a) => (evaluateAllReduce(s).ecmp?.efficiency ?? 1) >= num(a.value),
  ib_ports_active: (s, a) => {
    const act = ibActive(s);
    const rails = a.rail === undefined ? Array.from({ length: RAILS }, (_, r) => r) : [num(a.rail)];
    return s.mode === 'ib' && nodesFrom(a).every((n) => rails.every((r) => act.has(`${n}:${r}`)));
  },
  link_width: (s, a) => (s.switches[String(a.switch)].ports[String(a.port)].lanes ?? 4) >= num(a.value ?? 4),
};
function nodesFrom(a: Record<string, unknown>): string[] {
  return a.node === undefined || a.node === 'all' ? [...NODES] : [String(a.node)];
}

export function cloneState(s: FabricState): FabricState {
  return structuredClone(s);
}
