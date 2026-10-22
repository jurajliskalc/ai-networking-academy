import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Data (unit-testable) ----------
// Sources: Linux kernel (net/, drivers/infiniband/core/: uverbs_main.c, verbs.c ib_resolve_eth_dmac), rdma-core
// (libibverbs, providers/mlx5), iproute2 man pages (ss, ip, tc, rdma), ethtool(8), tcpdump(1), libpcap pcap-rdmasniff.c
// (RDMA sniffer, libpcap 1.9.0+), mlx5 en_main.c mlx5e_get_stats / en_stats.c (vport_rdma counters), and the academy lessons rdma-on-linux and linux-networking-toolkit.

export type Stack = 'tcp' | 'rdma';
export type Band = 'user' | 'kernel' | 'hw';
export type RdmaMode = 'data' | 'setup';

export interface Layer { id: string; stack: Stack; band: Band; name: string; sub: string; detail: string; blind: string }

export const LAYERS: Layer[] = [
  { id: 't-app', stack: 'tcp', band: 'user', name: 'Application', sub: 'send() / write() on a socket',
    detail: 'The data sits in an ordinary user buffer. The application hands it to the kernel with a system call; from here on the kernel owns the copy.',
    blind: 'Nothing below the socket: a drop in a qdisc, a NIC ring or the fabric shows up here only as slower progress.' },
  { id: 't-sock', stack: 'tcp', band: 'kernel', name: 'System call + socket layer', sub: 'copy into the socket send buffer',
    detail: 'The system call switches into the kernel, and the data is copied from user memory into socket buffers (sk_buff). The socket send buffer limits how much can be queued.',
    blind: 'strace shows the call and its byte count, not what TCP, IP or the NIC did with the data afterwards.' },
  { id: 't-tcp', stack: 'tcp', band: 'kernel', name: 'TCP', sub: 'sequence numbers, cwnd, retransmission',
    detail: 'TCP numbers the bytes, respects the congestion window and the peer\'s receive window, keeps data until it is acknowledged and retransmits on loss. With TSO/GSO it builds segments larger than the MTU and lets the NIC or a later stage cut them.',
    blind: 'TCP counters say that loss happened (retransmissions), not where on the path it happened.' },
  { id: 't-ip', stack: 'tcp', band: 'kernel', name: 'IP', sub: 'route lookup, policy rules, netfilter',
    detail: 'The kernel picks a route (main or policy-routing table), adds the IP header and runs the netfilter hooks (iptables / nftables).',
    blind: 'A route lookup says where a packet would go, not whether the next hop delivered it.' },
  { id: 't-qdisc', stack: 'tcp', band: 'kernel', name: 'Neighbour + qdisc (tc)', sub: 'ARP / ND, queueing discipline',
    detail: 'The neighbour table supplies the next hop\'s MAC address (ARP for IPv4, ND for IPv6). The packet is queued in the interface\'s queueing discipline, where tc shaping, policing and queue limits apply.',
    blind: 'qdisc counters cover only packets that went through the kernel queue on this host.' },
  { id: 't-drv', stack: 'tcp', band: 'kernel', name: 'NIC driver (netdev)', sub: 'e.g. mlx5_core: TX ring, DMA, doorbell',
    detail: 'The driver maps the packet for DMA, writes a descriptor into a transmit ring and rings the NIC\'s doorbell. Packet capture taps (tcpdump) see the packet as it is handed to the driver, so with TSO a capture shows segments larger than the MTU.',
    blind: 'Netdev counters (ip -s link) count what the kernel handed over, not what the NIC finally put on the wire.' },
  { id: 't-nic', stack: 'tcp', band: 'hw', name: 'NIC + wire', sub: 'DMA read, TSO, checksum, transmit',
    detail: 'The NIC fetches descriptor and data over PCIe, segments and checksums (offloads), and transmits. On the receiver the path runs in reverse with interrupts / NAPI polling and a final copy into the application\'s buffer.',
    blind: 'Physical-port counters do not tell you which socket or application a frame belonged to.' },

  { id: 'r-app', stack: 'rdma', band: 'user', name: 'Application', sub: 'NCCL, UCX, MPI, perftest',
    detail: 'The application talks verbs: it creates queue pairs, registers memory and posts work requests. Its connection bootstrap (exchanging QP numbers, GIDs, rkeys) usually runs over an ordinary TCP socket or rdma_cm.',
    blind: 'ss shows no queue pairs: RDMA connections are not sockets. At most it shows the TCP bootstrap connection (for example perftest\'s exchange port 18515 or NCCL\'s bootstrap).' },
  { id: 'r-verbs', stack: 'rdma', band: 'user', name: 'libibverbs', sub: 'rdma-core: the ibv_* API',
    detail: 'libibverbs is a thin dispatcher: data-path calls such as ibv_post_send and ibv_poll_cq jump straight into the provider library through function pointers. Control calls (ibv_create_qp, ibv_reg_mr ...) go to the kernel.',
    blind: 'strace shows nothing for ibv_post_send or ibv_poll_cq: they are function calls and memory writes, not system calls.' },
  { id: 'r-prov', stack: 'rdma', band: 'user', name: 'Provider library', sub: 'e.g. libmlx5: builds WQEs, rings doorbells',
    detail: 'The provider writes the work queue entry (WQE) into the send queue ring, an ordinary buffer in the process\'s own memory that the kernel pinned at QP creation so the NIC can read it by DMA. It then updates the doorbell record and writes the doorbell register in a UAR page that the driver mapped into the process. That posted MMIO write goes over PCIe straight to the NIC.',
    blind: 'If the provider for your NIC is missing, ibv_devices lists nothing even though the kernel device exists.' },
  { id: 'r-uverbs', stack: 'rdma', band: 'kernel', name: 'ib_uverbs', sub: '/dev/infiniband/uverbsN',
    detail: 'The door into the kernel for verbs control commands, issued as ioctl() / write() on /dev/infiniband/uverbsN (the device file is mode 0666 by default). Without this file, for example in a container, RDMA cannot work at all.',
    blind: 'Not on the data path: once a QP exists, no per-packet or per-WR work passes through here.' },
  { id: 'r-core', stack: 'rdma', band: 'kernel', name: 'ib_core (+ rdma_cm)', sub: 'objects, GID table, address resolution',
    detail: 'ib_core tracks every PD, CQ, QP and MR per process, pins registered memory (subject to the memlock limit), keeps the GID table and, on RoCE, resolves the destination MAC from the GID when a QP is moved to RTR: through the kernel\'s routing and neighbour tables for IP-based GIDs, or directly for a link-local GID derived from a MAC. rdma_cm does IP-based address and route resolution for applications that use it.',
    blind: 'Kernel routing and the neighbour table are consulted at QP setup; an existing QP keeps the destination MAC it was given rather than looking it up per packet, so per-packet kernel tools have nothing to show.' },
  { id: 'r-drv', stack: 'rdma', band: 'kernel', name: 'Vendor RDMA driver', sub: 'e.g. mlx5_ib on mlx5_core',
    detail: 'Turns verbs objects into firmware commands: create the QP context in the NIC, load MR translation tables, register the pinned queue buffers with the NIC and map doorbell (UAR) pages into the process.',
    blind: 'Not on the data path: the driver does no per-packet work for RDMA. The RDMA counters it exposes (hw_counters, rdma statistic) are kept by the NIC, not counted by the driver.' },
  { id: 'r-nic', stack: 'rdma', band: 'hw', name: 'RDMA NIC + wire', sub: 'transport in hardware',
    detail: 'The NIC reads the WQE and payload by DMA, segments the message into MTU packets with BTH (and RETH), on RoCE builds Ethernet/IP/UDP headers from the QP\'s address vector, and runs reliability (PSNs, ACKs, retransmission) and congestion control (e.g. DCQCN) itself. The remote NIC writes into remote memory without the remote CPU.',
    blind: 'ip -s link usually does not count it; tcpdump on the netdev usually does not see it; tc qdiscs and iptables / nftables never touch it. RoCE QoS lives in the NIC (trust mode, PFC, ETS).' },
];

