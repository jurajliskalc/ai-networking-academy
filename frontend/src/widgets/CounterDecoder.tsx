import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Data and pure scoring logic (exported for unit tests) ----------

export type Group = 'host' | 'rdma' | 'switch' | 'ib';
export type State = 'rising' | 'flat' | 'unknown';
export interface Counter { id: string; name: string; group: Group; meaning: string }

export const GROUPS: Record<Group, string> = {
  host: 'Host NIC: ethtool -S (mlx5)',
  rdma: 'Host RDMA: hw_counters / rdma statistic',
  switch: 'Switch port / queue (RoCE priority)',
  ib: 'InfiniBand PMA: perfquery',
};

// Meanings follow the Linux kernel mlx5 counters documentation, the mlx5 RDMA counters and the IBTA PortCounters.
export const COUNTERS: Counter[] = [
  { id: 'crc', group: 'host', name: 'rx_crc_errors_phy', meaning: 'Received packets dropped on the physical port because of FCS errors' },
  { id: 'sym', group: 'host', name: 'rx_symbol_err_phy', meaning: 'Received packets dropped because of physical coding (symbol) errors; rx_pcs_symbol_err_phy counts the errors FEC could not correct' },
  { id: 'lde', group: 'host', name: 'link_down_events_phy', meaning: 'Times the link operational state went down (port flapping)' },
  { id: 'disc', group: 'host', name: 'rx_discards_phy', meaning: 'Received packets dropped for lack of buffer on the physical port: the adapter cannot absorb incoming traffic' },
  { id: 'oob', group: 'host', name: 'rx_out_of_buffer', meaning: 'Times a (netdev) receive queue had no software buffers posted for incoming traffic' },
  { id: 'rxp', group: 'host', name: 'rx_prio3_pause', meaning: 'PFC pause frames received from the far end on priority 3 (the switch is pausing this NIC); present only if PFC is enabled on that priority' },
  { id: 'txp', group: 'host', name: 'tx_prio3_pause', meaning: 'PFC pause frames sent on priority 3 (this NIC is pausing the switch); present only if PFC is enabled on that priority' },
  { id: 'storm', group: 'host', name: 'tx_pause_storm_warning_events', meaning: 'Times the device was sending pauses for a long period (pause storm prevention)' },
  { id: 'oos', group: 'rdma', name: 'out_of_sequence', meaning: 'Out-of-sequence packets received (responder saw a PSN gap)' },
  { id: 'pse', group: 'rdma', name: 'packet_seq_err', meaning: 'NAK sequence-error packets received (requester; QP retry limit not yet exceeded)' },
  { id: 'lat', group: 'rdma', name: 'local_ack_timeout_err', meaning: 'Requester ACK timer expired (QP retry limit not yet exceeded)' },
  { id: 'cnps', group: 'rdma', name: 'np_cnp_sent', meaning: 'CNPs sent by this node as Notification Point after receiving ECN-CE marked RoCEv2 packets' },
  { id: 'cnph', group: 'rdma', name: 'rp_cnp_handled', meaning: 'CNPs handled by this node as Reaction Point to throttle its send rate' },
  { id: 'ecnr', group: 'rdma', name: 'np_ecn_marked_roce_packets', meaning: 'RoCEv2 packets received with ECN bits 11 (CE)' },
  { id: 'rnr', group: 'rdma', name: 'rnr_nak_retry_err', meaning: 'RNR NAKs received: the responder had no receive WQE (QP retry limit not yet exceeded)' },
  { id: 'swdrop', group: 'switch', name: 'drops on lossless queue', meaning: 'Packets dropped on the RoCE (should-be lossless) queue' },
  { id: 'swpfctx', group: 'switch', name: 'PFC pause tx', meaning: 'Switch sends pause upstream: its ingress buffer for that port/priority is filling' },
  { id: 'swpfcrx', group: 'switch', name: 'PFC pause rx', meaning: 'Switch is paused by its neighbour (host or next switch) on that priority' },
  { id: 'swecn', group: 'switch', name: 'ECN marked packets', meaning: 'Egress queue crossed its ECN threshold and marked CE' },
  { id: 'swwm', group: 'switch', name: 'buffer watermark high', meaning: 'Peak queue/pool occupancy since last read is near the limit' },
  { id: 'ibsym', group: 'ib', name: 'SymbolErrorCounter', meaning: 'Minor link errors detected on one or more physical lanes' },
  { id: 'ibld', group: 'ib', name: 'LinkDownedCounter', meaning: 'Link error recovery failed and the link went down' },
  { id: 'ibrcv', group: 'ib', name: 'PortRcvErrors', meaning: 'Received packets with errors (CRC, malformed, buffer overrun)' },
  { id: 'ibxd', group: 'ib', name: 'PortXmitDiscards', meaning: 'Outbound packets discarded because the port was down or congested (e.g. head-of-queue timeout)' },
  { id: 'ibxw', group: 'ib', name: 'PortXmitWait', meaning: 'Ticks the port had data to send but sent nothing (no credits or no arbitration): IB congestion' },
];

