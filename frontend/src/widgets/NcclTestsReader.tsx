import { useMemo, useState, type ReactNode } from 'react';
import NumInput from '../components/NumInput';

export type Coll = 'all_reduce' | 'all_gather' | 'reduce_scatter' | 'broadcast' | 'reduce' | 'alltoall';
export const COLLS: Coll[] = ['all_reduce', 'all_gather', 'reduce_scatter', 'broadcast', 'reduce', 'alltoall'];

/** busbw / algbw factor from nccl-tests doc/PERFORMANCE.md. */
export function busFactor(c: Coll, n: number): number {
  if (c === 'all_reduce') return (2 * (n - 1)) / n;
  if (c === 'broadcast' || c === 'reduce') return 1;
  return (n - 1) / n; // all_gather, reduce_scatter, alltoall
}
export const factorText = (c: Coll) => (c === 'all_reduce' ? '2(n-1)/n' : c === 'broadcast' || c === 'reduce' ? '1' : '(n-1)/n');
/** algbw in GB/s (GB = 1e9 B) from S in bytes and t in microseconds. */
export const algbw = (bytes: number, us: number) => bytes / (us * 1e3);

/** nccl-tests size suffixes (-b/-e) are binary: K = 1024, M = 1024², G = 1024³. */
export function parseSize(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(?:([KMGT])i?)?B?$/i);
  if (!m) return null;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m[2] ?? '').toUpperCase() as '' | 'K' | 'M' | 'G' | 'T'];
  return Math.round(Number(m[1]) * mult);
}

export interface Parsed { size: number; time: number; algbw: number; busbw: number }
/**
 * Parse one data row of nccl-tests output. Column layouts differ between versions and collectives
 * (with or without redop/root), so locate the out-of-place "time algbw busbw" triple by checking algbw ≈ size / time.
 */
export function parseLine(line: string): Parsed | null {
  const tok = line.trim().split(/\s+/);
  if (tok.length < 5 || !/^\d+$/.test(tok[0])) return null;
  const size = Number(tok[0]);
  const nums = tok.slice(2).map(Number);
  for (let i = 0; i + 2 < nums.length; i++) {
    const t = nums[i], a = nums[i + 1];
    if (!(t > 0) || Number.isNaN(a) || Number.isNaN(nums[i + 2])) continue;
    const exp = algbw(size, t);
    if (Math.abs(exp - a) <= Math.max(0.011, 0.02 * exp)) return { size, time: t, algbw: a, busbw: nums[i + 2] };
  }
  return null;
}

export type Topo = 'single' | 'multi';
export interface CeilIn { coll: Coll; n: number; g: number; topo: Topo; nvl: number; k: number; nicGbps: number }
/**
 * First-order busbw ceiling (GB/s). Single node: per-GPU NVLink bandwidth per direction.
 * Multi-node ring-style collectives: a node sends its share across all k NICs, so busbw ≤ k × NIC rate (and ≤ NVLink).
 * Multi-node all-to-all: each GPU's NIC share carries the (n-g)/n of its data that leaves the node, so busbw ≤ (k·B/g)·(n-1)/(n-g).
 */
export function ceiling(c: CeilIn): { value: number; steps: string[] } {
  if (c.topo === 'single') return { value: c.nvl, steps: [`single node: ceiling = NVLink per GPU per direction = ${c.nvl} GB/s`] };
  const nodeNet = (c.k * c.nicGbps) / 8;
  if (c.coll === 'alltoall') {
    const perGpu = nodeNet / c.g;
    const v = c.n > c.g ? (perGpu * (c.n - 1)) / (c.n - c.g) : c.nvl;
    return { value: Math.min(v, c.nvl), steps: [`node NICs = ${c.k} × ${c.nicGbps} Gb/s / 8 = ${nodeNet} GB/s → per GPU ${fmt(perGpu)} GB/s`,
      `off-node share of each rank's data = (n−g)/n = ${c.n - c.g}/${c.n}`, `busbw ceiling = ${fmt(perGpu)} × (n−1)/(n−g) = ${fmt(v)} GB/s${v > c.nvl ? `, capped by NVLink ${c.nvl}` : ''}`] };
  }
  return { value: Math.min(nodeNet, c.nvl), steps: [`node NICs = ${c.k} × ${c.nicGbps} Gb/s / 8 = ${fmt(nodeNet)} GB/s (each ring crosses a node boundary through one NIC; channels spread over all ${c.k})`,
    `ceiling = min(${fmt(nodeNet)}, NVLink ${c.nvl}) = ${fmt(Math.min(nodeNet, c.nvl))} GB/s`] };
}

