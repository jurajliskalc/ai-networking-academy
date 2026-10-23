// Inventory reports produced by labs/hw-toolkit/aina_hw.py ("aina.hw.report/1"), and the fabric health
// review the Connect page runs on them. Pure functions, unit-tested against a fixture.
import type { HandsOnLab } from '../types';
import { derive, type Profile, type Role } from './profile';

export interface Gid { index: number; gid: string; type: string | null; netdev: string | null }
export interface RdmaPort {
  port: number; state: string | null; phys_state: string | null; rate: string | null; rate_gbps: number | null;
  link_layer: string | null; lid: number | null; sm_lid: number | null; netdev: string | null; active_mtu: number | null;
  gids: Gid[]; counters: Record<string, number>; hw_counters: Record<string, number>;
  /** rdma_cm configfs defaults (toolkit 1.1+): null without rdma_cm configfs; configured=false means kernel defaults (ToS 0). */
  rdma_cm?: { configured: boolean; default_roce_tos: number | null; default_roce_mode: string | null } | null;
}
export interface RdmaDevice {
  name: string; node_type: string | null; fw_ver: string | null; board_id: string | null; hca_type: string | null;
  node_guid: string | null; pci: string | null; numa_node: number | null;
  pcie: { speed: number | null; width: number | null; max_speed: number | null; max_width: number | null };
  ports: RdmaPort[];
}
export interface Qos { source: string; trust: string | null; pfc_enabled: number[] | null; dscp_prio: Record<string, number> | null }
export interface Netdev {
  name: string; mtu: number | null; operstate: string | null; speed_mbps: number | null; mac?: string | null; ipv4: string[];
  /** IPoIB interface (toolkit 1.1+): Ethernet QoS fields are null for it. */
  ipoib?: boolean;
  driver?: string; driver_version?: string; firmware?: string; bus?: string;
  pause: Record<string, boolean> | null; qos: Qos | null; ecn: Record<string, number[]> | null;
  stats: Record<string, number>; lldp: { system: string | null; port: string | null } | null;
}
export interface HostFacts {
  schema: string; toolkit: string; collected: string; role: string | null; redacted?: boolean;
  host: { hostname: string | null; kernel: string | null; os: string | null; arch?: string; cpu: string | null; numa_nodes: number | null; mem_gb: number | null; cmdline_flags: string[]; governor: string | null; memlock: string | null;
    /** toolkit 1.1+: EFI Secure Boot state and the active kernel lockdown mode ('none', 'integrity', 'confidentiality'). */
    secure_boot?: boolean | null; lockdown?: string | null };
  software: { rdma_core: string | null; perftest: string | null; ofed: string | null; nvidia_driver: string | null; python?: string; tools: Record<string, boolean> };
  modules: Record<string, boolean>;
  rdma: RdmaDevice[];
  /** umad devices in kernel order (toolkit 1.1+): umad tools without -C/-P open the first. */
  umad?: { name: string; ibdev: string | null; port: number | null }[];
  netdevs: Netdev[];
  gpus: { index: number; name: string; pci: string; driver: string }[];
  gpu_topo: string | null;
  notes: string[];
}
export interface Report { schema: string; toolkit: string; generated: string; lab: string | null; fabric?: string | null; hosts: HostFacts[] }

export const REPORT_SCHEMA = 'aina.hw.report/1';
export const HOST_SCHEMA = 'aina.hw.host/1';

/** Accept a full report, or a single host's facts (collect --stdout), and normalise to a Report. */
export function parseReport(json: unknown): Report {
  if (!json || typeof json !== 'object') throw new Error('Not a JSON object');
  const o = json as Record<string, unknown>;
  if (o.schema === HOST_SCHEMA) return { schema: REPORT_SCHEMA, toolkit: String(o.toolkit ?? ''), generated: String(o.collected ?? ''), lab: null, hosts: [o as unknown as HostFacts] };
  if (o.schema !== REPORT_SCHEMA) throw new Error(`Unknown schema ${JSON.stringify(o.schema)} (expected ${REPORT_SCHEMA})`);
  if (!Array.isArray(o.hosts)) throw new Error('Report has no hosts');
  for (const h of o.hosts as HostFacts[]) {
    if (h?.schema !== HOST_SCHEMA || !h.host || !Array.isArray(h.rdma) || !Array.isArray(h.netdevs)) throw new Error('A host entry is malformed');
  }
  return o as unknown as Report;
}

export const hostLabel = (h: HostFacts) => `${h.host.hostname ?? 'unknown host'}${h.role ? ` (${h.role})` : ''}`;

/** The port a lab uses on a host: the profile's device for that role, else the first ACTIVE port, else the first. */
export function dataPort(h: HostFacts, p?: Profile): { dev: RdmaDevice; port: RdmaPort } | null {
  const want = h.role && p ? p[`${h.role}_RDMA_DEV`] : undefined;
  const portNo = Number(p?.RDMA_PORT ?? 1);
  const dev = h.rdma.find((d) => d.name === want);
  const port = dev?.ports.find((x) => x.port === portNo) ?? dev?.ports[0];
  if (dev && port) return { dev, port };
  for (const d of h.rdma) for (const x of d.ports) if (x.state === 'ACTIVE') return { dev: d, port: x };
  const d0 = h.rdma[0];
  return d0?.ports[0] ? { dev: d0, port: d0.ports[0] } : null;
}

