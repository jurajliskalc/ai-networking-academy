import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model (exported for unit tests) ----------
// The trace is defined at 1 µs resolution: every burst starts, peaks and ends on an integer microsecond.
// Occupancy(t) = BASE + triangular bursts, so samples, window averages and window maxima can be computed
// exactly from the burst list instead of storing 6×10⁸ points.

export const SPAN_US = 600e6; // 10 minutes
export const BASE = 5; // % of the queue's buffer limit (background occupancy)
export const THRESHOLD = 30; // % "alert" threshold; every generated burst crosses it

export interface Burst { s: number; r: number; d: number; p: number } // start µs, rise µs, fall µs, peak height above BASE (%)
export type Stat = 'sample' | 'avg' | 'max' | 'counter';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synchronized "collective waves": every 250-350 ms a train of 1-4 microbursts; ~2 % are longer (ms-scale) episodes. */
export function generateBursts(seed: number): Burst[] {
  const rnd = mulberry32(seed);
  const out: Burst[] = [];
  let t = 50_000, prevEnd = 0;
  while (t < SPAN_US - 20_000) {
    const n = 1 + Math.floor(rnd() * 4);
    let tb = t + Math.round(rnd() * 2000);
    for (let i = 0; i < n; i++) {
      const long = rnd() < 0.02;
      const r = long ? 1000 + Math.round(rnd() * 2000) : 10 + Math.round(rnd() * 140);
      const d = long ? 3000 + Math.round(rnd() * 7000) : 20 + Math.round(rnd() * 380);
      const p = Math.round((27 + 68 * rnd() * rnd()) * 10) / 10;
      const s = Math.max(tb, prevEnd + 100);
      out.push({ s, r, d, p });
      prevEnd = s + r + d;
      tb = prevEnd + 200 + Math.round(rnd() * 3000);
    }
    t += 250_000 + Math.round(rnd() * 100_000);
  }
  return out;
}

const end = (b: Burst) => b.s + b.r + b.d;
/** Height of burst b at absolute time t (µs). */
export function burstAt(b: Burst, t: number): number {
  const x = t - b.s;
  if (x <= 0 || x >= b.r + b.d) return 0;
  return x <= b.r ? (b.p * x) / b.r : (b.p * (b.r + b.d - x)) / b.d;
}
/** ∫ of burst height from b.s to t (piecewise quadratic). */
function burstArea(b: Burst, t: number): number {
  const x = Math.min(Math.max(t - b.s, 0), b.r + b.d);
  if (x <= b.r) return (b.p * x * x) / (2 * b.r);
  const y = x - b.r;
  return (b.p * b.r) / 2 + b.p * (y - (y * y) / (2 * b.d));
}
/** Max of burst height over [a, b]: the triangle is unimodal, so it is the apex if inside, else the larger endpoint. */
function burstMax(b: Burst, a: number, z: number): number {
  const apex = b.s + b.r;
  return apex >= a && apex <= z ? b.p : Math.max(burstAt(b, a), burstAt(b, z));
}
/** Interval during which BASE + burst ≥ THRESHOLD. */
export function aboveInterval(b: Burst): [number, number] {
  const f = (THRESHOLD - BASE) / b.p;
  return [b.s + f * b.r, b.s + b.r + (1 - f) * b.d];
}

/** One reading per interval: window k = [kΔ, (k+1)Δ), read at its end. */
export function readings(bursts: Burst[], dt: number, stat: Stat, span = SPAN_US, from = 0): Float64Array {
  const k0 = Math.floor(from / dt), nW = Math.ceil(span / dt);
  const out = new Float64Array(nW);
  let i = 0;
  for (let k = 0; k < nW; k++) {
    const w0 = (k0 + k) * dt, w1 = w0 + dt;
    while (i < bursts.length && end(bursts[i]) <= w0) i++;
    let v = stat === 'counter' ? 0 : stat === 'max' ? BASE : stat === 'avg' ? BASE * dt : BASE;
    for (let j = i; j < bursts.length && bursts[j].s < w1; j++) {
      const b = bursts[j];
      if (stat === 'sample') v += burstAt(b, w1);
      else if (stat === 'avg') v += burstArea(b, w1) - burstArea(b, w0);
      else if (stat === 'max') v = Math.max(v, BASE + burstMax(b, w0, w1));
      else { const [a, z] = aboveInterval(b); v += Math.max(0, Math.min(z, w1) - Math.max(a, w0)); }
    }
    out[k] = stat === 'avg' ? v / dt : stat === 'counter' ? (100 * v) / dt : v;
  }
  return out;
}

