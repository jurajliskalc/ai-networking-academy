import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

// ---------- Pure model (unit-testable) ----------
//
// Each of N workers finishes its share of a synchronous step after
//   T_i = base + J_i + d·B_i
// J_i ~ Exponential(mean mu)   small, always-present jitter (OS noise, clocks, congestion)
// B_i ~ Bernoulli(p)           a rare "slow event" on that worker in this step, which costs an extra d
// all independent. The step ends when the slowest worker is done: T_step = base + max_i (J_i + d·B_i).
// Everything below is computed exactly (closed form) or by deterministic numerical integration; no random numbers.

/** P(at least one of n workers is slow in a step) = 1 − (1 − p)^n, computed without cancellation for tiny p. */
export function pSlowStep(p: number, n: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return -Math.expm1(n * Math.log1p(-p));
}

/** Smallest worker count at which a step is slow with probability ≥ target. */
export function workersForProb(p: number, target: number): number {
  return Math.ceil(Math.log1p(-target) / Math.log1p(-p) - 1e-9);
}

/** n-th harmonic number H_n = 1 + 1/2 + … + 1/n (E[max of n iid Exp(1)] = H_n). */
export function harmonic(n: number): number {
  let h = 0;
  for (let k = 1; k <= n; k++) h += 1 / k;
  return h;
}

/** CDF of one worker's extra time X = J + d·B at x ≥ 0. */
export function workerCdf(x: number, mu: number, p: number, d: number): number {
  const G = (y: number) => (y < 0 ? 0 : mu <= 0 ? 1 : -Math.expm1(-y / mu));
  return (1 - p) * G(x) + p * G(x - d);
}

/** CDF of the step's extra time max(X_1..X_n). */
export const stepCdf = (x: number, n: number, mu: number, p: number, d: number) => Math.pow(workerCdf(x, mu, p, d), n);

function simpson(f: (x: number) => number, a: number, b: number, m: number): number {
  if (b <= a) return 0;
  const h = (b - a) / m;
  let s = f(a) + f(b);
  for (let i = 1; i < m; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

/** E[max_i X_i]: exact closed forms where they exist, else ∫0^∞ (1 − F(x)^n) dx by composite Simpson's rule. */
export function expectedExtra(n: number, mu: number, p: number, d: number): number {
  if (mu <= 0) return d * pSlowStep(p, n); // no jitter: the step is late by d iff any worker had a slow event
  if (p <= 0 || d <= 0) return mu * harmonic(n); // jitter only: E[max of n Exp(mu)] = mu·H_n
  const f = (x: number) => 1 - stepCdf(x, n, mu, p, d);
  const tail = mu * (Math.log(n) + 40); // beyond this 1 − F^n < n·e^−(ln n + 40) ≈ 4e−18
  // Split [0, d] where the jitter part has decayed, so a tiny mu next to a large d is still resolved.
  const a = Math.min(d, tail);
  return simpson(f, 0, a, 4000) + simpson(f, a, d, 2000) + simpson(f, d, d + tail, 8000);
}

/** q-quantile of the step's extra time, by bisection on F(x)^n = q. */
export function quantileExtra(q: number, n: number, mu: number, p: number, d: number): number {
  let lo = 0, hi = d + Math.max(mu, 1e-9) * (Math.log(n) + 60);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (stepCdf(mid, n, mu, p, d) < q) lo = mid; else hi = mid;
  }
  return hi;
}

export interface StepStats { pSlow: number; mean: number; slowdown: number; lostPct: number; workerMean: number; p50: number; p99: number }

/** Expected step time and derived numbers for n workers. Times in the caller's unit (ms in the UI). */
export function stepStats(n: number, base: number, mu: number, p: number, d: number): StepStats {
  const mean = base + expectedExtra(n, mu, p, d);
  return {
    pSlow: pSlowStep(p, n),
    mean,
    slowdown: mean / base,
    lostPct: (1 - base / mean) * 100,
    workerMean: base + mu + p * d, // what one worker averages on its own: looks harmless
    p50: base + quantileExtra(0.5, n, mu, p, d),
    p99: base + quantileExtra(0.99, n, mu, p, d),
  };
}

/** GPU-seconds spent waiting per step when exactly one worker is late by d: every other worker idles d. */
export const idleGpuSecondsPerStep = (n: number, dSeconds: number) => (n - 1) * dSeconds;

// ---------- formatting ----------

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 1e4 ? 1 : 3)} s` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`);
const fmtN = (n: number) => n.toLocaleString('en-US');
const fmtProb = (x: number) => (x > 0.9995 && x < 1 ? '> 99.9%' : x < 0.001 && x > 0 ? '< 0.1%' : `${(x * 100).toFixed(1)}%`);
const pLabel = (p: number) => `1 in ${Math.round(1 / p).toLocaleString('en-US')}`;