export type Verdict = 'latency' | 'healthy' | 'suspicious' | 'bad' | 'above';
export function verdict(bytes: number, eff: number): Verdict {
  if (bytes < 16 * 1024 ** 2) return 'latency';
  if (eff > 1.05) return 'above';
  if (eff >= 0.8) return 'healthy';
  if (eff >= 0.6) return 'suspicious';
  return 'bad';
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toLocaleString('en-US', { maximumFractionDigits: d }) : '—');
const fmtBytes = (b: number) => { const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0, v = b; while (v >= 1024 && i < 4) { v /= 1024; i++; } return `${fmt(v, 2)} ${u[i]}`; };

const SEMANTICS: Record<Coll, string> = {
  all_reduce: 'S = the buffer each rank contributes and receives (count × type size).',
  all_gather: 'S = the full gathered output: n × the per-rank chunk (sendcount × type size × n). Each rank contributes S/n.',
  reduce_scatter: 'S = the full input array: n × the per-rank output chunk (recvcount × type size × n). Each rank ends with S/n.',
  broadcast: 'S = the message size sent from the root.',
  reduce: 'S = the message size reduced to the root.',
  alltoall: 'S = each rank\'s total send buffer; it sends S/n to every rank (including itself).',
};
const SAMPLE = '  8589934592   2147483648  float    sum    -1 46500.0  184.73  346.37      0 46420.0  185.05  346.97      0';
const NVL_PRESETS: [string, number][] = [['A100-class NVLink 3 (~300)', 300], ['H100-class NVLink 4 (~450)', 450], ['B200-class NVLink 5 (~900)', 900]];

function Seg<T extends string | number>({ label, value, options, onChange, render }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>{options.map((o) => (
        <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
          className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{render ? render(o) : String(o)}</button>
      ))}</div>
    </div>
  );
}
function Num({ label, value, set, min = 1 }: { label: string; value: number; set: (v: number) => void; min?: number }) {
  return (
    <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <NumInput min={min} value={value} onValue={set} className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" /></label>
  );
}
function Out({ label, value, tone = 'text-fg' }: { label: string; value: ReactNode; tone?: string }) {
  return <div className="rounded-lg border border-line bg-panel-2 px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div><div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div></div>;
}

