import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/ui';

type Algo = 'ring' | 'tree';

const hue = (c: number, n: number) => `hsl(${Math.round((c * 360) / n)} 70% 55%)`;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ---------- Ring all-reduce state ---------- */
// buf[g][c] = number of GPUs whose contribution chunk c on GPU g already contains (N = fully reduced)
interface RingStep { phase: 'rs' | 'ag'; idx: number; sends: { from: number; to: number; chunk: number }[] }

function ringSteps(n: number): RingStep[] {
  const out: RingStep[] = [];
  for (let s = 0; s < n - 1; s++) out.push({ phase: 'rs', idx: s + 1, sends: Array.from({ length: n }, (_, i) => ({ from: i, to: (i + 1) % n, chunk: (((i - s) % n) + n) % n })) });
  for (let s = 0; s < n - 1; s++) out.push({ phase: 'ag', idx: s + 1, sends: Array.from({ length: n }, (_, i) => ({ from: i, to: (i + 1) % n, chunk: (((i + 1 - s) % n) + n) % n })) });
  return out;
}

function ringState(n: number, steps: RingStep[], upto: number): number[][] {
  const buf = Array.from({ length: n }, () => Array.from({ length: n }, () => 1));
  for (let k = 0; k < upto; k++) {
    const st = steps[k];
    const snap = buf.map((r) => r.slice());
    for (const m of st.sends) buf[m.to][m.chunk] = st.phase === 'rs' ? snap[m.to][m.chunk] + snap[m.from][m.chunk] : snap[m.from][m.chunk];
  }
  return buf;
}

/* ---------- Double binary tree (illustrative) ---------- */
interface TNode { rank: number; parent: number; depth: number; pos: number }
function buildTree(ranks: number[]): TNode[] {
  const out: TNode[] = [];
  const rec = (lo: number, hi: number, parent: number, depth: number) => {
    if (lo > hi) return;
    const mid = (lo + hi) >> 1;
    out.push({ rank: ranks[mid], parent, depth, pos: mid });
    rec(lo, mid - 1, ranks[mid], depth + 1);
    rec(mid + 1, hi, ranks[mid], depth + 1);
  };
  rec(0, ranks.length - 1, -1, 0);
  return out;
}

/* ---------- Cost model ---------- */
function ringT(n: number, s: number, bw: number, a: number) { return 2 * (n - 1) * a + ((2 * (n - 1)) / n) * (s / bw); }
function treeT(n: number, s: number, bw: number, a: number) { return 2 * Math.log2(n) * a + 2 * (s / bw); }
function fmtBytes(b: number) { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return `${b >= 100 ? b.toFixed(0) : b.toFixed(b >= 10 ? 1 : 2)} ${u[i]}`; }
function fmtTime(us: number) { return us < 1000 ? `${us.toFixed(1)} µs` : us < 1e6 ? `${(us / 1000).toFixed(2)} ms` : `${(us / 1e6).toFixed(2)} s`; }