export interface Step { layers: string[]; title: string; text: string }

export const TCP_STEPS: Step[] = [
  { layers: ['t-app'], title: 'send()', text: 'The application calls send() on a connected TCP socket with a pointer to its buffer.' },
  { layers: ['t-sock'], title: 'System call, copy', text: 'The CPU enters the kernel; the bytes are copied into socket buffers. (MSG_ZEROCOPY can avoid the copy for large sends, at the cost of extra completion handling.)' },
  { layers: ['t-tcp'], title: 'TCP', text: 'TCP assigns sequence numbers and sends only what cwnd and the receive window allow; the data stays queued until ACKed.' },
  { layers: ['t-ip'], title: 'IP', text: 'Route lookup (ip rule, ip route), IP header, netfilter hooks.' },
  { layers: ['t-qdisc'], title: 'Neighbour + qdisc', text: 'Next-hop MAC from the neighbour table; the packet is enqueued in the qdisc and dequeued when the device can take it.' },
  { layers: ['t-drv'], title: 'Driver', text: 'TX descriptor written, DMA mapped, doorbell rung by the kernel driver. A tcpdump on this netdev captures the packet here.' },
  { layers: ['t-nic'], title: 'NIC + wire', text: 'NIC DMA-reads the data, segments (TSO) and checksums, transmits. The receiver repeats the stack upward: interrupt / NAPI, IP, TCP, a copy into the application.' },
];

