import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model (simplified, unit-testable) ----------

export type LatModel = 'ring' | 'tree';

export interface StepParams {
  gradGB: number;      // total gradient bytes per step, decimal GB (1e9)
  fwdMs: number;       // forward compute time of a healthy rank
  bwdMs: number;       // backward compute time of a healthy rank
  optMs: number;       // optimizer step time
  layers: number;      // backward is split into equal layers
  bucketMiB: number;   // DDP bucket_cap_mb (MiB = 2^20 bytes); PyTorch default 25
  n: number;           // data-parallel ranks
  busbwGBs: number;    // per-GPU bus bandwidth, GB/s
  alphaUs: number;     // per-step latency, microseconds
  latModel: LatModel;  // flat ring: 2(n-1) steps; tree: about 2*ceil(log2 n) steps
  overlap: boolean;    // launch each bucket as soon as it is ready
  stragglerPct: number; // one rank computes this much slower
}

export interface Bucket { i: number; bytes: number; ready: number; start: number; end: number }

/** Latency steps of one all-reduce under the chosen latency model. */
export function latencySteps(n: number, model: LatModel): number {
  return model === 'ring' ? 2 * (n - 1) : 2 * Math.ceil(Math.log2(n));
}

/** All-reduce time in ms: 2(n-1)/n * bytes / busbw  +  steps * alpha. */
export function allReduceMs(bytes: number, n: number, busbwGBs: number, alphaUs: number, model: LatModel): number {
  const bw = ((2 * (n - 1)) / n) * bytes / (busbwGBs * 1e9) * 1e3;
  return bw + (latencySteps(n, model) * alphaUs) / 1e3;
}

/** Split total gradient bytes into DDP-style buckets of at most bucketBytes. */
export function bucketSizes(totalBytes: number, bucketBytes: number): number[] {
  const out: number[] = [];
  for (let done = 0; done < totalBytes; done += bucketBytes) out.push(Math.min(bucketBytes, totalBytes - done));
  return out;
}

export interface StepResult {
  slow: number; fwdEnd: number; bwdEnd: number; fastFwdEnd: number; fastBwdEnd: number;
  buckets: Bucket[]; commTotal: number; commEnd: number; exposed: number; step: number; perBucket: number;
}

export function simulateStep(p: StepParams): StepResult {
  const slow = 1 + p.stragglerPct / 100;
  // The collective cannot finish before the slowest rank has produced the bucket: use straggler times.
  const fwdEnd = p.fwdMs * slow, bwd = p.bwdMs * slow, bwdEnd = fwdEnd + bwd;
  const total = p.gradGB * 1e9, perLayer = total / p.layers;
  const sizes = bucketSizes(total, p.bucketMiB * 2 ** 20);
  let cum = 0, prevEnd = 0, commTotal = 0;
  const buckets = sizes.map((bytes, i) => {
    cum += bytes;
    // Gradients appear from the last layer backwards; the bucket fires when the layer holding its last byte is done.
    const layersDone = Math.min(p.layers, Math.ceil(cum / perLayer - 1e-9));
    const ready = fwdEnd + (layersDone * bwd) / p.layers;
    const dur = allReduceMs(bytes, p.n, p.busbwGBs, p.alphaUs, p.latModel);
    const start = Math.max(p.overlap ? ready : bwdEnd, prevEnd);
    prevEnd = start + dur;
    commTotal += dur;
    return { i, bytes, ready, start, end: prevEnd };
  });
  const commEnd = buckets.length ? prevEnd : bwdEnd;
  const exposed = Math.max(0, commEnd - bwdEnd);
  const step = Math.max(bwdEnd, commEnd) + p.optMs * slow;
  return {
    slow, fwdEnd, bwdEnd, fastFwdEnd: p.fwdMs, fastBwdEnd: p.fwdMs + p.bwdMs, buckets, commTotal, commEnd, exposed, step,
    perBucket: allReduceMs(Math.min(total, p.bucketMiB * 2 ** 20), p.n, p.busbwGBs, p.alphaUs, p.latModel),
  };
}

// ---------- UI ----------

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

function Seg<T extends string | number>({ label, value, options, onChange, fmt }: { label: string; value: T; options: T[]; onChange: (v: T) => void; fmt?: (v: T) => string }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{fmt ? fmt(o) : String(o)}</button>
        ))}
      </div>
    </div>
  );
}