export default function NcclTestsReader() {
  const [coll, setColl] = useState<Coll>('all_reduce');
  const [n, setN] = useState(16);
  const [g, setG] = useState(8);
  const [sizeStr, setSizeStr] = useState('8G');
  const [t, setT] = useState(46500);
  const [topo, setTopo] = useState<Topo>('multi');
  const [nvl, setNvl] = useState(450);
  const [k, setK] = useState(8);
  const [nic, setNic] = useState(400);
  const [paste, setPaste] = useState(SAMPLE);
  const [printed, setPrinted] = useState<Parsed | null>(parseLine(SAMPLE));

  const S = parseSize(sizeStr);
  const gg = topo === 'single' ? n : Math.min(g, n);
  const nodes = n / gg;
  const a = S && t > 0 ? algbw(S, t) : NaN;
  const f = busFactor(coll, n);
  const b = a * f;
  const ceil = useMemo(() => ceiling({ coll, n, g: gg, topo, nvl, k, nicGbps: nic }), [coll, n, gg, topo, nvl, k, nic]);
  const eff = b / ceil.value;
  const v = S ? verdict(S, eff) : 'latency';

  const doParse = () => {
    const p = parseLine(paste);
    setPrinted(p);
    if (p) { setSizeStr(String(p.size)); setT(p.time); }
  };
  const ratio = printed && printed.algbw >= 1 ? printed.busbw / printed.algbw : null;
  const impliedN = ratio === null ? null : coll === 'all_reduce' ? (ratio < 2 ? 2 / (2 - ratio) : null) : coll === 'broadcast' || coll === 'reduce' ? null : ratio < 1 ? 1 / (1 - ratio) : null;

  const V: Record<Verdict, { tone: string; title: string; hints: string[] }> = {
    latency: { tone: 'border-data/40 bg-data/10 text-data', title: 'Latency-bound region: not a bandwidth test', hints: ['Below ~16 MiB the time is dominated by the per-operation latency (α), so busbw is far below the ceiling by design.', 'Judge the plateau: sweep to large sizes (-e 8G or as much as memory allows) and read busbw there.', 'For small sizes, compare time (µs) with your baseline instead.'] },
    healthy: { tone: 'border-accent/40 bg-accent-soft text-accent', title: 'Healthy: close to the first-order ceiling', hints: ['Record it, with NCCL version, env and node list, as the baseline for regressions.', 'Repeat runs and other node orders to check variance (ECMP collisions show up as spread, not as a low mean).'] },
    suspicious: { tone: 'border-warn/40 bg-warn/10 text-warn', title: 'Suspicious: noticeably below the ceiling', hints: ['Is busbw still rising at the largest size? Extend -e to reach the plateau.', 'One slow NIC, cable or optic caps every ring through it: run pairwise tests and find the outlier node.', 'Check the NCCL INFO lines: all NICs listed in NET/IB, GDRDMA on NET hops, P2P (not SHM) intra-node.', 'On RoCE, repeat runs: high spread points at ECMP collisions (NCCL_IB_QPS_PER_CONNECTION, adaptive routing).'] },
    bad: { tone: 'border-danger/40 bg-danger/10 text-danger', title: 'Bad: far below the ceiling', hints: ['"Using network Socket" in the INFO log means no RDMA at all.', 'Missing "/GDRDMA" on NET hops: data is staged through host memory.', 'Fewer NICs in use than expected (NCCL_IB_HCA), or a NIC trained at reduced PCIe width or link speed.', 'PFC storms, drops or retransmissions on the fabric: check switch and NIC counters.'] },
    above: { tone: 'border-data/40 bg-data/10 text-data', title: 'Above the ring ceiling', hints: ['Expected with in-network or in-switch reduction (CollNet/SHARP, NVLS): less data crosses the links than the formula assumes. Check which algorithm ran.', 'Otherwise re-check the inputs: rank count, GPUs per node, NIC count and speed.'] },
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2"><Seg label="Collective (binary *_perf)" value={coll} options={COLLS} onChange={setColl} /></div>
        <Num label="Ranks n (GPUs)" value={n} set={setN} min={2} />
        <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Size S (bytes, or 8G, 512M …)</span>
          <input value={sizeStr} onChange={(e) => setSizeStr(e.target.value)} aria-invalid={!S} className={`w-full rounded-md border bg-panel px-2 py-1 font-mono text-sm ${S ? 'border-line' : 'border-danger'}`} /></label>
        <Num label="Time t (µs, out-of-place)" value={t} set={setT} />
      </div>
      <p className="text-xs text-muted"><span className="font-mono text-fg">{coll}</span>: {SEMANTICS[coll]} {S ? <>S = {S.toLocaleString('en-US')} B = {fmtBytes(S)}.</> : <span className="text-danger">Size not understood.</span>}</p>

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Or paste an nccl-tests data row</span>
          <input value={paste} onChange={(e) => setPaste(e.target.value)} className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs" /></label>
        <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
          <button type="button" onClick={doParse} className="rounded-md border border-accent bg-accent-soft px-3 py-1 text-sm text-accent">Parse row</button>
          {printed ? <span className="text-xs text-muted">size {printed.size.toLocaleString('en-US')} B · time {printed.time} µs · printed algbw {printed.algbw} · busbw {printed.busbw}
            {ratio !== null && <> · busbw/algbw = {fmt(ratio, 3)}{impliedN ? <> → n ≈ {fmt(impliedN, 1)} for {coll}</> : null}</>}</span>
            : <span className="text-xs text-danger">Could not find size and time columns (needs a data row, not a header).</span>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Seg label="Topology" value={topo} options={['single', 'multi'] as const} onChange={setTopo} render={(x) => (x === 'single' ? 'single node (NVLink)' : 'multi-node')} />
        <Seg label="NVLink per GPU, per direction (GB/s)" value={nvl} options={NVL_PRESETS.map((p) => p[1])} onChange={setNvl} render={(x) => NVL_PRESETS.find((p) => p[1] === x)![0]} />
        {topo === 'multi' && <>
          <Num label="GPUs per node g" value={g} set={setG} />
          <div className="grid grid-cols-2 gap-2"><Num label="NICs per node k" value={k} set={setK} />
            <label className="block"><span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">NIC Gb/s</span>
              <select value={nic} onChange={(e) => setNic(Number(e.target.value))} className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm">{[100, 200, 400, 800].map((x) => <option key={x} value={x}>{x}</option>)}</select></label></div>
        </>}
      </div>
      {topo === 'multi' && (n % gg !== 0) && <div className="text-xs text-warn">n is not a multiple of g; the model assumes full nodes.</div>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="algbw = S / t" value={`${fmt(a)} GB/s`} />
        <Out label={`busbw = algbw × ${factorText(coll)}`} value={`${fmt(b)} GB/s`} tone="text-accent" />
        <Out label={`ceiling (${topo === 'single' ? '1 node' : `${fmt(nodes, 1)} nodes`})`} value={`${fmt(ceil.value)} GB/s`} tone="text-data" />
        <Out label="efficiency" value={`${fmt(eff * 100, 1)} %`} tone={v === 'healthy' ? 'text-accent' : v === 'bad' ? 'text-danger' : v === 'suspicious' ? 'text-warn' : 'text-data'} />
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`busbw is ${fmt(eff * 100, 0)} percent of the ceiling`}>
        <div className={`h-full rounded-full ${v === 'bad' ? 'bg-danger' : v === 'suspicious' ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.min(100, Math.max(0, eff * 100))}%` }} />
      </div>

      <div className={`rounded-lg border px-3 py-2 text-sm ${V[v].tone}`} role="status">
        <div className="font-semibold">{V[v].title}</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg">{V[v].hints.map((h) => <li key={h}>{h}</li>)}</ul>
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>algbw = {S ? S.toLocaleString('en-US') : '?'} B / ({fmt(t)} µs × 10³) = <span className="font-mono text-fg">{fmt(a)} GB/s</span> (GB = 10⁹ B)</li>
          <li>busbw = {fmt(a)} × {factorText(coll)} = {fmt(a)} × {fmt(f, 4)} = <span className="font-mono text-fg">{fmt(b)} GB/s</span></li>
          {ceil.steps.map((s) => <li key={s}>{s}</li>)}
          <li>efficiency = {fmt(b)} / {fmt(ceil.value)} = <span className="font-mono text-fg">{fmt(eff * 100, 1)} %</span></li>
        </ol>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        Factors from nccl-tests doc/PERFORMANCE.md. The ceiling is a first-order model: it ignores protocol overhead, PCIe and GPU-NIC topology, congestion and algorithm choice,
        so a healthy plateau usually sits somewhat below it. The verdict bands (≥ 80 % healthy, 60-80 % suspicious, below 60 % bad, under 16 MiB latency-bound) are illustrative
        rules of thumb: set acceptance criteria from your own reference runs. NVLink figures are per GPU per direction (about half the commonly quoted bidirectional totals); check
        your platform datasheet. Use the out-of-place time; in-place is usually similar.
      </p>
    </div>
  );
}
