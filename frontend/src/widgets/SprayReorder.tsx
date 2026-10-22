import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

// ---------- Pure model (unit-testable). Time unit: one "slot" = the time to serialize one packet at line rate. ----------
//
// Sources:
// - RoCEv2 RC receiver behaviour (IBTA IBA Vol. 1, ch. 9.7, reliable service; lesson adaptive-routing-packet-spraying):
//   the responder expects PSN = ePSN; a higher PSN is a sequence error, it is discarded and answered with a
//   NAK (PSN sequence error) carrying ePSN; further out-of-sequence packets are discarded silently until ePSN
//   arrives; a lower PSN is a duplicate (dropped, re-acknowledged). The requester retransmits from the NAKed PSN
//   onwards (go-back-N, as on many NIC generations).
// - "Reordered" packet: RFC 4737 (a packet whose sequence number is lower than the next expected, i.e. lower than
//   the highest seen so far + 1). Displacement (arrival position minus send position): RFC 5236.
// - Direct data placement and completion-when-all-arrived: lessons adaptive-routing-packet-spraying (NVIDIA's
//   description of Spectrum-X SuperNICs) and ultra-ethernet (UET RUD delivery mode).

/** RoCEv2 RC WRITE middle packet, 4096 B payload: Eth 14 + IPv4 20 + UDP 8 + BTH 12 + payload + ICRC 4 + FCS 4 = 4158 B, + 20 B preamble/IPG. */
export const WIRE_BYTES = 4096 + 14 + 20 + 8 + 12 + 4 + 4 + 20; // 4178
export const PAYLOAD = 4096;
export const slotNs = (gbps: number) => (WIRE_BYTES * 8) / gbps; // 400G: 33 424 bit / 400 = 83.56 ns

export interface SprayCfg {
  k: number;               // packets in the message
  delays: number[];        // one-way delay of each path, slots (>= 1)
  congested: number | null; // index of a path with a standing queue, or null
  backlog: number;         // packets of other traffic queued ahead on that path at t = 0
}
export interface Pkt { psn: number; path: number; send: number; arrive: number }

/**
 * A fabric of P paths. Each path has one FIFO hop served at line rate (1 slot per packet); the congested path
 * starts with `backlog` packets of other traffic ahead. arrival = send + queueing wait + path delay.
 */
export function makeFabric(cfg: SprayCfg, service = 1) {
  const free = cfg.delays.map((_, p) => (p === cfg.congested ? cfg.backlog : 0));
  return (t: number, p: number) => {
    const wait = Math.max(0, free[p] - t);
    free[p] = Math.max(free[p], t) + service;
    return t + wait + (service - 1) + cfg.delays[p];
  };
}

/** First transmission: packet i leaves at slot i on path i mod P (round-robin spray). */
export function sprayArrivals(cfg: SprayCfg): Pkt[] {
  const send = makeFabric(cfg), P = cfg.delays.length;
  return Array.from({ length: cfg.k }, (_, i) => ({ psn: i, path: i % P, send: i, arrive: send(i, i % P) }));
}

/** PSNs in arrival order; simultaneous arrivals in send order. */
export const arrivalOrder = (pkts: Pkt[]) => [...pkts].sort((a, b) => a.arrive - b.arrive || a.send - b.send).map((p) => p.psn);

export function reorderStats(order: number[]) {
  let maxSeen = -1, reordered = 0, maxDisp = 0;
  const late: boolean[] = [];
  order.forEach((psn, pos) => {
    const isLate = psn < maxSeen + 1 && maxSeen >= 0; // RFC 4737: s < NextExp
    late.push(isLate); if (isLate) reordered++;
    maxSeen = Math.max(maxSeen, psn);
    maxDisp = Math.max(maxDisp, Math.abs(pos - psn)); // RFC 5236 displacement
  });
  return { reordered, fraction: order.length ? reordered / order.length : 0, maxDisplacement: maxDisp, late };
}

/** What a go-back-N RC receiver does with one pass of arrivals (no retransmissions yet). */
export function goBackNPass(order: number[]) {
  let e = 0, nakState = false, accepted = 0, discarded = 0;
  const naks: number[] = [];
  for (const psn of order) {
    if (psn === e) { e++; accepted++; nakState = false; }
    else if (psn > e) { discarded++; if (!nakState) { naks.push(e); nakState = true; } }
    // psn < e: duplicate, cannot happen in a single pass
  }
  return { accepted, discarded, naks, ePsn: e };
}

