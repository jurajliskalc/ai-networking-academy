import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model ----------

export type Coll = 'broadcast' | 'reduce' | 'allgather' | 'reducescatter' | 'allreduce' | 'alltoall';

/** One chunk of S/N bytes. kind: own = local input, recv = copied from another rank, sum = reduced over all ranks. */
export interface Chunk { label: string; kind: 'own' | 'recv' | 'sum' }
export type Buffer = (Chunk | null)[]; // null = slot not used / not written

const L = (r: number) => String.fromCharCode(65 + r); // rank 0 -> A, 1 -> B ...

/** nccl-tests busbw correction factor (doc/PERFORMANCE.md; all-to-all also in src/alltoall.cu). */
export function busbwFactor(c: Coll, n: number): number {
  if (c === 'allreduce') return (2 * (n - 1)) / n;
  if (c === 'broadcast' || c === 'reduce') return 1;
  return (n - 1) / n; // allgather, reducescatter, alltoall
}

/** Bytes each rank sends, as a multiple of S (S = full per-rank buffer, the "size" nccl-tests prints). */
export function sentPerRank(c: Coll, n: number): number {
  if (c === 'allreduce') return (2 * (n - 1)) / n;
  if (c === 'broadcast' || c === 'reduce') return 1; // pipelined chain; the chain end (broadcast) or root (reduce) sends 0
  return (n - 1) / n;
}

/** Input and output size per rank as a multiple of S. */
export function ioSize(c: Coll, n: number, isRoot: boolean): { in: number; out: number } {
  switch (c) {
    case 'broadcast': return { in: isRoot ? 1 : 0, out: 1 };
    case 'reduce': return { in: 1, out: isRoot ? 1 : 0 };
    case 'allgather': return { in: 1 / n, out: 1 };
    case 'reducescatter': return { in: 1, out: 1 / n };
    default: return { in: 1, out: 1 };
  }
}

export function buffers(c: Coll, n: number, root: number): { before: Buffer[]; after: Buffer[] } {
  const ranks = Array.from({ length: n }, (_, r) => r);
  const full = (r: number): Buffer => ranks.map((j) => ({ label: `${L(r)}${j}`, kind: 'own' }));
  const empty = (): Buffer => ranks.map(() => null);
  const sum = (j: number): Chunk => ({ label: `Σ${j}`, kind: 'sum' });
  switch (c) {
    case 'broadcast':
      return { before: ranks.map((r) => (r === root ? full(r) : empty())), after: ranks.map((r) => ranks.map((j) => ({ label: `${L(root)}${j}`, kind: r === root ? 'own' : 'recv' }))) };
    case 'reduce':
      return { before: ranks.map(full), after: ranks.map((r) => (r === root ? ranks.map(sum) : empty())) };
    case 'allgather':
      return { before: ranks.map((r) => ranks.map((j) => (j === r ? { label: L(r), kind: 'own' } : null))), after: ranks.map((r) => ranks.map((j) => ({ label: L(j), kind: j === r ? 'own' : 'recv' }))) };
    case 'reducescatter':
      return { before: ranks.map(full), after: ranks.map((r) => ranks.map((j) => (j === r ? sum(j) : null))) };
    case 'allreduce':
      return { before: ranks.map(full), after: ranks.map(() => ranks.map(sum)) };
    case 'alltoall':
      // Rank r's chunk j is addressed to rank j; afterwards rank r's slot i holds chunk r from rank i.
      return { before: ranks.map(full), after: ranks.map((r) => ranks.map((i) => ({ label: `${L(i)}${r}`, kind: i === r ? 'own' : 'recv' }))) };
  }
}

// ---------- UI ----------