export const RDMA_DATA_STEPS: Step[] = [
  { layers: ['r-app'], title: 'ibv_post_send()', text: 'The buffer was registered earlier (ibv_reg_mr, a control-path call). Posting a work request is an ordinary function call.' },
  { layers: ['r-verbs'], title: 'libibverbs', text: 'libibverbs forwards the call to the provider through the device context\'s function pointers. No system call.' },
  { layers: ['r-prov'], title: 'Build the WQE', text: 'libmlx5 writes the WQE (opcode, local SGE with lkey, remote address and rkey) into the send queue ring in process memory.' },
  { layers: ['r-prov', 'r-nic'], title: 'Doorbell: user space to NIC', text: 'One MMIO write to the doorbell register in the UAR page mapped into the process. ib_uverbs, ib_core and the driver are not involved: this is the kernel bypass.' },
  { layers: ['r-nic'], title: 'NIC does the transport', text: 'The NIC DMA-reads the WQE and payload, segments into MTU packets, adds BTH / RETH (and on RoCE Ethernet / IP / UDP from the QP\'s address vector), tracks PSNs and ACKs and runs congestion control.' },
  { layers: ['r-nic'], title: 'Remote side', text: 'The remote NIC checks the rkey and writes the data into the remote buffer by DMA; for an RDMA WRITE the remote CPU and kernel do nothing. An ACK comes back.' },
  { layers: ['r-prov', 'r-app'], title: 'Completion', text: 'The NIC writes a CQE into the CQ in host memory; the application finds it with ibv_poll_cq, again without a system call. (Only an application that sleeps on a completion channel, ibv_get_cq_event, makes a system call.)' },
];

