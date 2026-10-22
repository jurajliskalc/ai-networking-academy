import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model (unit-testable) ----------
// Schedules follow Narayanan et al., "Efficient Large-Scale Language Model Training on GPU Clusters Using
// Megatron-LM" (SC21, arXiv 2104.04473), section 2.2: GPipe (all forwards, then all backwards), the
// non-interleaved 1F1B schedule (PipeDream-Flush) and the interleaved 1F1B schedule with v model chunks.
// Paper results used: bubble fraction (bubble time / ideal time) = (p - 1) / m for GPipe and 1F1B, and
// (1 / v) · (p - 1) / m for the interleaved schedule; 1F1B keeps at most p micro-batches in flight.
// The interleaved order mirrors Megatron-LM's schedules.py (forward_backward_pipelining_with_interleaving):
// warm-up = (p - s - 1) · 2 + (v - 1) · p virtual micro-batches, then one forward / one backward.

export type Sched = 'gpipe' | '1f1b' | 'interleaved';

export interface Step { kind: 'F' | 'B'; mb: number; chunk: number }
export interface Op extends Step { stage: number; start: number; end: number }

/** The order in which stage s (0-based) runs its forward and backward blocks. */
export function stageOrder(sched: Sched, p: number, m: number, s: number, v = 1): Step[] {
  const out: Step[] = [];
  if (sched === 'gpipe') {
    for (let j = 0; j < m; j++) out.push({ kind: 'F', mb: j, chunk: 0 });
    for (let j = 0; j < m; j++) out.push({ kind: 'B', mb: j, chunk: 0 });
    return out;
  }
  if (sched === '1f1b') {
    const w = Math.min(p - s - 1, m);
    for (let j = 0; j < w; j++) out.push({ kind: 'F', mb: j, chunk: 0 });
    for (let i = 0; i < m - w; i++) { out.push({ kind: 'F', mb: w + i, chunk: 0 }); out.push({ kind: 'B', mb: i, chunk: 0 }); }
    for (let j = m - w; j < m; j++) out.push({ kind: 'B', mb: j, chunk: 0 });
    return out;
  }
  // Interleaved: K = m·v virtual micro-batches, visited in groups of p per model chunk.
  const K = m * v, g = p * v;
  const mbOf = (k: number) => Math.floor(k / g) * p + (k % p);
  const fChunk = (k: number) => Math.floor((k % g) / p);
  const bChunk = (k: number) => v - 1 - Math.floor((k % g) / p);
  const w = Math.min((p - s - 1) * 2 + (v - 1) * p, K);
  for (let k = 0; k < w; k++) out.push({ kind: 'F', mb: mbOf(k), chunk: fChunk(k) });
  for (let i = 0; i < K - w; i++) {
    out.push({ kind: 'F', mb: mbOf(w + i), chunk: fChunk(w + i) });
    out.push({ kind: 'B', mb: mbOf(i), chunk: bChunk(i) });
  }
  for (let k = K - w; k < K; k++) out.push({ kind: 'B', mb: mbOf(k), chunk: bChunk(k) });
  return out;
}

export interface SimResult {
  ops: Op[]; makespan: number; busy: number; bubbleTime: number;
  /** Bubble as a share of the total step time: 1 − busy / makespan. */
  bubbleFrac: number;
  /** Peak micro-batches whose activations a stage holds (forward done, backward not yet), per stage; chunks count 1/v. */
  peakInFlight: number[];
}

/**
 * Brute-force list scheduler: every stage runs its blocks in the order above; a block starts when its stage is
 * free and its input is ready (forward: the previous virtual stage's forward of that micro-batch; backward: the
 * next virtual stage's backward and this stage's own forward). Communication time is zero. With v chunks each
 * block takes tf/v or tb/v and virtual stage c·p + s lives on device s.
 */
