import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

/* ---------- NCCL list-matching syntax (NCCL_SOCKET_IFNAME, NCCL_IB_HCA) ---------- */

export interface Spec { exclude: boolean; exact: boolean; items: { name: string; port?: number }[] }
/** A leading '^' excludes, then a leading '=' makes the whole list exact-match; otherwise each entry is a prefix. "dev:port" pins a port (IB_HCA). */
export function parseSpec(raw: string): Spec {
  let s = raw.trim(), exclude = false, exact = false;
  if (s.startsWith('^')) { exclude = true; s = s.slice(1); }
  if (s.startsWith('=')) { exact = true; s = s.slice(1); }
  const items = s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [name, port] = x.split(':');
    return { name, port: port !== undefined && port !== '' ? Number(port) : undefined };
  });
  return { exclude, exact, items };
}
export function matches(spec: Spec, name: string, port?: number): { selected: boolean; by?: string } {
  if (!spec.items.length) return { selected: true };
  const hit = spec.items.find((it) => (spec.exact ? name === it.name : name.startsWith(it.name)) && (it.port === undefined || port === undefined || it.port === port));
  const by = hit ? `${spec.exact ? '=' : 'prefix '}${hit.name}${hit.port !== undefined ? `:${hit.port}` : ''}` : undefined;
  return { selected: spec.exclude ? !hit : !!hit, by };
}
/** Verbs local ACK timeout per attempt: 4.096 µs × 2^value (IB spec; NCCL_IB_TIMEOUT sets the exponent). */
export const ibTimeoutUs = (v: number) => 4.096 * 2 ** v;

/* ---------- the variables (from the NCCL environment-variable documentation) ---------- */

type Cat = 'iface' | 'ib' | 'topo' | 'algo' | 'debug' | 'timeout';
const CATS: { id: Cat; label: string }[] = [
  { id: 'iface', label: 'Interface selection' }, { id: 'ib', label: 'IB / RoCE' }, { id: 'topo', label: 'Topology / GDR / P2P' },
  { id: 'algo', label: 'Algorithms / protocols' }, { id: 'debug', label: 'Debugging' }, { id: 'timeout', label: 'Timeouts' },
];
interface Var { name: string; cat: Cat; what: string; def: string; typical: string; wrong: string; detail: string; diag?: boolean; deprecated?: string }

