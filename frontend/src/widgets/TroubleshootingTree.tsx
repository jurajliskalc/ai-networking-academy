import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Tree data (exported so it can be validated in tests) ----------

export interface Evidence { cmd: string; look: string }
export interface Choice { label: string; hint?: string; next: string }
export interface QuestionNode { kind: 'q'; title: string; body: string; checklist?: string[]; choices: Choice[] }
export interface LeafNode { kind: 'leaf'; title: string; cause: string; evidence: Evidence[]; fix: string; tone: 'danger' | 'warn' | 'data' }
export type TreeNode = QuestionNode | LeafNode;

export const ROOT = 'scope';

export const TREE: Record<string, TreeNode> = {
  scope: {
    kind: 'q', title: 'Scope before you touch anything',
    body: 'Preserve evidence first (NCCL logs, ethtool -S and hw_counters snapshots, dmesg, the change log), then answer the scoping questions. Write the answers in the incident log.',
    checklist: [
      'What exactly: hang, error, or slowdown? By how much, measured how?',
      'One job or all jobs? Jobs that share nodes, a rail, a pod, an NCCL version?',
      'One node, one rail (same GPU/NIC index on many hosts), or everywhere?',
      'Since when, constant or periodic, and what changed around then (firmware, config push, recabling, image)?',
    ],
    choices: [{ label: 'Scoped and evidence saved: reproduce it', next: 'repro' }],
  },
  repro: {
    kind: 'q', title: 'Reproduce without the model code',
    body: 'Run nccl-tests (all_reduce_perf) on the same nodes and placement as the failing job, with a known-good node set as a control, and ib_write_bw NIC by NIC between suspect hosts. What does the synthetic test show?',
    choices: [
      { label: 'It fails or hangs at initialisation', hint: 'before the first collective completes', next: 'init' },
      { label: 'It runs, then fails with an error mid-run', hint: 'NCCL WARN, completion error, timeout', next: 'midrun' },
      { label: 'It completes but busbw is below baseline', next: 'slow' },
      { label: 'Synthetic tests are clean; only the real job suffers', next: 'leaf-notnet' },
    ],
  },
  init: {
    kind: 'q', title: 'Fails at init: where does the NCCL_DEBUG=INFO log stop?',
    body: 'Re-run with NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,NET and read the first failing rank\'s log.',
    choices: [
      { label: 'Hangs at bootstrap, no NET/IB connection lines yet', next: 'leaf-bootstrap' },
      { label: 'Connect fails, or status 12 (retry exceeded) on the very first operation', next: 'init-qp' },
    ],
  },
  'init-qp': {
    kind: 'q', title: 'First packets never acknowledged',
    body: 'Test the pair with perftest, which exchanges QP info over TCP: ib_write_bw -d <dev> -x <gid-idx> on both ends. Then compare with rdma_cm (add -R, or rping).',
    choices: [
      { label: 'perftest also fails; GID index is not RoCE v2 on the expected subnet (or differs between hosts)', next: 'leaf-gid' },
      { label: 'perftest with TCP exchange works, rdma_cm (-R / rping) fails', next: 'leaf-rdmacm' },
      { label: 'Works inside a rack, fails across racks', next: 'leaf-routed' },
    ],
  },
  midrun: {
    kind: 'q', title: 'Fails mid-run: what is the first non-flush error?',
    body: 'Ignore the hundreds of status 5 (IBV_WC_WR_FLUSH_ERR) lines: they follow the first error. Find the first rank and peer that reported something else.',
    choices: [
      { label: 'Status 12: IBV_WC_RETRY_EXC_ERR (transport retry counter exceeded)', next: 'retry' },
      { label: 'Status 13: IBV_WC_RNR_RETRY_EXC_ERR (receiver not ready)', next: 'leaf-rnr' },
      { label: 'NCCL watchdog timeout with no RDMA completion error', next: 'leaf-gpu' },
    ],
  },
  retry: {
    kind: 'q', title: 'Retry exceeded: which pattern fits?',
    body: 'Retry exceeded means "no ACK within timeout × retry_cnt". Compare sender local_ack_timeout_err with receiver out_of_sequence, and look at link events in the same window.',
    choices: [
      { label: 'Coincides with link flaps (link_down_events_phy / LinkDownedCounter / switch log)', next: 'leaf-linkdown' },
      { label: 'Small messages fine, large ones fail (ib_write_bw -a size sweep)', next: 'leaf-mtu' },
      { label: 'Only under load; receiver out_of_sequence rising, drops on the RoCE queue', next: 'leaf-pfc' },
    ],
  },
  slow: {
    kind: 'q', title: 'Slow: how wide is it?',
    body: 'Bisect: per-node pairs against a known-good node, then per-rail nccl-tests. Map slow ranks to hosts and rails with your inventory.',
    choices: [
      { label: 'One node, or one rail (same NIC index on several hosts)', next: 'slow-one' },
      { label: 'All nodes / every rail roughly equally', next: 'slow-all' },
    ],
  },
  'slow-one': {
    kind: 'q', title: 'One node or rail: what does the NIC-level evidence show?',
    body: 'Run ib_write_bw from each NIC of the suspect host to a known-good host and compare with its sibling NICs, then read the host checks below.',
    choices: [
      { label: 'One NIC tops out near half rate; lspci LnkSta below LnkCap', next: 'leaf-pcie' },
      { label: 'One link with rising symbol/CRC errors or a corrected-bits outlier', next: 'leaf-ber' },
      { label: 'NIC perftest fine, but NCCL log shows NET/Socket or no GPU Direct RDMA', next: 'leaf-socket' },
      { label: 'NIC perftest fine; GPU↔NIC path is slow and crosses CPU sockets', next: 'leaf-numa' },
      { label: 'GPU-NIC peer traffic slow; PCIe switches show ACS redirect enabled', next: 'leaf-acs' },
    ],
  },
  'slow-all': {
    kind: 'q', title: 'Everywhere: what do the fabric counters say?',
    body: 'Take counter deltas on several hosts and their leaves during the test and compare with your baseline.',
    choices: [
      { label: 'PFC pauses rising but ECN marks / CNPs near zero, or drops on the RoCE priority', next: 'leaf-qos' },
      { label: 'No errors; big run-to-run variance; uneven uplink utilisation', next: 'leaf-ecmp' },
      { label: 'All uplinks evenly hot; busbw matches what the oversubscribed design can carry', next: 'leaf-oversub' },
    ],
  },

  'leaf-notnet': {
    kind: 'leaf', tone: 'data', title: 'Not (only) the network, or the test missed the path',
    cause: 'The synthetic test does not traverse the faulty component, or the bottleneck is compute, storage or the data loader.',
    evidence: [
      { cmd: 'all_reduce_perf on the exact job node list and placement', look: 'A convenient subset may avoid the bad link; reproduce with the same nodes' },
      { cmd: 'dcgmi diag -r 2', look: 'GPU health; levels vary by DCGM version' },
      { cmd: 'nvidia-smi -q -d PERFORMANCE', look: 'Clock event / throttle reasons (thermal, power)' },
      { cmd: 'dmesg -T | grep -i xid', look: 'GPU Xid errors on a straggler rank' },
    ],
    fix: 'Re-test with the job\'s nodes; if clean, profile the step (checkpoint writes, data loader, GPU throttling) and correlate with periodic events.',
  },
  'leaf-bootstrap': {
    kind: 'leaf', tone: 'warn', title: 'Bootstrap: wrong interface or blocked TCP',
    cause: 'NCCL bootstraps over TCP sockets on the interface chosen by NCCL_SOCKET_IFNAME (or auto-detection, which may pick docker0 or a management port). A firewall or wrong interface makes it hang before any RDMA traffic.',
    evidence: [
      { cmd: 'NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,NET', look: 'Which interface/IP NCCL picked for bootstrap ("Bootstrap : Using ...", wording varies by version)' },
      { cmd: 'ip -br addr', look: 'That the selected interface exists and is routable between all hosts' },
      { cmd: 'ss -ltnp ; nc -vz <peer> <port>', look: 'Listening sockets and whether TCP reaches the peer on that interface' },
    ],
    fix: 'Set NCCL_SOCKET_IFNAME to the correct interface on every rank; open the TCP ports between nodes (NCCL uses ephemeral ports).',
  },
  'leaf-gid': {
    kind: 'leaf', tone: 'danger', title: 'Wrong GID index or GID type',
    cause: 'GID indices follow the order addresses were added; after an IPv6 or VLAN change, a hard-coded index (NCCL_IB_GID_INDEX, ib_write_bw -x) may point at a link-local or RoCE v1 entry.',
    evidence: [
      { cmd: 'show_gids', look: 'Index, GID, IPv4, RoCE version, netdev (script shipped with some NVIDIA driver packages)' },
      { cmd: 'cat /sys/class/infiniband/<dev>/ports/1/gid_attrs/types/<idx>', look: '"RoCE v2" on every host for the index in use' },
      { cmd: 'ibv_devinfo -d <dev> -v', look: 'GID table, port state, active_mtu, link_layer' },
    ],
    fix: 'Use the RoCE v2 GID of the fabric subnet on every host (prefer NCCL automatic GID selection where your version supports it); add an admission check.',
  },
  'leaf-rdmacm': {
    kind: 'leaf', tone: 'warn', title: 'rdma_cm address resolution or a filtering hop',
    cause: 'Applications using rdma_cm resolve addresses and routes through the kernel; a missing route, wrong default RoCE mode for rdma_cm, or an ACL in the path breaks them while perftest with TCP exchange works. NCCL\'s built-in IB transport exchanges QP information over its own sockets rather than rdma_cm, so this explains rdma_cm-based tools and libraries; if NCCL itself fails while TCP-exchange perftest works, compare the GID index and traffic class NCCL used (INFO log) with the ones perftest used.',
    evidence: [
      { cmd: 'rping -s -v  /  rping -c -a <peer-ip> -v -C 5', look: 'rdma_cm connection set-up on its own' },
      { cmd: 'ip route get <peer-ip>', look: 'Route leaves via the RDMA netdev, not management' },
      { cmd: 'ib_write_bw -R -d <dev> <peer>', look: 'perftest using rdma_cm instead of TCP exchange' },
    ],
    fix: 'Fix routing to the RDMA interface, set rdma_cm to RoCE v2, and allow the traffic on routers/security groups. Host iptables usually does not see hardware RoCE (Soft-RoCE is the exception).',
  },
  'leaf-routed': {
    kind: 'leaf', tone: 'warn', title: 'RoCE v1 or UDP 4791 filtered on a routed hop',
    cause: 'RoCE v1 frames cannot cross a router; RoCE v2 (UDP 4791) can, unless an ACL or firewall appliance drops it.',
    evidence: [
      { cmd: 'show_gids  (or sysfs gid_attrs/types/<idx>)', look: 'Entry type for the index in use' },
      { cmd: 'switch/router ACL counters for UDP 4791', look: 'Hits on a deny rule at the rack boundary' },
    ],
    fix: 'Use RoCE v2 everywhere; permit UDP 4791 on fabric ACLs.',
  },
  'leaf-rnr': {
    kind: 'leaf', tone: 'data', title: 'Receiver not ready',
    cause: 'The responder had no receive WQE posted and kept answering RNR NAK until rnr_retry was exhausted: an application or library receive-posting problem, not a fabric fault.',
    evidence: [
      { cmd: 'rdma statistic show link <dev>/1', look: 'rnr_nak_retry_err (RNR NAKs received) rising on the requester' },
      { cmd: 'application / NCCL WARN log', look: 'Status 13 and the peer it names' },
    ],
    fix: 'Fix the receiver\'s posting rate or queue depth; rnr_retry = 7 means retry indefinitely where that is appropriate.',
  },
  'leaf-gpu': {
    kind: 'leaf', tone: 'data', title: 'Stuck rank: GPU or host fault',
    cause: 'A collective waits forever for one rank that stopped (GPU Xid, ECC error, process crash) while the network is fine.',
    evidence: [
      { cmd: 'dmesg -T | grep -iE "xid|aer|mlx5"', look: 'Xid errors, PCIe AER, NIC driver warnings on the stuck host' },
      { cmd: 'nvidia-smi', look: 'GPU state, ECC, utilisation stuck at 100 % or 0 %' },
      { cmd: 'NCCL_DEBUG=INFO (watchdog / async error message)', look: 'Which collective and rank the timeout names' },
    ],
    fix: 'Drain the host, repair or replace the GPU, restart from checkpoint; do not raise NCCL timeouts to hide it.',
  },
  'leaf-linkdown': {
    kind: 'leaf', tone: 'danger', title: 'Link flap',
    cause: 'A link going down kills in-flight QPs on that path; repeated flaps point at a loose connector, failing optic or thermal issue.',
    evidence: [
      { cmd: 'ethtool -S <netdev> | grep link_down_events_phy', look: 'Increments during the failure window' },
      { cmd: 'perfquery <lid> <port>', look: 'LinkDownedCounter, LinkErrorRecoveryCounter, SymbolErrorCounter on IB' },
      { cmd: 'mlxlink -d <dev> -c -m', look: 'Raw/effective BER, per-lane errors, module temperature' },
      { cmd: 'ethtool -m <netdev>', look: 'Per-lane Rx power far below siblings' },
    ],
    fix: 'Inspect and clean, reseat, swap optic then cable then port (one at a time); soak-test before returning to service.',
  },
  'leaf-mtu': {
    kind: 'leaf', tone: 'danger', title: 'MTU black hole',
    cause: 'A hop has a smaller MTU than RoCE packets need (4096 B payload plus headers ≈ 4.15 KB). RDMA has no PMTUD, so large packets are dropped silently.',
    evidence: [
      { cmd: 'ib_write_bw -a -d <dev> -x <idx> <peer>', look: 'Works up to some size, then status 12' },
      { cmd: 'ibv_devinfo -d <dev> | grep active_mtu', look: 'RDMA MTU both ends' },
      { cmd: 'ip link show <netdev>; switch interface MTU on every hop', look: 'One hop below the jumbo design MTU' },
    ],
    fix: 'Make MTU consistent end to end (jumbo on every fabric link, L2 and L3 MTU on switches); add an MTU consistency check.',
  },
  'leaf-pfc': {
    kind: 'leaf', tone: 'danger', title: 'RoCE running lossy: PFC not on the RoCE priority',
    cause: 'PFC is enabled on a different priority than the one RoCE traffic is classified onto (DSCP/PCP trust mismatch), so congestion drops packets and retransmissions (go-back-N on many NICs) pile up.',
    evidence: [
      { cmd: 'mlnx_qos -i <netdev>', look: 'Trust mode, PFC-enabled priorities, DSCP-to-priority map on the host' },
      { cmd: 'ethtool -S <netdev> | grep -E "prio3|discards"', look: 'RoCE bytes on which priority, pause counters zero, rx_discards_phy' },
      { cmd: 'nv show qos roce', look: 'Switch RoCE mode, PFC priority and ECN config (Cumulus Linux NVUE)' },
      { cmd: 'rdma statistic show link <dev>/1', look: 'out_of_sequence on receivers, packet_seq_err on senders' },
    ],
    fix: 'Align PFC priority and trust (DSCP or PCP) on NICs and switches end to end; roll back the offending change; add an intent check in CI.',
  },
  'leaf-pcie': {
    kind: 'leaf', tone: 'warn', title: 'PCIe link downtrained',
    cause: 'The NIC (or GPU) trained at a lower width or generation than its slot supports, often after maintenance; it can no longer feed line rate.',
    evidence: [
      { cmd: 'lspci -vv -s <bdf> | grep -E "LnkCap|LnkSta"', look: 'LnkSta width/speed below LnkCap (e.g. x8 instead of x16)' },
      { cmd: 'ib_write_bw per NIC vs siblings', look: 'One NIC near half of its peers' },
      { cmd: 'dmesg | grep -i aer', look: 'PCIe correctable/uncorrectable errors' },
    ],
    fix: 'Reseat or replace the card/riser; add LnkSta == LnkCap to node admission checks.',
  },
  'leaf-ber': {
    kind: 'leaf', tone: 'warn', title: 'Marginal link (BER)',
    cause: 'Errors escaping FEC drop packets; each costs an RDMA retransmission, making that rank a straggler.',
    evidence: [
      { cmd: 'ethtool -S <netdev> | grep -E "crc_errors_phy|symbol_err_phy|corrected_bits_phy"', look: 'Deltas versus sibling NICs' },
      { cmd: 'mlxlink -d <dev> -c', look: 'Raw BER vs vendor threshold, effective errors, per-lane imbalance' },
      { cmd: 'perfquery <lid> <port>', look: 'SymbolErrorCounter / PortRcvErrors rate on IB' },
    ],
    fix: 'Read both ends, clean and inspect connectors, swap optic/cable/port one at a time; soak before return.',
  },
  'leaf-socket': {
    kind: 'leaf', tone: 'warn', title: 'NCCL fell back to sockets or lost GPU Direct RDMA',
    cause: 'NCCL did not find or could not use the RDMA devices (missing plugin, NCCL_IB_HCA filter, NCCL_IB_DISABLE set, or peer memory module not loaded), so traffic goes over TCP or bounces through host memory.',
    evidence: [
      { cmd: 'NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,NET', look: 'NET/Socket instead of NET/IB; "GDRDMA" missing on channel lines (wording varies by version)' },
      { cmd: 'env | grep NCCL_', look: 'NCCL_IB_DISABLE, NCCL_IB_HCA, NCCL_NET_GDR_LEVEL set by the launcher or container' },
      { cmd: 'ibv_devinfo', look: 'Devices visible inside the container, PORT_ACTIVE' },
    ],
    fix: 'Expose the RDMA devices to the container, fix NCCL_IB_HCA, load the GPU peer-memory support your driver stack uses.',
  },
  'leaf-numa': {
    kind: 'leaf', tone: 'warn', title: 'NUMA / affinity mismatch',
    cause: 'The GPU-to-NIC mapping or CPU threads cross the inter-socket link (SYS in topo -m), adding latency and capping bandwidth.',
    evidence: [
      { cmd: 'nvidia-smi topo -m', look: 'GPU↔NIC relationship (PIX/PXB good, SYS crosses sockets) and CPU/NUMA affinity' },
      { cmd: 'cat /sys/class/net/<netdev>/device/numa_node', look: 'NIC NUMA node vs the GPU and the process binding' },
      { cmd: 'numactl --show (inside the rank)', look: 'Process bound to the wrong socket' },
    ],
    fix: 'Bind each rank to the CPU/NUMA node local to its GPU and NIC; check that NCCL picks the closest NIC per GPU.',
  },
  'leaf-acs': {
    kind: 'leaf', tone: 'warn', title: 'PCIe ACS redirecting peer-to-peer traffic',
    cause: 'With ACS enabled on PCIe switches, GPU↔NIC peer traffic is forced up to the root complex, which slows or breaks GPU Direct RDMA (common on bare metal; VMs need it for isolation).',
    evidence: [
      { cmd: 'sudo lspci -vvv | grep ACSCtl', look: '"SrcValid+" on PCIe switch ports between GPU and NIC' },
      { cmd: 'nvidia-smi topo -m', look: 'GPU and NIC under the same PCIe switch (PIX/PXB)' },
    ],
    fix: 'Disable ACS on bare-metal hosts (BIOS or setpci at boot), per the NCCL troubleshooting guide; keep it where virtualisation needs it.',
  },
  'leaf-qos': {
    kind: 'leaf', tone: 'danger', title: 'QoS / PFC / ECN configuration',
    cause: 'ECN not marking on the RoCE queue (PFC does all the work, head-of-line blocking spreads), CNPs on the wrong priority, or the lossless class misconfigured fleet-wide after a push.',
    evidence: [
      { cmd: 'nv show qos roce', look: 'RoCE mode, PFC priority, ECN thresholds on the switch (Cumulus NVUE)' },
      { cmd: 'mlnx_qos -i <netdev>', look: 'Host trust and PFC priorities match the switch' },
      { cmd: 'rdma statistic show link <dev>/1', look: 'np_ecn_marked_roce_packets, np_cnp_sent, rp_cnp_handled near zero while pauses rise' },
      { cmd: 'ethtool -S <netdev> | grep pause', look: 'rx_prio3_pause / tx_prio3_pause rates versus baseline' },
    ],
    fix: 'Restore ECN on the RoCE queue with thresholds below PFC XOFF, carry CNPs on their configured priority, roll back the template; add config intent checks.',
  },
  'leaf-ecmp': {
    kind: 'leaf', tone: 'data', title: 'ECMP collisions / polarization',
    cause: 'A few large RoCE flows hash onto the same uplinks while others idle; results vary from run to run.',
    evidence: [
      { cmd: 'switch per-uplink utilisation and ECN marks', look: 'Some members at 100 %, others far lower' },
      { cmd: 'repeat all_reduce_perf several times', look: 'busbw varies run to run with no errors' },
    ],
    fix: 'More QPs per connection (NCCL_IB_QPS_PER_CONNECTION) for entropy, different hash seeds per tier, adaptive routing where supported.',
  },
  'leaf-oversub': {
    kind: 'leaf', tone: 'data', title: 'Oversubscription: the fabric is doing what it was built for',
    cause: 'With a down:up ratio above 1:1, cross-leaf collectives can only reach the uplink share of host bandwidth.',
    evidence: [
      { cmd: 'busbw vs the fabric ceiling', look: 'Measured busbw ≈ host rate × uplink/downlink ratio' },
      { cmd: 'per-port switch counters', look: 'All uplinks evenly saturated, no drops' },
    ],
    fix: 'Rail-align placement so traffic stays below the leaf, schedule jobs within pods, or add spine capacity.',
  },
};