export const RDMA_SETUP_STEPS: Step[] = [
  { layers: ['r-app'], title: 'Control verbs', text: 'At start-up the application calls ibv_open_device, ibv_alloc_pd, ibv_reg_mr, ibv_create_cq, ibv_create_qp and ibv_modify_qp.' },
  { layers: ['r-verbs', 'r-prov'], title: 'Marshal the command', text: 'libibverbs and the provider prepare the command; the provider allocates the queue buffers in process memory.' },
  { layers: ['r-uverbs'], title: 'Enter the kernel', text: 'The command goes to ib_uverbs as ioctl() / write() on /dev/infiniband/uverbsN: this is where strace sees RDMA.' },
  { layers: ['r-core'], title: 'ib_core', text: 'ib_core validates the request and records the object against the process (what rdma resource show lists). ibv_reg_mr pins the pages, so the memlock limit applies here.' },
  { layers: ['r-drv', 'r-nic'], title: 'Driver to firmware', text: 'mlx5_ib (through mlx5_core) issues firmware commands that create the QP context and the MR translation in the NIC.' },
  { layers: ['r-core'], title: 'Address resolution (RoCE)', text: 'When the QP moves to RTR, the kernel resolves the destination MAC from the GID (for IP-based GIDs through its routing and neighbour tables, the same ones ip route get and ip neigh show) and stores it in the QP context. rdma_cm users resolve the address and route before this.' },
  { layers: ['r-drv', 'r-prov'], title: 'Hand back and map', text: 'The kernel returns handles and maps the doorbell (UAR) page into the process; the queue buffers already live in process memory, pinned for DMA. From now on the data path skips the kernel.' },
];

export interface Tool { id: string; cmd: string; short: string; layers: string[]; sees: string; rdma: 'yes' | 'no' | 'setup' | 'partial'; rdmaNote: string }

