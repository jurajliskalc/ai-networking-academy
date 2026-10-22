import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Pill } from '../components/ui';
import NumInput from '../components/NumInput';

// ---------- Pure model (unit-testable) ----------
// All-reduce of S bytes over N hosts (one endpoint per node per rail for the inter-node part).
// Ring (reduce-scatter + all-gather): each host sends and receives 2(N−1)/N · S, in 2(N−1) sequential steps
//   (nccl-tests PERFORMANCE.md; the collective-operations lesson).
// In-network aggregation (SHARP-style): each host sends S up to its leaf switch and receives S back;
//   switches reduce on the way up, the root's result is sent down the same tree (sharp-in-network-computing lesson).

export const ringBytesPerHost = (n: number, s: number) => (n > 1 ? ((2 * (n - 1)) / n) * s : 0);
export const ringSteps = (n: number) => 2 * (n - 1);
export const sharpBytesPerHost = (n: number, s: number) => (n > 1 ? s : 0);

/** Switch levels needed so that one root covers n hosts when every switch aggregates up to k children. */
export function treeLevels(n: number, k: number): number {
  if (n <= 1) return 0;
  let levels = 0, cover = 1;
  while (cover < n) { cover *= k; levels++; }
  return levels;
}
/** Sequential link hops of the in-network all-reduce: up through every level, then back down. */
export const sharpHops = (n: number, k: number) => 2 * treeLevels(n, k);

/** Alpha-beta time, seconds. alpha = per-step host/software latency, B = link bytes/s per direction. */
export const ringTime = (n: number, s: number, B: number, alpha: number) => ringSteps(n) * alpha + ringBytesPerHost(n, s) / B;
/** In-network: one host-side start-up alpha, per-hop switch latency on 2·levels hops, and S/B streaming (up and down
 *  overlap on full-duplex links when the message is pipelined in chunks). */
export const sharpTime = (n: number, k: number, s: number, B: number, alpha: number, hop: number) =>
  (n > 1 ? alpha + sharpHops(n, k) * hop + s / B : 0);

/** nccl-tests: algbw = S / t; busbw = algbw · 2(N−1)/N for all-reduce, whatever algorithm ran. */
export const busFactor = (n: number) => (2 * (n - 1)) / n;
export const algbw = (s: number, t: number) => s / t;
export const busbw = (n: number, s: number, t: number) => algbw(s, t) * busFactor(n);

export interface TreeNode { id: string; level: number; index: number; children: number[]; x: number }

/** Tree for drawing: level 0 = hosts, each higher level groups k nodes of the level below. */
export function buildTree(n: number, k: number): TreeNode[][] {
  const levels: TreeNode[][] = [Array.from({ length: n }, (_, i) => ({ id: `H${i + 1}`, level: 0, index: i, children: [], x: i }))];
  while (levels[levels.length - 1].length > 1 || levels.length === 1) {
    const below = levels[levels.length - 1];
    const lvl = levels.length;
    const up: TreeNode[] = [];
    for (let i = 0; i < below.length; i += k) {
      const ch = below.slice(i, i + k).map((c) => c.index);
      up.push({ id: `S${lvl}.${up.length + 1}`, level: lvl, index: up.length, children: ch, x: ch.reduce((a, c) => a + below[c].x, 0) / ch.length });
    }
    levels.push(up);
    if (n <= 1) break;
  }
  return levels;
}

/** Hosts under a node (inclusive range of host indices). */
export function hostsUnder(levels: TreeNode[][], level: number, index: number): number[] {
  if (level === 0) return [index];
  return levels[level][index].children.flatMap((c) => hostsUnder(levels, level - 1, c));
}

// ---------- formatting ----------