export type HypId = 'link' | 'nopfc' | 'storm' | 'slowrx' | 'noecn' | 'deadlock' | 'rnr' | 'busy';
export interface Hypothesis { id: HypId; title: string; next: string }
export const HYPOTHESES: Hypothesis[] = [
  { id: 'link', title: 'Bad link, optic or cable', next: 'mlxlink -d <dev> -c -m and ethtool -m <netdev> on both ends (BER, per-lane errors, Rx power); perfquery on IB; swap one part at a time' },
  { id: 'nopfc', title: 'Congestion without PFC protection (RoCE lossy)', next: 'mlnx_qos -i <netdev> on hosts and nv show qos roce on switches: PFC priority and trust must match the priority RoCE traffic actually uses (check rx_prioN_bytes)' },
  { id: 'storm', title: 'PFC misconfiguration or pause storm', next: 'ethtool -S <netdev> | grep -E "pause|storm" on hosts; per-port PFC tx counters to find the port that originates the pauses; check the PFC watchdog' },
  { id: 'slowrx', title: 'Receiver too slow to drain (host side)', next: 'lspci -vv (LnkSta vs LnkCap), nvidia-smi topo -m (NUMA), rx_out_of_buffer / RDMA out_of_buffer, IRQ and CPU affinity' },
  { id: 'noecn', title: 'ECN / DCQCN not working', next: 'nv show qos roce (ECN thresholds on the RoCE queue); rdma statistic show link <dev>/1 for np_cnp_sent and rp_cnp_handled; confirm CNP priority' },
  { id: 'deadlock', title: 'Routing loop or PFC deadlock', next: 'Look for pause on every port of a cycle with no drain; check routing tables and traceroute/netq trace for loops; PFC watchdog events' },
  { id: 'rnr', title: 'Receiver not ready (no receive WQEs)', next: 'Application or NCCL log for IBV_WC_RNR_RETRY_EXC_ERR (13) and the peer; check receive queue depth and the QP rnr_retry setting' },
  { id: 'busy', title: 'Healthy-busy: congestion control doing its job', next: 'Compare rates with rail peers and baseline; check per-uplink utilisation for ECMP imbalance before changing anything' },
];

interface Rule { hyp: HypId; pts: number; rising?: string[]; anyRising?: string[]; flat?: string[]; why: string }