export default function AllReduceSim() {
  const [n, setN] = useState(4);
  const [algo, setAlgo] = useState<Algo>('ring');
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [logS, setLogS] = useState(26); // 64 MB
  const [bwGB, setBwGB] = useState(50);
  const [alpha, setAlpha] = useState(5);

  const steps = useMemo(() => ringSteps(n), [n]);
  const tree0 = useMemo(() => buildTree(Array.from({ length: n }, (_, i) => i)), [n]);
  const tree1 = useMemo(() => buildTree(Array.from({ length: n }, (_, i) => (i + 1) % n)), [n]);
  const depth = Math.max(...tree0.map((t) => t.depth), ...tree1.map((t) => t.depth));
  const total = algo === 'ring' ? steps.length : 2 * depth;

  useEffect(() => { setStep(0); setPlaying(false); }, [n, algo]);
  useEffect(() => {
    if (!playing) return;
    if (step >= total) { setPlaying(false); return; }
    const id = window.setTimeout(() => setStep((s) => s + 1), reducedMotion() ? 250 : 900);
    return () => window.clearTimeout(id);
  }, [playing, step, total]);

  const buf = useMemo(() => ringState(n, steps, step), [n, steps, step]);
  const cur = algo === 'ring' && step > 0 ? steps[step - 1] : null;

  // geometry
  const R = 120, cx = 160, cy = 150;
  const pos = (i: number) => { const a = (2 * Math.PI * i) / n - Math.PI / 2; return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; };
  const nodeR = n > 10 ? 13 : 17;

  // cost model numbers
  const S = 2 ** logS;
  const B = bwGB * 1e9 / 1e6; // bytes per µs
  const tr = ringT(n, S, B, alpha), tt = treeT(n, S, B, alpha);
  const busF = (2 * (n - 1)) / n;
  const crossover = n * alpha * B * (n - 1 - Math.log2(n)); // bytes where ring == tree

  let phaseText = 'Initial: every GPU holds its own N chunks (unreduced).';
  if (algo === 'ring' && cur) phaseText = cur.phase === 'rs'
    ? `Reduce-scatter ${cur.idx}/${n - 1}: each GPU sends one chunk to its right neighbour, which adds it to its own copy.`
    : `All-gather ${cur.idx}/${n - 1}: each GPU forwards a fully reduced chunk; the receiver overwrites.`;
  if (algo === 'ring' && step === total) phaseText = 'Done: every GPU holds all N fully reduced chunks. Each GPU sent 2(N−1) chunks of S/N bytes.';
  if (algo === 'tree') phaseText = step === 0 ? 'Initial: each tree carries half of the buffer (pipelined in chunks in practice).'
    : step <= depth ? `Reduce ${step}/${depth}: nodes at depth ${depth - step + 1} send partial sums to their parent.`
    : step < total ? `Broadcast ${step - depth}/${depth}: the result flows from the root down to depth ${step - depth}.` : 'Done: the roots reduced everything and broadcast it back down both trees.';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <label className="flex items-center gap-2 text-xs"><span className="text-muted">GPUs</span>
          <input type="range" min={2} max={16} value={n} onChange={(e) => setN(+e.target.value)} className="w-28 accent-[var(--accent)]" />
          <span className="w-6 font-mono">{n}</span></label>
        <div className="inline-flex overflow-hidden rounded-lg border border-line">
          {(['ring', 'tree'] as Algo[]).map((a) => (
            <button key={a} type="button" onClick={() => setAlgo(a)} className={`px-3 py-1 text-xs ${algo === a ? 'bg-accent-soft text-accent' : 'bg-panel text-muted hover:text-fg'}`}>{a === 'ring' ? 'Ring' : 'Double binary tree'}</button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => setStep((s) => Math.min(total, s + 1))} disabled={step >= total}>Step</Button>
          <Button className="!px-3 !py-1 text-xs" onClick={() => { if (step >= total) setStep(0); setPlaying((p) => !p); }}>{playing ? 'Pause' : 'Play'}</Button>
          <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => { setStep(0); setPlaying(false); }}>Reset</Button>
        </div>
        <span className="font-mono text-xs text-muted">step {step}/{total}</span>
      </div>
      <p className="min-h-[2.5rem] text-sm">{phaseText}</p>

      {algo === 'ring' ? (
        <div className="grid items-start gap-4 md:grid-cols-2">
          <svg viewBox="0 0 320 300" className="w-full max-w-md" role="img" aria-label="Ring of GPUs">
            <defs><marker id="ar-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" /></marker></defs>
            <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--border)" strokeWidth={1.5} />
            {cur?.sends.map((m) => {
              const a = pos(m.from), b = pos(m.to);
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              const ox = (mx - cx) * 0.18, oy = (my - cy) * 0.18;
              return (
                <g key={m.from}>
                  <path d={`M${a.x},${a.y} Q${mx + ox},${my + oy} ${b.x},${b.y}`} fill="none" stroke={hue(m.chunk, n)} strokeWidth={2.5} className="flow-dash" markerEnd="url(#ar-arrow)" />
                  <circle cx={mx + ox * 1.6} cy={my + oy * 1.6} r={n > 10 ? 5 : 7} fill={hue(m.chunk, n)} stroke="var(--panel)" strokeWidth={1} />
                </g>
              );
            })}
            {Array.from({ length: n }, (_, i) => { const p = pos(i); return (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r={nodeR} fill="var(--panel-2)" stroke="var(--accent)" strokeWidth={1.5} />
                <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={n > 10 ? 9 : 11} fontFamily="var(--font-mono)" fill="var(--text)">G{i}</text>
              </g>); })}
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fill="var(--muted)">{cur ? (cur.phase === 'rs' ? 'reduce-scatter' : 'all-gather') : 'ring'}</text>
          </svg>
          <div>
            <div className="mb-1 font-mono text-[10px] text-muted">per-GPU buffer (rows) × chunk (cols). Fill = share of GPUs summed in; ring = fully reduced</div>
            <div className="grid gap-[2px]" style={{ gridTemplateColumns: `2.2rem repeat(${n}, minmax(0, 1fr))` }}>
              <div />
              {Array.from({ length: n }, (_, c) => <div key={c} className="text-center font-mono text-[9px] text-muted">{c}</div>)}
              {buf.map((row, g) => [
                <div key={`l${g}`} className="font-mono text-[10px] leading-5 text-muted">G{g}</div>,
                ...row.map((v, c) => {
                  const moving = cur?.sends.some((m) => m.to === g && m.chunk === c);
                  return <div key={`${g}-${c}`} title={`G${g} chunk ${c}: ${v}/${n}`} className="h-5 rounded-[3px]"
                    style={{ background: `color-mix(in srgb, ${hue(c, n)} ${Math.round(12 + (88 * v) / n)}%, transparent)`, outline: v === n ? '1.5px solid var(--accent)' : moving ? '1.5px dashed var(--text)' : 'none', outlineOffset: -1.5 }} />;
                }),
              ])}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {[tree0, tree1].map((t, ti) => <TreeView key={ti} nodes={t} depth={depth} step={step} n={n} label={`Tree ${ti}${ti === 1 ? ' (ranks shifted by one)' : ''}: half the data`} />)}
          <p className="text-xs text-muted md:col-span-2">Illustrative double binary tree: the second tree is shifted so that most leaves of one tree are interior nodes in the other, so every GPU both sends and receives near full bandwidth. Latency grows with log₂N instead of N.</p>
        </div>
      )}

      {/* ---------- Alpha-beta model ---------- */}
      <div className="rounded-xl border border-line bg-panel-2 p-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">alpha-beta cost model · N = {n}</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs"><div className="flex justify-between"><span className="text-muted">Message S</span><span className="font-mono">{fmtBytes(S)}</span></div>
            <input type="range" min={10} max={34} value={logS} onChange={(e) => setLogS(+e.target.value)} className="w-full accent-[var(--accent)]" /></label>
          <label className="text-xs"><div className="flex justify-between"><span className="text-muted">Link bandwidth B</span><span className="font-mono">{bwGB} GB/s</span></div>
            <input type="range" min={5} max={400} step={5} value={bwGB} onChange={(e) => setBwGB(+e.target.value)} className="w-full accent-[var(--accent)]" /></label>
          <label className="text-xs"><div className="flex justify-between"><span className="text-muted">Latency α</span><span className="font-mono">{alpha} µs</span></div>
            <input type="range" min={0.5} max={30} step={0.5} value={alpha} onChange={(e) => setAlpha(+e.target.value)} className="w-full accent-[var(--accent)]" /></label>
        </div>
        <div className="mt-3 grid gap-2 font-mono text-xs sm:grid-cols-2">
          {([['Ring', tr, 'var(--data)', '2(N−1)·α + 2(N−1)/N · S/B'], ['Tree', tt, 'var(--warn)', '2·log₂N·α + 2·S/B']] as const).map(([name, t, c, f]) => (
            <div key={name} className="rounded-lg border border-line bg-panel p-2" style={{ borderLeft: `3px solid ${c}` }}>
              <div className="flex justify-between"><span className="font-semibold" style={{ color: c }}>{name}</span><span>{fmtTime(t)}</span></div>
              <div className="text-[10px] text-muted">{f}</div>
              <div className="mt-1">algbw {(S / t / 1e3).toFixed(2)} GB/s · busbw {((S / t / 1e3) * busF).toFixed(2)} GB/s</div>
            </div>
          ))}
        </div>
        <Chart n={n} bw={B} alpha={alpha} logS={logS} crossover={crossover} />
        <p className="mt-2 text-xs text-muted">
          {crossover > 0 ? <>Crossover at about <span className="font-mono text-fg">{fmtBytes(crossover)}</span>: below it the tree's log₂N latency term wins, above it the ring's lower bandwidth term (2(N−1)/N &lt; 2) wins. </> : <>At N = 2 both have the same latency term, so the ring is never slower. </>}
          This is a simplified model of NCCL's pipelined double binary trees (Jeaugey, NVIDIA blog 2019; NCCL tuning picks per size). busbw = algbw · 2(N−1)/N, as defined in nccl-tests PERFORMANCE.md: it normalises out N so the number is comparable to link bandwidth, and for a ring it approaches B.
        </p>
      </div>
    </div>
  );
}