export interface Summary { detected: number; total: number; flagged: number; peakSeen: number; truePeak: number }
export function summarize(bursts: Burst[], dt: number, stat: Stat, R: Float64Array): Summary {
  let detected = 0;
  for (const b of bursts) {
    const [a, z] = aboveInterval(b);
    if (stat === 'sample') { if (Math.floor(z / dt) * dt >= a) detected++; continue; }
    for (let k = Math.floor(a / dt); k <= Math.min(R.length - 1, Math.floor(z / dt)); k++) {
      if (stat === 'counter' ? R[k] > 0 : R[k] >= THRESHOLD) { detected++; break; }
    }
  }
  let flagged = 0, peakSeen = 0;
  for (const v of R) { if (stat === 'counter' ? v > 0 : v >= THRESHOLD) flagged++; if (v > peakSeen) peakSeen = v; }
  const truePeak = bursts.reduce((m, b) => Math.max(m, BASE + b.p), BASE);
  return { detected, total: bursts.length, flagged, peakSeen, truePeak };
}

// ---------- UI ----------

const INTERVALS: { dt: number; label: string }[] = [
  { dt: 1e3, label: '1 ms' }, { dt: 1e4, label: '10 ms' }, { dt: 1e6, label: '1 s' },
  { dt: 1e7, label: '10 s' }, { dt: 3e7, label: '30 s' }, { dt: 3e8, label: '5 min' },
];
const STATS: { id: Stat; label: string }[] = [
  { id: 'sample', label: 'instant sample (gauge)' }, { id: 'avg', label: 'average over interval' },
  { id: 'max', label: 'watermark (max since last read)' }, { id: 'counter', label: 'counter: time above threshold, rate()' },
];
const ZOOMS = [600e6, 10e6, 100e3, 2e3];

export function fmtUs(us: number): string {
  if (us >= 60e6) return `${+(us / 60e6).toFixed(2)} min`;
  if (us >= 1e6) return `${+(us / 1e6).toFixed(2)} s`;
  if (us >= 1e3) return `${+(us / 1e3).toFixed(2)} ms`;
  return `${Math.round(us)} µs`;
}

const X0 = 44, X1 = 750, Y0 = 12, Y1 = 182;
const yOf = (v: number) => Y1 - (Math.min(100, v) / 100) * (Y1 - Y0);