/** Reorder buffer: hold packets that arrive ahead of the next expected PSN, release in order. */
export function reorderBuffer(order: number[]) {
  const held = new Set<number>();
  let e = 0, peak = 0;
  const occupancy: number[] = [];
  for (const psn of order) {
    if (psn === e) { e++; while (held.has(e)) { held.delete(e); e++; } }
    else held.add(psn);
    peak = Math.max(peak, held.size);
    occupancy.push(held.size);
  }
  return { peak, occupancy };
}

export interface GbnResult { sent: number; retransmitted: number; naks: number; discarded: number; duplicates: number; completion: number; done: boolean }

/**
 * Slot-by-slot simulation of a sprayed RC message with go-back-N. In each slot: (1) the receiver processes arrivals,
 * (2) NAKs reach the sender after `rev` slots and rewind its next PSN, (3) the sender transmits one packet, on path
 * (transmission count mod P). Window, ACK pacing and timeouts are not modelled (no packet is really lost).
 */
export function simulateGoBackN(cfg: SprayCfg, rev = Math.max(1, Math.min(...cfg.delays)), limit = 200_000): GbnResult {
  const P = cfg.delays.length, send = makeFabric(cfg);
  const inflight: { psn: number; arrive: number; seq: number }[] = [];
  const nakAt: { t: number; psn: number }[] = [];
  let nxt = 0, tx = 0, e = 0, nakState = false, naks = 0, discarded = 0, duplicates = 0, completion = -1;
  for (let t = 0; t < limit; t++) {
    const now = inflight.filter((p) => p.arrive === t).sort((a, b) => a.seq - b.seq);
    for (const p of now) {
      if (p.psn === e) { e++; nakState = false; if (e === cfg.k) completion = t; }
      else if (p.psn > e) { discarded++; if (!nakState) { nakState = true; naks++; nakAt.push({ t: t + rev, psn: e }); } }
      else duplicates++;
    }
    if (completion >= 0) break;
    for (let i = inflight.length - 1; i >= 0; i--) if (inflight[i].arrive === t) inflight.splice(i, 1);
    for (let i = nakAt.length - 1; i >= 0; i--) if (nakAt[i].t === t) { if (nakAt[i].psn < nxt) nxt = nakAt[i].psn; nakAt.splice(i, 1); }
    if (nxt < cfg.k) { inflight.push({ psn: nxt, arrive: send(t, tx % P), seq: tx }); nxt++; tx++; }
  }
  return { sent: tx, retransmitted: tx - cfg.k, naks, discarded, duplicates, completion, done: completion >= 0 };
}

/** Per-flow ECMP: the whole message on one hashed path, in order. A colliding elephant flow halves its share of the link. */
export function ecmpCompletion(cfg: SprayCfg, path: number, collide: boolean) {
  const send = makeFabric(cfg, collide ? 2 : 1);
  let last = 0;
  for (let i = 0; i < cfg.k; i++) last = send(i, path);
  return last;
}

/** Completion when the receiver places or reorders: the last arrival of the first transmission. */
export const lastArrival = (pkts: Pkt[]) => Math.max(...pkts.map((p) => p.arrive));

// ---------- UI ----------

