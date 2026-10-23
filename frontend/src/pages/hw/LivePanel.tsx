// Live counters from the local agent (`aina-hw serve`, /api/live): rates from deltas, with sparklines.
// Polls only while the learner has pressed Start, about once a second, and pauses while the tab is hidden.
// Screen readers hear transitions (traffic started, pauses started, ...) through one polite live region,
// never every changing number.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Pause, Play, Unplug } from 'lucide-react';
import { advance, describeChange, emptyLive, flagsOf, fmtRate, parseLive, pauseRate, type Flags, type LiveState, type Sample } from '../../hw/live';
import { setHw, useHw } from '../../hw/store';
import { Button, Card, Pill } from '../../components/ui';

export const LIVE_POLL_MS = 1000;

type Phase = 'off' | 'connecting' | 'live' | 'error';

/** Poll /api/live while `on`. Returns the folded state, the phase and the last error. */
export function useLive(on: boolean) {
  const [hw] = useHw();
  const [state, setState] = useState<LiveState>(emptyLive);
  const [phase, setPhase] = useState<Phase>('off');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const base = hw.agentUrl.replace(/\/+$/, '');
  const poll = useCallback(async () => {
    if (busy.current || (typeof document !== 'undefined' && document.hidden)) return;
    busy.current = true;
    try {
      const r = await fetch(`${base}/api/live`, { cache: 'no-store' });
      if (r.status === 404) throw new Error('This agent has no live counters: update labs/hw-toolkit on host A and restart "aina-hw serve".');
      if (!r.ok) throw new Error(`/api/live: HTTP ${r.status}`);
      const res = parseLive(await r.json());
      setState((s) => advance(s, res));
      setPhase('live');
      setError(null);
      setHw((s) => (s.agentAt && Date.now() - Date.parse(s.agentAt) < 60_000 ? s : { ...s, agentAt: new Date().toISOString() }));
    } catch (e) {
      setPhase('error');
      setError(e instanceof TypeError ? `Could not reach ${base}. Is "aina-hw serve" running on host A and the SSH tunnel open?` : (e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [base]);
  useEffect(() => {
    if (!on) {
      setPhase('off');
      return;
    }
    setPhase('connecting');
    setState(emptyLive());
    void poll();
    const t = setInterval(() => void poll(), LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [on, poll]);
  return { state, phase, error, base };
}

/** A tiny line of the last samples; decorative (aria-hidden): the value next to it is the readout. */
function Sparkline({ values }: { values: (number | null)[] }) {
  const w = 96, h = 22;
  const nums = values.map((v) => (v === null ? null : v));
  const max = Math.max(1e-9, ...nums.filter((v): v is number => v !== null));
  const n = Math.max(nums.length, 2);
  const pts = nums.map((v, i) => (v === null ? null : `${((i / (n - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`));
  const segs: string[][] = [[]];
  for (const p of pts) p ? segs[segs.length - 1].push(p) : segs.push([]);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0 overflow-visible text-accent" data-testid="sparkline">
      <line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="var(--line)" strokeWidth="1" />
      {segs.filter((s) => s.length > 1).map((s, i) => <polyline key={i} points={s.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
      {segs.filter((s) => s.length === 1).map((s, i) => { const [x, y] = s[0].split(','); return <circle key={`d${i}`} cx={x} cy={y} r="1.5" fill="currentColor" />; })}
    </svg>
  );
}

interface Metric { id: string; label: string; unit: 'gbps' | 'ps'; get: (r: Sample['r']) => number | null; note?: string; alert?: boolean }

function metrics(prio: number, hist: Sample[] | undefined, ib: boolean): Metric[] {
  const kind = (dir: 'rx' | 'tx') => {
    for (let i = (hist?.length ?? 0) - 1; i >= 0; i--) { const k = pauseRate(hist![i].r, dir).kind; if (k) return k; }
    return null;
  };
  const pk = (dir: 'rx' | 'tx') => (kind(dir) === 'pfc' ? `PFC prio ${prio}` : kind(dir) === 'global' ? '802.3x global' : 'no pause counter');
  if (ib) return [
    { id: 'ibtx', label: 'IB data out', unit: 'gbps', get: (r) => r.ib_tx_gbps },
    { id: 'ibrx', label: 'IB data in', unit: 'gbps', get: (r) => r.ib_rx_gbps },
    { id: 'oos', label: 'Out of sequence', unit: 'ps', get: (r) => r.oos_ps, alert: true },
    { id: 'ackto', label: 'ACK timeouts', unit: 'ps', get: (r) => r.ack_timeout_ps, alert: true },
  ];
  return [
    { id: 'rdmatx', label: 'RDMA out', unit: 'gbps', get: (r) => r.rdma_tx_gbps, note: 'tx_vport_rdma_unicast_bytes' },
    { id: 'rdmarx', label: 'RDMA in', unit: 'gbps', get: (r) => r.rdma_rx_gbps, note: 'rx_vport_rdma_unicast_bytes' },
    { id: 'ptx', label: 'Pauses sent', unit: 'ps', get: (r) => pauseRate(r, 'tx').value, note: pk('tx') },
    { id: 'prx', label: 'Pauses received', unit: 'ps', get: (r) => pauseRate(r, 'rx').value, note: pk('rx') },
    { id: 'cnps', label: 'CNPs sent', unit: 'ps', get: (r) => r.cnp_sent_ps, note: 'np_cnp_sent (this host is the receiver)' },
    { id: 'cnph', label: 'CNPs handled', unit: 'ps', get: (r) => r.cnp_handled_ps, note: 'rp_cnp_handled (this host slows down)' },
    { id: 'ecn', label: 'ECN marked', unit: 'ps', get: (r) => r.ecn_marked_ps, note: 'np_ecn_marked_roce_packets' },
    { id: 'oos', label: 'Out of sequence', unit: 'ps', get: (r) => r.oos_ps, alert: true, note: 'out_of_sequence: packets lost on the way' },
    { id: 'seq', label: 'Seq. errors', unit: 'ps', get: (r) => r.seq_err_ps, alert: true, note: 'packet_seq_err' },
    { id: 'disc', label: 'Discards', unit: 'ps', get: (r) => r.discards_ps, alert: true, note: 'rx_discards_phy' },
  ];
}

const COMPACT = new Set(['rdmatx', 'rdmarx', 'ptx', 'prx', 'cnps', 'oos', 'ibtx', 'ibrx']);

function PortCard({ k, s, compact }: { k: string; s: LiveState; compact: boolean }) {
  const info = s.ports[k];
  const hist = s.history[k];
  const ib = info.port.link_layer === 'InfiniBand';
  const ms = metrics(s.prio, hist, ib).filter((m) => !compact || COMPACT.has(m.id));
  const label = `Host ${info.role} ${info.port.dev}/${info.port.port}`;
  return (
    <section aria-label={`Live counters, ${label}`} className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel-2 px-3 py-2">
        <div className="text-sm font-semibold">Host {info.role} <span className="font-mono text-xs font-normal text-muted">{info.port.dev}/{info.port.port}{info.port.netdev ? ` · ${info.port.netdev}` : ''}</span></div>
        <div className="flex gap-1.5 font-mono text-[11px]">
          <span className={info.port.state === 'ACTIVE' ? 'text-accent' : 'text-danger'}>{info.port.state ?? '?'}</span>
          {info.port.rate_gbps && <span className="text-muted">{info.port.rate_gbps}G {ib ? 'IB' : 'Eth'}</span>}
        </div>
      </div>
      <dl className={`grid gap-px bg-line ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'}`}>
        {ms.map((m) => {
          const vals = (hist ?? []).map((x) => m.get(x.r));
          const cur = [...vals].reverse().find((v) => v !== null) ?? null;
          const nums = vals.filter((v): v is number => v !== null);
          const peak = nums.length ? Math.max(...nums) : null;
          const bad = m.alert && (cur ?? 0) > 0;
          return (
            <div key={m.id} className="bg-panel p-2.5" title={m.note}>
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted">{m.label}</dt>
              <dd className="mt-1 flex items-end justify-between gap-2">
                <span className={`text-base font-semibold tabular-nums ${bad ? 'text-danger' : ''}`} data-metric={m.id}>{fmtRate(cur, m.unit)}</span>
                {!compact && <Sparkline values={vals} />}
              </dd>
              {!compact && <dd className="mt-0.5 truncate text-[10px] text-muted">{m.note ? `${m.note} · ` : ''}peak {fmtRate(peak, m.unit)}</dd>}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/** The live readout. `compact` is the sidebar version shown on hardware lab pages. */
export function LivePanel({ compact = false, autoStart = false }: { compact?: boolean; autoStart?: boolean }) {
  const [on, setOn] = useState(autoStart);
  const { state, phase, error, base } = useLive(on);
  const [announce, setAnnounce] = useState('');
  const flags = useRef<Record<string, Flags>>({});
  const lastSaid = useRef(0);
  // Announce transitions only, at most every 5 s.
  useEffect(() => {
    const msgs: string[] = [];
    for (const k of Object.keys(state.history)) {
      const h = state.history[k];
      const now = flagsOf(h[h.length - 1]?.r);
      const before = flags.current[k] ?? { traffic: false, pause: false, cnp: false, oos: false };
      const info = state.ports[k];
      const msg = info ? describeChange(`Host ${info.role} ${info.port.dev}/${info.port.port}`, before, now) : null;
      if (msg) msgs.push(msg);
      flags.current[k] = now;
    }
    if (msgs.length && Date.now() - lastSaid.current > 5000) {
      lastSaid.current = Date.now();
      setAnnounce(msgs.join(' '));
    }
  }, [state]);
  const keys = Object.keys(state.ports).sort();
  const remoteErrors = state.hosts.filter((h) => !h.ok && h.role !== 'A');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={on ? 'ghost' : 'primary'} onClick={() => setOn((v) => !v)} pressed={on} label={on ? 'Stop live counters' : 'Start live counters'}>
          {on ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}{on ? 'Stop' : 'Start live counters'}
        </Button>
        <span className="text-xs text-muted" role="status">
          {phase === 'off' && <>Reads <code>{base}/api/live</code> once a second while running.</>}
          {phase === 'connecting' && 'Connecting...'}
          {phase === 'live' && <span className="inline-flex items-center gap-1 text-accent"><Activity size={13} aria-hidden />Live · lossless priority {state.prio}</span>}
        </span>
      </div>
      {phase === 'error' && error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger"><Unplug size={14} className="mt-px shrink-0" aria-hidden />{error}</div>}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announce}</p>
      {on && keys.length > 0 && (
        <div className={compact ? 'space-y-3' : 'grid gap-3 2xl:grid-cols-2'}>
          {keys.map((k) => <PortCard key={k} k={k} s={state} compact={compact} />)}
        </div>
      )}
      {on && phase === 'live' && !state.remote && (
        <p className="text-[11px] text-muted">Only host A is shown. Start the agent with <code>./aina-hw serve --live-remote</code> to add host B over one SSH session (sampled every 2 s).</p>
      )}
      {remoteErrors.map((h) => (
        <p key={h.role} className="text-[11px] text-warn">Host {h.role}: {h.error ? `not reachable (${h.error})` : 'starting the SSH session...'}</p>
      ))}
      {on && phase === 'live' && !compact && <p className="text-[11px] text-muted">Rates are deltas between samples of the same host. RDMA traffic is offloaded: it shows in the vport RDMA and priority counters, not in the netdev byte counters.</p>}
    </div>
  );
}

/** Sidebar card for hardware lab pages: offered once the agent has been reached from this browser. */
export function LiveCard() {
  const [hw] = useHw();
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Live counters</div>
        <Link to="/hw/live" className="text-xs text-data hover:underline">Full view</Link>
      </div>
      {hw.agentAt ? <LivePanel compact />
        : <p className="text-xs text-muted">Watch bandwidth, pauses, CNPs and drops while you run the lab: start <code>./aina-hw serve</code> on host A and <Link to="/hw/connect" className="text-data underline underline-offset-2">connect it</Link> first.</p>}
      <Pill className="mt-3">read-only</Pill>
    </Card>
  );
}