export const VARS: Var[] = [
  { name: 'NCCL_SOCKET_IFNAME', cat: 'iface', what: 'IP interfaces for bootstrap and the socket transport', def: 'auto (favours ib*; avoids lo and docker*)', typical: '=bond0 or ^docker,lo', wrong: 'Init hangs or bootstrap connect errors; log shows "Bootstrap : Using docker0"', detail: 'Comma list of prefixes; a leading ^ excludes, a leading = makes the list exact. Must name an interface that every node can reach on the same network. Try the matcher below.' },
  { name: 'NCCL_SOCKET_FAMILY', cat: 'iface', what: 'Force IPv4 or IPv6 for socket communication', def: 'unset (either)', typical: 'AF_INET', wrong: 'Bootstrap uses an address family that is not routed between nodes', detail: 'Values AF_INET or AF_INET6. Rarely needed; useful on dual-stack hosts where only one family is reachable.' },
  { name: 'NCCL_IB_HCA', cat: 'iface', what: 'Which RDMA devices / ports the IB verbs transport may use', def: 'unset (NCCL chooses among usable devices)', typical: '=mlx5_0,…,mlx5_7 (compute NICs only)', wrong: 'Storage or front-end NICs carry NCCL traffic; mlx5_1 also matches mlx5_10', detail: 'Same prefix / = / ^ syntax as NCCL_SOCKET_IFNAME, plus device:port. With 10+ devices, prefer exact matching. Check the "NET/IB : Using [0]mlx5_0:1/RoCE …" INFO line.' },
  { name: 'NCCL_NET_PLUGIN', cat: 'iface', what: 'Select a network plugin library', def: 'unset (tries libnccl-net.so)', typical: 'site/cloud specific, or none', wrong: 'Wrong or missing plugin: falls back to built-in IB or sockets', detail: 'Cloud fabrics often ship their own plugin. The INFO line "Using network …" shows which transport won.' },
  { name: 'NCCL_IB_DISABLE', cat: 'ib', what: 'Disable the IB/RoCE verbs transport', def: 'unset (transport enabled)', typical: 'unset (1 only to test)', wrong: '"Using network Socket": bandwidth a fraction of line rate', detail: 'Diagnostic only. If a hang disappears with sockets, the RDMA path is implicated. Never ship it in an image.', diag: true },
  { name: 'NCCL_IB_GID_INDEX', cat: 'ib', what: 'RoCE GID table index NCCL uses', def: 'AUTO since 2.32u1 (-1 is the legacy alias)', typical: 'the RoCEv2 IPv4 entry, often 3 (verify with show_gids)', wrong: 'Connections fail, or traffic goes out RoCEv1 or from the wrong IP', detail: 'The index is per system: extra IPs, IPv6 or VLAN interfaces shift the table. When it is not set, NCCL (since 2.21) selects a GID dynamically using NCCL_IB_ROCE_VERSION_NUM, NCCL_IB_ADDR_FAMILY and NCCL_IB_ADDR_RANGE.' },
  { name: 'NCCL_IB_ROCE_VERSION_NUM', cat: 'ib', what: 'RoCE version used for dynamic GID selection', def: '2', typical: 'default', wrong: 'Dynamic selection picks a GID of the wrong RoCE version', detail: 'Only matters when NCCL_IB_GID_INDEX is not set explicitly.' },
  { name: 'NCCL_IB_ADDR_FAMILY', cat: 'ib', what: 'IP family for dynamic GID selection', def: 'AF_INET', typical: 'default, AF_INET6 on IPv6 back-ends', wrong: 'GID chosen for the wrong family; peers unreachable', detail: 'Used with dynamic GID selection.' },
  { name: 'NCCL_IB_ADDR_RANGE', cat: 'ib', what: 'Restrict dynamic GID selection to a CIDR range', def: 'unset (ignored)', typical: 'the back-end subnet, e.g. 10.100.0.0/16', wrong: 'GID from a management or storage IP selected', detail: 'Accepts IPv4 or IPv6 CIDR ranges.' },
  { name: 'NCCL_IB_TC', cat: 'ib', what: 'Traffic class byte (IP DS field) for RoCE data packets', def: 'AUTO since 2.32u1 (TC 0 unless the communicator sets one); 0 before', typical: 'DSCP × 4 + ECN, e.g. 104 or 106 (ECT(0)) for DSCP 26', wrong: 'NCCL lands in the default queue: no PFC/ECN, drops or pauses on the wrong priority', detail: 'The low two bits are ECN, so the value is DSCP << 2 plus the ECN bits. Setting the DSCP number itself (26) is the classic mistake. Verify on the wire or with per-queue switch counters.' },
  { name: 'NCCL_IB_FIFO_TC', cat: 'ib', what: 'Traffic class for NCCL control messages', def: 'AUTO since 2.32u1 (follows NCCL_IB_TC)', typical: 'per site QoS design', wrong: 'Control messages queued behind bulk data', detail: 'Since 2.22.3. Control messages are short RDMA writes that return credits; by default they use the same traffic class as NCCL_IB_TC. Leave at default unless your QoS design gives control traffic its own high-priority class.' },
  { name: 'NCCL_IB_SL', cat: 'ib', what: 'InfiniBand service level', def: 'AUTO since 2.32u1 (SL 0 unless the communicator sets a TC); 0 before', typical: 'the SL your SM QoS policy maps to the compute VL', wrong: 'NCCL shares a VL with storage; SL not mapped by the SM', detail: 'The SL-to-VL map is configured by the subnet manager; both must agree.' },
  { name: 'NCCL_IB_QPS_PER_CONNECTION', cat: 'ib', what: 'Queue pairs per connection', def: '1', typical: '2-4 on RoCE ECMP fabrics (measure)', wrong: 'ECMP collisions: high run-to-run variance in busbw', detail: 'More QPs give more distinct 5-tuples (UDP source ports) for ECMP hashing. Range 1-128. See also NCCL_IB_SPLIT_DATA_ON_QPS.' },
  { name: 'NCCL_IB_SPLIT_DATA_ON_QPS', cat: 'ib', what: 'How messages are spread over multiple QPs', def: '0 (round-robin per message) since 2.20; 1 in 2.18-2.19', typical: 'default', wrong: 'Little effect from extra QPs on large messages', detail: '1 splits each message evenly across the QPs (can add latency with many QPs). In round-robin mode, operations that send few messages do not use every QP.' },
  { name: 'NCCL_IB_ADAPTIVE_ROUTING', cat: 'ib', what: 'Use adaptive-routing-capable transfers', def: 'enabled on IB, disabled on RoCE', typical: 'default; enable on RoCE only when the fabric supports AR', wrong: 'AR-capable fabric not exploited, or AR on a fabric that is not configured for it', detail: '1 forces on, 0 disables. Follow your switch and NIC vendor guidance for RoCE.' },
  { name: 'NCCL_IB_PCI_RELAXED_ORDERING', cat: 'ib', what: 'PCIe Relaxed Ordering for IB verbs', def: '2 (auto)', typical: 'default', wrong: 'With 0: lower bandwidth, notably in VMs; with 1: init fails where RO is unsupported', detail: '2 = use if available, 1 = force (fail otherwise), 0 = disable.' },
  { name: 'NCCL_IB_TIMEOUT', cat: 'timeout', what: 'Exponent of the verbs local ACK timeout', def: '20 since 2.23 (18 from 2.14, 14 before)', typical: 'default; raise only with evidence', wrong: 'Too low: retry-exceeded (status 12) under real congestion; too high: long stalls before failing', detail: 'Timeout per attempt = 4.096 µs × 2^value: 20 ≈ 4.3 s. Range 0-31 (0 or ≥ 32 means infinite). Fix flaps, black holes or PFC problems before raising it.' },
  { name: 'NCCL_IB_RETRY_CNT', cat: 'timeout', what: 'Verbs transport retry count', def: '7', typical: 'default (7 is the maximum)', wrong: 'Lower values: transient loss becomes a fatal error', detail: 'Range 0-7. NCCL documents the total wait as ≈ timeout × retry count: with 20 and 7, 7 × 4.3 s ≈ 30 s before the error. Counting the first attempt adds one more timeout.' },
  { name: 'NCCL_NET_GDR_LEVEL', cat: 'topo', what: 'Max GPU-NIC distance at which GPUDirect RDMA is used', def: 'auto', typical: 'unset; PXB/PHB/SYS only to test', wrong: 'NET hops show "NET/IB/x" without "/GDRDMA": data staged through host memory', detail: 'Values LOC, PIX, PXB, PHB, SYS (formerly NCCL_IB_GDR_LEVEL). Compare with the nvidia-smi topo -m distance of each GPU-NIC pair.' },
  { name: 'NCCL_NET_GDR_READ', cat: 'topo', what: 'Send directly from GPU memory (GDR read) instead of staging', def: '1 on NVLink-based platforms, 0 otherwise (since 2.4.2)', typical: 'default', wrong: 'Send-side bandwidth lower on PCIe-only platforms', detail: '0 or 1.' },
  { name: 'NCCL_DMABUF_ENABLE', cat: 'topo', what: 'GPUDirect RDMA registration through Linux DMA-BUF', def: '1', typical: 'default', wrong: 'No GDR when DMA-BUF is disabled and no peer-memory module is loaded', detail: 'Requires kernel and driver support. The INFO line (GDRDMA on NET hops) is the definitive check.' },
  { name: 'NCCL_P2P_LEVEL', cat: 'topo', what: 'Max GPU-GPU distance for the P2P transport', def: 'auto', typical: 'unset', wrong: 'Intra-node traffic via SHM instead of P2P; or P2P over a slow path', detail: 'Values LOC, NVL, PIX, PXB, PHB, SYS.' },
  { name: 'NCCL_P2P_DISABLE', cat: 'topo', what: 'Disable P2P (NVLink / PCIe peer) transport', def: 'unset (enabled)', typical: 'unset (1 only to test)', wrong: 'Single-node busbw collapses; hops show SHM', detail: 'Diagnostic: if a single-node problem disappears, suspect the peer path (ACS, IOMMU, NVLink).', diag: true },
  { name: 'NCCL_SHM_DISABLE', cat: 'topo', what: 'Disable the shared-memory transport', def: 'unset (enabled)', typical: 'unset', wrong: 'Falls back to the network for intra-node peers', detail: 'Diagnostic. Container /dev/shm size problems are fixed with --shm-size or --ipc=host, not this.', diag: true },
  { name: 'NCCL_CROSS_NIC', cat: 'topo', what: 'Whether rings/trees may use different NICs on different nodes', def: '2 (prefer same NIC, allow crossing)', typical: '0 in rail-optimized fabrics', wrong: 'Rail-crossing traffic hits the spines', detail: '0 = same NIC index on both sides, 1 = allow different, 2 = default compromise.' },
  { name: 'NCCL_PXN_DISABLE', cat: 'topo', what: 'Disable PXN (send via NVLink to a GPU on the right NIC)', def: '0', typical: 'unset', wrong: 'With PXN off, more cross-rail traffic in the network', detail: 'PXN moves data over NVLink to a GPU whose NIC is on the destination rail, keeping traffic rail-local.' },
  { name: 'NCCL_TOPO_FILE', cat: 'topo', what: 'Load an XML topology before detection', def: '/var/run/nvidia-topologyd/virtualTopology.xml if present', typical: 'vendor/cloud file for VMs', wrong: 'VM hides the PCIe tree: poor GPU-NIC pairing, no GDR', detail: 'Single-host topology description. Use files published by the platform vendor.' },
  { name: 'NCCL_TOPO_DUMP_FILE', cat: 'topo', what: 'Write the detected topology as XML', def: 'unset', typical: 'a path such as /tmp/nccl_topo.xml when debugging', wrong: '—', detail: 'Compare dumps of a good and a bad node.' },
  { name: 'NCCL_ALGO', cat: 'algo', what: 'Restrict algorithms', def: 'unset (tuned per size)', typical: 'unset; Ring or Tree only to test', wrong: 'A leftover override costs bandwidth or latency for months', detail: 'Comma list (e.g. Ring, Tree, CollnetDirect, CollnetChain, NVLS, NVLSTree, PAT); ^ excludes. Names supported depend on version.', diag: true },
  { name: 'NCCL_PROTO', cat: 'algo', what: 'Restrict protocols', def: 'LL,LL128,Simple where LL128 is supported', typical: 'unset; Simple only to test', wrong: 'Small-message latency or large-message bandwidth regresses', detail: 'NVIDIA discourages changing it except to work around a bug.', diag: true },
  { name: 'NCCL_MIN_CTAS', cat: 'algo', what: 'Minimum CTAs (channels) per collective', def: 'undefined (auto)', typical: 'unset', wrong: 'Too many SMs taken from compute, or too few for bandwidth', detail: 'Up to 64 (32 before 2.25). Replaces NCCL_MIN_NCHANNELS.' },
  { name: 'NCCL_MAX_CTAS', cat: 'algo', what: 'Maximum CTAs (channels) per collective', def: 'undefined (auto)', typical: 'unset', wrong: 'Bandwidth capped below the NICs', detail: 'Up to 64 (32 before 2.25). Replaces NCCL_MAX_NCHANNELS.' },
  { name: 'NCCL_MIN_NCHANNELS', cat: 'algo', what: 'Minimum channels (old name)', def: 'platform dependent', typical: 'migrate to NCCL_MIN_CTAS', wrong: 'Same as MIN_CTAS', detail: 'Deprecated in 2.17.', deprecated: 'NCCL_MIN_CTAS' },
  { name: 'NCCL_MAX_NCHANNELS', cat: 'algo', what: 'Maximum channels (old name)', def: 'auto', typical: 'migrate to NCCL_MAX_CTAS', wrong: 'Same as MAX_CTAS', detail: 'Deprecated in 2.17.', deprecated: 'NCCL_MAX_CTAS' },
  { name: 'NCCL_NVLS_ENABLE', cat: 'algo', what: 'NVLink SHARP (in-switch reduction) on NVSwitch systems', def: '2 (use if supported)', typical: 'default', wrong: 'Disabled: lower all-reduce busbw on NVLS-capable nodes', detail: '0 off (no NVLS resources allocated). 1 and 2 (default) behave the same since 2.29: init does not fail where NVLS is unsupported, but fails if NVLS resources cannot be allocated (2.27-2.28 tried a silent fallback).' },
  { name: 'NCCL_COLLNET_ENABLE', cat: 'algo', what: 'Enable CollNet (e.g. SHARP in-network reduction plugin)', def: '0', typical: '1 on SHARP-enabled IB fabrics', wrong: 'SHARP never used though deployed', detail: 'Requires the CollNet plugin and fabric support.' },
  { name: 'NCCL_DEBUG', cat: 'debug', what: 'Log level', def: 'unset (no debug output)', typical: 'WARN in production, INFO to investigate', wrong: 'INFO everywhere at scale: gigabytes of logs', detail: 'Levels VERSION, WARN, INFO and TRACE; 2.32 adds ATTN (older releases do not recognise it and log nothing, so prefer NCCL_DEBUG=WARN plus NCCL_DEBUG_LEVELS=ATTN). TRACE output needs an NCCL build with tracing enabled.' },
  { name: 'NCCL_DEBUG_SUBSYS', cat: 'debug', what: 'Filter INFO output by subsystem', def: 'INIT,BOOTSTRAP,ENV', typical: 'INIT,NET,ENV', wrong: 'Missing the lines you need, or drowning in COLL', detail: 'e.g. INIT, NET, GRAPH, ENV, TUNING, COLL, P2P, SHM, BOOTSTRAP, ALL; a leading ^ excludes.' },
  { name: 'NCCL_DEBUG_FILE', cat: 'debug', what: 'Write logs to a file per process', def: 'stdout', typical: '/scratch/nccl.%h.%p.log', wrong: 'Interleaved stdout from hundreds of ranks', detail: '%h = hostname, %p = PID.' },
];