const cap = 'font-mono text-[10px] uppercase tracking-[0.14em] text-muted';
const btn = (on: boolean) => `min-h-6 rounded-md border px-2 py-1 font-mono text-xs transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;
const PATH_COLORS = ['var(--data)', 'var(--accent)', 'var(--warn)', 'var(--muted)', 'var(--data)', 'var(--accent)', 'var(--warn)', 'var(--muted)'];
const PATH_DASH = ['', '', '', '', '4 3', '4 3', '4 3', '4 3'];

function Out({ label, value, sub, tone = 'text-fg' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

const DELAY_PRESETS: { id: string; label: string; delays: number[] }[] = [
  { id: 'equal', label: 'Equal delays', delays: [6, 6, 6, 6, 6, 6, 6, 6] },
  { id: 'one-slow', label: 'One path +4', delays: [6, 10, 6, 6, 6, 6, 6, 6] },
  { id: 'skewed', label: 'Skewed', delays: [4, 9, 6, 12, 5, 8, 7, 10] },
];

function Ladder({ pkts, late, k }: { pkts: Pkt[]; late: boolean[]; k: number }) {
  const W = 640, H = 170, L = 70, R = 14, top = 34, bot = 128;
  const tMax = Math.max(1, ...pkts.map((p) => p.arrive)) + 1;
  const x = (t: number) => L + (t / tMax) * (W - L - R);
  const order = arrivalOrder(pkts);
  const lateSet = new Set(order.filter((_, i) => late[i]));
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((v) => tMax / v <= 6) ?? 2000;
  const ticks = Array.from({ length: Math.floor(tMax / step) + 1 }, (_, i) => i * step);
  const showLabels = k <= 16;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
      aria-label={`Ladder diagram: ${k} packets leave the sender in PSN order over ${new Set(pkts.map((p) => p.path)).size} paths and arrive in the order ${order.join(', ')}. ${lateSet.size} arrive after a higher PSN.`}>
      <line x1={L} y1={top} x2={W - R} y2={top} stroke="var(--border)" strokeWidth={2} />
      <line x1={L} y1={bot} x2={W - R} y2={bot} stroke="var(--border)" strokeWidth={2} />
      <text x={L - 8} y={top + 4} textAnchor="end" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">sender</text>
      <text x={L - 8} y={bot + 4} textAnchor="end" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">receiver</text>
      {pkts.map((p) => (
        <line key={p.psn} x1={x(p.send)} y1={top} x2={x(p.arrive)} y2={bot} stroke={PATH_COLORS[p.path]} strokeDasharray={PATH_DASH[p.path]} strokeWidth={lateSet.has(p.psn) ? 2 : 1.2} opacity={0.9} />
      ))}
      {showLabels && pkts.map((p) => (
        <text key={`s${p.psn}`} x={x(p.send)} y={top - 6} textAnchor="middle" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{p.psn}</text>
      ))}
      {showLabels && pkts.map((p) => {
        const sameT = pkts.filter((q) => q.arrive === p.arrive && q.send < p.send).length;
        return (
          <text key={`r${p.psn}`} x={x(p.arrive)} y={bot + 12 + sameT * 9} textAnchor="middle" fontSize={9}
            fill={lateSet.has(p.psn) ? 'var(--warn)' : 'var(--muted)'} fontWeight={lateSet.has(p.psn) ? 700 : 400} fontFamily="var(--font-mono)">{p.psn}{lateSet.has(p.psn) ? '*' : ''}</text>
        );
      })}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={H - 14} x2={x(t)} y2={H - 10} stroke="var(--muted)" />
          <text x={x(t)} y={H - 1} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">{t}</text>
        </g>
      ))}
      <text x={L - 8} y={H - 1} textAnchor="end" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">slot</text>
    </svg>
  );
}


export default function SprayReorder() {
  const [k, setK] = useState(16);
  const [P, setP] = useState(4);
  const [delays, setDelays] = useState<number[]>(DELAY_PRESETS[1].delays);
  const [congOn, setCongOn] = useState(false);
  const [congPath, setCongPath] = useState(2);
  const [backlog, setBacklog] = useState(8);
  const [ecmpPath, setEcmpPath] = useState(0);
  const [collide, setCollide] = useState(true);
  const [gbps, setGbps] = useState(400);

  const cfg: SprayCfg = useMemo(() => ({ k, delays: delays.slice(0, P), congested: congOn ? Math.min(congPath, P - 1) : null, backlog }), [k, P, delays, congOn, congPath, backlog]);
  const pkts = useMemo(() => sprayArrivals(cfg), [cfg]);
  const order = useMemo(() => arrivalOrder(pkts), [pkts]);
  const st = reorderStats(order);
  const pass = goBackNPass(order);
  const rob = reorderBuffer(order);
  const gbn = useMemo(() => simulateGoBackN(cfg), [cfg]);
  const ddp = lastArrival(pkts);
  const ePath = Math.min(ecmpPath, P - 1);
  const ecmp = ecmpCompletion(cfg, ePath, collide);
  const ns = slotNs(gbps);
  const fmtT = (slots: number) => { const v = slots * ns; return v >= 1000 ? `${(v / 1000).toFixed(2)} µs` : `${v.toFixed(0)} ns`; };
  const best = Math.min(ddp, ecmp, ...(gbn.done ? [gbn.completion] : []));
  const rel = (v: number) => (best > 0 ? `${(v / best).toFixed(2)}×` : '');

  const setDelay = (p: number, v: number) => { setDelays((d) => d.map((x, i) => (i === p ? v : x))); };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <div className={`${cap} mb-1`}>Message size (packets of 4 KB)</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Packets in the message">
            {[8, 16, 32, 64].map((v) => <button key={v} type="button" aria-pressed={k === v} onClick={() => setK(v)} className={btn(k === v)}>{v}</button>)}
          </div>
        </div>
        <div>
          <div className={`${cap} mb-1`}>Paths sprayed over</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Number of paths">
            {[1, 2, 4, 8].map((v) => <button key={v} type="button" aria-pressed={P === v} onClick={() => setP(v)} className={btn(P === v)}>{v}</button>)}
          </div>
        </div>
        <div>
          <div className={`${cap} mb-1`}>Path delays</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Path delay presets">
            {DELAY_PRESETS.map((d) => {
              const on = d.delays.slice(0, P).every((v, i) => v === delays[i]);
              return <button key={d.id} type="button" aria-pressed={on} onClick={() => setDelays(d.delays)} className={btn(on)}>{d.label}</button>;
            })}
          </div>
        </div>
      </div>

      <fieldset className="rounded-lg border border-line p-2">
        <legend className={`${cap} px-1`}>One-way delay of each path (slots; 1 slot = one packet time)</legend>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: P }, (_, p) => (
            <label key={p} className="flex items-center gap-1 text-xs">
              <svg width="18" height="8" aria-hidden><line x1="0" y1="4" x2="18" y2="4" stroke={PATH_COLORS[p]} strokeWidth="2" strokeDasharray={PATH_DASH[p]} /></svg>
              <span className="font-mono text-muted">path {p}</span>
              <NumInput integer min={1} max={40} value={delays[p]} onValue={(v) => setDelay(p, v)}
                className="w-14 rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-sm" />
            </label>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={congOn} onChange={(e) => setCongOn(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />Congestion on one path</label>
          <label className="inline-flex items-center gap-1.5 text-muted">path
            <select value={Math.min(congPath, P - 1)} onChange={(e) => setCongPath(+e.target.value)} disabled={!congOn} className="min-h-6 rounded-md border border-line bg-panel px-1 py-0.5 font-mono text-fg disabled:opacity-50">
              {Array.from({ length: P }, (_, p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5 text-muted">packets already queued
            <NumInput integer min={0} max={64} value={backlog} disabled={!congOn} onValue={setBacklog} className="w-14 rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-sm text-fg disabled:opacity-50" />
          </label>
        </div>
      </fieldset>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className={`${cap} px-1 pb-1`}>Send order vs arrival order (round-robin spray; * = arrives after a higher PSN)</div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Ladder diagram, scrollable">
          <div className="min-w-[560px]"><Ladder pkts={pkts} late={st.late} k={k} /></div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 px-1" role="group" aria-label="Arrival order of PSNs">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">arrival order</span>
          {order.map((psn, i) => (
            <span key={i} className={`rounded border px-1 font-mono text-[11px] ${st.late[i] ? 'border-warn font-semibold text-warn' : 'border-line text-muted'}`}>
              {psn}{st.late[i] ? '*' : ''}{st.late[i] && <span className="sr-only"> (late)</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="Reordered packets" value={`${st.reordered} / ${k}`} sub={`${(st.fraction * 100).toFixed(0)} % arrive after a higher PSN`} tone={st.reordered ? 'text-warn' : 'text-accent'} />
        <Out label="Max displacement" value={`${st.maxDisplacement}`} sub="positions from send order" />
        <Out label="Reorder buffer peak" value={`${rob.peak} pkt`} sub={`${((rob.peak * PAYLOAD) / 1024).toFixed(0)} KB per QP`} tone="text-data" />
        <Out label="Message done (spray)" value={`${ddp} slots`} sub={fmtT(ddp)} />
      </div>

      <div>
        <div className={`${cap} mb-1.5`}>How the receiver copes</div>
        <div className="grid gap-2 md:grid-cols-3" aria-live="polite">
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
            <div className="font-semibold text-fg">(a) Classic RoCEv2 RC, go-back-N</div>
            <p className="mt-1 text-muted">
              First pass: accepts {pass.accepted} of {k}, discards {pass.discarded} that arrive ahead of the expected PSN, sends {pass.naks.length} NAK{pass.naks.length === 1 ? '' : 's'}
              {pass.naks.length ? ` (first: expected PSN ${pass.naks[0]})` : ''}. Every NAK rewinds the sender, and the resent packets are sprayed again.
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              <li>packets sent <span className={gbn.retransmitted ? 'text-danger' : 'text-accent'}>{gbn.sent}</span> ({gbn.retransmitted} retransmitted)</li>
              <li>NAKs {gbn.naks} · discarded {gbn.discarded} · duplicates {gbn.duplicates}</li>
              <li>goodput {((k / gbn.sent) * 100).toFixed(0)} % · done at {gbn.done ? `${gbn.completion} slots (${rel(gbn.completion)})` : 'not within the limit'}</li>
            </ul>
          </div>
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
            <div className="font-semibold text-fg">(b) Reorder buffer</div>
            <p className="mt-1 text-muted">
              Hold early packets until the gap fills, then deliver in PSN order. No retransmissions, but the NIC needs on-chip memory for the worst
              gap of every active QP.
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              <li>peak held <span className="text-data">{rob.peak}</span> packets = {((rob.peak * PAYLOAD) / 1024).toFixed(0)} KB</li>
              <li>× 1,000 active QPs ≈ {((rob.peak * PAYLOAD * 1000) / 1e6).toFixed(1)} MB</li>
              <li>done at {ddp} slots ({rel(ddp)})</li>
            </ul>
          </div>
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
            <div className="font-semibold text-fg">(c) Direct data placement</div>
            <p className="mt-1 text-muted">
              Each packet carries (or lets the NIC derive) its target address, so it is written to its final place on arrival. The NIC tracks a
              bitmap of {k} PSNs and completes the message only when all have arrived (UET RUD; NVIDIA describes Spectrum-X SuperNICs similarly).
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs">
              <li>buffer <span className="text-accent">0</span> packets · state {k} bits</li>
              <li>retransmissions 0</li>
              <li>done at {ddp} slots ({rel(ddp)})</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-3">
        <div className={`${cap} mb-2`}>Compare: per-flow ECMP (no spraying)</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <label className="inline-flex items-center gap-1.5 text-muted">the hash puts this flow on path
            <select value={ePath} onChange={(e) => setEcmpPath(+e.target.value)} className="min-h-6 rounded-md border border-line bg-panel px-1 py-0.5 font-mono text-fg">
              {Array.from({ length: P }, (_, p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={collide} onChange={(e) => setCollide(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />another elephant flow hashed onto the same path</label>
        </div>
        <p className="mt-2 text-sm text-muted" aria-live="polite">
          All {k} packets take path {ePath}, so they arrive in order (0 reordered, 0 retransmissions), and the message is done at
          <span className="font-mono text-fg"> {ecmp} slots ({rel(ecmp)})</span>{collide ? ': the collision halves this flow\'s share of the link, so serializing the message takes twice as long' : ''}
          {cfg.congested === ePath ? ', behind the queue on the congested path' : ''}. Spraying with a reorder-tolerant receiver finishes at {ddp} slots.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className={cap}>Slot length at</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Link speed for the slot length">
          {[200, 400, 800].map((g) => <button key={g} type="button" aria-pressed={gbps === g} onClick={() => setGbps(g)} className={btn(gbps === g)}>{g}G</button>)}
        </div>
        <Pill>1 slot = {WIRE_BYTES} B × 8 / {gbps} Gb/s = {ns.toFixed(1)} ns</Pill>
      </div>

      <div>
        <div className={`${cap} mb-1.5`}>Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>packet i leaves at slot i on path i mod {P}; arrival = i + queue wait + path delay (the congested path starts with {cfg.congested === null ? 0 : backlog} packets queued, drained at one per slot)</li>
          <li>a packet is reordered (RFC 4737) when its PSN is below the highest PSN already received: {st.reordered} of {k}</li>
          <li>go-back-N: the receiver keeps only PSN = expected; each gap costs one NAK, the discarded packets and a rewind of the sender to the NAKed PSN</li>
          <li>reorder buffer occupancy after each arrival: [{rob.occupancy.join(', ')}] → peak {rob.peak}</li>
          <li>placement or reorder buffer: done when the last packet lands = max arrival = {ddp} slots</li>
        </ol>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Slot model: every link runs at the sender's line rate, each path has one FIFO hop, round-robin spraying stands in for switch adaptive routing
        or UET entropy spraying (both steer by load or congestion feedback, which can reduce reordering compared with this blind rotation), and the last hop is not modelled
        as a queue. No packet is really lost, so every retransmission here is spurious; NAKs return after the shortest path delay; send window, ACK
        coalescing, timeouts and congestion control are ignored. Real NICs differ: many keep go-back-N, some newer RoCE NICs offer selective
        repeat or out-of-order placement, and vendor details (for example of Spectrum-X SuperNICs) are not fully public. The ECMP collision assumes
        the two flows share the link equally. 4 KB payload per packet.
      </p>
    </div>
  );
}