export const isRoceV2Ipv4 = (g: Gid) => /v2/i.test(g.type ?? '') && /^0000:0000:0000:0000:0000:ffff:/i.test(g.gid);
export const gidToIpv4 = (gid: string) => {
  const m = gid.match(/ffff:([0-9a-f]{4}):([0-9a-f]{4})$/i);
  if (!m) return null;
  const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
};

export type Severity = 'error' | 'warn' | 'info';
export interface Finding { id: string; severity: Severity; title: string; detail: string; where?: string; fix?: string; lesson?: string; lab?: string }

/** An InfiniBand port without a subnet manager reports LID 65535 (0xffff), not 0. */
export const UNASSIGNED_LID = 0xffff;
const IB_INIT_DETAIL = 'The link trained (physical state LinkUp) but no subnet manager has configured the port: its LID is 65535 (0xffff, unassigned) and its SM LID 0. Verbs traffic cannot start (perftest prints "Port number 1 state is Init"), and sminfo times out.';
const IB_INIT_FIX = 'Run one subnet manager on the fabric. With NVIDIA DOCA the unit is opensmd.service (sudo systemctl start opensmd); opensm -B -g <port GUID> binds it to one port. The InfiniBand bring-up lab walks through it.';

const ERROR_COUNTERS = ['symbol_error', 'link_error_recovery', 'port_rcv_errors','local_link_integrity_errors', 'excessive_buffer_overrun_errors'];
const PHY_ERRORS = ['rx_crc_errors_phy', 'rx_symbol_err_phy'];

/** Rules mirror what a fabric engineer checks first. Counters are cumulative (since boot or last reset), so they are
 *  flagged as evidence to investigate, not as proof of a current fault. */