export const SYMPTOMS: { s: string; vars: string[]; note: string }[] = [
  { s: '"Using network Socket" / bandwidth a fraction of line rate', vars: ['NCCL_IB_DISABLE', 'NCCL_IB_HCA', 'NCCL_NET_PLUGIN'], note: 'Also check RDMA devices are visible in the container (/dev/infiniband).' },
  { s: 'Init hangs, bootstrap connection errors', vars: ['NCCL_SOCKET_IFNAME', 'NCCL_SOCKET_FAMILY'], note: 'Firewall and DNS are common non-NCCL causes.' },
  { s: 'Storage or front-end NICs carry NCCL traffic', vars: ['NCCL_IB_HCA'], note: 'Prefix match: mlx5_1 also selects mlx5_10, mlx5_11.' },
  { s: 'RoCE connections fail, or traffic is RoCEv1 / wrong IP', vars: ['NCCL_IB_GID_INDEX', 'NCCL_IB_ROCE_VERSION_NUM', 'NCCL_IB_ADDR_FAMILY', 'NCCL_IB_ADDR_RANGE'], note: 'Read the GID table on the target host (show_gids).' },
  { s: 'NCCL traffic in the wrong switch queue / PFC on the wrong priority', vars: ['NCCL_IB_TC', 'NCCL_IB_FIFO_TC', 'NCCL_IB_SL'], note: 'TC = DSCP × 4. Also NIC trust mode and switch DSCP maps.' },
  { s: 'Transport retry exceeded (status 12), long stalls', vars: ['NCCL_IB_TIMEOUT', 'NCCL_IB_RETRY_CNT'], note: 'Find the flapping link, black hole or PFC deadlock first.' },
  { s: 'No GDRDMA on NET hops', vars: ['NCCL_NET_GDR_LEVEL', 'NCCL_DMABUF_ENABLE', 'NCCL_NET_GDR_READ', 'NCCL_TOPO_FILE'], note: 'Also: peer-memory module, driver, ACS/IOMMU.' },
  { s: 'Single-node busbw low, hops via SHM', vars: ['NCCL_P2P_DISABLE', 'NCCL_P2P_LEVEL', 'NCCL_SHM_DISABLE'], note: 'Check nvidia-smi topo -m and ACS.' },
  { s: 'Rail-optimized fabric: traffic crossing the spines', vars: ['NCCL_CROSS_NIC', 'NCCL_PXN_DISABLE'], note: 'Also verify cabling matches rails (LLDP).' },
  { s: 'High run-to-run variance on a RoCE ECMP fabric', vars: ['NCCL_IB_QPS_PER_CONNECTION', 'NCCL_IB_SPLIT_DATA_ON_QPS', 'NCCL_IB_ADAPTIVE_ROUTING'], note: 'ECMP collisions of few large flows.' },
  { s: 'Slower than baseline after an image or job-template change', vars: ['NCCL_ALGO', 'NCCL_PROTO', 'NCCL_MAX_CTAS', 'NCCL_MIN_CTAS', 'NCCL_MAX_NCHANNELS', 'NCCL_NVLS_ENABLE', 'NCCL_COLLNET_ENABLE'], note: 'Leftover overrides: diff NCCL_DEBUG_SUBSYS=ENV output with the baseline.' },
  { s: 'Wrong GPU-NIC pairing inside a VM', vars: ['NCCL_TOPO_FILE', 'NCCL_TOPO_DUMP_FILE'], note: 'Compare dumps from a good and a bad node.' },
  { s: 'Logs unreadable or missing the key lines', vars: ['NCCL_DEBUG', 'NCCL_DEBUG_SUBSYS', 'NCCL_DEBUG_FILE'], note: 'One file per rank, targeted subsystems.' },
];