// rising: all must be rising; anyRising: at least one rising; flat: all must be marked flat (checked, not rising).
export const RULES: Rule[] = [
  { hyp: 'link', pts: 3, anyRising: ['crc', 'sym'], why: 'FCS / symbol-error drops on the host port' },
  { hyp: 'link', pts: 3, anyRising: ['lde', 'ibld'], why: 'link went down (flap)' },
  { hyp: 'link', pts: 3, anyRising: ['ibsym', 'ibrcv'], why: 'IB symbol or receive errors on the port' },
  { hyp: 'link', pts: 1, rising: ['oos'], flat: ['swdrop', 'disc'], why: 'packets lost but no buffer drops anywhere: corruption is the likelier loss' },
  { hyp: 'link', pts: -2, flat: ['crc', 'sym'], why: 'host physical error counters checked and flat' },
  { hyp: 'nopfc', pts: 4, rising: ['swdrop'], why: 'drops on the queue that should be lossless' },
  { hyp: 'nopfc', pts: 3, rising: ['disc'], why: 'NIC dropped for lack of buffer instead of pausing' },
  { hyp: 'nopfc', pts: 2, anyRising: ['oos', 'pse'], why: 'RC transport sees sequence gaps (loss)' },
  { hyp: 'nopfc', pts: 2, anyRising: ['swdrop', 'disc'], flat: ['rxp', 'txp'], why: 'drops while no pause on priority 3: PFC is not acting on the RoCE priority' },
  { hyp: 'storm', pts: 3, rising: ['storm'], why: 'NIC pause-storm detector fired' },
  { hyp: 'storm', pts: 1, rising: ['txp'], why: 'host is sending pause' },
  { hyp: 'storm', pts: 2, rising: ['swpfcrx', 'swpfctx'], why: 'pause received and propagated by the switch' },
  { hyp: 'storm', pts: 1, rising: ['rxp'], why: 'host NIC is being paused' },
  { hyp: 'slowrx', pts: 3, rising: ['oob'], why: 'host receive queues ran out of posted buffers' },
  { hyp: 'slowrx', pts: 3, rising: ['txp'], why: 'host pauses the switch: it cannot drain its receive buffer' },
  { hyp: 'slowrx', pts: 1, rising: ['disc'], why: 'NIC buffer overflowing' },
  { hyp: 'slowrx', pts: 3, rising: ['storm'], why: 'a host NIC that pauses for a long time has usually stopped draining (PCIe, host memory, stalled driver)' },
  { hyp: 'slowrx', pts: 1, rising: ['swpfcrx'], why: 'switch is paused by a downstream neighbour' },
  { hyp: 'slowrx', pts: 1, rising: ['ibxw'], why: 'IB port waits for credits from a slow receiver' },
  { hyp: 'noecn', pts: 4, anyRising: ['rxp', 'swpfctx'], flat: ['cnps', 'cnph'], why: 'pauses rising while CNPs are flat: PFC is doing all the congestion control' },
  { hyp: 'noecn', pts: 3, rising: ['ecnr'], flat: ['cnps'], why: 'CE-marked packets arrive but no CNPs are sent (NP side disabled?)' },
  { hyp: 'noecn', pts: 2, rising: ['swecn'], flat: ['ecnr'], why: 'switch marks, receiver sees no CE: marks on another queue or ECN bits rewritten' },
  { hyp: 'noecn', pts: 2, rising: ['swwm'], flat: ['swecn'], why: 'queue near full without ECN marking' },
  { hyp: 'noecn', pts: -3, anyRising: ['cnps', 'cnph'], why: 'CNPs are flowing, so DCQCN is at least partly working' },
  { hyp: 'deadlock', pts: 2, rising: ['swpfctx', 'swpfcrx', 'rxp'], why: 'pause in every direction you looked' },
  { hyp: 'deadlock', pts: 2, rising: ['lat'], why: 'ACK timeouts: packets (or ACKs) stuck or lost in the fabric' },
  { hyp: 'deadlock', pts: 2, rising: ['ibxd'], why: 'IB transmit discards (head-of-queue lifetime, routing to a dead port)' },
  { hyp: 'deadlock', pts: -2, anyRising: ['swecn', 'cnps'], flat: ['lat', 'ibxd'], why: 'traffic still draining and ACKing' },
  { hyp: 'rnr', pts: 5, rising: ['rnr'], why: 'RNR NAKs received: responder had no receive WQE posted' },
  { hyp: 'busy', pts: 2, anyRising: ['swecn', 'ecnr'], why: 'ECN marking active' },
  { hyp: 'busy', pts: 2, rising: ['cnps', 'cnph'], why: 'CNPs sent and handled: DCQCN loop closed' },
  { hyp: 'busy', pts: 1, anyRising: ['rxp', 'ibxw', 'swwm'], why: 'some pause / wait / buffer use under load' },
  { hyp: 'busy', pts: -4, anyRising: ['swdrop', 'disc', 'crc', 'sym', 'oos', 'lat', 'storm', 'lde', 'ibld', 'ibrcv'], why: 'drops, errors or retransmissions are never healthy' },
];

export type States = Record<string, State>;
export interface Ranked { hyp: Hypothesis; score: number; reasons: { pts: number; why: string }[] }

export function ruleFires(r: Rule, s: States): boolean {
  if (r.rising && !r.rising.every((c) => s[c] === 'rising')) return false;
  if (r.anyRising && !r.anyRising.some((c) => s[c] === 'rising')) return false;
  if (r.flat && !r.flat.every((c) => s[c] === 'flat')) return false;
  return Boolean(r.rising || r.anyRising || r.flat);
}