export function simulate(sched: Sched, p: number, m: number, tf: number, tb: number, v = 1): SimResult {
  const vv = sched === 'interleaved' ? v : 1;
  const V = p * vv;
  const orders = Array.from({ length: p }, (_, s) => stageOrder(sched, p, m, s, vv));
  const done = new Map<string, number>(); // `${kind}${virtualStage}:${mb}` -> end time
  const key = (k: string, vs: number, j: number) => `${k}${vs}:${j}`;
  const ptr = new Array(p).fill(0), free = new Array(p).fill(0);
  const ops: Op[] = [];
  let left = orders.reduce((a, o) => a + o.length, 0);
  while (left > 0) {
    let progressed = false;
    for (let s = 0; s < p; s++) {
      while (ptr[s] < orders[s].length) {
        const st = orders[s][ptr[s]];
        const vs = st.chunk * p + s;
        const deps: string[] = st.kind === 'F'
          ? (vs > 0 ? [key('F', vs - 1, st.mb)] : [])
          : [key('F', vs, st.mb), ...(vs < V - 1 ? [key('B', vs + 1, st.mb)] : [])];
        if (!deps.every((d) => done.has(d))) break;
        const start = Math.max(free[s], ...deps.map((d) => done.get(d)!));
        const end = start + (st.kind === 'F' ? tf : tb) / vv;
        done.set(key(st.kind, vs, st.mb), end);
        ops.push({ ...st, stage: s, start, end });
        free[s] = end; ptr[s]++; left--; progressed = true;
      }
    }
    if (!progressed) throw new Error('schedule deadlock');
  }
  const makespan = Math.max(...ops.map((o) => o.end));
  const busy = m * (tf + tb);
  const peakInFlight = orders.map((o) => {
    let cur = 0, peak = 0;
    for (const st of o) { cur += st.kind === 'F' ? 1 : -1; peak = Math.max(peak, cur); }
    return peak / vv;
  });
  return { ops, makespan, busy, bubbleTime: makespan - busy, bubbleFrac: 1 - busy / makespan, peakInFlight };
}

/** Closed-form bubble share of the total step time: (p − 1) / (v·m + p − 1); v = 1 for GPipe and 1F1B. */
export const bubbleFormula = (p: number, m: number, v = 1) => (p - 1) / (v * m + p - 1);
/** The paper's form: bubble time relative to the ideal (bubble-free) time, (p − 1) / (v·m). */
export const bubbleOverIdeal = (p: number, m: number, v = 1) => (p - 1) / (v * m);

/** Bytes of one activation (forward) or activation-gradient (backward) tensor crossing a stage boundary. */
export const p2pBytes = (microBatch: number, seqLen: number, hidden: number, bytesPerElem: number) => microBatch * seqLen * hidden * bytesPerElem;
/**
 * Bytes one stage boundary carries per training step, each direction: m tensors forward plus m backward.
 * With v chunks a micro-batch crosses every device boundary v times (and wraps from the last device to the
 * first v − 1 times), so per-device traffic grows by v.
 */
export const boundaryBytesPerStep = (m: number, tensorBytes: number, v = 1) => m * tensorBytes * v;

// ---------- formatting ----------

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e10 ? 1 : 2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e7 ? 1 : 2)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}
const fmtT = (s: number) => (s < 1e-3 ? `${(s * 1e6).toFixed(0)} µs` : s < 1 ? `${(s * 1e3).toFixed(s < 0.01 ? 2 : 1)} ms` : `${s.toFixed(2)} s`);
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const n2 = (x: number) => (Number.isInteger(x) ? String(x) : (Math.round(x * 100) / 100).toString());

