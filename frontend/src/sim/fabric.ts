// Fabric Simulator: a deterministic model of a small rail-optimized RoCEv2 GPU cluster.
//
// Topology: 4 GPU nodes (node01-node04), each with 8 GPUs and 8 ConnectX-7-class NICs (one per rail).
// Rail r of every node connects to leaf0(r+1) (a rail leaf); every leaf has one uplink to each of
// two spines. The model is intentionally simple and is documented in docs/SIMULATOR.md: it reproduces
// the *symptoms* real faults produce (which counters move, which tests fail, how bandwidth drops), not
// exact numbers of any product.

export const NODES = ['node01', 'node02', 'node03', 'node04'] as const;
export const RAILS = 8;
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
}
export interface Host { name: string; nics: Nic[]; files: Record<string, string>; dmesg: string[] }
export type Peer = { kind: 'host'; node: string; rail: number } | { kind: 'switch'; sw: string; port: string };
export interface Port { name: string; peer: Peer; mtu: number; admin: boolean; cable: 'ok' | 'unplugged'; ber: number; counters: Record<string, number> }
export interface SwitchCfg { roce: RoceMode; ports: Record<string, { mtu: number; admin: boolean }> }
export interface Switch { name: string; role: 'leaf' | 'spine'; rail?: number; cfg: SwitchCfg; pending: SwitchCfg | null; ports: Record<string, Port> }
export interface FabricState { hosts: Record<string, Host>; switches: Record<string, Switch>; actions: string[] }

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
NCCL_DEBUG=WARN
`;

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
const emptyHw = () => ({
  rx_write_requests: 0, rx_read_requests: 0, out_of_sequence: 0, packet_seq_err: 0, local_ack_timeout_err: 0,
  implied_nak_seq_err: 0, duplicate_request: 0, np_ecn_marked_roce_packets: 0, np_cnp_sent: 0, rp_cnp_handled: 0, rp_cnp_ignored: 0,
});
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
        pfc: zeroPfc(), pcieWidth: 16, pcieSpeed: 32, counters: emptyNicCounters(r), hw: emptyHw(),
      })),
    };
  }
  const switches: Record<string, Switch> = {};
  const mkPort = (name: string, peer: Peer): Port => ({ name, peer, mtu: 9216, admin: true, cable: 'ok', ber: 1e-15, counters: emptyPortCounters() });
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
  return { hosts, switches, actions: [] };
}

/** The NVUE-style config mirrors the port objects; this copies ports -> cfg. */
function syncCfg(sw: Switch) {
  sw.cfg.ports = Object.fromEntries(Object.values(sw.ports).map((p) => [p.name, { mtu: p.mtu, admin: p.admin }]));
}

export function applyFaults(s: FabricState, faults: Fault[]): FabricState {
  for (const f of faults) applyFault(s, f);
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

export const FAULT_TYPES = ['switch_port_mtu', 'switch_port_admin_down', 'cable_unplugged', 'bad_cable', 'switch_roce', 'host_mtu', 'host_pfc', 'host_trust', 'nic_admin_down', 'pcie_downtrain', 'nccl_conf'];

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

/** Issues on the access link and NIC of (node, rail), independent of the far end. */
export function nicIssues(s: FabricState, node: string, rail: number): Issue[] {
  const nic = s.hosts[node].nics[rail];
  const leaf = s.switches[LEAVES[rail]];
  const port = leaf.ports[leafPortFor(node)];
  const issues: Issue[] = [];
  if (!nic.admin) issues.push({ fatal: true, factor: 0, kind: 'down', detail: `${nic.netdev} administratively down` });
  if (!port.admin) issues.push({ fatal: true, factor: 0, kind: 'down', detail: `${leaf.name} ${port.name} administratively down` });
  if (port.cable === 'unplugged') issues.push({ fatal: true, factor: 0, kind: 'down', detail: `no carrier between ${node} ${nic.netdev} and ${leaf.name} ${port.name}` });
  if (port.ber > 1e-8) issues.push({ fatal: false, factor: 0.55, kind: 'ber', detail: `high BER on ${leaf.name} ${port.name}` });
  const pcieCap = pcieGbps(nic) * 0.9;
  if (pcieCap < LINE_RATE_GBPS) issues.push({ fatal: false, factor: pcieCap / LINE_RATE_GBPS, kind: 'pcie', detail: `PCIe link x${nic.pcieWidth} ${nic.pcieSpeed}GT/s` });
  // Lossless config: switch must run RoCE lossless with PFC on prio 3; NIC must trust DSCP and enable PFC on prio 3 only.
  if (leaf.cfg.roce !== 'lossless') issues.push({ fatal: false, underLoadOnly: true, factor: 0.3, kind: 'lossy', detail: `${leaf.name} RoCE QoS ${leaf.cfg.roce}` });
  else if (nic.trust !== 'dscp') issues.push({ fatal: false, underLoadOnly: true, factor: 0.35, kind: 'trust', detail: `${nic.netdev} trusts PCP` });
  else if (!nic.pfc[ROCE_PRIO]) issues.push({ fatal: false, underLoadOnly: true, factor: 0.35, kind: 'pfc', detail: `${nic.netdev} PFC not enabled on priority ${ROCE_PRIO}` });
  return issues;
}

export interface PairResult { ok: boolean; gbps: number; error?: string; mtu: number; issues: Issue[]; path: Port[] }

/** One RC connection from (a, ra) to (b, rb), unloaded fabric (like ib_write_bw with one QP). */
export function evaluatePair(s: FabricState, a: string, ra: number, b: string, rb: number, gidIndex = 3): PairResult {
  const issues = [...nicIssues(s, a, ra), ...nicIssues(s, b, rb)];
  const na = s.hosts[a].nics[ra];
  const nb = s.hosts[b].nics[rb];
  const mtu = Math.min(roceMtu(na.mtu), roceMtu(nb.mtu));
  const path: Port[] = [s.switches[LEAVES[ra]].ports[leafPortFor(a)]];
  if (ra !== rb) {
    const up = (leaf: string) => ['swp31', 'swp32'].map((p) => s.switches[leaf].ports[p]).filter((p) => p.admin && p.cable === 'ok');
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
  if (gidIndex !== 3) return { ok: false, gbps: 0, error: 'gid', mtu, issues, path };
  const tooSmall = path.find((p) => p.mtu < mtu + ROCE_IP_OVERHEAD);
  if (tooSmall) return { ok: false, gbps: 0, error: 'mtu', mtu, issues: [...issues, { fatal: true, factor: 0, kind: 'mtu-drop', detail: `${tooSmall.name} MTU ${tooSmall.mtu}` }], path };
  let factor = 1;
  for (const i of issues) if (!i.underLoadOnly) factor = Math.min(factor, i.factor);
  if (mtu < 4096) factor *= mtu >= 2048 ? 0.93 : 0.82;
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
  const rails = Array.from({ length: RAILS }, (_, r) => r).filter((r) => confs.every((c) => hcaSelected(c.NCCL_IB_HCA, `mlx5_${r}`)));
  // No HCA matches NCCL_IB_HCA: real NCCL logs this at INFO level and silently falls back to sockets.
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
  // Traffic class: NCCL_IB_TC=106 is DSCP 26 (106 >> 2) with ECT. Anything else lands outside the lossless class.
  if (tcs.some((t) => t >> 2 !== 26)) {
    const f = 0.35;
    if (f < minFactor) { minFactor = f; limiting = { fatal: false, underLoadOnly: true, factor: f, kind: 'tc', detail: `NCCL_IB_TC=${tcs.find((t) => t >> 2 !== 26)} (DSCP ${tcs.find((t) => t >> 2 !== 26)! >> 2}) is not the lossless RoCE class` }; }
  }
  return { ...base, ok: true, rails, busbw: Math.round(PER_RAIL_BUSBW * rails.length * minFactor * 100) / 100, limiting };
}

/** Advance counters as if `kind` traffic ran. Deterministic so the same lab always tells the same story. */
export function accrueTraffic(s: FabricState, kind: 'collective' | 'pair', scope?: { nodes: string[]; rails: number[] }, ar?: CollectiveResult) {
  const nodes = scope?.nodes ?? [...NODES];
  const rails = scope?.rails ?? ar?.rails ?? [];
  const load = kind === 'collective';
  const tc = ar ? Number(ar.conf.NCCL_IB_TC ?? 0) : 106;
  const prio = tc >> 2 === 26 ? ROCE_PRIO : 0;
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
        // Healthy lossless fabric under an all-to-all-ish load: some ECN marking and CNPs, little pausing.
        const marks = 9_400 + r * 113 + nodeIndex(node) * 57;
        port.counters.ecn_marked += marks;
        nic.hw.np_ecn_marked_roce_packets += marks; nic.hw.np_cnp_sent += Math.round(marks * 0.97);
        nic.hw.rp_cnp_handled += Math.round(marks * 0.95);
        c[`rx_prio${ROCE_PRIO}_pause`] += 120 + r; c[`tx_prio${ROCE_PRIO}_pause`] += 85 + r;
        port.counters.rx_pfc_pause += 85 + r; port.counters.tx_pfc_pause += 120 + r;
      }
    }
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
};
function nodesFrom(a: Record<string, unknown>): string[] {
  return a.node === undefined || a.node === 'all' ? [...NODES] : [String(a.node)];
}

export function cloneState(s: FabricState): FabricState {
  return structuredClone(s);
}