const INFO: Record<Coll, { name: string; formula: string; sent: string; use: string; note?: string }> = {
  broadcast: { name: 'Broadcast', formula: '1', sent: '≈ S (pipelined chain)', use: 'Initial weights from rank 0 (PyTorch DDP broadcasts model state at start-up); rare per step.' },
  reduce: { name: 'Reduce', formula: '1', sent: '≈ S (pipelined chain)', use: 'Rare in training: a result is needed on one rank only (e.g. a metric).' },
  allgather: { name: 'All-gather', formula: '(n−1)/n', sent: '(n−1)/n · S', use: 'FSDP / ZeRO-3: gather sharded weights before each layer\'s forward and backward; TP with sequence parallelism.' },
  reducescatter: { name: 'Reduce-scatter', formula: '(n−1)/n', sent: '(n−1)/n · S', use: 'FSDP / ZeRO-2/3: each rank keeps only its shard of the summed gradients; TP with sequence parallelism.' },
  allreduce: { name: 'All-reduce', formula: '2(n−1)/n', sent: '2(n−1)/n · S', use: 'DP gradient averaging (PyTorch DDP); Megatron TP activations inside each layer.' },
  alltoall: { name: 'All-to-all', formula: '(n−1)/n', sent: '(n−1)/n · S as n−1 pieces of S/n', use: 'MoE expert parallelism (EP): token dispatch and combine, twice per MoE layer each pass.', note: 'NCCL implements all-to-all as grouped point-to-point send/recv to every peer, not as a ring; the chunk addressed to itself never leaves the rank.' },
};
const ORDER: Coll[] = ['broadcast', 'reduce', 'allgather', 'reducescatter', 'allreduce', 'alltoall'];
const KIND: Record<Chunk['kind'], string> = {
  own: 'border-data/60 bg-data/15 text-data',
  recv: 'border-warn/60 bg-warn/15 text-warn',
  sum: 'border-accent/60 bg-accent/15 text-accent',
};

function Buf({ b }: { b: Buffer }) {
  return (
    <div className="flex gap-0.5">
      {b.map((c, j) => c
        ? <span key={j} className={`flex h-7 min-w-0 flex-1 items-center justify-center rounded border font-mono text-[10px] ${KIND[c.kind]}`}>{c.label}</span>
        : <span key={j} className="flex h-7 min-w-0 flex-1 items-center justify-center rounded border border-dashed border-line font-mono text-[10px] text-muted">·</span>)}
    </div>
  );
}

const frac = (v: number, n: number) => (v === 0 ? '0' : v === 1 ? 'S' : v === 1 / n ? 'S/n' : `${v.toFixed(3)}·S`);