export function rankHypotheses(s: States): Ranked[] {
  return HYPOTHESES.map((hyp) => {
    const reasons = RULES.filter((r) => r.hyp === hyp.id && ruleFires(r, s)).map((r) => ({ pts: r.pts, why: r.why }));
    return { hyp, score: reasons.reduce((a, r) => a + r.pts, 0), reasons };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
}

export const PRESETS: { label: string; rising: string[]; flat: string[] }[] = [
  { label: 'Dirty optic', rising: ['crc', 'sym', 'oos', 'pse'], flat: ['swdrop', 'disc', 'rxp', 'txp'] },
  { label: 'PFC on wrong priority', rising: ['swdrop', 'oos', 'pse', 'lat', 'swecn'], flat: ['rxp', 'txp', 'crc', 'sym'] },
  { label: 'ECN disabled', rising: ['rxp', 'swpfctx', 'swwm'], flat: ['cnps', 'cnph', 'swecn', 'ecnr', 'swdrop'] },
  { label: 'Host cannot drain', rising: ['txp', 'swpfcrx', 'storm', 'swpfctx'], flat: ['crc', 'sym', 'swdrop'] },
  { label: 'Healthy incast', rising: ['swecn', 'ecnr', 'cnps', 'cnph', 'rxp'], flat: ['swdrop', 'disc', 'oos', 'crc', 'sym', 'lat'] },
];

// ---------- UI ----------

const STATES: State[] = ['rising', 'flat', 'unknown'];
const stateLabel: Record<State, string> = { rising: 'rising', flat: 'flat', unknown: '?' };
const stateCls: Record<State, string> = {
  rising: 'border-danger bg-danger/10 text-danger', flat: 'border-accent bg-accent-soft text-accent', unknown: 'border-line bg-panel-2 text-muted',
};

export default function CounterDecoder() {
  const [s, setS] = useState<States>({});
  const ranked = useMemo(() => rankHypotheses(s), [s]);
  const set = (id: string, v: State) => setS((p) => ({ ...p, [id]: v }));
  const top = ranked[0]?.score ?? 1;
  const nRising = Object.values(s).filter((v) => v === 'rising').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Try a scenario:</span>
        {PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => setS(Object.fromEntries([...p.rising.map((c) => [c, 'rising']), ...p.flat.map((c) => [c, 'flat'])]))}
            className="rounded-md border border-line bg-panel px-2 py-1 text-xs hover:bg-panel-2">{p.label}</button>
        ))}
        <button type="button" onClick={() => setS({})} className="rounded-md border border-line bg-panel px-2 py-1 text-xs text-muted hover:bg-panel-2">Clear</button>
      </div>
      <p className="text-xs text-muted">Mark each counter by its <strong>delta</strong> over the bad window (compare with healthy peers): rising, flat (checked, not moving) or ? (not checked). Priority 3 stands for your RoCE priority.</p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {(Object.keys(GROUPS) as Group[]).map((g) => (
            <fieldset key={g} className="rounded-lg border border-line bg-panel p-2">
              <legend className="px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{GROUPS[g]}</legend>
              <div className="divide-y divide-line">
                {COUNTERS.filter((c) => c.group === g).map((c) => {
                  const v = s[c.id] ?? 'unknown';
                  return (
                    <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-xs text-fg">{c.name}</div>
                        <div className="text-[11px] leading-snug text-muted">{c.meaning}</div>
                      </div>
                      <div className="flex gap-1" role="group" aria-label={`${c.name} state`}>
                        {STATES.map((st) => (
                          <button key={st} type="button" aria-pressed={v === st} onClick={() => set(c.id, st)}
                            className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${v === st ? stateCls[st] : 'border-line bg-panel hover:bg-panel-2 text-muted'}`}>
                            {stateLabel[st]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="space-y-2 lg:sticky lg:top-4 lg:self-start" aria-live="polite">
          <div className="flex items-center gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Ranked hypotheses</div>
            <Pill>{nRising} rising</Pill>
          </div>
          {ranked.length === 0 && <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm text-muted">Mark some counters as rising (or pick a scenario) to see hypotheses.</div>}
          {ranked.map((r, i) => (
            <div key={r.hyp.id} className={`rounded-lg border p-3 ${i === 0 ? 'border-accent bg-accent-soft/40' : 'border-line bg-panel-2'}`}>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-semibold">{i + 1}. {r.hyp.title}</div>
                <div className="font-mono text-sm tabular-nums text-accent">{r.score}</div>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-panel">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(100 * r.score) / top}%` }} />
              </div>
              <ul className="mt-2 space-y-0.5 text-xs">
                {r.reasons.map((x) => (
                  <li key={x.why} className="flex gap-2"><span className={`w-7 shrink-0 text-right font-mono ${x.pts > 0 ? 'text-accent' : 'text-danger'}`}>{x.pts > 0 ? `+${x.pts}` : x.pts}</span><span className="text-muted">{x.why}</span></li>
                ))}
              </ul>
              <div className="mt-2 text-xs"><span className="font-semibold text-data">Next: </span><span className="text-muted">{r.hyp.next}</span></div>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Scores are a teaching heuristic (hand-weighted rules shown next to each hypothesis), not a diagnosis: several causes often coexist, and one is usually the
        consequence of another (an ECMP collision causes congestion, which causes pause). Counter meanings follow the kernel mlx5 counters documentation, the mlx5
        RDMA hw_counters and the IBTA PortCounters; names and availability vary by driver, firmware and switch OS, so verify on your version. Switch counter names are
        generic: map them to your NOS. <span className="font-mono">rx_out_of_buffer</span> counts netdev receive queues; RDMA receive starvation shows in the hw_counter
        <span className="font-mono"> out_of_buffer</span> instead.
      </p>
    </div>
  );
}