function TreeView({ nodes, depth, step, n, label }: { nodes: TNode[]; depth: number; step: number; n: number; label: string }) {
  const W = 320, H = 40 + depth * 52 + 20;
  const byRank = new Map(nodes.map((t) => [t.rank, t]));
  const hasKids = new Set(nodes.map((t) => t.parent));
  const xy = (r: number) => { const t = byRank.get(r)!; return { x: 20 + (t.pos + 0.5) * ((W - 40) / n), y: 30 + t.depth * 52 }; };
  const reduceLevel = step <= depth ? depth - step + 1 : 0; // depth currently sending up
  const bcastLevel = step > depth ? step - depth : -1; // depth currently receiving down
  const done = (t: TNode) => (step > depth && t.depth <= bcastLevel) || (step >= depth && t.depth === 0);
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] text-muted">{label}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        {nodes.filter((t) => t.parent >= 0).map((t) => {
          const a = xy(t.rank), b = xy(t.parent);
          const up = step > 0 && step <= depth && t.depth === reduceLevel;
          const down = bcastLevel > 0 && t.depth === bcastLevel;
          const active = up || down;
          return <line key={t.rank} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={active ? (up ? 'var(--data)' : 'var(--accent)') : 'var(--border)'} strokeWidth={active ? 2.5 : 1.5} className={active ? 'flow-dash' : ''} style={down ? { animationDirection: 'reverse' } : undefined} />;
        })}
        {nodes.map((t) => { const p = xy(t.rank); const d = done(t); const reduced = step > 0 && step <= depth && t.depth === reduceLevel - 1 && hasKids.has(t.rank); return (
          <g key={t.rank}>
            <circle cx={p.x} cy={p.y} r={n > 10 ? 8 : 11} fill={d ? 'var(--accent-soft)' : 'var(--panel)'} stroke={d ? 'var(--accent)' : reduced ? 'var(--data)' : 'var(--muted)'} strokeWidth={1.5} />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={n > 10 ? 7.5 : 9} fontFamily="var(--font-mono)" fill="var(--text)">{t.rank}</text>
          </g>); })}
      </svg>
    </div>
  );
}