function Slider({ id, label, value, min, max, step, unit, onChange }: { id: string; label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
        <span>{label}</span><span className="text-fg">{value} {unit}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={`${value} ${unit}`} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </div>
  );
}

const W = 760, X0 = 118, ROW = 30;

export default function TrainingStepTimeline() {
  const [gradGB, setGrad] = useState(2);
  const [fwdMs, setFwd] = useState(60);
  const [bwdMs, setBwd] = useState(120);
  const [optMs, setOpt] = useState(10);
  const [bucketMiB, setBucket] = useState(25);
  const [n, setN] = useState(64);
  const [busbw, setBusbw] = useState(50);
  const [alphaUs, setAlpha] = useState(2);
  const [latModel, setLat] = useState<LatModel>('ring');
  const [overlap, setOverlap] = useState(true);
  const [strag, setStrag] = useState(0);

  const base: StepParams = { gradGB, fwdMs, bwdMs, optMs, layers: 24, bucketMiB, n, busbwGBs: busbw, alphaUs, latModel, overlap, stragglerPct: strag };
  const r = simulateStep(base);
  const healthy = simulateStep({ ...base, stragglerPct: 0 });
  const flip = simulateStep({ ...base, overlap: !overlap });

  const rows = strag > 0 ? 3 : 2;
  const H = 34 + rows * (ROW + 12) + 26;
  const T = r.step * 1.02;
  const x = (t: number) => X0 + (t / T) * (W - X0 - 10);
  const tickStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => T / s <= 8) ?? 10000;
  const ticks = Array.from({ length: Math.floor(T / tickStep) + 1 }, (_, i) => i * tickStep);
  const rowY = (k: number) => 30 + k * (ROW + 12);
  const commRow = rows - 1;
  const bucketBytes = bucketMiB * 2 ** 20;
  // The largest bucket can never exceed the whole gradient (e.g. 0.25 GB with 250 MiB buckets is one 0.25 GB bucket).
  const fullBucket = Math.min(gradGB * 1e9, bucketBytes);

  const computeRow = (k: number, label: string, f: number, b: number, s: number) => {
    // All ranks leave the last all-reduce together, so every optimizer step starts at comm end (>= slowest backward end).
    const y = rowY(k), fEnd = f, bEnd = f + b, optStart = Math.max(r.commEnd, bEnd);
    return (
      <g key={label}>
        <text x={4} y={y + ROW / 2 + 4} fontSize={11} fill="var(--text)">{label}</text>
        <rect x={x(0)} y={y} width={x(fEnd) - x(0)} height={ROW} rx={3} fill="var(--data)" opacity={0.85} />
        {x(fEnd) - x(0) > 28 && <text x={(x(0) + x(fEnd)) / 2} y={y + ROW / 2 + 4} fontSize={10} textAnchor="middle" fill="var(--panel)">fwd</text>}
        {Array.from({ length: 24 }, (_, l) => (
          <rect key={l} x={x(fEnd + (l * b) / 24)} y={y} width={Math.max(0.5, x(fEnd + ((l + 1) * b) / 24) - x(fEnd + (l * b) / 24) - 0.6)} height={ROW} fill="var(--accent)" opacity={l % 2 ? 0.7 : 0.9} />
        ))}
        {x(bEnd) - x(fEnd) > 60 && <text x={(x(fEnd) + x(bEnd)) / 2} y={y + ROW / 2 + 4} fontSize={10} textAnchor="middle" fill="var(--panel)">bwd (24 layers, last → first)</text>}
        {optStart > bEnd + 1e-6 && (
          <g>
            <rect x={x(bEnd)} y={y + 4} width={x(optStart) - x(bEnd)} height={ROW - 8} fill="none" stroke="var(--muted)" strokeDasharray="3 3" />
            {x(optStart) - x(bEnd) > 34 && <text x={(x(bEnd) + x(optStart)) / 2} y={y + ROW / 2 + 4} fontSize={10} textAnchor="middle" fill="var(--muted)">wait</text>}
          </g>
        )}
        <rect x={x(optStart)} y={y} width={Math.max(1, x(optStart + optMs * s) - x(optStart))} height={ROW} rx={3} fill="var(--warn)" opacity={0.85} />
      </g>
    );
  };

  const cy = rowY(commRow);
  const derivation: ReactNode[] = [
    <>buckets = ⌈{gradGB} GB / {bucketMiB} MiB⌉ = ⌈{(gradGB * 1e9).toExponential(2)} / {bucketBytes.toLocaleString('en-US')} B⌉ = <b className="font-mono text-fg">{r.buckets.length}</b></>,
    <>bandwidth term per full bucket = 2({n}−1)/{n} × {(fullBucket / 1e6).toFixed(2)} MB / {busbw} GB/s = <b className="font-mono text-fg">{ms(((2 * (n - 1)) / n) * fullBucket / (busbw * 1e9) * 1e3)} ms</b></>,
    <>latency term per bucket = {latencySteps(n, latModel)} steps × {alphaUs} µs = <b className="font-mono text-fg">{ms((latencySteps(n, latModel) * alphaUs) / 1e3)} ms</b> ({latModel === 'ring' ? 'flat ring: 2(n−1) steps' : 'tree: ≈ 2⌈log₂ n⌉ steps'})</>,
    <>all-reduce time summed over buckets = <b className="font-mono text-fg">{ms(r.commTotal)} ms</b>; compute (slowest rank) = {ms(r.fwdEnd)} + {ms(r.bwdEnd - r.fwdEnd)} = {ms(r.bwdEnd)} ms</>,
    <>exposed communication = max(0, comm end − backward end) = {ms(r.commEnd)} − {ms(r.bwdEnd)} = <b className="font-mono text-danger">{ms(r.exposed)} ms</b></>,
    <>step = max(backward end, comm end) + optimizer = <b className="font-mono text-fg">{ms(r.step)} ms</b></>,
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Slider id="tst-grad" label="Gradient size" value={gradGB} min={0.25} max={16} step={0.25} unit="GB" onChange={setGrad} />
        <Slider id="tst-fwd" label="Forward" value={fwdMs} min={10} max={500} step={5} unit="ms" onChange={setFwd} />
        <Slider id="tst-bwd" label="Backward" value={bwdMs} min={20} max={1000} step={5} unit="ms" onChange={setBwd} />
        <Seg label="DP ranks n" value={n} options={[2, 8, 64, 512, 4096]} onChange={setN} />
        <Seg label="Per-GPU busbw (GB/s)" value={busbw} options={[12.5, 25, 50, 100]} onChange={setBusbw} />
        <Seg label="Bucket size (MiB)" value={bucketMiB} options={[5, 25, 100, 250]} onChange={setBucket} fmt={(v) => (v === 25 ? '25 (DDP default)' : String(v))} />
        <Seg label="Latency α per step (µs)" value={alphaUs} options={[0, 2, 5, 10]} onChange={setAlpha} />
        <Seg label="Latency model" value={latModel} options={['ring', 'tree'] as LatModel[]} onChange={setLat} />
        <Slider id="tst-opt" label="Optimizer step" value={optMs} min={0} max={100} step={1} unit="ms" onChange={setOpt} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Overlap comm with backward</div>
          <button type="button" aria-pressed={overlap} onClick={() => setOverlap(!overlap)}
            className={`rounded-md border px-3 py-1 font-mono text-xs ${overlap ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'}`}>{overlap ? 'on' : 'off'}</button>
        </div>
        <div className="min-w-[220px] flex-1">
          <Slider id="tst-strag" label="Straggler: one rank slower by" value={strag} min={0} max={50} step={1} unit="%" onChange={setStrag} />
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Timeline of one training step: forward ends at ${ms(r.fwdEnd)} ms, backward at ${ms(r.bwdEnd)} ms, ${r.buckets.length} all-reduce buckets finish at ${ms(r.commEnd)} ms, exposed communication ${ms(r.exposed)} ms, step ends at ${ms(r.step)} ms${strag > 0 ? `; the straggler delays every rank by ${ms(r.step - healthy.step)} ms` : ''}.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={22} y2={H - 22} stroke="var(--border)" />
            <text x={x(t)} y={16} fontSize={10} textAnchor="middle" fill="var(--muted)">{t} ms</text>
          </g>
        ))}
        {computeRow(0, strag > 0 ? 'healthy rank' : 'each rank', fwdMs, bwdMs, 1)}
        {strag > 0 && computeRow(1, `straggler +${strag}%`, r.fwdEnd, r.bwdEnd - r.fwdEnd, r.slow)}
        <text x={4} y={cy + ROW / 2 + 4} fontSize={11} fill="var(--text)">comm stream</text>
        <rect x={x(0)} y={cy} width={x(T) - x(0)} height={ROW} fill="var(--panel-2)" />
        {r.buckets.map((b) => (
          <rect key={b.i} x={x(b.start)} y={cy + 3} width={Math.max(0.6, x(b.end) - x(b.start) - (r.buckets.length < 200 ? 0.6 : 0))} height={ROW - 6} fill="var(--data)" opacity={b.i % 2 ? 0.55 : 0.85} />
        ))}
        {r.exposed > 0 && (
          <g>
            <rect x={x(r.bwdEnd)} y={cy - 2} width={x(r.commEnd) - x(r.bwdEnd)} height={ROW + 4} fill="var(--danger)" opacity={0.18} stroke="var(--danger)" />
            <text x={(x(r.bwdEnd) + x(r.commEnd)) / 2} y={cy + ROW + 16} fontSize={10} textAnchor="middle" fill="var(--danger)">exposed {ms(r.exposed)} ms</text>
          </g>
        )}
        <line x1={x(r.step)} x2={x(r.step)} y1={22} y2={H - 22} stroke="var(--text)" strokeDasharray="4 3" />
        <text x={Math.min(x(r.step), W - 4)} y={H - 6} fontSize={10} textAnchor="end" fill="var(--text)">step end {ms(r.step)} ms</text>
      </svg>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {[['var(--data)', 'forward'], ['var(--accent)', 'backward layers'], ['var(--data)', 'all-reduce bucket (alternating shades)'], ['var(--warn)', 'optimizer'], ['var(--danger)', 'exposed comm']].map(([c, l]) => (
          <span key={l} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} aria-hidden />{l}</span>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" aria-live="polite">
        <Pill>step <span className="font-mono text-fg">{ms(r.step)} ms</span></Pill>
        <Pill>exposed comm <span className="font-mono text-danger">{ms(r.exposed)} ms</span> ({((r.exposed / r.step) * 100).toFixed(0)}% of step)</Pill>
        <Pill>hidden <span className="font-mono text-fg">{r.commTotal > 0 ? (((r.commTotal - r.exposed) / r.commTotal) * 100).toFixed(0) : 0}%</span> of {ms(r.commTotal)} ms comm</Pill>
        <Pill>overlap {overlap ? 'off' : 'on'} would give <span className="font-mono text-fg">{ms(flip.step)} ms</span></Pill>
        {strag > 0 && <Pill className="border-warn/50">straggler cost <span className="font-mono text-warn">+{ms(r.step - healthy.step)} ms</span> (+{(((r.step - healthy.step) / healthy.step) * 100).toFixed(0)}%) for all {n} ranks</Pill>}
      </div>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">{derivation.map((d, i) => <li key={i}>{d}</li>)}</ol>

      {strag > 0 && (
        <p className="text-sm text-muted">
          Synchronous data parallelism: no bucket's all-reduce can complete until the slowest rank has computed that bucket, so the
          comm stream follows the straggler's backward pass and the {n - 1} healthy ranks sit in <span className="text-fg">wait</span> before their optimizer step.
          One rank {strag}% slower makes the whole job {(((r.step - healthy.step) / healthy.step) * 100).toFixed(0)}% slower here.
        </p>
      )}

      <p className="text-[11px] text-muted">
        Simplified model for intuition, not a profiler: equal-sized layers produce gradients uniformly from the last layer to the first; buckets
        fire when the layer holding their last byte finishes and run one at a time on a single comm stream; ring all-reduce time = 2(n−1)/n · bucket / busbw
        plus a latency term (flat-ring 2(n−1)·α, or ≈2⌈log₂ n⌉·α for a tree, as NCCL may choose). Real PyTorch DDP builds buckets from parameters in roughly
        reverse order, uses a smaller first bucket, and can reorder after the first iteration; comm kernels also steal some SM time and memory bandwidth from
        compute, and NCCL may run hierarchical or NVLS/SHARP algorithms. Busbw options are line-rate upper bounds for 100/200/400/800G NICs; measure yours with nccl-tests.
      </p>
    </div>
  );
}