export function pathTitles(path: string[]): string[] {
  return path.map((id) => TREE[id].title);
}

// ---------- UI ----------

const toneCls = { danger: 'border-danger/40 text-danger', warn: 'border-warn/40 text-warn', data: 'border-data/40 text-data' } as const;

export default function TroubleshootingTree() {
  const [path, setPath] = useState<string[]>([ROOT]);
  const id = path[path.length - 1];
  const node = TREE[id];
  const go = (next: string) => setPath((p) => [...p, next]);

  return (
    <div className="space-y-4">
      <nav aria-label="Decision path" className="flex flex-wrap items-center gap-1 text-xs">
        {path.map((pid, i) => (
          <span key={pid} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted">›</span>}
            <button type="button" onClick={() => setPath(path.slice(0, i + 1))} aria-current={i === path.length - 1 ? 'step' : undefined}
              className={`rounded px-1.5 py-0.5 ${i === path.length - 1 ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}>
              {TREE[pid].title.length > 34 ? `${TREE[pid].title.slice(0, 32)}…` : TREE[pid].title}
            </button>
          </span>
        ))}
      </nav>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setPath((p) => (p.length > 1 ? p.slice(0, -1) : p))} disabled={path.length === 1}
          className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:bg-panel-2 disabled:opacity-40">← Back</button>
        <button type="button" onClick={() => setPath([ROOT])} disabled={path.length === 1}
          className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:bg-panel-2 disabled:opacity-40">Restart</button>
        <Pill>step {path.length}</Pill>
      </div>

      {node.kind === 'q' ? (
        <div className="rounded-xl border border-line bg-panel-2 p-4">
          <h3 className="text-base font-semibold">{node.title}</h3>
          <p className="mt-1 text-sm text-muted">{node.body}</p>
          {node.checklist && (
            <ul className="mt-3 space-y-1 text-sm">
              {node.checklist.map((c) => <li key={c} className="flex gap-2"><span className="text-accent">□</span><span>{c}</span></li>)}
            </ul>
          )}
          <div className="mt-4 grid gap-2">
            {node.choices.map((c) => (
              <button key={c.next} type="button" onClick={() => go(c.next)}
                className="rounded-lg border border-line bg-panel px-3 py-2 text-left text-sm transition hover:border-accent hover:bg-accent-soft">
                <span className="text-fg">{c.label}</span>
                {c.hint && <span className="block text-xs text-muted">{c.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={`rounded-xl border bg-panel-2 p-4 ${toneCls[node.tone].split(' ')[0]}`}>
          <div className={`font-mono text-[10px] uppercase tracking-[0.14em] ${toneCls[node.tone].split(' ')[1]}`}>Likely root cause</div>
          <h3 className="text-base font-semibold">{node.title}</h3>
          <p className="mt-1 text-sm text-muted">{node.cause}</p>
          <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Evidence to collect (snapshot, wait, snapshot: use deltas)</div>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead><tr className="border-b border-line text-xs text-muted"><th className="py-1 pr-3 font-medium">Command</th><th className="py-1 font-medium">What to look for</th></tr></thead>
              <tbody>
                {node.evidence.map((e) => (
                  <tr key={e.cmd} className="border-b border-line/60 align-top">
                    <td className="py-1.5 pr-3"><code className="font-mono text-xs text-data">{e.cmd}</code></td>
                    <td className="py-1.5 text-muted">{e.look}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
            <span className="font-semibold text-accent">Fix: </span>{node.fix}
          </div>
          <p className="mt-2 text-xs text-muted">Then verify with the same test that showed the fault, and turn the evidence into an alert or admission check.</p>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted">
        A teaching tree, not an exhaustive runbook: real incidents can match several branches at once, so confirm each hypothesis with a prediction and a test.
        Counter names (mlx5 ethtool and RDMA hw_counters), NCCL log wording and tool availability (show_gids, mlnx_qos, NVUE <span className="font-mono">nv</span> commands)
        vary by driver, firmware, NCCL and NOS release; check the documentation for your versions. Replace &lt;dev&gt;, &lt;netdev&gt;, &lt;bdf&gt; and &lt;lid&gt; with your device names.
      </p>
    </div>
  );
}