export function fmtBytes(b: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${+(b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2))} ${u[i]}`;
}
const fmtTime = (s: number) => (s < 1e-3 ? `${(s * 1e6).toFixed(1)} µs` : s < 1 ? `${(s * 1e3).toFixed(2)} ms` : `${s.toFixed(2)} s`);
const fmtGBs = (Bps: number) => `${(Bps / 1e9).toFixed(Bps >= 1e11 ? 0 : 1)} GB/s`;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

/** Phase of the stepper: 0 = initial; 1..L = up (level t switches have reduced); L+1..2L = down (level 2L−t has the result). */
function phaseOf(step: number, L: number) {
  if (step === 0) return { kind: 'init' as const, level: -1 };
  if (step <= L) return { kind: 'up' as const, level: step };
  return { kind: 'down' as const, level: 2 * L - step };
}

function TreeDiagram({ levels, step }: { levels: TreeNode[][]; step: number }) {
  const n = levels[0].length, L = levels.length - 1;
  const LM = 40, W = Math.max(380, n * 40 + LM + 20), rowH = 66, H = 24 + L * rowH + 46;
  const px = (x: number) => LM + ((x + 0.5) / n) * (W - LM - 20);
  const py = (level: number) => H - 34 - level * rowH;
  const ph = phaseOf(step, L);
  const total = n * (n + 1) / 2; // host i holds value i+1, so the reduced result is 1 + 2 + … + n
  // What each node holds at this step.
  const holds = (level: number, index: number): { label: string; state: 'own' | 'partial' | 'result' | 'idle' } => {
    const hs = hostsUnder(levels, level, index);
    const sum = hs.reduce((a, h) => a + h + 1, 0);
    const resultReached = ph.kind === 'down' && level >= ph.level;
    if (resultReached || (ph.kind === 'up' && ph.level === L && level === L)) return { label: String(total), state: 'result' };
    if (level === 0) return { label: String(index + 1), state: 'own' };
    if (ph.kind !== 'init' && level <= ph.level) return { label: `${sum}`, state: 'partial' };
    return { label: '·', state: 'idle' };
  };
  const desc = ph.kind === 'init' ? `initial state: each host holds its own value`
    : ph.kind === 'up' ? `step ${step} of ${2 * L}: level ${ph.level} switches reduce their children's data and ${ph.level === L ? 'the root has the full sum' : 'forward one partial sum upward'}`
    : `step ${step} of ${2 * L}: the result travels down to ${ph.level === 0 ? 'every host' : `level ${ph.level}`}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto w-full" style={{ minWidth: Math.min(W, 640), maxWidth: Math.max(W * 1.25, 560) }} role="img"
      aria-label={`Aggregation tree with ${n} hosts and ${L} switch level${L === 1 ? '' : 's'}; ${desc}. The final sum is ${total}.`}>
      <defs>
        <marker id="sh-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--text)" /></marker>
      </defs>
      {levels.slice(1).map((row, li) => row.map((node) => node.children.map((c) => {
        const level = li + 1, child = levels[level - 1][c];
        const up = ph.kind === 'up' && ph.level === level;
        const down = ph.kind === 'down' && ph.level === level - 1;
        const active = up || down;
        const [x1, y1, x2, y2] = up ? [px(child.x), py(level - 1) - 14, px(node.x), py(level) + 14] : [px(node.x), py(level) + 14, px(child.x), py(level - 1) - 14];
        return <line key={`${node.id}-${c}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={active ? (up ? 'var(--data)' : 'var(--accent)') : 'var(--border)'}
          strokeWidth={active ? 2.5 : 1.25} strokeDasharray={down ? '6 3' : ''} markerEnd={active ? 'url(#sh-arrow)' : undefined} className={active && !reducedMotion() ? 'flow-dash' : ''} />;
      })))}
      {levels.map((_, level) => (
        <text key={`lv${level}`} x={4} y={py(level) + 4} fontSize={9} fontFamily="var(--font-mono)" fill="var(--muted)">
          {level === 0 ? 'hosts' : level === L ? 'root' : level === 1 ? 'leaf' : `L${level}`}
        </text>
      ))}
      {levels.map((row, level) => row.map((node) => {
        const h = holds(level, node.index), x = px(node.x), y = py(level);
        const fill = h.state === 'result' ? 'var(--accent-soft)' : h.state === 'partial' ? 'var(--panel-2)' : 'var(--panel)';
        const stroke = h.state === 'result' ? 'var(--accent)' : h.state === 'partial' ? 'var(--data)' : 'var(--muted)';
        return (
          <g key={node.id}>
            {level === 0
              ? <circle cx={x} cy={y} r={14} fill={fill} stroke={stroke} strokeWidth={1.5} />
              : <rect x={x - 22} y={y - 14} width={44} height={28} rx={5} fill={fill} stroke={stroke} strokeWidth={1.5} strokeDasharray={h.state === 'idle' ? '3 2' : ''} />}
            <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={h.state === 'result' ? 700 : 400} fontFamily="var(--font-mono)" fill="var(--text)">{h.label}</text>
            {level === 0 && <text x={x} y={y + 28} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono)" fill="var(--muted)">{node.id}</text>}
          </g>
        );
      }))}
    </svg>
  );
}