// ---------- UI ----------

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`min-h-6 rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
            {render ? render(o) : String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Out({ label, value, sub, tone = 'text-fg' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function Slider({ id, label, value, min, max, onChange, valueText }: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void; valueText: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
        <label htmlFor={id}>{label}</label><span className="text-base font-semibold normal-case tracking-normal text-fg">{value}</span>
      </div>
      <input id={id} type="range" min={min} max={max} value={value} aria-valuetext={valueText} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </div>
  );
}

const SCHED_LABEL: Record<Sched, string> = { gpipe: 'GPipe', '1f1b': '1F1B', interleaved: 'Interleaved 1F1B' };

function Gantt({ r, p, sched, v, label }: { r: SimResult; p: number; sched: Sched; v: number; label: string }) {
  const W = 720, L = 62, Rm = 8, T = 8, RH = 26, G = 6, B = 24;
  const H = T + p * (RH + G) + B;
  const x = (t: number) => L + (t / r.makespan) * (W - L - Rm);
  const ticks = 5;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img" aria-label={label}>
      <defs>
        <pattern id="ps-idle" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--panel-2)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" strokeWidth="2" />
        </pattern>
      </defs>
      {Array.from({ length: p }, (_, s) => {
        const y = T + s * (RH + G);
        return (
          <g key={s}>
            <text x={L - 8} y={y + RH / 2 + 4} fontSize={11} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">stage {s + 1}</text>
            <rect x={L} y={y} width={W - L - Rm} height={RH} fill="url(#ps-idle)" />
          </g>
        );
      })}
      {r.ops.map((o, i) => {
        const y = T + o.stage * (RH + G);
        const x0 = x(o.start), w = Math.max(0.5, x(o.end) - x0);
        const isF = o.kind === 'F';
        const top = isF ? y : y + 4;
        return (
          <g key={i}>
            <rect x={x0 + 0.5} y={top} width={Math.max(0.5, w - 1)} height={isF ? RH : RH - 8} rx={2}
              fill={isF ? 'var(--data)' : 'var(--accent)'} />
            {sched === 'interleaved' && v > 1 && w >= 4 && Array.from({ length: o.chunk }, (_, c) => (
              <line key={c} x1={x0 + 2} x2={x0 + w - 2} y1={top + 2.5 + c * 3} y2={top + 2.5 + c * 3} stroke="var(--bg)" strokeWidth={1.2} />
            ))}
            {w >= 14 && (
              <text x={x0 + w / 2} y={y + RH / 2 + 4} fontSize={w >= 22 ? 11 : 9} textAnchor="middle" fill="var(--bg)" fontFamily="var(--font-mono)" fontWeight={700}>
                {w >= 30 ? `${o.kind}${o.mb + 1}` : o.mb + 1}
              </text>
            )}
          </g>
        );
      })}
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const t = (r.makespan * i) / ticks;
        return (
          <g key={i}>
            <line x1={x(t)} y1={H - B} x2={x(t)} y2={H - B + 4} stroke="var(--muted)" />
            <text x={x(t)} y={H - B + 16} fontSize={10} textAnchor={i === 0 ? 'start' : i === ticks ? 'end' : 'middle'} fill="var(--muted)" fontFamily="var(--font-mono)">{n2(t)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function PipelineSchedule() {
  const [sched, setSched] = useState<Sched>('1f1b');
  const [p, setP] = useState(4);
  const [m, setM] = useState(8);
  const [v, setV] = useState(2);
  const [ratio, setRatio] = useState(2);
  const [mb, setMb] = useState(1);
  const [mbText, setMbText] = useState('1');
  const [seq, setSeq] = useState(8192);
  const [hidden, setHidden] = useState(8192);
  const [bytes, setBytes] = useState(2);
  const [gbps, setGbps] = useState(400);

  const inter = sched === 'interleaved';
  const vv = inter ? v : 1;
  const mEff = inter ? Math.max(p, Math.round(m / p) * p) : m;
  const r = simulate(sched, p, mEff, 1, ratio, vv);
  const formula = bubbleFormula(p, mEff, vv);
  const tensor = p2pBytes(mb, seq, hidden, bytes);
  const perStep = boundaryBytesPerStep(mEff, tensor, vv);
  const xferS = (tensor * 8) / (gbps * 1e9);
  const peak0 = r.peakInFlight[0];

  const label = `${SCHED_LABEL[sched]} schedule, ${p} stages, ${mEff} micro-batches${inter ? `, ${v} chunks per stage` : ''}, backward ${ratio} times forward. ` +
    `The step takes ${n2(r.makespan)} forward-block times; each stage is idle ${pct(r.bubbleFrac)} of the step. Stage 1 holds up to ${n2(peak0)} micro-batches of activations.`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Seg label="Schedule" value={sched} options={['gpipe', '1f1b', 'interleaved'] as const} onChange={setSched} render={(s) => SCHED_LABEL[s]} />
        <Slider id="ps-p" label="Pipeline stages p" value={p} min={2} max={8} onChange={setP} valueText={`${p} stages`} />
        <Slider id="ps-m" label="Micro-batches m" value={m} min={1} max={32} onChange={setM} valueText={`${m} micro-batches`} />
        <Seg label="Backward time ÷ forward time" value={ratio} options={[1, 2, 3] as const} onChange={setRatio} render={(x) => (x === 2 ? '2 (typical)' : String(x))} />
        {inter
          ? <Seg label="Model chunks per stage v" value={v} options={[2, 3, 4] as const} onChange={setV} />
          : <div className="text-xs text-muted"><div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em]">Model chunks v</div>Only the interleaved schedule splits a stage into chunks.</div>}
      </div>
      {inter && mEff !== m && (
        <p className="text-xs text-warn" role="status">This interleaved order (Megatron-LM's classic implementation) needs m to be a multiple of p; using m = {mEff}.</p>
      )}

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 pb-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">One training step, time in forward-block units</div>
          <div className="flex flex-wrap gap-3 text-[11px] text-muted" aria-hidden="true">
            <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-4 rounded-sm" style={{ background: 'var(--data)' }} />forward (full height)</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-4 rounded-sm" style={{ background: 'var(--accent)' }} />backward (shorter)</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-4 rounded-sm border border-line" style={{ background: 'repeating-linear-gradient(45deg, var(--panel-2) 0 3px, var(--border) 3px 5px)' }} />idle (bubble)</span>
            {inter && <span>stripes on top: none = chunk 1, one = chunk 2, …</span>}
          </div>
        </div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Pipeline schedule timeline (scrolls sideways on narrow screens)">
          <Gantt r={r} p={p} sched={sched} v={vv} label={label} />
        </div>
        <p className="px-1 pt-1 text-[11px] text-muted">Numbers are micro-batches (F3 = forward of micro-batch 3, B3 = its backward).</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="Bubble (simulated)" value={pct(r.bubbleFrac)} tone={r.bubbleFrac > 0.25 ? 'text-warn' : 'text-accent'} sub={`idle ${n2(r.bubbleTime)} of ${n2(r.makespan)} time units`} />
        <Out label="Formula" value={pct(formula)} sub={inter ? `(p−1)/(v·m+p−1) = ${p - 1}/${vv * mEff + p - 1}` : `(p−1)/(m+p−1) = ${p - 1}/${mEff + p - 1}`} tone="text-data" />
        <Out label="Activations held" value={`${n2(peak0)} µbatches`} sub={`peak per stage: ${r.peakInFlight.map(n2).join(', ')}`} />
        <Out label="Step time" value={n2(r.makespan)} sub={`ideal m·(tf+tb) = ${n2(r.busy)}; unit = one forward`} />
      </div>

      <div className="rounded-lg border border-line bg-panel p-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Point-to-point traffic at each stage boundary</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="ps-mb" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Micro-batch size (sequences)</label>
            <input id="ps-mb" type="number" min={1} max={64} value={mbText} onBlur={() => setMbText(String(mb))}
              onChange={(e) => { setMbText(e.target.value); const n = Math.floor(Number(e.target.value)); if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 1) setMb(Math.min(64, n)); }}
              className="w-20 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
          </div>
          <Seg label="Sequence length" value={seq} options={[2048, 4096, 8192, 32768] as const} onChange={setSeq} />
          <Seg label="Hidden size" value={hidden} options={[4096, 8192, 12288, 16384] as const} onChange={setHidden} />
          <Seg label="Bytes per element" value={bytes} options={[2, 4] as const} onChange={setBytes} render={(b) => (b === 2 ? '2 (BF16)' : '4 (FP32)')} />
          <Seg label="Link per direction" value={gbps} options={[200, 400, 800] as const} onChange={setGbps} render={(g) => `${g}G`} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
          <Out label="One tensor" value={fmtBytes(tensor)} sub={`${mb} × ${seq} × ${hidden} × ${bytes} B`} tone="text-data" />
          <Out label="Forward, per step" value={fmtBytes(perStep)} sub={`${mEff} activations${inter ? ` × ${vv} chunks` : ''}, stage s → s+1`} />
          <Out label="Backward, per step" value={fmtBytes(perStep)} sub="same size: activation gradients, s+1 → s" />
          <Out label={`One send at ${gbps}G`} value={fmtT(xferS)} sub="bandwidth term only" tone="text-warn" />
        </div>
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Each stage does m forwards and m backwards: busy time = m·(tf + tb) = {mEff} × (1 + {ratio}) = <span className="font-mono text-fg">{n2(r.busy)}</span>.</li>
          <li>{inter
            ? <>With v chunks the fill and drain shrink to (p − 1)·(tf + tb)/v = {p - 1} × {1 + ratio} / {vv} = <span className="font-mono text-fg">{n2(((p - 1) * (1 + ratio)) / vv)}</span></>
            : <>The first micro-batch needs p − 1 forward blocks to reach the last stage, and the last backward needs p − 1 blocks to drain back: (p − 1)·(tf + tb) = {p - 1} × {1 + ratio} = <span className="font-mono text-fg">{n2((p - 1) * (1 + ratio))}</span></>}
            {' '}idle per stage, so the step takes {n2(r.busy)} + {n2(r.bubbleTime)} = <span className="font-mono text-fg">{n2(r.makespan)}</span> (the simulation agrees).</li>
          <li>Bubble share = idle ÷ step = <span className="font-mono text-fg">{pct(r.bubbleFrac)}</span>. The tb/tf ratio cancels: change it and the share stays put. Relative to the ideal time it is (p − 1)/{inter ? '(v·m)' : 'm'} = {pct(bubbleOverIdeal(p, mEff, vv))}, the form the Megatron-LM paper uses.</li>
          <li>GPipe and 1F1B have the <em>same</em> bubble; 1F1B wins on memory: stage 1 starts backward passes after p forwards, so it holds at most p micro-batches of activations instead of m{sched === 'gpipe' ? ` (here ${mEff} instead of ${Math.min(p, mEff)})` : ''}.</li>
          <li>Each boundary carries one {fmtBytes(tensor)} activation per micro-batch forward and one gradient of the same size backward{inter ? `; interleaving multiplies boundary crossings by v = ${vv}` : ''}: {fmtBytes(perStep)} each way per step.</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>bubble = (p−1)/(m+p−1)</Pill>
        <Pill>more micro-batches → smaller bubble</Pill>
        <Pill>1F1B: ≤ p micro-batches in flight</Pill>
        <Pill>interleaving: bubble ÷ v, traffic × v</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model: every stage has the same layers and cost, forward and backward times are fixed per micro-batch, and sends take zero time (in practice
        they partly overlap with compute and lengthen the step when they do not). The optimizer step, data-parallel gradient reduction and activation
        recomputation are left out; "activations held" counts micro-batches, not bytes, and with full activation recomputation a stage keeps only checkpointed layer inputs. The
        activation size is the plain hidden-state tensor; tensor and sequence parallelism can split it (Megatron-LM's scatter/gather optimization sends
        1/t of it per tensor-parallel rank). The interleaved order follows Megatron-LM's classic schedule, which requires m to be a multiple of p (newer releases may relax this; check yours).
      </p>
    </div>
  );
}