export const TOOLS: Tool[] = [
  { id: 'ss', short: 'ss', cmd: 'ss -tin', layers: ['t-app', 't-sock', 't-tcp'], sees: 'TCP sockets: state, cwnd, RTT, retransmissions, queues.', rdma: 'no',
    rdmaNote: 'QPs are not sockets. Only a TCP bootstrap connection shows up.' },
  { id: 'nstat', short: 'nstat', cmd: 'nstat -az', layers: ['t-tcp', 't-ip'], sees: 'Kernel protocol counters such as TcpRetransSegs, IP and UDP counters.', rdma: 'no',
    rdmaNote: 'RoCE packets never reach the kernel\'s TCP/IP/UDP code, so these counters do not move.' },
  { id: 'strace', short: 'strace', cmd: 'strace -f -p <pid>', layers: ['t-sock', 'r-uverbs'], sees: 'System calls: send/recv on sockets, ioctl/write on /dev/infiniband/uverbsN.', rdma: 'setup',
    rdmaNote: 'Sees control verbs (they are system calls), not ibv_post_send or ibv_poll_cq.' },
  { id: 'route', short: 'ip route/neigh', cmd: 'ip route get / ip neigh', layers: ['t-ip', 't-qdisc', 'r-core'], sees: 'The route and next-hop MAC the kernel would use.', rdma: 'setup',
    rdmaNote: 'On RoCE the same tables are consulted once, at QP setup, to find the destination MAC.' },
  { id: 'tc', short: 'tc', cmd: 'tc -s qdisc show dev <netdev>', layers: ['t-qdisc'], sees: 'Per-qdisc sent bytes, drops, overlimits, backlog.', rdma: 'no',
    rdmaNote: 'RoCE never passes through the qdisc; its QoS is set in the NIC (trust, PFC, ETS).' },
  { id: 'tcpdump', short: 'tcpdump', cmd: 'tcpdump -i <netdev>', layers: ['t-drv'], sees: 'Packets handed to or received from the driver by the kernel (TSO segments can exceed the MTU).', rdma: 'no',
    rdmaNote: 'Offloaded RDMA traffic normally never passes the kernel, so a netdev capture usually misses it (see RDMA capture).' },
  { id: 'iplink', short: 'ip -s link', cmd: 'ip -s link show dev <netdev>', layers: ['t-drv'], sees: 'Kernel netdev byte, packet, error and drop counters.', rdma: 'no',
    rdmaNote: 'Packet and byte counts usually exclude RDMA traffic the NIC handles itself, so the link can look idle during a training job. Driver-dependent: on mlx5 some drop/error fields fold in port-level counters, and an uplink representor in switchdev mode reports physical-port counts that include RoCE.' },
  { id: 'ethtool', short: 'ethtool -S', cmd: 'ethtool -S <netdev>', layers: ['t-drv', 't-nic', 'r-nic'], sees: 'Driver statistics: per-queue software counters plus physical-port counters (names are driver-specific; on mlx5 the *_phy group).', rdma: 'partial',
    rdmaNote: 'Physical-port counters (bytes, CRC errors, discards, per-priority pause) count every frame, RoCE included; per-queue counters do not. mlx5 also has vport RDMA counters (rx_vport_rdma_unicast_packets and similar); names vary by driver.' },
  { id: 'rdmalink', short: 'rdma link', cmd: 'rdma link / rdma dev', layers: ['r-core'], sees: 'RDMA devices, port state, physical state and the associated netdev.', rdma: 'yes',
    rdmaNote: 'State and mapping, not traffic.' },
  { id: 'rdmares', short: 'rdma resource', cmd: 'rdma resource show qp', layers: ['r-app', 'r-core'], sees: 'Per-process PDs, CQs, QPs (with state), MRs and cm_ids that ib_core tracks.', rdma: 'yes',
    rdmaNote: 'Objects created on the control path; it does not count packets.' },
  { id: 'rdmastat', short: 'rdma statistic', cmd: 'rdma statistic show link <dev>/<port>', layers: ['r-nic'], sees: 'The NIC\'s RDMA hardware counters (sysfs hw_counters): out_of_sequence, local_ack_timeout_err, np_cnp_sent ...', rdma: 'yes',
    rdmaNote: 'The main window into the hardware transport. Read deltas, not totals.' },
  { id: 'devinfo', short: 'ibv_devinfo', cmd: 'ibv_devices / ibv_devinfo', layers: ['r-verbs', 'r-prov'], sees: 'Devices as libibverbs and the provider see them: port state, link_layer, active_mtu, limits.', rdma: 'yes',
    rdmaNote: 'Attributes only. An empty list with devices in /sys/class/infiniband points at a missing provider.' },
  { id: 'gids', short: 'GID table', cmd: 'show_gids or sysfs gids/', layers: ['r-core'], sees: 'The RoCE GID table: index, GID, RoCE version, netdev.', rdma: 'yes',
    rdmaNote: 'show_gids is an NVIDIA (MLNX_OFED / DOCA) script; /sys/class/infiniband/<dev>/ports/<n>/gids works everywhere.' },
  { id: 'perfquery', short: 'perfquery', cmd: 'perfquery (InfiniBand)', layers: ['r-nic'], sees: 'IB port counters (PMA PortCounters) of this or any port in the subnet.', rdma: 'yes',
    rdmaNote: 'InfiniBand only; needs umad access (usually root).' },
  { id: 'capture', short: 'RDMA capture', cmd: 'RDMA capture', layers: ['r-nic'], sees: 'The RDMA packets themselves.', rdma: 'partial',
    rdmaNote: 'Needs special support: libpcap 1.9.0+ built with RDMA sniffing lists RDMA devices, so tcpdump -i mlx5_0 can capture on NICs and drivers that support sniffer flow steering; NVIDIA also offers ibdump for ConnectX; or mirror the switch port. Usually root; check your driver and versions.' },
];

export const stepsFor = (s: Stack, mode: RdmaMode): Step[] => (s === 'tcp' ? TCP_STEPS : mode === 'data' ? RDMA_DATA_STEPS : RDMA_SETUP_STEPS);

/** Layers a path never touches: the RDMA data path skips the whole kernel band. */
export function bypassed(mode: RdmaMode): string[] {
  const visited = new Set(stepsFor('rdma', mode).flatMap((s) => s.layers));
  return LAYERS.filter((l) => l.stack === 'rdma' && !visited.has(l.id)).map((l) => l.id);
}

export const toolsFor = (layerId: string) => TOOLS.filter((t) => t.layers.includes(layerId));
export const layer = (id: string) => LAYERS.find((l) => l.id === id)!;

// ---------- UI ----------