function StepLadder({ label, steps, done, tone }: { label: string; steps: number; done: number; tone: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between font-mono text-[10px] text-muted"><span>{label}</span><span>{done}/{steps} sequential steps</span></div>
      <div className="flex flex-wrap gap-[3px]" aria-hidden>
        {Array.from({ length: steps }, (_, i) => (
          <span key={i} className="h-3 w-3 rounded-[3px] border" style={{ borderColor: tone, background: i < done ? tone : 'transparent' }} />
        ))}
      </div>
    </div>
  );
}

function TimeChart({ n, k, B, alpha, hop, logS }: { n: number; k: number; B: number; alpha: number; hop: number; logS: number }) {
  const W = 560, H = 200, L = 52, R = 12, T = 12, Bt = 28, lo = 10, hi = 32;
  const xs = Array.from({ length: (hi - lo) * 2 + 1 }, (_, i) => lo + i / 2);
  const pts = xs.map((l) => ({ l, r: ringTime(n, 2 ** l, B, alpha), s: sharpTime(n, k, 2 ** l, B, alpha, hop) }));
  const ymin = Math.floor(Math.log10(Math.min(...pts.map((p) => Math.min(p.r, p.s))))), ymax = Math.ceil(Math.log10(Math.max(...pts.map((p) => Math.max(p.r, p.s)))));
  const X = (l: number) => L + ((l - lo) / (hi - lo)) * (W - L - R);
  const Y = (t: number) => T + (1 - (Math.log10(t) - ymin) / (ymax - ymin || 1)) * (H - T - Bt);
  const line = (key: 'r' | 's') => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.l).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
  const decades = Array.from({ length: ymax - ymin + 1 }, (_, i) => ymin + i);
  const S = 2 ** logS, tr = ringTime(n, S, B, alpha), ts = sharpTime(n, k, S, B, alpha, hop);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[480px]" role="img"
      aria-label={`All-reduce time versus message size, log-log, ${n} hosts. At ${fmtBytes(S)}: ring ${fmtTime(tr)}, in-network ${fmtTime(ts)}, ${(tr / ts).toFixed(2)} times faster. Small messages: ratio near ${(ringTime(n, 1024, B, alpha) / sharpTime(n, k, 1024, B, alpha, hop)).toFixed(1)}; large messages: ratio approaches ${busFactor(n).toFixed(2)}.`}>
      {decades.map((d) => (
        <g key={d}>
          <line x1={L} x2={W - R} y1={Y(10 ** d)} y2={Y(10 ** d)} stroke="var(--border)" strokeWidth={0.75} />
          <text x={L - 4} y={Y(10 ** d) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{fmtTime(10 ** d).replace('.0 ', ' ').replace('.00 ', ' ')}</text>
        </g>
      ))}
      {[10, 16, 22, 28, 32].map((l) => <text key={l} x={X(l)} y={H - 10} textAnchor={l === hi ? 'end' : 'middle'} fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{fmtBytes(2 ** l)}</text>)}
      <path d={line('r')} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="6 3" />
      <path d={line('s')} fill="none" stroke="var(--data)" strokeWidth={2.5} />
      <line x1={X(logS)} x2={X(logS)} y1={T} y2={H - Bt} stroke="var(--accent)" strokeWidth={1.25} />
      <g fontSize={10} fontFamily="var(--font-mono)">
        <line x1={L + 8} x2={L + 28} y1={T + 6} y2={T + 6} stroke="var(--warn)" strokeWidth={2} strokeDasharray="6 3" /><text x={L + 32} y={T + 9} fill="var(--text)">ring</text>
        <line x1={L + 70} x2={L + 90} y1={T + 6} y2={T + 6} stroke="var(--data)" strokeWidth={2.5} /><text x={L + 94} y={T + 9} fill="var(--text)">in-network (SHARP-style)</text>
      </g>
    </svg>
  );
}