function Plot({ bursts, v0, span, dt, stat }: { bursts: Burst[]; v0: number; span: number; dt: number; stat: Stat }) {
  const W = X1 - X0;
  const xOf = (t: number) => X0 + ((t - v0) / span) * W;
  // True trace: max per pixel column (an envelope), computed exactly from the bursts.
  const truth = readings(bursts, span / W, 'max', span, v0);
  const truePts = Array.from(truth, (v, i) => `${X0 + i + 0.5},${yOf(v).toFixed(1)}`).join(' ');
  // Collector view: readings whose windows overlap the view.
  const k0 = Math.floor(v0 / dt), k1 = Math.ceil((v0 + span) / dt);
  const R = readings(bursts, dt, stat, (k1 - k0) * dt, k0 * dt);
  let seen: string;
  if (R.length <= W) {
    seen = Array.from(R, (v, i) => {
      const a = Math.max(X0, xOf((k0 + i) * dt)), b = Math.min(X1, xOf((k0 + i + 1) * dt));
      return `${a.toFixed(1)},${yOf(v).toFixed(1)} ${b.toFixed(1)},${yOf(v).toFixed(1)}`;
    }).join(' ');
  } else {
    const per = R.length / W;
    seen = Array.from({ length: W }, (_, px) => {
      let m = 0;
      for (let k = Math.floor(px * per); k < Math.min(R.length, Math.floor((px + 1) * per)); k++) m = Math.max(m, R[k]);
      return `${X0 + px + 0.5},${yOf(m).toFixed(1)}`;
    }).join(' ');
  }
  const dots = R.length <= 60 ? Array.from(R, (v, i) => ({ x: xOf((k0 + i + 1) * dt), y: yOf(v) })).filter((d) => d.x >= X0 && d.x <= X1) : [];
  return (
    <svg viewBox="0 0 760 210" className="w-full" role="img" aria-label="True queue occupancy versus what the collector sees">
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={X0} x2={X1} y1={yOf(v)} y2={yOf(v)} stroke="var(--border)" strokeWidth={0.6} />
          <text x={X0 - 6} y={yOf(v) + 3} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">{v}%</text>
        </g>
      ))}
      <line x1={X0} x2={X1} y1={yOf(THRESHOLD)} y2={yOf(THRESHOLD)} stroke="var(--warn)" strokeDasharray="4 3" />
      <text x={X1} y={yOf(THRESHOLD) - 4} fontSize={10} textAnchor="end" fill="var(--warn)">alert threshold {THRESHOLD}%</text>
      <polyline points={truePts} fill="none" stroke="var(--muted)" strokeWidth={1} opacity={0.8} />
      <polyline points={seen} fill="none" stroke="var(--data)" strokeWidth={2} />
      {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={3} fill="var(--data)" />)}
      <text x={X0} y={200} fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">{fmtUs(v0)}</text>
      <text x={X1} y={200} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtUs(v0 + span)}</text>
      <text x={(X0 + X1) / 2} y={200} fontSize={10} textAnchor="middle" fill="var(--muted)">view {fmtUs(span)}</text>
    </svg>
  );
}

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function TelemetrySampling() {
  const [seed, setSeed] = useState(7);
  const [dt, setDt] = useState(1e7);
  const [stat, setStat] = useState<Stat>('sample');
  const [zoom, setZoom] = useState(600e6);
  const bursts = useMemo(() => generateBursts(seed), [seed]);
  const table = useMemo(() => INTERVALS.map((iv) => ({ ...iv, s: summarize(bursts, iv.dt, stat, readings(bursts, iv.dt, stat)) })), [bursts, stat]);
  const cur = table.find((r) => r.dt === dt)!.s;
  const peakBurst = bursts.reduce((m, b) => (b.p > m.p ? b : m), bursts[0]);
  const centre = peakBurst.s + peakBurst.r;
  const v0 = Math.min(Math.max(0, centre - zoom / 2), SPAN_US - zoom);
  const pct = (s: Summary) => (100 * s.detected) / s.total;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Seg label="Polling / sample interval" value={dt} options={INTERVALS.map((i) => i.dt)} onChange={setDt} render={(v) => INTERVALS.find((i) => i.dt === v)!.label} />
        <Seg label="Zoom (centred on the largest burst)" value={zoom} options={ZOOMS} onChange={setZoom} render={fmtUs} />
        <div className="sm:col-span-2"><Seg label="What the collector reads" value={stat} options={STATS.map((s) => s.id)} onChange={setStat} render={(v) => STATS.find((s) => s.id === v)!.label} /></div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Pill><span className="inline-block h-0.5 w-4 bg-muted" /> true occupancy (1 µs resolution, max per pixel)</Pill>
        <Pill><span className="inline-block h-0.5 w-4 bg-data" /> collector view{stat === 'counter' ? ' (% of interval above threshold)' : ''}</Pill>
        <Pill>{bursts.length.toLocaleString('en-US')} bursts in 10 min</Pill>
        <button type="button" onClick={() => setSeed((s) => s + 1)} className="rounded-md border border-line bg-panel px-2 py-0.5 text-xs hover:bg-panel-2">New trace (seed {seed})</button>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2"><Plot bursts={bursts} v0={v0} span={zoom} dt={dt} stat={stat} /></div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { l: 'Bursts detected', v: `${pct(cur).toFixed(pct(cur) < 1 && pct(cur) > 0 ? 2 : 1)} %`, t: pct(cur) > 90 ? 'text-accent' : pct(cur) > 10 ? 'text-warn' : 'text-danger', sub: `${cur.detected.toLocaleString('en-US')} of ${cur.total.toLocaleString('en-US')}` },
          { l: 'Peak seen / true peak', v: stat === 'counter' ? 'n/a' : `${cur.peakSeen.toFixed(1)} / ${cur.truePeak.toFixed(1)} %`, t: stat !== 'counter' && cur.peakSeen >= cur.truePeak - 0.05 ? 'text-accent' : 'text-warn', sub: stat === 'counter' ? 'a counter has no peak' : 'max reading over 10 min' },
          { l: 'Intervals flagged', v: cur.flagged.toLocaleString('en-US'), t: 'text-fg', sub: 'readings ≥ threshold (or > 0)' },
          { l: 'Readings per series', v: Math.ceil(SPAN_US / dt).toLocaleString('en-US'), t: 'text-fg', sub: 'in 10 minutes' },
        ].map((o) => (
          <div key={o.l} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{o.l}</div>
            <div className={`font-mono text-lg font-semibold tabular-nums ${o.t}`}>{o.v}</div>
            <div className="text-[11px] text-muted">{o.sub}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm">
          <caption className="mb-1 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-muted">All intervals, {STATS.find((s) => s.id === stat)!.label}</caption>
          <thead><tr className="border-b border-line text-xs text-muted"><th className="py-1 pr-3 font-medium">Interval</th><th className="py-1 pr-3 font-medium">Bursts detected</th><th className="py-1 pr-3 font-medium">Peak seen</th><th className="py-1 font-medium">Flagged intervals</th></tr></thead>
          <tbody className="font-mono tabular-nums">
            {table.map((r) => (
              <tr key={r.dt} className={`border-b border-line/60 ${r.dt === dt ? 'text-accent' : ''}`}>
                <td className="py-1 pr-3">{r.label}</td>
                <td className="py-1 pr-3">{pct(r.s).toFixed(2)} %</td>
                <td className="py-1 pr-3">{stat === 'counter' ? 'n/a' : `${r.s.peakSeen.toFixed(1)} %`}</td>
                <td className="py-1">{r.s.flagged.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 text-sm text-muted md:grid-cols-2">
        <p><strong className="text-fg">Gauges vs counters.</strong> Queue occupancy is a <em>gauge</em>: a value that goes up and down, so a reading says only what it was at that instant, and a 10 s sample almost never lands inside a 100 µs burst. Pause frames, ECN marks, drops and pause duration are <em>counters</em>: monotonically increasing, so every event is captured however rarely you read. <code className="font-mono">rate(x[1m])</code> or <code className="font-mono">increase()</code> turns them into per-second rates, but averages away <em>when</em> inside the window they happened.</p>
        <p><strong className="text-fg">Watermarks and subscriptions.</strong> A watermark register holds the peak since the last read (typically cleared on read; some NOSes also keep a persistent peak), so the interval only sets the window each worst moment is reported for, and the true peak survives any interval; what it cannot tell you is how many bursts there were (compare flagged intervals with bursts). In a gNMI STREAM subscription, SAMPLE mode sends values every <code className="font-mono">sample_interval</code> (given in nanoseconds; right for counters and watermarks); ON_CHANGE sends only when a value changes (right for oper-status and other state, wrong for a fast-moving gauge); TARGET_DEFINED lets the device choose per leaf.</p>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Synthetic, seeded trace: triangular microbursts (rise 10-150 µs, fall 20-400 µs, ~2 % ms-scale episodes) in trains every 250-350 ms over a 5 % background,
        expressed as % of the queue's buffer limit; every burst crosses the 30 % threshold. Values are computed exactly from the burst list (samples at the end of
        each interval; averages by integrating the triangles). The 1 ms and 10 ms options represent high-frequency telemetry, which only some ASICs and NOS releases
        offer and usually for a few ports at a time; check your platform's supported paths and minimum intervals. The "counter" mode models a time-above-threshold
        counter in the spirit of PFC pause-duration counters; real switches expose different counters.
      </p>
    </div>
  );
}