const HCAS: { name: string; role: string }[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ name: `mlx5_${i}`, role: `compute, rail ${i}` })),
  { name: 'mlx5_8', role: 'front-end / in-band' }, { name: 'mlx5_9', role: 'front-end / in-band' },
  { name: 'mlx5_10', role: 'storage' }, { name: 'mlx5_11', role: 'storage' },
];
const IFACES: { name: string; role: string }[] = [
  { name: 'lo', role: 'loopback' }, { name: 'docker0', role: 'container bridge' }, { name: 'virbr0', role: 'libvirt bridge' },
  { name: 'eno1', role: 'BMC-adjacent mgmt' }, { name: 'bond0', role: 'cluster management bond' }, { name: 'ib0', role: 'IPoIB' },
];
const PRESETS = { hca: ['mlx5_1', '=mlx5_1', '^mlx5_1', '=mlx5_0,mlx5_1,mlx5_2,mlx5_3,mlx5_4,mlx5_5,mlx5_6,mlx5_7', '^=mlx5_10,mlx5_11', 'mlx5_0:1,mlx5_1:1'], ifn: ['eth', 'bond', '=bond0', '^docker,lo,virbr', 'ib'] };

function Matcher() {
  const [which, setWhich] = useState<'hca' | 'ifn'>('hca');
  const [spec, setSpec] = useState('mlx5_1');
  const devs = which === 'hca' ? HCAS : IFACES;
  const p = parseSpec(spec);
  const res = devs.map((d) => ({ ...d, ...matches(p, d.name, which === 'hca' ? 1 : undefined) }));
  const varName = which === 'hca' ? 'NCCL_IB_HCA' : 'NCCL_SOCKET_IFNAME';
  return (
    <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Matcher</span>
        {(['hca', 'ifn'] as const).map((w) => <button key={w} type="button" aria-pressed={which === w} onClick={() => { setWhich(w); setSpec(PRESETS[w][0]); }}
          className={`rounded-md border px-2 py-1 font-mono text-xs ${which === w ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel'}`}>{w === 'hca' ? 'NCCL_IB_HCA' : 'NCCL_SOCKET_IFNAME'}</button>)}
      </div>
      <label className="flex flex-wrap items-center gap-2 font-mono text-sm"><span>{varName}=</span>
        <input value={spec} onChange={(e) => setSpec(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" aria-label={`${varName} value`} />
      </label>
      <div className="flex flex-wrap gap-1">{PRESETS[which].map((x) => <button key={x} type="button" onClick={() => setSpec(x)} className="rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] hover:bg-panel-2">{x.length > 26 ? `${x.slice(0, 24)}…` : x}</button>)}</div>
      <div className="text-xs text-muted">Parsed: {p.items.length ? <>{p.exclude ? 'exclude' : 'include'} {p.exact ? 'exact names' : 'name prefixes'} [{p.items.map((i) => i.name + (i.port !== undefined ? `:${i.port}` : '')).join(', ')}]</> : 'empty: NCCL\'s automatic selection applies'}</div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
        {res.map((d) => (
          <div key={d.name} className={`rounded-md border px-2 py-1 text-xs ${d.selected ? 'border-accent bg-accent-soft' : 'border-line bg-panel opacity-70'}`}>
            <div className={`font-mono font-semibold ${d.selected ? 'text-accent' : 'text-muted line-through'}`}>{d.name}{which === 'hca' ? ':1' : ''}</div>
            <div className={`text-[11px] ${d.selected && /storage|front|docker|lo|virbr/.test(d.role) ? 'text-danger' : 'text-muted'}`}>{d.role}{d.by ? ` · ${d.by}` : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function NcclEnvExplorer() {
  const [q, setQ] = useState('');
  const [cats, setCats] = useState<Cat[]>([]);
  const [mode, setMode] = useState<'table' | 'symptom'>('table');
  const [sel, setSel] = useState<string | null>('NCCL_IB_HCA');
  const [sym, setSym] = useState(0);
  const [tmo, setTmo] = useState(20);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return VARS.filter((v) => (!cats.length || cats.includes(v.cat)) && (!t || [v.name, v.what, v.wrong, v.typical, v.detail].some((x) => x.toLowerCase().includes(t))));
  }, [q, cats]);
  const v = VARS.find((x) => x.name === sel);
  const fmtT = (us: number) => (us < 1e3 ? `${us.toFixed(1)} µs` : us < 1e6 ? `${(us / 1e3).toFixed(1)} ms` : `${(us / 1e6).toFixed(2)} s`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {(['table', 'symptom'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
          className={`rounded-md border px-3 py-1 text-sm ${mode === m ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{m === 'table' ? 'Variables' : 'Symptom → suspect variables'}</button>)}
      </div>

      {mode === 'table' ? <>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-[200px] flex-1 items-center gap-2 text-sm"><span className="sr-only">Search variables</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, purpose or symptom…" className="w-full rounded-md border border-line bg-panel px-2 py-1.5 text-sm" />
          </label>
          <Pill>{rows.length} / {VARS.length}</Pill>
        </div>
        <div className="flex flex-wrap gap-1">
          {CATS.map((c) => { const a = cats.includes(c.id); return <button key={c.id} type="button" aria-pressed={a} onClick={() => setCats(a ? cats.filter((x) => x !== c.id) : [...cats, c.id])}
            className={`rounded-md border px-2 py-1 font-mono text-xs ${a ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{c.label}</button>; })}
        </div>
        <div className="max-h-[420px] overflow-auto rounded-lg border border-line">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="sticky top-0 bg-panel-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              <tr><th className="px-2 py-1.5">Variable</th><th className="px-2 py-1.5">What it does</th><th className="px-2 py-1.5">Default</th><th className="px-2 py-1.5">Typical</th><th className="px-2 py-1.5">Symptom when wrong</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={`border-t border-line align-top ${sel === r.name ? 'bg-accent-soft' : ''}`}>
                  <td className="px-2 py-1.5"><button type="button" onClick={() => setSel(r.name)} aria-pressed={sel === r.name} className="text-left font-mono text-accent hover:underline">{r.name}</button>
                    {r.diag && <div className="text-[10px] text-warn">test only</div>}{r.deprecated && <div className="text-[10px] text-warn">deprecated</div>}</td>
                  <td className="px-2 py-1.5">{r.what}</td><td className="px-2 py-1.5 font-mono text-muted">{r.def}</td><td className="px-2 py-1.5 font-mono">{r.typical}</td><td className="px-2 py-1.5 text-muted">{r.wrong}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {v && (
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-semibold text-accent">{v.name}</span><Pill>{CATS.find((c) => c.id === v.cat)!.label}</Pill>{v.deprecated && <Pill className="text-warn">use {v.deprecated}</Pill>}</div>
            <p className="mt-1.5">{v.what}. {v.detail}</p>
            <div className="mt-1.5 grid gap-1 text-xs sm:grid-cols-3"><div><span className="text-muted">Default: </span><span className="font-mono">{v.def}</span></div><div><span className="text-muted">Typical: </span><span className="font-mono">{v.typical}</span></div><div><span className="text-muted">If wrong: </span>{v.wrong}</div></div>
            {v.name === 'NCCL_IB_TIMEOUT' && (
              <label className="mt-2 block text-xs"><span className="font-mono">NCCL_IB_TIMEOUT={tmo}</span> → 4.096 µs × 2^{tmo} = <span className="font-mono text-data">{fmtT(ibTimeoutUs(tmo))}</span> per attempt; × 7 retries (NCCL_IB_RETRY_CNT default) ≈ <span className="font-mono text-data">{fmtT(ibTimeoutUs(tmo) * 7)}</span> before the error
                <input type="range" min={10} max={24} value={tmo} onChange={(e) => setTmo(Number(e.target.value))} className="mt-1 w-full accent-[var(--accent)]" aria-label="NCCL_IB_TIMEOUT exponent" /></label>
            )}
          </div>
        )}
        {(sel === 'NCCL_IB_HCA' || sel === 'NCCL_SOCKET_IFNAME') && <Matcher />}
      </> : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="space-y-1">
            {SYMPTOMS.map((s, i) => <li key={s.s}><button type="button" aria-pressed={sym === i} onClick={() => setSym(i)}
              className={`w-full rounded-md border px-2 py-1.5 text-left text-sm ${sym === i ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-panel-2'}`}>{s.s}</button></li>)}
          </ul>
          <div className="space-y-2">
            {SYMPTOMS[sym].vars.map((n) => { const x = VARS.find((y) => y.name === n)!; return (
              <div key={n} className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
                <button type="button" onClick={() => { setMode('table'); setSel(n); setQ(''); setCats([]); }} className="font-mono font-semibold text-accent hover:underline">{n}</button>
                <div className="text-xs text-muted">{x.what}. Default <span className="font-mono">{x.def}</span>; typical <span className="font-mono">{x.typical}</span>.</div>
              </div>); })}
            <p className="text-xs text-muted">{SYMPTOMS[sym].note} Confirm what each rank actually saw with NCCL_DEBUG=INFO and NCCL_DEBUG_SUBSYS=ENV before changing anything.</p>
          </div>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted">
        Selected networking-relevant variables from the NCCL environment-variable documentation (docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html). Defaults and
        accepted values change between NCCL releases (for example the AUTO defaults for GID index, TC and SL are recent); check the page for the NCCL version in your container.
        "Typical" values are examples for a rail-optimized RoCE or InfiniBand back-end, not recommendations for every site. Device names in the matcher are a sample server.
      </p>
    </div>
  );
}