export default function CollectiveExplorer() {
  const [c, setC] = useState<Coll>('allreduce');
  const [n, setN] = useState(4);
  const [root, setRoot] = useState(0);
  const [sMB, setS] = useState(1024);
  const [bw, setBw] = useState(50);
  const r0 = Math.min(root, n - 1);
  const { before, after } = buffers(c, n, r0);
  const info = INFO[c];
  const f = busbwFactor(c, n);
  const rooted = c === 'broadcast' || c === 'reduce';
  const io = ioSize(c, n, true), ioNon = ioSize(c, n, false);
  const sendMB = sentPerRank(c, n) * sMB;
  const tMs = (sMB * f) / (bw * 1e3) * 1e3; // ideal: time = S · factor / busbw

  const panel = (title: string, bufs: Buffer[]) => (
    <div className="rounded-lg border border-line bg-panel-2 p-2">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{title}</div>
      <div className="space-y-1">
        {bufs.map((b, r) => (
          <div key={r} className="flex items-center gap-2">
            <span className={`w-14 shrink-0 font-mono text-[11px] ${rooted && r === r0 ? 'text-fg font-semibold' : 'text-muted'}`}>rank {r}{rooted && r === r0 ? '*' : ''}</span>
            <div className="min-w-0 flex-1"><Buf b={b} /></div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Collective">
        {ORDER.map((k) => (
          <button key={k} type="button" onClick={() => setC(k)} aria-pressed={c === k}
            className={`rounded-md border px-2.5 py-1 text-xs transition ${c === k ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{INFO[k].name}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Ranks n</div>
          <div className="flex flex-wrap gap-1">
            {[2, 3, 4, 5, 6, 7, 8].map((o) => (
              <button key={o} type="button" onClick={() => setN(o)} aria-pressed={n === o}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${n === o ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{o}</button>
            ))}
          </div>
        </div>
        {rooted && (
          <div>
            <label htmlFor="ce-root" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Root</label>
            <select id="ce-root" value={r0} onChange={(e) => setRoot(Number(e.target.value))} className="rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs">
              {Array.from({ length: n }, (_, r) => <option key={r} value={r}>rank {r}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {panel('Before', before)}
        {panel('After', after)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm border ${KIND.own}`} />own data (letter = source rank, digit = chunk)</span>
        <span className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm border ${KIND.recv}`} />received copy</span>
        <span className="inline-flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm border ${KIND.sum}`} />Σj = sum of chunk j over all ranks</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-line" />unused</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <tbody>
            {[
              ['Input per rank', rooted ? `${frac(io.in, n)} on ${c === 'broadcast' ? 'root' : 'every rank'}${c === 'broadcast' ? ', others none' : ''}` : frac(io.in, n)],
              ['Output per rank', rooted ? `${frac(io.out, n)} on ${c === 'reduce' ? 'root only' : 'every rank'}${c === 'reduce' ? ` (others ${frac(ioNon.out, n)})` : ''}` : frac(io.out, n)],
              ['Output / input', rooted ? '1 (root\'s buffer size)' : `${(io.out / io.in).toFixed(io.out / io.in < 1 ? 3 : 0)}×`],
              ['Sent per rank (bandwidth-optimal)', `${info.sent} = ${sentPerRank(c, n).toFixed(3)}·S`],
              ['nccl-tests busbw factor', `${info.formula} = ${f.toFixed(3)}   (busbw = algbw × factor, algbw = S / time)`],
              ['Typical use in training', info.use],
            ].map(([k, v]) => (
              <tr key={k} className="border-b border-line align-top">
                <td className="w-56 py-1.5 pr-3 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">{k}</td>
                <td className="py-1.5 text-fg">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {info.note && <p className="text-sm text-muted">{info.note}</p>}

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">What-if: size and bandwidth</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted">S = buffer size (nccl-tests "size"), MB
            <input type="number" min={1} max={65536} value={sMB} onChange={(e) => setS(Math.max(1, Number(e.target.value) || 1))} className="mt-1 w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm text-fg" />
          </label>
          <label className="text-xs text-muted">Bottleneck link bandwidth per rank, GB/s (400G NIC ≈ 50)
            <input type="number" min={1} max={2000} value={bw} onChange={(e) => setBw(Math.max(1, Number(e.target.value) || 1))} className="mt-1 w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm text-fg" />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill>each rank sends ≈ <span className="font-mono text-fg">{sendMB.toFixed(1)} MB</span></Pill>
          <Pill>ideal time ≈ S·factor / B = {sMB}·{f.toFixed(3)} / {bw} GB/s = <span className="font-mono text-fg">{tMs.toFixed(2)} ms</span></Pill>
          <Pill>algbw = <span className="font-mono text-fg">{(sMB / 1e3 / (tMs / 1e3)).toFixed(1)} GB/s</span>, busbw = <span className="font-mono text-fg">{bw} GB/s</span></Pill>
        </div>
      </div>

      <p className="text-[11px] text-muted">
        Bandwidth term only (no latency α, no protocol overhead, no in-network reduction such as SHARP/NVLS, which lowers the bytes sent for reductions).
        Busbw factors follow NVIDIA nccl-tests doc/PERFORMANCE.md; the all-to-all factor (n−1)/n is also what nccl-tests src/alltoall.cu computes. S follows the nccl-tests
        convention: the full buffer (output size for all-gather, input size for reduce-scatter). Rooted collectives are shown as a pipelined chain; NCCL's ring broadcast and
        reduce work this way, so the busbw factor is 1. Chunk labels are symbolic, and the "typical use" column is a common mapping, not the only one.
      </p>
    </div>
  );
}