const DRAW_N = [4, 8, 16] as const;
const DRAW_K = [2, 4] as const;
const NUM_N = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048] as const;
const NUM_K = [2, 4, 8, 16, 32] as const;
const LINK = [
  // Per-direction data rate of one host link: InfiniBand HDR 200 Gb/s, NDR 400 Gb/s, XDR 800 Gb/s, divided by 8.
  { id: 25, name: 'HDR 200G' }, { id: 50, name: 'NDR 400G' }, { id: 100, name: 'XDR 800G' },
] as const;

export default function SharpAggregation() {
  // Stepper
  const [dn, setDn] = useState<number>(4);
  const [dk, setDk] = useState<number>(2);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const levels = useMemo(() => buildTree(dn, dk), [dn, dk]);
  const L = levels.length - 1, total = 2 * L;
  useEffect(() => { setStep(0); setPlaying(false); }, [dn, dk]);
  useEffect(() => {
    if (!playing) return;
    if (step >= total) { setPlaying(false); return; }
    const id = window.setTimeout(() => setStep((s) => s + 1), reducedMotion() ? 300 : 1100);
    return () => window.clearTimeout(id);
  }, [playing, step, total]);
  const ph = phaseOf(step, L);
  const ringDone = Math.min(ringSteps(dn), Math.round((step / total) * ringSteps(dn)));
  const phaseText = ph.kind === 'init' ? `Each host holds its own data (host i holds the value i). The result every host needs is the sum, ${dn * (dn + 1) / 2}.`
    : ph.kind === 'up' ? (ph.level === L ? `Up ${step}/${L}: the root reduces its children's partial sums and now holds the full result.` : `Up ${step}/${L}: each level-${ph.level} switch adds the data of its ${dk} children and forwards one partial sum: one stream up per link, not one per host.`)
    : `Down ${step - L}/${L}: the root's result is sent down the same tree${ph.level === 0 ? ' and has reached every host. Each host sent S once and received S once.' : `, now at level ${ph.level}.`}`;

  // Numbers
  const [nIdx, setNIdx] = useState(7); // 256
  const [k, setK] = useState<number>(32);
  const [logS, setLogS] = useState(28); // 256 MiB
  const [gbs, setGbs] = useState<number>(50);
  const [alphaUs, setAlphaUs] = useState(5);
  const [hopUs, setHopUs] = useState(1);
  const n = NUM_N[nIdx], S = 2 ** logS, B = gbs * 1e9, alpha = alphaUs * 1e-6, hop = hopUs * 1e-6;
  const rb = ringBytesPerHost(n, S), sb = sharpBytesPerHost(n, S);
  const tr = ringTime(n, S, B, alpha), ts = sharpTime(n, k, S, B, alpha, hop);
  const lv = treeLevels(n, k);

  return (
    <div className="space-y-5">
      <section aria-labelledby="sh-watch" className="space-y-3">
        <div id="sh-watch" className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Watch one all-reduce</div>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <Seg label="Hosts" value={dn} options={DRAW_N} onChange={setDn} />
          <Seg label="Children per switch" value={dk} options={DRAW_K} onChange={setDk} />
          <div className="flex gap-2">
            <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => setStep((s) => Math.min(total, s + 1))} disabled={step >= total}>Step</Button>
            <Button className="!px-3 !py-1 text-xs" onClick={() => { if (step >= total) setStep(0); setPlaying((p) => !p); }}>{playing ? 'Pause' : 'Play'}</Button>
            <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => { setStep(0); setPlaying(false); }}>Reset</Button>
          </div>
        </div>
        <p className="min-h-[2.5rem] text-sm" aria-live={playing ? 'off' : 'polite'}><span className="sr-only">Step {step} of {total}. </span>{phaseText}</p>
        <div className="overflow-x-auto rounded-lg border border-line bg-panel p-2" tabIndex={0} role="region" aria-label="Aggregation tree diagram, scrollable">
          <TreeDiagram levels={levels} step={step} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span><span className="font-mono text-data">solid arrow</span> = data going up, being reduced</span>
          <span><span className="font-mono text-accent">dashed arrow</span> = result coming down</span>
          <span>numbers = the value or partial sum a node holds</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <StepLadder label={`In-network: 2 × ${L} level${L === 1 ? '' : 's'}`} steps={total} done={step} tone="var(--data)" />
          <StepLadder label={`Ring: 2 × (${dn} − 1)`} steps={ringSteps(dn)} done={ringDone} tone="var(--warn)" />
        </div>
        <p className="text-xs text-muted">The ring ladder advances in proportion, for comparison only. The allreduce-sim widget animates the ring itself.</p>
      </section>

      <section aria-labelledby="sh-scale" className="space-y-3 rounded-xl border border-line bg-panel-2 p-3">
        <div id="sh-scale" className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Scale it up (alpha-beta model)</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              <label htmlFor="sh-n">Hosts N (per rail)</label><span className="text-base font-semibold normal-case tracking-normal text-fg">{n}</span>
            </div>
            <input id="sh-n" type="range" min={0} max={NUM_N.length - 1} value={nIdx} aria-valuetext={`${n} hosts`} onChange={(e) => setNIdx(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              <label htmlFor="sh-s">Message S</label><span className="text-base font-semibold normal-case tracking-normal text-fg">{fmtBytes(S)}</span>
            </div>
            <input id="sh-s" type="range" min={10} max={32} value={logS} aria-valuetext={fmtBytes(S)} onChange={(e) => setLogS(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </div>
          <Seg label="Children per switch (down-ports)" value={k} options={NUM_K} onChange={setK} />
          <Seg label="Host link (per direction)" value={gbs} options={LINK.map((l) => l.id)} onChange={setGbs} render={(v) => `${LINK.find((l) => l.id === v)!.name} · ${v} GB/s`} />
          <div>
            <label htmlFor="sh-alpha" className={lbl}>Host step latency α (µs, assumed)</label>
            <NumInput id="sh-alpha" min={0} max={100} step={0.5} value={alphaUs} onValue={setAlphaUs}
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
          </div>
          <div>
            <label htmlFor="sh-hop" className={lbl}>Per switch hop (µs, assumed)</label>
            <NumInput id="sh-hop" min={0} max={100} step={0.1} value={hopUs} onValue={setHopUs}
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
          <Out label="Ring: per host, each way" value={fmtBytes(rb)} tone="text-warn" sub={`2(N−1)/N × S = ${busFactor(n).toFixed(3)} × S`} />
          <Out label="In-network: per host" value={fmtBytes(sb)} tone="text-data" sub={`S up, S down (${(rb / sb).toFixed(2)}× less)`} />
          <Out label="Sequential steps" value={`${ringSteps(n)} vs ${2 * lv}`} sub={`ring 2(N−1) vs tree 2 × ${lv} level${lv === 1 ? '' : 's'}`} />
          <Out label="Time: ring vs in-network" value={`${(tr / ts).toFixed(2)}×`} tone="text-accent" sub={`${fmtTime(tr)} vs ${fmtTime(ts)}`} />
        </div>

        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Time versus message size chart, scrollable">
          <TimeChart n={n} k={k} B={B} alpha={alpha} hop={hop} logS={logS} />
        </div>

        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="nccl-tests view of both algorithms" aria-live="polite">
          <table className="w-full min-w-[420px] text-left font-mono text-xs">
            <caption className="pb-1 text-left text-[11px] text-muted">What nccl-tests would report (busbw = algbw × {busFactor(n).toFixed(3)}, the same factor for both; nccl-tests uses the total rank count, so with several GPUs per host the factor is 2(ranks − 1)/ranks)</caption>
            <thead><tr className="text-muted"><th className="py-1 pr-3 font-normal">Algorithm</th><th className="pr-3 font-normal">time</th><th className="pr-3 font-normal">algbw</th><th className="font-normal">busbw</th></tr></thead>
            <tbody>
              <tr className="border-t border-line"><td className="py-1 pr-3">Ring</td><td className="pr-3">{fmtTime(tr)}</td><td className="pr-3">{fmtGBs(algbw(S, tr))}</td><td>{fmtGBs(busbw(n, S, tr))}</td></tr>
              <tr className="border-t border-line"><td className="py-1 pr-3">In-network</td><td className="pr-3">{fmtTime(ts)}</td><td className="pr-3">{fmtGBs(algbw(S, ts))}</td>
                <td className={busbw(n, S, ts) > B ? 'text-warn' : ''}>{fmtGBs(busbw(n, S, ts))}{busbw(n, S, ts) > B ? ' (above link rate)' : ''}</td></tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">
          A ring can at best reach busbw ≈ link rate ({gbs} GB/s). With in-network reduction algbw itself approaches the link rate, so the reported busbw
          can exceed it by up to 2(N−1)/N. That is the formula, not a measurement error: compare busbw with SHARP on and off, not against the line rate alone.
        </p>
      </section>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation (N = {n}, S = {fmtBytes(S)})</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>ring: reduce-scatter then all-gather, N − 1 steps each, S/N bytes per step → 2(N − 1)/N × S = <span className="font-mono text-fg">{fmtBytes(rb)}</span> sent and received per host in {ringSteps(n)} steps</li>
          <li>in-network: S up to the leaf, S down from it; every switch forwards one reduced stream, so every link carries S each way</li>
          <li>tree levels with {k} children per switch: smallest L with {k}<sup>L</sup> ≥ {n} → L = {lv}; sequential hops = 2L = {2 * lv} (same k at every level is a simplification: in a two-tier fat tree of radix-R switches a leaf has R/2 hosts but the root spine can take up to R leaves, so two levels reach R²/2 hosts)</li>
          <li>ring time = 2(N − 1)·α + 2(N − 1)/N·S/B = {ringSteps(n)} × {alphaUs} µs + {fmtBytes(rb)} / {gbs} GB/s = <span className="font-mono text-fg">{fmtTime(tr)}</span></li>
          <li>in-network time = α + 2L·hop + S/B = {alphaUs} µs + {2 * lv} × {hopUs} µs + {fmtBytes(S)} / {gbs} GB/s = <span className="font-mono text-fg">{fmtTime(ts)}</span></li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>large messages: at best {busFactor(n).toFixed(2)}× (→ 2× as N grows)</Pill>
        <Pill>N = 2: no bandwidth gain (ring already sends S)</Pill>
        <Pill>small messages: {ringSteps(n)} steps vs {2 * lv} hops</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Idealised model. The ring is the flat host ring of the alpha-beta model; NCCL also has tree algorithms and, inside a server, reduces over
        NVLink first (or with NVLink SHARP on NVSwitch), so N here is the number of inter-node endpoints per rail and only that part of the
        all-reduce moves to the switches. The in-network time assumes the message is pipelined in chunks so up and down traffic overlap, and that
        switch reduction keeps up with line rate (the goal of streaming aggregation in SHARPv2 on Quantum/HDR and SHARPv3 on Quantum-2/NDR). α and
        the per-hop latency are inputs, not vendor figures. Which data types and operations are supported, how many trees and concurrent jobs the
        switches can hold, and the message-size limits depend on the switch generation and SHARP release: take them from NVIDIA's SHARP
        documentation. When SHARP resources cannot be obtained, NCCL typically falls back to host algorithms without failing the job, so check the NCCL debug log rather than assume it is active. Binary units for message sizes
        (1 MiB = 2^20 B), decimal for rates (1 GB/s = 10^9 B/s).
      </p>
    </div>
  );
}