export function review(r: Report, p: Profile, now = new Date()): Finding[] {
  const f: Finding[] = [];
  const add = (x: Finding) => f.push(x);
  const fabric = p.FABRIC === 'ib' ? 'InfiniBand' : 'Ethernet';
  const hosts = r.hosts;
  const ports = hosts.map((h) => ({ h, dp: dataPort(h, p), nd: null as Netdev | null }));
  for (const x of ports) x.nd = x.h.netdevs.find((n) => n.name === (x.dp?.port.netdev ?? (x.h.role ? p[`${x.h.role}_NETDEV`] : ''))) ?? null;

  const age = (now.getTime() - Date.parse(r.generated)) / 86_400_000;
  if (age > 7) add({ id: 'report-stale', severity: 'info', title: 'Report is more than a week old', detail: `Generated ${r.generated.slice(0, 10)}. Collect again after changes: ./aina-hw collect-all.` });
  const want = p.HOST_COUNT === '3' ? 3 : 2;
  if (hosts.length < want) add({ id: 'hosts-missing', severity: 'warn', title: `Report covers ${hosts.length} of ${want} hosts`, detail: 'collect-all could not reach every host in lab.env, or the report came from a single host.', fix: 'Run ./aina-hw collect-all on host A with key-based SSH to the others.' });

  for (const { h, dp, nd } of ports) {
    const where = hostLabel(h);
    if (!h.rdma.length) {
      add({ id: 'no-rdma', severity: 'error', where, title: 'No RDMA devices', detail: 'Nothing under /sys/class/infiniband: the RDMA driver is not loaded, or there is no RDMA NIC.', fix: 'Check lspci for the NIC, load the provider driver (for example mlx5_ib) and ib_uverbs, and run setup-rdma-host.sh --check.', lesson: 'rdma-on-linux' });
      continue;
    }
    if (!dp) continue;
    const { dev, port } = dp;
    const pid = `${dev.name}/${port.port}`;
    if (h.role && p[`${h.role}_RDMA_DEV`] && dev.name !== p[`${h.role}_RDMA_DEV`])
      add({ id: 'profile-dev', severity: 'warn', where, title: `Profile device ${p[`${h.role}_RDMA_DEV`]} not found`, detail: `The host has ${h.rdma.map((d) => d.name).join(', ')}; the review used ${pid}.`, fix: `Set ${h.role}_RDMA_DEV on the Connect page.` });
    if (port.state !== 'ACTIVE') {
      const ib = port.link_layer === 'InfiniBand';
      const init = ib && port.state === 'INIT';
      add({ id: 'port-state', severity: 'error', where, title: `${pid} is ${port.state ?? 'unknown'}`, detail: init ? IB_INIT_DETAIL : `Physical state ${port.phys_state ?? 'unknown'}.${ib && /polling/i.test(port.phys_state ?? '') ? ' POLLING means the port keeps trying to train: no link partner yet (peer down, cable).' : ''}`, fix: init ? IB_INIT_FIX : 'Check the cable, the peer port and the link speed/FEC settings on both ends.', lesson: ib ? 'subnet-manager-routing' : 'link-layer-ber-fec', lab: ib ? 'hw-09-infiniband-bringup' : 'hw-05-link-health-optics' });
    }
    if (port.link_layer && port.link_layer !== fabric)
      add({ id: 'link-layer', severity: 'error', where, title: `${pid} runs ${port.link_layer}, profile says ${fabric}`, detail: 'VPI adapters can run either; the port type is a persistent firmware setting.', fix: 'Change FABRIC in the profile, or set the port type with mlxconfig (LINK_TYPE_P1) and reset the NIC.', lesson: 'nics-dpus-supernics' });
    // InfiniBand ports other than the lab port: INIT means no SM; an IPoIB netdev that is down.
    for (const d of h.rdma) for (const x of d.ports) {
      if (x === port || x.link_layer !== 'InfiniBand') continue;
      if (x.state === 'INIT')
        add({ id: 'ib-init', severity: p.FABRIC === 'ib' ? 'warn' : 'info', where, title: `${d.name}/${x.port} (InfiniBand) is INIT: no subnet manager`, detail: IB_INIT_DETAIL, fix: IB_INIT_FIX, lesson: 'subnet-manager-routing', lab: 'hw-09-infiniband-bringup' });
    }
    for (const n of h.netdevs) {
      const ibPort = h.rdma.flatMap((d) => d.ports).find((x) => x.netdev === n.name && x.link_layer === 'InfiniBand');
      if (n.ipoib && n.operstate === 'down' && ibPort && (p.FABRIC === 'ib' || ibPort === port))
        add({ id: 'ipoib-down', severity: 'info', where, title: `IPoIB interface ${n.name} is down`, detail: 'An IPoIB netdev stays DOWN until it is configured. Verbs traffic (perftest, NCCL over IB verbs) and the umad tools (ibstat, sminfo, perfquery) do not need it; IP over the InfiniBand fabric does, including rdma_cm address resolution (rping, ib_write_bw -R) to an IPoIB address.', fix: `sudo ip link set ${n.name} up, then give it an address (netplan), if you want IP over InfiniBand.`, lab: 'hw-09-infiniband-bringup' });
    }
    if (port.link_layer === 'InfiniBand' && port.state === 'ACTIVE' && (!port.sm_lid || !port.lid || port.lid === UNASSIGNED_LID))
      add({ id: 'ib-no-sm', severity: 'error', where, title: `${pid} has no LID or SM LID`, detail: 'No subnet manager has assigned addresses.', fix: 'Run one subnet manager on the fabric.', lesson: 'subnet-manager-routing' });
    const pc = dev.pcie;
    if (pc.speed && pc.max_speed && pc.width && pc.max_width && (pc.speed < pc.max_speed || pc.width < pc.max_width))
      add({ id: 'pcie-down', severity: 'warn', where, title: `${dev.name} PCIe link below capability`, detail: `Running ${pc.speed} GT/s x${pc.width}, capable of ${pc.max_speed} GT/s x${pc.max_width}. A downtrained slot can cap RDMA bandwidth well below line rate. The card may also sit in a slot with fewer lanes or an older generation than the card supports.`, fix: 'Check the slot (lspci -vv LnkCap vs LnkSta), riser and BIOS PCIe settings; reseat the card.', lesson: 'pcie-numa-topology', lab: 'hw-01-inventory-baseline' });
    if (dev.numa_node === -1 && (h.host.numa_nodes ?? 1) > 1)
      add({ id: 'numa-unknown', severity: 'info', where, title: `${dev.name} reports no NUMA node`, detail: 'On a multi-socket host the firmware should report which socket the slot hangs off; without it, pinning is guesswork.', lesson: 'pcie-numa-topology' });
    if (port.link_layer === 'Ethernet' && port.active_mtu && port.active_mtu < 4096)
      add({ id: 'active-mtu', severity: 'warn', where, title: `${pid} active RDMA MTU is ${port.active_mtu}`, detail: 'The RDMA path MTU follows the netdev MTU; 4096 needs a netdev MTU of roughly 4200 or more. Smaller path MTUs cost bandwidth and message rate.', fix: `Set MTU ${p.MTU} on the data interface (and 9216 on switch ports).`, lesson: 'mtu-jumbo-frames' });
    if (port.link_layer === 'Ethernet') {
      const v2 = port.gids.filter(isRoceV2Ipv4);
      if (!v2.length) add({ id: 'no-roce-gid', severity: 'error', where, title: `${pid} has no RoCE v2 IPv4 GID`, detail: 'GIDs are derived from the IP addresses on the netdev. Without an IPv4 address on the RDMA interface there is no routable RoCE v2 GID.', fix: `Configure ${h.role ? p[`${h.role}_IP`] : 'the data IP'} on ${port.netdev ?? 'the RDMA netdev'}.`, lesson: 'rdma-connection-failures', lab: 'hw-02-roce-first-traffic' });
      else if (v2.every((g) => String(g.index) !== p.GID_INDEX))
        add({ id: 'gid-index', severity: 'warn', where, title: `RoCE v2 IPv4 GID is at index ${v2.map((g) => g.index).join(', ')}, profile says ${p.GID_INDEX}`, detail: 'Tools that take an explicit GID index (perftest -x, ibv_rc_pingpong -g, NCCL_IB_GID_INDEX) would pick the wrong entry.', fix: 'Update GID_INDEX in the profile, or pass the per-host index.', lesson: 'rdma-connection-failures', lab: 'hw-02-roce-first-traffic' });
      const ip = h.role ? p[`${h.role}_IP`] : null;
      if (ip && nd && !nd.ipv4.some((a) => a.split('/')[0] === ip))
        add({ id: 'profile-ip', severity: 'warn', where, title: `${nd.name} does not have the profile IP ${ip}`, detail: `Addresses found: ${nd.ipv4.join(', ') || 'none'}.`, fix: 'Configure the data IP (netplan or nmcli snippet on the Connect page) or correct the profile.' });
    }
    if (nd) {
      // IPoIB netdevs run 2044 or 4092 by design; the profile MTU is the Ethernet data MTU
      if (p.FABRIC === 'roce' && nd.mtu && String(nd.mtu) !== p.MTU) add({ id: 'mtu-profile', severity: 'warn', where, title: `${nd.name} MTU ${nd.mtu}, profile says ${p.MTU}`, detail: 'Lab commands and checks assume the profile MTU.', lesson: 'mtu-jumbo-frames' });
      if (p.FABRIC === 'roce') {
        const q = nd.qos;
        if (!q) add({ id: 'qos-unknown', severity: 'info', where, title: `QoS of ${nd.name} not readable`, detail: 'Neither mlnx_qos nor iproute2 dcb returned data (some reads need root: collect with --sudo).', lab: 'hw-03-host-qos-pfc-ecn' });
        else {
          if (q.trust && q.trust !== 'dscp') add({ id: 'trust', severity: 'warn', where, title: `${nd.name} trusts ${q.trust.toUpperCase()}, not DSCP`, detail: 'Routed RoCEv2 fabrics classify by DSCP; with PCP trust and untagged traffic everything lands in priority 0.', fix: 'Set DSCP trust (QoS lab).', lesson: 'qos-trust-and-mapping', lab: 'hw-03-host-qos-pfc-ecn' });
          if (q.pfc_enabled && (q.pfc_enabled.length !== 1 || String(q.pfc_enabled[0]) !== p.ROCE_PRIO))
            add({ id: 'pfc', severity: q.pfc_enabled.length ? 'warn' : 'info', where, title: q.pfc_enabled.length ? `PFC on priorities ${q.pfc_enabled.join(', ')}, profile says ${p.ROCE_PRIO}` : 'PFC is off', detail: q.pfc_enabled.length ? 'PFC must be enabled on the same priority at both ends of every link.' : 'Fine for Tier 1 basics; the lossless labs enable it.', lesson: 'pfc-priority-flow-control', lab: 'hw-03-host-qos-pfc-ecn' });
          if (q.dscp_prio && q.dscp_prio[p.ROCE_DSCP] !== undefined && String(q.dscp_prio[p.ROCE_DSCP]) !== p.ROCE_PRIO)
            add({ id: 'dscp-map', severity: 'warn', where, title: `DSCP ${p.ROCE_DSCP} maps to priority ${q.dscp_prio[p.ROCE_DSCP]}`, detail: `RoCE traffic marked DSCP ${p.ROCE_DSCP} should land in lossless priority ${p.ROCE_PRIO}.`, lesson: 'qos-trust-and-mapping', lab: 'hw-03-host-qos-pfc-ecn' });
          flowControl(nd, q, p, where, add);
        }
        roceTos(dev.name, port, nd, p, where, add);
        if (nd.ecn?.roce_np && !nd.ecn.roce_np.includes(Number(p.ROCE_PRIO)))
          add({ id: 'ecn-np', severity: 'warn', where, title: `RoCE ECN (notification point) off for priority ${p.ROCE_PRIO}`, detail: 'Without ECN reaction, congestion is handled by PFC alone, which spreads pauses through the fabric.', lesson: 'ecn-and-dcqcn', lab: 'hw-03-host-qos-pfc-ecn' });
      }
      const phy = PHY_ERRORS.filter((k) => (nd.stats[k] ?? 0) > 0);
      if (phy.length) add({ id: 'phy-errors', severity: 'warn', where, title: `${nd.name} has PHY error counts`, detail: phy.map((k) => `${k}=${nd.stats[k]}`).join(', ') + ' (cumulative). Watch whether they grow under load.', lesson: 'link-layer-ber-fec', lab: 'hw-05-link-health-optics' });
      if (nd.lldp?.port && p.SWITCH_OS !== 'none' && h.role) {
        const expect = p[`${h.role}_SWITCH_PORT`];
        if (expect && nd.lldp.port !== expect)
          add({ id: 'cabling', severity: 'warn', where, title: `${nd.name} is cabled to ${nd.lldp.system ?? '?'} ${nd.lldp.port}`, detail: `The profile expects ${p.SWITCH} ${expect}.`, fix: 'Fix the cable or the profile port map.' });
      }
    }
    const errs = ERROR_COUNTERS.filter((k) => (port.counters[k] ?? 0) > 0);
    if (errs.length) add({ id: 'port-errors', severity: 'warn', where, title: `${pid} error counters are non-zero`, detail: errs.map((k) => `${k}=${port.counters[k]}`).join(', ') + ' (cumulative since boot or last reset).', lesson: 'link-layer-ber-fec', lab: 'hw-05-link-health-optics' });
    if ((port.counters.link_downed ?? 0) > 0)
      add({ id: 'link-downed', severity: 'info', where, title: `${pid} link went down ${port.counters.link_downed} time(s)`, detail: 'Expected after a peer reboot, a cable reseat or a switch reload. If it grows while nothing was touched, the link is flapping.', lesson: 'link-layer-ber-fec', lab: 'hw-05-link-health-optics' });
    const seq = ['out_of_sequence', 'packet_seq_err'].filter((k) => (port.hw_counters[k] ?? 0) > 0);
    if (seq.length) add({ id: 'seq-errors', severity: 'info', where, title: `${pid} has seen packet loss`, detail: seq.map((k) => `${k}=${port.hw_counters[k]}`).join(', ') + ': gaps in packet sequence numbers at this receiver. Expected on a lossy fabric; on a lossless one it points at drops.', lesson: 'lossless-misconfigurations' });
    if (h.host.memlock && h.host.memlock !== 'unlimited') {
      const kib = Number.parseInt(h.host.memlock, 10);
      const small = Number.isFinite(kib) && kib <= 8192;
      add({ id: 'memlock', severity: small ? 'warn' : 'info', where, title: `Locked-memory limit is ${h.host.memlock} KiB`,
        detail: small
          ? 'RDMA pins every registered buffer, and the limit counts against it. With 8192 KiB (a common default), ib_write_bw -a (message sizes up to 8 MiB) fails on the reference hosts: "Couldn\'t allocate MR" (DOCA\'s perftest adds "with error=12"), then "failed to create mr", "Failed to create MR" and " Couldn\'t create IB resources". Large NCCL runs hit the same limit.'
          : 'RDMA pins every registered buffer, and the limit counts against it. Whether this is enough depends on message sizes and queue depths (not verified for this value); unlimited takes the question away.',
        fix: 'setup-rdma-host.sh --set-memlock (memlock unlimited), then log in again.', lab: 'hw-01-inventory-baseline' });
    }
    hostPlatform(h, where, add);
    if (h.host.governor && h.host.governor !== 'performance')
      add({ id: 'governor', severity: 'info', where, title: `CPU governor is ${h.host.governor}`, detail: 'perftest warns about CPU frequency scaling; latency results are noisier when cores clock down.' });
    if (h.gpus.length && !h.modules.nvidia_peermem && !h.modules.nv_peer_mem)
      add({ id: 'peermem', severity: 'warn', where, title: 'GPUs present but nvidia_peermem is not loaded', detail: 'GPUDirect RDMA needs either the peer-memory module or a DMA-BUF capable driver, kernel and application stack.', fix: 'sudo modprobe nvidia_peermem, or follow the DMA-BUF route in the GPUDirect lab.', lesson: 'gpudirect-rdma-storage', lab: 'hw-07-gpudirect-numa' });
    if (!h.software.tools.ib_write_bw) add({ id: 'no-perftest', severity: 'warn', where, title: 'perftest is not installed', detail: 'Most labs measure with ib_write_bw and friends.', fix: 'Run labs/hw-toolkit/setup-rdma-host.sh.' });
  }

  // Cross-host consistency.
  const live = ports.filter((x) => x.dp);
  const distinct = <T,>(xs: T[]) => [...new Set(xs.filter((v) => v !== null && v !== undefined && v !== ''))];
  const mtus = distinct(live.map((x) => x.nd?.mtu ?? null));
  if (mtus.length > 1) add({ id: 'mtu-mismatch', severity: 'error', title: 'MTU differs between hosts', detail: live.map((x) => `${hostLabel(x.h)} ${x.nd?.name}=${x.nd?.mtu}`).join(', ') + '. Large frames from the bigger side are dropped by the smaller side.', fix: `Set MTU ${p.MTU} everywhere.`, lesson: 'mtu-jumbo-frames', lab: 'hw-04-break-fix-roce' });
  const rates = distinct(live.map((x) => x.dp!.port.rate_gbps));
  if (rates.length > 1) add({ id: 'rate-mismatch', severity: 'warn', title: 'Port rates differ between hosts', detail: live.map((x) => `${hostLabel(x.h)} ${x.dp!.port.rate}`).join(', ') + '. Tests run at the slowest rate; a port that came up at a lower speed than expected often has a cable or FEC problem.', lesson: 'link-layer-ber-fec' });
  const pfcs = distinct(live.map((x) => (x.nd?.qos?.pfc_enabled ? x.nd.qos.pfc_enabled.join(',') || 'none' : null)));
  if (pfcs.length > 1) add({ id: 'pfc-mismatch', severity: 'error', title: 'PFC priorities differ between hosts', detail: live.map((x) => `${hostLabel(x.h)} [${x.nd?.qos?.pfc_enabled?.join(',') || 'off'}]`).join(', ') + '. A NIC that pauses a priority its peer never pauses gives you a link that is lossless in one direction only.', lesson: 'pfc-priority-flow-control', lab: 'hw-03-host-qos-pfc-ecn' });
  // Flow control must be the same kind on both ends (PFC priorities are compared above).
  const fc = live.filter((x) => x.nd && !x.nd.ipoib && x.nd.pause && x.nd.qos?.pfc_enabled && !x.nd.qos.pfc_enabled.length);
  if (p.FABRIC === 'roce' && fc.length === live.length && live.length > 1 && distinct(fc.map((x) => (x.nd!.pause!.rx || x.nd!.pause!.tx ? 'global' : 'none'))).length > 1)
    add({ id: 'flow-control-mismatch', severity: 'warn', title: 'Flow control differs between hosts', detail: fc.map((x) => `${hostLabel(x.h)} ${x.nd!.name}: global pause ${x.nd!.pause!.rx ? 'RX on' : 'RX off'}/${x.nd!.pause!.tx ? 'TX on' : 'TX off'}`).join(', ') + '. With PFC off, one end sends 802.3x pause frames the other never sends: the link is flow-controlled in one direction only.', fix: 'Use the same mode on both ends: PFC on the RoCE priority for the lossless labs (hw-03), or the default global pause (ethtool -A <if> rx on tx on) on both.', lesson: 'pfc-priority-flow-control', lab: 'hw-03-host-qos-pfc-ecn' });
  // Classification must match: same trust, and the RoCE DSCP in the same priority everywhere.
  const anyPfc = live.some((x) => x.nd?.qos?.pfc_enabled?.length);
  const trusts = distinct(live.map((x) => (x.nd?.ipoib ? null : x.nd?.qos?.trust ?? null)));
  if (p.FABRIC === 'roce' && trusts.length > 1)
    add({ id: 'trust-mismatch', severity: anyPfc ? 'error' : 'warn', title: 'Hosts trust different QoS fields', detail: live.map((x) => `${hostLabel(x.h)} ${x.nd?.name}: ${x.nd?.qos?.trust ?? '?'}`).join(', ') + `. A PCP-trusting host puts untagged RoCE in priority 0 whatever its DSCP. On the reference hosts, removing the DSCP entry on one side (trust back to pcp) moved the same tclass-106 traffic from rx_prio3_bytes to rx_prio0_bytes${anyPfc ? ', out of the lossless priority' : ''}.`, fix: 'Set DSCP trust on every host (hw-03 apply-qos.sh: mlnx_qos -i <if> --trust dscp; with iproute2 on mlx5 a dcb app dscp-prio entry switches the port to DSCP trust).', lesson: 'qos-trust-and-mapping', lab: 'hw-03-host-qos-pfc-ecn' });
  const maps = live.filter((x) => x.nd?.qos?.trust === 'dscp' && x.nd.qos.dscp_prio?.[p.ROCE_DSCP] !== undefined);
  if (p.FABRIC === 'roce' && distinct(maps.map((x) => x.nd!.qos!.dscp_prio![p.ROCE_DSCP])).length > 1)
    add({ id: 'dscp-map-mismatch', severity: anyPfc ? 'error' : 'warn', title: `DSCP ${p.ROCE_DSCP} maps to different priorities on different hosts`, detail: maps.map((x) => `${hostLabel(x.h)} -> priority ${x.nd!.qos!.dscp_prio![p.ROCE_DSCP]}`).join(', ') + '. The same packets are lossless on one host and lossy on the other.', fix: `Map DSCP ${p.ROCE_DSCP} to priority ${p.ROCE_PRIO} everywhere (QoS lab).`, lesson: 'qos-trust-and-mapping', lab: 'hw-03-host-qos-pfc-ecn' });
  const byModel = new Map<string, Set<string>>();
  for (const h of hosts) for (const d of h.rdma) if (d.fw_ver) {
    const k = d.board_id || d.hca_type || 'unknown';
    byModel.set(k, (byModel.get(k) ?? new Set()).add(d.fw_ver));
  }
  for (const [model, fw] of byModel) if (fw.size > 1) {
    const vs = [...fw].sort(cmpVersion);
    const latest = vs[vs.length - 1];
    add({ id: 'fw-mismatch', severity: 'warn', title: `Firmware differs across ${model} NICs`, detail: `Versions: ${vs.join(', ')}. Mixed firmware makes results hard to compare and can differ in defaults. ibdiagnet flags it too: "... has FW version ${vs[0]} while the latest FW version for the same Devid/PSID on this fabric is ${latest}".`, fix: `Bring every ${model} card to the same release (${latest} is the newest here) with NVIDIA's firmware tools (MFT mlxfwmanager or flint), then reset the adapter as the tool tells you. Under kernel lockdown MFT cannot open the device: see the lockdown finding.`, lesson: 'fabric-validation-burn-in' });
  }
  const ofed = distinct(hosts.map((h) => (h.software.ofed ? 'ofed' : 'inbox')));
  if (ofed.length > 1) add({ id: 'stack-mismatch', severity: 'warn', title: 'Driver stacks differ', detail: 'Some hosts run NVIDIA OFED/DOCA, others the inbox kernel drivers. Tools, counters and defaults differ between the two.' });
  const kernels = distinct(hosts.map((h) => h.host.kernel));
  if (kernels.length > 1) add({ id: 'kernel-mismatch', severity: 'info', title: 'Kernels differ between hosts', detail: kernels.join(', ') });
  const order: Severity[] = ['error', 'warn', 'info'];
  return f.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

/** Dotted numeric versions: 16.29.1016 < 16.34.1002. */
export function cmpVersion(a: string, b: string): number {
  const x = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0), y = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

type Add = (x: Finding) => void;

/** 802.3x global pause against PFC on one RoCE netdev (mlx5 behaviour from docs/HARDWARE_VERIFICATION.md). */
function flowControl(nd: Netdev, q: Qos, p: Profile, where: string, add: Add) {
  if (!nd.pause || !q.pfc_enabled || nd.ipoib) return;
  const global = !!(nd.pause.rx || nd.pause.tx);
  const pfcOn = q.pfc_enabled.length > 0;
  const seen = ['rx_global_pause', 'tx_global_pause'].filter((k) => (nd.stats[k] ?? 0) > 0).map((k) => `${k}=${nd.stats[k]}`);
  if (pfcOn && global)
    add({ id: 'pfc-global-pause', severity: 'warn', where, title: `${nd.name} reports PFC and global pause both on`, detail: `On mlx5 they exclude each other: enabling PFC on any priority turns global 802.3x pause off (ethtool -a then shows RX off, TX off), and ethtool -A ${nd.name} rx on tx on while PFC is enabled silently clears PFC on all priorities (rc 0, no warning). Seeing both on means the two reads disagree, for example because a setting changed while the report was collected.`, fix: `Read both again (ethtool -a ${nd.name}; mlnx_qos -i ${nd.name} or dcb pfc show dev ${nd.name}). If PFC was cleared, re-apply it (hw-03 apply-qos.sh) and do not run ethtool -A rx on tx on afterwards.`, lesson: 'pfc-priority-flow-control', lab: 'hw-03-host-qos-pfc-ecn' });
  else if (!pfcOn && global)
    add({ id: 'global-pause', severity: 'info', where, title: `${nd.name}: global 802.3x pause on, PFC off`, detail: `The mlx5 default (ethtool -a: RX on, TX on). A pause frame then stops all traffic on the link, whatever its priority, so RoCE has no lossless class of its own; ethtool -S counts rx_global_pause / tx_global_pause instead of per-priority prioN_pause${seen.length ? ` (here: ${seen.join(', ')})` : ''}.`, fix: `For the lossless labs enable PFC on priority ${p.ROCE_PRIO} (hw-03): that turns global pause off automatically. Do not run ethtool -A rx on tx on afterwards: it silently clears PFC.`, lesson: 'pfc-priority-flow-control', lab: 'hw-03-host-qos-pfc-ecn' });
  else if (!pfcOn && !global)
    add({ id: 'no-flow-control', severity: 'warn', where, title: `${nd.name} has no link-level flow control`, detail: 'Global pause and PFC are both off, so RoCE runs lossy: a receiver short of buffer drops packets and RC recovers by retransmitting. On the reference hosts, RoCE in a priority with neither PFC nor global pause showed out_of_sequence +30 and np_cnp_sent +17 at the receiver in a 10 s run, with np_ecn_marked_roce_packets +0: CNPs caused by loss, not by ECN.', fix: `Enable PFC on priority ${p.ROCE_PRIO} on both hosts (hw-03), or restore the default global pause: sudo ethtool -A ${nd.name} rx on tx on.`, lesson: 'lossless-misconfigurations', lab: 'hw-03-host-qos-pfc-ecn' });
}

/** rdma_cm's per-port default ToS (configfs) against the profile's traffic class. */
function roceTos(dev: string, port: RdmaPort, nd: Netdev, p: Profile, where: string, add: Add) {
  const rc = port.rdma_cm;
  if (!rc || port.link_layer !== 'Ethernet' || !p.TCLASS) return;
  const tos = rc.configured ? rc.default_roce_tos : 0;
  if (tos === null || String(tos) === p.TCLASS) return;
  const lossless = !!nd.qos?.pfc_enabled?.includes(Number(p.ROCE_PRIO));
  if (!rc.configured && !lossless) return; // kernel default on a lossy setup: nothing to align yet
  add({ id: 'roce-tos', severity: 'warn', where, title: `rdma_cm default ToS on ${dev}/${port.port} is ${tos}${rc.configured ? '' : ' (kernel default)'}, profile traffic class is ${p.TCLASS}`,
    detail: `Connections set up through rdma_cm that do not pick a ToS themselves (rping, ib_write_bw -R without -T) use this per-port default, so their packets carry DSCP ${tos >> 2} instead of ${p.ROCE_DSCP}${lossless ? ` and miss lossless priority ${p.ROCE_PRIO}` : ''}. Tools that set the traffic class per run (ib_write_bw --tclass, ib_write_bw -R -T ${p.TCLASS}) are not affected.`,
    fix: `sudo mkdir -p /sys/kernel/config/rdma_cm/${dev} && echo ${p.TCLASS} | sudo tee /sys/kernel/config/rdma_cm/${dev}/ports/${port.port}/default_roce_tos (with NVIDIA's tools, cma_roce_tos -d ${dev} reads it back). Runtime only: configfs does not survive a reboot.`,
    lesson: 'qos-trust-and-mapping', lab: 'hw-03-host-qos-pfc-ecn' });
}

/** Host-level platform facts: kernel lockdown, umad device order on mixed RoCE + InfiniBand hosts. */
function hostPlatform(h: HostFacts, where: string, add: Add) {
  const ld = h.host.lockdown;
  if (ld && ld !== 'none')
    add({ id: 'lockdown', severity: 'info', where, title: `Kernel lockdown is on (${ld})${h.host.secure_boot ? ', Secure Boot enabled' : ''}`,
      detail: 'Lockdown blocks debugfs even for root (cat .../cc_params/rp_ai_rate: "Operation not permitted"), so the DCQCN parameters there are unreadable. MFT and mstflint cannot open the device (mlxconfig: "-E- Failed to open the device"; mstconfig: "crspace read (0xf0014) failed: Bad file descriptor"), and mlxlink -d mlx5_0 fails. On kernel 7.0 with MFT 4.37, mlxlink -d /dev/fwctl/fwctl0 works; mlxconfig and flint over fwctl do not.',
      fix: "Use mlxlink -d /dev/fwctl/fwctl0 for link diagnostics and, with NVIDIA's stack, /sys/class/net/<if>/ecn/ for the DCQCN switches. Firmware changes (mlxconfig settings such as LINK_TYPE, firmware updates) need Secure Boot off or a signed MFT kernel module." });
  const lls = new Set(h.rdma.flatMap((d) => d.ports.map((x) => x.link_layer)));
  if (!lls.has('Ethernet') || !lls.has('InfiniBand')) return;
  const first = h.umad?.[0]?.ibdev ?? h.rdma[0]?.name;
  const dev = h.rdma.find((d) => d.name === first);
  const ib = h.rdma.find((d) => d.ports.some((x) => x.link_layer === 'InfiniBand'));
  if (!dev || !ib || dev.ports[0]?.link_layer !== 'Ethernet') return;
  const ibPort = ib.ports.find((x) => x.link_layer === 'InfiniBand')!.port;
  add({ id: 'umad-first', severity: 'info', where, title: `umad tools open ${dev.name} (RoCE) unless told otherwise`,
    detail: `This host has RoCE and InfiniBand ports. Without -C/-P, sminfo, perfquery, iblinkinfo and the other umad tools open the first RDMA device, here the RoCE port ${dev.name}, and fail: "ibwarn: [pid] mad_rpc_open_port2: client_register for mgmt 1 failed" / "sminfo: iberror: failed: Failed to open '(null)' port '0'".`,
    fix: `Always name the InfiniBand CA and port: sminfo -C ${ib.name} -P ${ibPort} (ibdiagnet uses -i ${ib.name} -p ${ibPort}). ibstat -l lists every CA, RoCE ones included.`, lab: 'hw-09-infiniband-bringup' });
}

export type Readiness = 'ready' | 'missing' | 'unknown' | 'self';
export interface LabReadiness { status: 'ready' | 'blocked' | 'unknown'; items: { id: string; state: Readiness; note?: string }[] }

/** Can this lab run on the learner's lab? Uses the report where it can, the profile otherwise, and marks
 *  requirements nobody can detect (root, SSH keys) as self-declared. */
export function readiness(lab: HandsOnLab, p: Profile, r: Report | null): LabReadiness {
  const rdmaHosts = r ? r.hosts.filter((h) => h.rdma.length).length : null;
  const items: LabReadiness['items'] = lab.requires.map((id): LabReadiness['items'][number] => {
    switch (id) {
      case 'linux-vm': return { id, state: 'ready' as Readiness };
      case 'two-rdma-hosts': return rdmaHosts === null ? { id, state: 'unknown' as Readiness } : { id, state: (rdmaHosts >= 2 ? 'ready' : 'missing') as Readiness, note: `${rdmaHosts} in report` };
      case 'three-rdma-hosts': return rdmaHosts === null ? { id, state: (p.HOST_COUNT === '3' ? 'unknown' : 'missing') as Readiness, note: p.HOST_COUNT === '3' ? undefined : 'profile has 2 hosts' } : { id, state: (rdmaHosts >= 3 ? 'ready' : 'missing') as Readiness, note: `${rdmaHosts} in report` };
      case 'lossless-switch': return { id, state: (p.SWITCH_OS === 'none' ? 'missing' : 'self') as Readiness, note: p.SWITCH_OS === 'none' ? 'profile: no switch' : undefined };
      case 'gpu': return !r ? { id, state: 'unknown' as Readiness } : { id, state: (r.hosts.length >= 2 && r.hosts.every((h) => h.gpus.length > 0) ? 'ready' : 'missing') as Readiness };
      case 'infiniband': return !r ? { id, state: (p.FABRIC === 'ib' ? 'unknown' : 'missing') as Readiness } : { id, state: (r.hosts.some((h) => h.rdma.some((d) => d.ports.some((x) => x.link_layer === 'InfiniBand'))) ? 'ready' : 'missing') as Readiness };
      default: return { id, state: 'self' as Readiness };
    }
  });
  if (lab.fabric !== 'any' && lab.fabric !== p.FABRIC && lab.tier > 0 && !lab.requires.includes('infiniband')) items.push({ id: 'fabric', state: 'missing', note: `needs ${lab.fabric === 'ib' ? 'InfiniBand' : 'RoCE'}` });
  const status = items.some((i) => i.state === 'missing') ? 'blocked' : items.some((i) => i.state === 'unknown') ? 'unknown' : 'ready';
  return { status, items };
}

export const roleOf = (h: HostFacts): Role | null => (h.role === 'A' || h.role === 'B' || h.role === 'C' ? h.role : null);

/** Values the report can fill into the profile: per-role device, netdev, data IP, plus GID index and MTU. */
export function detectedProfile(r: Report, p: Profile): { next: Profile; changes: string[] } {
  const next = { ...p };
  const changes: string[] = [];
  const set = (k: string, v: string | null | undefined) => {
    if (v && next[k] !== v) {
      changes.push(`${k}: ${next[k] || '(empty)'} → ${v}`);
      next[k] = v;
    }
  };
  const hosts = r.hosts.filter((h) => roleOf(h));
  for (const h of hosts) {
    const role = roleOf(h)!;
    const dp = dataPort(h);
    if (!dp) continue;
    set(`${role}_RDMA_DEV`, dp.dev.name);
    set(`${role}_NETDEV`, dp.port.netdev);
    const nd = h.netdevs.find((n) => n.name === dp.port.netdev);
    const v2 = dp.port.gids.find(isRoceV2Ipv4);
    set(`${role}_IP`, nd?.ipv4[0]?.split('/')[0] ?? (v2 ? gidToIpv4(v2.gid) : null));
    if (role === 'A') {
      set('RDMA_PORT', String(dp.port.port));
      if (nd?.mtu) set('MTU', String(nd.mtu));
      if (v2) set('GID_INDEX', String(v2.index));
      if (nd?.ipv4[0]?.includes('/')) set('PREFIX_LEN', nd.ipv4[0].split('/')[1]);
      set('FABRIC', dp.port.link_layer === 'InfiniBand' ? 'ib' : dp.port.link_layer === 'Ethernet' ? 'roce' : null);
    }
  }
  if (hosts.length >= 2) set('HOST_COUNT', hosts.length >= 3 ? '3' : '2');
  return { next: derive(next), changes };
}