const BAND_LABEL: Record<Band, string> = { user: 'User space', kernel: 'Kernel', hw: 'Hardware' };
const btn = (on: boolean) => `min-h-6 rounded-md border px-2 py-1 font-mono text-xs ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;

function Column({ stack, title, step, mode, sel, onSel, lens }: {
  stack: Stack; title: string; step: Step | null; mode: RdmaMode; sel: string; onSel: (id: string) => void; lens: Tool | null;
}) {
  const skip = stack === 'rdma' ? bypassed(mode) : [];
  return (
    <div className="rounded-lg border border-line bg-panel p-2">
      <div className="px-1 pb-2 text-sm font-semibold">{title}</div>
      {(['user', 'kernel', 'hw'] as const).map((band) => {
        const ls = LAYERS.filter((l) => l.stack === stack && l.band === band);
        return (
          <div key={band} className="mb-2 last:mb-0">
            <div className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{BAND_LABEL[band]}</div>
            <ul className="space-y-1" aria-label={`${title}: ${BAND_LABEL[band]}`}>
              {ls.map((l) => {
                const active = !!step?.layers.includes(l.id);
                const bypass = skip.includes(l.id);
                const seen = !!lens?.layers.includes(l.id);
                const isSel = sel === l.id;
                return (
                  <li key={l.id}>
                    <button type="button" onClick={() => onSel(l.id)} aria-pressed={isSel} aria-current={active ? 'step' : undefined}
                      className={`w-full rounded-md border px-2 py-1.5 text-left transition ${active ? 'border-accent bg-accent-soft' : seen ? 'border-data bg-panel-2' : 'border-line bg-panel-2 hover:border-muted'} ${isSel ? 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--panel)]' : ''} ${bypass ? 'border-dashed !bg-panel' : ''}`}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-sm font-semibold ${active ? 'text-accent' : 'text-fg'}`}>{active && <span aria-hidden>▶ </span>}{l.name}</span>
                        {active && <span className="rounded border border-accent px-1 font-mono text-[10px] text-accent">this step</span>}
                        {bypass && <span className="rounded border border-line px-1 font-mono text-[10px] text-muted">bypassed in the data path</span>}
                        {seen && <span className="rounded border border-data px-1 font-mono text-[10px] text-data">seen by {lens!.short}</span>}
                      </div>
                      <div className="font-mono text-[11px] text-muted">{l.sub}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export default function HostStackPaths() {
  const [mode, setMode] = useState<RdmaMode>('data');
  const [i, setI] = useState(0);
  const [sel, setSel] = useState('r-nic');
  const [lensId, setLens] = useState<string | null>(null);
  const tcp = TCP_STEPS, rdma = stepsFor('rdma', mode);
  const n = Math.max(tcp.length, rdma.length);
  const tStep = tcp[Math.min(i, tcp.length - 1)], rStep = rdma[Math.min(i, rdma.length - 1)];
  const lens = TOOLS.find((t) => t.id === lensId) ?? null;
  const L = layer(sel);
  const watchers = toolsFor(sel);
  const skipped = bypassed(mode);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">RDMA column shows</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="RDMA column shows">
            {(['data', 'setup'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setI(0); }} className={btn(mode === m)}>
                {m === 'data' ? 'data path: ibv_post_send' : 'control path: QP setup'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Step through a send</div>
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0} className={`${btn(false)} disabled:opacity-40`}><span aria-hidden>◀ </span>Back</button>
            <button type="button" onClick={() => setI(Math.min(n - 1, i + 1))} disabled={i === n - 1} className={`${btn(false)} disabled:opacity-40`}>Next<span aria-hidden> ▶</span></button>
            <button type="button" onClick={() => setI(0)} className={btn(false)}>Restart</button>
            <span className="ml-1 font-mono text-xs text-muted">step {i + 1} of {n}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2" aria-live="polite">
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Kernel TCP/IP · step {i + 1}: {tStep.title}</div>
          <p>{tStep.text}</p>
        </div>
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">RDMA {mode === 'data' ? 'data path' : 'control path'} · step {i + 1}: {rStep.title}</div>
          <p>{rStep.text}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Column stack="tcp" title="Kernel TCP/IP path" step={tStep} mode={mode} sel={sel} onSel={setSel} lens={lens} />
        <Column stack="rdma" title={`RDMA path (${mode === 'data' ? 'data' : 'control'})`} step={rStep} mode={mode} sel={sel} onSel={setSel} lens={lens} />
      </div>
      <p className="text-xs text-muted">
        {mode === 'data'
          ? <>Kernel layers marked <span className="font-mono">bypassed</span> ({skipped.map((id) => layer(id).name).join(', ')}) do no work per message: the provider rings the NIC's doorbell directly from user space. Switch to the control path to see where the kernel is involved.</>
          : <>Setup goes through the kernel; only after it does the data path bypass it. Kernel bypass is a property of the data path, not of connection setup.</>}
      </p>

      <div className="rounded-lg border border-line p-3" aria-live="polite">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Selected layer · {L.stack === 'tcp' ? 'kernel TCP/IP' : 'RDMA'} · {BAND_LABEL[L.band]}</div>
        <div className="text-sm font-semibold">{L.name} <span className="font-mono text-xs font-normal text-muted">({L.sub})</span></div>
        <p className="mt-1 text-sm text-muted">{L.detail}</p>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-semibold text-accent">Tools that observe this layer</div>
            {watchers.length ? (
              <ul className="space-y-1 text-sm">
                {watchers.map((t) => <li key={t.id}><span className="font-mono text-fg">{t.cmd}</span><span className="text-muted">: {t.sees}</span></li>)}
              </ul>
            ) : <p className="text-sm text-muted">None in the standard toolbox: this layer is plain function calls and memory writes inside the process.</p>}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-warn">What you cannot see here</div>
            <p className="text-sm text-muted">{L.blind}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Tool lens: which layers does a tool observe?</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Tool lens">
          <button type="button" aria-pressed={lensId === null} onClick={() => setLens(null)} className={btn(lensId === null)}>none</button>
          {TOOLS.map((t) => (
            <button key={t.id} type="button" aria-pressed={lensId === t.id} onClick={() => setLens(t.id)} className={btn(lensId === t.id)}>{t.cmd}</button>
          ))}
        </div>
        <div className="mt-2 text-sm" aria-live="polite">
          {lens ? (
            <>
              <p><span className="font-mono text-fg">{lens.cmd}</span> <span className="text-muted">observes {lens.layers.map((id) => `${layer(id).name} (${layer(id).stack === 'tcp' ? 'TCP/IP' : 'RDMA'})`).join(', ')}. {lens.sees}</span></p>
              <p className="mt-1">
                <span className={`font-semibold ${lens.rdma === 'no' ? 'text-danger' : lens.rdma === 'yes' ? 'text-accent' : 'text-warn'}`}>
                  RDMA traffic: {{ yes: 'yes', no: 'no', setup: 'setup only', partial: 'partly' }[lens.rdma]}.
                </span>{' '}<span className="text-muted">{lens.rdmaNote}</span>
              </p>
            </>
          ) : <p className="text-muted">Pick a tool to outline the layers it can observe in both columns.</p>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>data path: no system call per message</Pill><Pill>control path: /dev/infiniband/uverbsN</Pill><Pill>RoCE MAC resolved at QP setup</Pill><Pill>tcpdump on the netdev ≠ RDMA capture</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Simplified for a send on one host. The TCP column omits receive-side detail, GRO/GSO internals and XDP; the RDMA column uses an NVIDIA ConnectX
        (mlx5) stack as the example, and other providers (irdma, bnxt_re, efa ...) follow the same split with their own names. Which counters include
        RDMA traffic depends on driver and firmware: on mlx5 the physical-port counters in ethtool -S count all frames while netdev counters usually do not.
        RDMA capture support (libpcap RDMA sniffer, ibdump, port mirroring) varies by NIC, driver and version; confirm on your platform before relying on it.
        Software RDMA (Soft-RoCE rdma_rxe, siw) implements the transport in the kernel, so there the RDMA data path does use the kernel.
      </p>
    </div>
  );
}