function Chart({ n, bw, alpha, logS, crossover }: { n: number; bw: number; alpha: number; logS: number; crossover: number }) {
  const W = 520, H = 200, L = 46, Rp = 10, T = 10, Bt = 28;
  const xs = Array.from({ length: 49 }, (_, i) => 10 + i * 0.5);
  const pts = xs.map((l) => ({ l, r: ringT(n, 2 ** l, bw, alpha), t: treeT(n, 2 ** l, bw, alpha) }));
  const ymin = Math.log10(Math.min(...pts.map((p) => Math.min(p.r, p.t)))), ymax = Math.log10(Math.max(...pts.map((p) => Math.max(p.r, p.t))));
  const X = (l: number) => L + ((l - 10) / 24) * (W - L - Rp);
  const Y = (us: number) => T + (1 - (Math.log10(us) - ymin) / (ymax - ymin || 1)) * (H - T - Bt);
  const line = (k: 'r' | 't') => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.l).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
  const decades: number[] = []; for (let d = Math.ceil(ymin); d <= Math.floor(ymax); d++) decades.push(d);
  const cl = crossover > 0 ? Math.log2(crossover) : -1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label="Time versus message size">
      {decades.map((d) => <g key={d}><line x1={L} x2={W - Rp} y1={Y(10 ** d)} y2={Y(10 ** d)} stroke="var(--border)" strokeWidth={0.75} />
        <text x={L - 4} y={Y(10 ** d) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{fmtTime(10 ** d).replace('.0 ', ' ').replace('.00 ', ' ')}</text></g>)}
      {[10, 20, 30].map((l) => <text key={l} x={X(l)} y={H - 10} textAnchor="middle" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{fmtBytes(2 ** l)}</text>)}
      <text x={W - Rp} y={H - 10} textAnchor="end" fontSize={9} fill="var(--muted)">{fmtBytes(2 ** 34)}</text>
      <path d={line('r')} fill="none" stroke="var(--data)" strokeWidth={2} />
      <path d={line('t')} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="5 3" />
      {cl >= 10 && cl <= 34 && <g><line x1={X(cl)} x2={X(cl)} y1={T} y2={H - Bt} stroke="var(--muted)" strokeDasharray="2 3" />
        <circle cx={X(cl)} cy={Y(ringT(n, crossover, bw, alpha))} r={3.5} fill="var(--text)" />
        <text x={X(cl) + 4} y={T + 9} fontSize={9} fill="var(--muted)">crossover</text></g>}
      <line x1={X(logS)} x2={X(logS)} y1={T} y2={H - Bt} stroke="var(--accent)" strokeWidth={1.5} />
      <g fontSize={10} fontFamily="var(--font-mono)"><rect x={L + 6} y={T + 2} width={10} height={3} fill="var(--data)" /><text x={L + 20} y={T + 7} fill="var(--text)">ring</text>
        <rect x={L + 56} y={T + 2} width={10} height={3} fill="var(--warn)" /><text x={L + 70} y={T + 7} fill="var(--text)">tree</text></g>
    </svg>
  );
}