// ---------- UI ----------

const lbl = 'mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted';
const btn = (on: boolean) => `min-h-[24px] rounded-md border px-2 py-1 font-mono text-xs transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className={lbl}>{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value} className={btn(o === value)}>
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

const PS = [1e-5, 1e-4, 1e-3, 1e-2] as const;
const NS = Array.from({ length: 13 }, (_, i) => 2 ** (i + 3)); // 8 … 32768
const DASH = ['1 4', '6 3', '', '2 2'];

function ProbChart({ p, n }: { p: number; n: number }) {
  const W = 640, H = 230, L = 46, R = 70, T = 12, B = 30;
  const lx0 = 3, lx1 = 15;
  const x = (nn: number) => L + ((Math.log2(nn) - lx0) / (lx1 - lx0)) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const curve = (pp: number) => {
    const pts: string[] = [];
    for (let k = 0; k <= 120; k++) { const nn = 2 ** (lx0 + ((lx1 - lx0) * k) / 120); pts.push(`${k ? 'L' : 'M'}${x(nn).toFixed(1)},${y(pSlowStep(pp, nn)).toFixed(1)}`); }
    return pts.join(' ');
  };
  const cur = pSlowStep(p, n);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]" role="img"
      aria-label={`Probability that a step waits on at least one slow worker versus worker count, 8 to 32768 on a log scale. With a per-worker probability of ${pLabel(p)} per step: ${NS.filter((_, i) => i % 3 === 0).map((nn) => `${fmtN(nn)} workers ${fmtProb(pSlowStep(p, nn))}`).join(', ')}. Selected: ${fmtN(n)} workers, ${fmtProb(cur)}.`}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--border)" strokeWidth={v === 0 ? 1 : 0.75} />
          <text x={L - 6} y={y(v) + 4} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">{v * 100}%</text>
        </g>
      ))}
      {[8, 64, 512, 4096, 32768].map((nn) => (
        <text key={nn} x={x(nn)} y={H - 10} fontSize={10} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtN(nn)}</text>
      ))}
      {PS.map((pp, i) => {
        const sel = pp === p;
        const endY = y(pSlowStep(pp, 2 ** lx1));
        // Label at the point where the curve crosses 50% (or at the right edge for curves that stay low).
        const n50 = workersForProb(pp, 0.5);
        const lxp = n50 <= 2 ** lx1 ? Math.max(x(n50), L + 16) : W - R;
        const lyp = n50 <= 2 ** lx1 ? y(0.5) : endY;
        return (
          <g key={pp}>
            <path d={curve(pp)} fill="none" stroke={sel ? 'var(--data)' : 'var(--muted)'} strokeWidth={sel ? 2.5 : 1.25} strokeDasharray={sel ? '' : DASH[i] || '3 3'} opacity={sel ? 1 : 0.8} />
            <text x={lxp + 4} y={n50 <= 2 ** lx1 ? lyp - 5 : lyp + 4} fontSize={10} fontWeight={sel ? 700 : 400}
              fill={sel ? 'var(--data)' : 'var(--muted)'} fontFamily="var(--font-mono)" textAnchor={n50 <= 2 ** lx1 ? 'end' : 'start'}>p={pp.toExponential(0)}</text>
          </g>
        );
      })}
      <line x1={x(n)} y1={T} x2={x(n)} y2={H - B} stroke="var(--accent)" strokeDasharray="3 3" />
      <circle cx={x(n)} cy={y(cur)} r={5} fill="var(--data)" stroke="var(--panel)" strokeWidth={1.5} />
      <text x={x(n) + (x(n) > W - R - 60 ? -8 : 8)} y={Math.max(T + 10, y(cur) - 8)} fontSize={11} fontWeight={700} fill="var(--text)" textAnchor={x(n) > W - R - 60 ? 'end' : 'start'} fontFamily="var(--font-mono)">{fmtProb(cur)}</text>
    </svg>
  );
}

function CdfChart({ n, base, mu, p, d, stats, one }: { n: number; base: number; mu: number; p: number; d: number; stats: StepStats; one: StepStats }) {
  const W = 640, H = 226, L = 46, R = 16, T = 30, B = 30;
  const xMax = base + Math.max(quantileExtra(0.999, n, mu, p, d), quantileExtra(0.999, 1, mu, p, d), 1e-6) * 1.08;
  const xMin = base;
  const x = (t: number) => L + ((t - xMin) / (xMax - xMin)) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const path = (nn: number) => {
    const pts: string[] = [];
    for (let k = 0; k <= 200; k++) { const t = xMin + ((xMax - xMin) * k) / 200; pts.push(`${k ? 'L' : 'M'}${x(t).toFixed(1)},${y(stepCdf(t - base, nn, mu, p, d)).toFixed(1)}`); }
    return pts.join(' ');
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => xMin + f * (xMax - xMin));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]" role="img"
      aria-label={`Cumulative distribution of step time. One worker alone: median ${fmtMs(one.p50)}, 99th percentile ${fmtMs(one.p99)}. Synchronous step over ${fmtN(n)} workers: median ${fmtMs(stats.p50)}, 99th percentile ${fmtMs(stats.p99)}, mean ${fmtMs(stats.mean)} against a base of ${fmtMs(base)}.`}>
      {[0, 0.5, 0.99].map((v) => (
        <g key={v}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--border)" strokeWidth={0.75} strokeDasharray={v === 0.99 ? '2 3' : ''} />
          <text x={L - 6} y={y(v) + 4} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">{v === 0.99 ? 'p99' : v === 0.5 ? 'p50' : '0'}</text>
        </g>
      ))}
      {ticks.map((t, i) => <text key={i} x={x(t)} y={H - 10} fontSize={10} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fill="var(--muted)" fontFamily="var(--font-mono)">{fmtMs(t)}</text>)}
      <path d={path(1)} fill="none" stroke="var(--muted)" strokeWidth={1.75} strokeDasharray="6 4" />
      <path d={path(n)} fill="none" stroke="var(--data)" strokeWidth={2.5} />
      <line x1={x(stats.mean)} y1={T} x2={x(stats.mean)} y2={H - B} stroke="var(--warn)" strokeWidth={1.5} />
      <text x={Math.min(x(stats.mean) + 4, W - R - 90)} y={T + 14} fontSize={10} fill="var(--warn)" fontFamily="var(--font-mono)">mean {fmtMs(stats.mean)}</text>
      <g fontSize={10} fontFamily="var(--font-mono)">
        <line x1={L + 8} x2={L + 28} y1={8} y2={8} stroke="var(--muted)" strokeWidth={1.75} strokeDasharray="6 4" />
        <text x={L + 32} y={11} fill="var(--text)">1 worker</text>
        <line x1={L + 100} x2={L + 120} y1={8} y2={8} stroke="var(--data)" strokeWidth={2.5} />
        <text x={L + 124} y={11} fill="var(--text)">step = slowest of {fmtN(n)}</text>
      </g>
    </svg>
  );
}


export default function StragglerTail() {
  const [nIdx, setNIdx] = useState(7); // 1024
  const [p, setP] = useState<number>(1e-3);
  const [base, setBase] = useState(1000);
  const [mu, setMu] = useState(2);
  const [d, setD] = useState(100);
  const n = NS[nIdx];

  const stats = useMemo(() => stepStats(n, base, mu, p, d), [n, base, mu, p, d]);
  const one = useMemo(() => stepStats(1, base, mu, p, d), [base, mu, p, d]);
  const n50 = workersForProb(p, 0.5), n99 = workersForProb(p, 0.99);
  const alwaysSlow = (base + d) / base; // one persistently bad worker: every step ≥ base + d
  const idleGpuH = (idleGpuSecondsPerStep(n, d / 1000) * (86400 / ((base + d) / 1000))) / 3600;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <label htmlFor="st-n">Workers (GPUs) in the job</label><span className="text-base font-semibold normal-case tracking-normal text-fg">{n.toLocaleString('en-US')}</span>
          </div>
          <input id="st-n" type="range" min={0} max={NS.length - 1} value={nIdx} aria-valuetext={`${n.toLocaleString('en-US')} workers`}
            onChange={(e) => setNIdx(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          <div className="flex justify-between font-mono text-[10px] text-muted" aria-hidden><span>8</span><span>32,768</span></div>
        </div>
        <Seg label="Chance one worker has a slow event in a step (p)" value={p} options={PS} onChange={setP} render={(v) => pLabel(v)} />
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          {([
            ['st-base', 'Base step (ms)', base, setBase, 1, 100000],
            ['st-mu', 'Mean jitter (ms)', mu, setMu, 0, 10000],
            ['st-d', 'Slow event adds (ms)', d, setD, 0, 100000],
          ] as const).map(([id, name, v, set, lo, hi]) => (
            <div key={id}>
              <label htmlFor={id} className={lbl}>{name}</label>
              <NumInput id={id} min={lo} max={hi} step="any" value={v} onValue={set}
                className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="Steps that wait on a slow worker" value={fmtProb(stats.pSlow)} tone={stats.pSlow > 0.5 ? 'text-danger' : stats.pSlow > 0.1 ? 'text-warn' : 'text-accent'}
          sub={`1 − (1 − ${p.toExponential(0)})^${n}`} />
        <Out label="Expected step time" value={fmtMs(stats.mean)} tone="text-data" sub={`p99 ${fmtMs(stats.p99)}`} />
        <Out label="Slowdown (E[step] / base)" value={`${stats.slowdown.toFixed(3)}×`} tone={stats.lostPct > 5 ? 'text-warn' : 'text-fg'} sub={`${stats.lostPct.toFixed(1)}% of throughput lost`} />
        <Out label="One worker on average" value={fmtMs(stats.workerMean)} sub={`${(((stats.workerMean - base) / base) * 100).toFixed(2)}% above base${stats.workerMean - base < 0.05 * base ? ': looks harmless' : ''}`} />
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">P(a step waits on ≥ 1 slow worker) vs job size</div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Probability chart, scrollable">
          <ProbChart p={p} n={n} />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Step-time distribution (CDF): one worker vs the synchronous step</div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Step-time distribution chart, scrollable">
          <CdfChart n={n} base={base} mu={mu} p={p} d={d} stats={stats} one={one} />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-muted" aria-live="polite">
        <span className="font-semibold text-fg">Rare per node, certain per step.</span> At {pLabel(p)} per worker per step, half of all steps are hit
        from <span className="font-mono text-fg">{n50.toLocaleString('en-US')}</span> workers and 99% from <span className="font-mono text-fg">{n99.toLocaleString('en-US')}</span>.
        A single <span className="text-fg">persistently</span> marginal link, NIC or GPU is the limit p = 1 for one worker: every step waits about {fmtMs(d)},
        at least a {alwaysSlow.toFixed(3)}× slowdown at any job size, while {(n - 1).toLocaleString('en-US')} healthy GPUs idle {fmtMs(d)} each step (about {idleGpuH >= 10 ? Math.round(idleGpuH).toLocaleString('en-US') : idleGpuH.toFixed(1)} GPU-hours a day if every step waits).
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>worker i finishes at base + J<sub>i</sub> + d·B<sub>i</sub>, J ~ Exponential(mean {fmtMs(mu)}), B = 1 with probability p; the step ends at the maximum</li>
          <li>P(no worker slow) = (1 − p)<sup>N</sup> = (1 − {p.toExponential(0)})<sup>{n}</sup> = {(1 - stats.pSlow).toPrecision(3)} → P(step hit) = <span className="font-mono text-fg">{fmtProb(stats.pSlow)}</span> ≈ 1 − e<sup>−Np</sup> = {fmtProb(-Math.expm1(-n * p))}</li>
          <li>jitter alone: E[max of N Exponentials] = mean × H<sub>N</sub> = {fmtMs(mu)} × {harmonic(n).toFixed(2)} = {fmtMs(mu * harmonic(n))} (H<sub>N</sub> ≈ ln N + 0.577 grows slowly)</li>
          <li>combined: E[step] = base + ∫ (1 − F(x)<sup>N</sup>) dx, F = (1 − p)·G(x) + p·G(x − d) = <span className="font-mono text-fg">{fmtMs(stats.mean)}</span>; slowdown {stats.slowdown.toFixed(3)}× (throughput × {(1 / stats.slowdown).toFixed(3)})</li>
          <li>with one always-slow worker: E[step] ≥ base + d = {fmtMs(base + d)}, whatever N is</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>50% of steps hit at N ≈ 0.69 / p</Pill>
        <Pill>expected slow workers per step: N·p = {+(n * p).toPrecision(3)}</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Illustrative model, not a measurement: workers are independent and identical, jitter is exponential and the slow event is a fixed extra
        delay; real stragglers are correlated (a shared switch, a hot rack), heavy-tailed and often persistent, which is worse. It assumes every step
        ends in a barrier-like collective that waits for all workers and ignores overlap of communication with compute, which can hide small delays.
        Mean and percentiles are computed deterministically (closed forms where they exist, otherwise Simpson integration and bisection on F(x)<sup>N</sup>), not sampled. The probabilities
        and delays are inputs to explore, not typical values for any platform.
      </p>
    </div>
  );
}
