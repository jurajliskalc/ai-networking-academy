import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model (unit-testable) ----------
// A rail-optimized fabric as described in the lessons rail-optimized-topology (m09) and nccl-architecture (m08):
// GPU i of every node has its own NIC i, NIC i of every node in a scalable unit (SU) plugs into rail leaf i, and
// every leaf connects to every spine (two-tier Clos). PXN (NCCL 2.12+, "PCI x NVLink") lets a GPU send through a
// NIC that is not its own: the data first crosses NVLink to the GPU that sits on the destination's rail, and that
// GPU's NIC sends it (NVIDIA blog "Doubling all2all Performance with NCCL 2.12"; NCCL env docs: NCCL_PXN_DISABLE
// "disable inter-node communication using a non-local NIC, using NVLink and an intermediate GPU").

export const NODES = 4;
export const GPUS = 8;
export const SPINES = 4;
export type Layout = '1su' | '2su';
export interface Fabric { layout: Layout; spine: boolean; pxn: boolean }
export interface Gpu { node: number; gpu: number }

export type Elem =
  | { t: 'gpu'; node: number; gpu: number }
  | { t: 'nvswitch'; node: number }
  | { t: 'nic'; node: number; rail: number }
  | { t: 'leaf'; su: number; rail: number }
  | { t: 'spine'; idx: number };

export type PathKind = 'self' | 'nvlink' | 'rail' | 'rail-spine' | 'cross-spine' | 'pxn' | 'pxn-spine' | 'unreachable';

export interface PathResult {
  kind: PathKind;
  elems: Elem[];
  /** Network switches the data crosses (leaves + spines); NVSwitch is counted separately. */
  switchHops: number;
  /** Network cables crossed (NIC-leaf, leaf-spine). */
  netLinks: number;
  /** NVLink transfers through the node's NVSwitch. */
  nvlinkHops: number;
  /** GPU-to-NIC PCIe crossings (source side + destination side). */
  pcieHops: number;
  spine: boolean;
  /** NIC (rail) the data leaves the source node through, if it leaves at all. */
  egressRail: number | null;
  relay: Gpu | null;
}

export const suOf = (layout: Layout, node: number) => (layout === '1su' ? 0 : Math.floor(node / (NODES / 2)));
/** Which spine ECMP happens to pick: a stand-in hash, only to draw one concrete path. */
export const spineFor = (a: Gpu, b: Gpu) => (a.node * GPUS + a.gpu + b.node * GPUS + b.gpu) % SPINES;

function finish(kind: PathKind, elems: Elem[], egressRail: number | null, relay: Gpu | null): PathResult {
  const sw = elems.filter((e) => e.t === 'leaf' || e.t === 'spine').length;
  const nics = elems.filter((e) => e.t === 'nic').length;
  return {
    kind, elems, switchHops: sw, netLinks: nics ? sw + 1 : 0, nvlinkHops: elems.filter((e) => e.t === 'nvswitch').length,
    pcieHops: nics, spine: elems.some((e) => e.t === 'spine'), egressRail, relay,
  };
}

/** The path NCCL-style point-to-point traffic takes from src to dst in the model fabric. */
export function railPath(f: Fabric, src: Gpu, dst: Gpu): PathResult {
  if (src.node === dst.node && src.gpu === dst.gpu) return finish('self', [{ t: 'gpu', ...src }], null, null);
  if (src.node === dst.node) return finish('nvlink', [{ t: 'gpu', ...src }, { t: 'nvswitch', node: src.node }, { t: 'gpu', ...dst }], null, null);
  const suA = suOf(f.layout, src.node), suB = suOf(f.layout, dst.node);
  // Network part: leave srcNode through NIC `rail`, arrive at dstNode on NIC dst.gpu.
  const net = (rail: number): Elem[] | null => {
    const out: Elem[] = [{ t: 'nic', node: src.node, rail }, { t: 'leaf', su: suA, rail }];
    if (suA !== suB || rail !== dst.gpu) {
      if (!f.spine) return null;
      out.push({ t: 'spine', idx: spineFor(src, dst) }, { t: 'leaf', su: suB, rail: dst.gpu });
    }
    out.push({ t: 'nic', node: dst.node, rail: dst.gpu });
    return out;
  };
  if (src.gpu === dst.gpu) {
    const n = net(src.gpu);
    if (!n) return finish('unreachable', [], null, null);
    return finish(n.some((e) => e.t === 'spine') ? 'rail-spine' : 'rail', [{ t: 'gpu', ...src }, ...n, { t: 'gpu', ...dst }], src.gpu, null);
  }
  if (f.pxn) {
    const relay = { node: src.node, gpu: dst.gpu };
    const n = net(dst.gpu);
    if (!n) return finish('unreachable', [], null, null);
    return finish(n.some((e) => e.t === 'spine') ? 'pxn-spine' : 'pxn',
      [{ t: 'gpu', ...src }, { t: 'nvswitch', node: src.node }, { t: 'gpu', ...relay }, ...n, { t: 'gpu', ...dst }], dst.gpu, relay);
  }
  const n = net(src.gpu);
  if (!n) return finish('unreachable', [], null, null);
  return finish('cross-spine', [{ t: 'gpu', ...src }, ...n, { t: 'gpu', ...dst }], src.gpu, null);
}

export const nodeName = (n: number) => String.fromCharCode(65 + n);

export function elemText(e: Elem): string {
  switch (e.t) {
    case 'gpu': return `GPU ${e.gpu} (node ${nodeName(e.node)})`;
    case 'nvswitch': return `NVLink via NVSwitch (node ${nodeName(e.node)})`;
    case 'nic': return `NIC ${e.rail} (node ${nodeName(e.node)}, rail ${e.rail})`;
    case 'leaf': return `rail-${e.rail} leaf (SU ${e.su + 1})`;
    case 'spine': return `spine ${e.idx + 1}`;
  }
}

// ---------- UI helpers ----------

function Seg<T extends string | number | boolean>({ label, value, options, onChange, render }: {
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

// ---------- Diagram geometry ----------

const W = 760, H = 350, M = 16, NW = 170, NG = 16;
const SPINE_Y = 26, SPINE_H = 26, LEAF_Y = 140, LEAF_H = 30, NODE_Y = 236;
const NIC_Y = NODE_Y - 4, NIC_H = 12, GPU_Y = NIC_Y + 22, GPU_H = 20, NVS_Y = GPU_Y + 30, NVS_H = 16, NODE_B = NVS_Y + NVS_H + 20;
const nodeX = (n: number) => M + n * (NW + NG);
const cellX = (n: number, g: number) => nodeX(n) + 6 + g * 20; // 18 wide, 2 gap
const cellCx = (n: number, g: number) => cellX(n, g) + 9;
function leafBox(layout: Layout, su: number, rail: number) {
  if (layout === '1su') { const step = (W - 2 * M) / GPUS; return { x: M + rail * step + 5, w: step - 10 }; }
  const span = 2 * NW + NG, step = span / GPUS, x0 = nodeX(su * 2);
  return { x: x0 + rail * step + 2, w: step - 4 };
}
const spineBox = (i: number) => { const step = (W - 2 * M) / SPINES; return { x: M + i * step + 20, w: step - 40 }; };

function Diagram({ f, path, src, dst, label }: { f: Fabric; path: PathResult; src: Gpu; dst: Gpu; label: string }) {
  const sus = f.layout === '1su' ? [0] : [0, 1];
  const on = (pred: (e: Elem) => boolean) => path.elems.some(pred);
  // Highlighted wire segments, derived from consecutive path elements.
  const hot = new Set<string>();
  path.elems.forEach((e, i) => {
    const nx = path.elems[i + 1];
    if (!nx) return;
    if (e.t === 'nic' && nx.t === 'leaf') hot.add(`nl:${e.node}:${e.rail}`);
    if (e.t === 'leaf' && nx.t === 'nic') hot.add(`nl:${nx.node}:${nx.rail}`);
    if (e.t === 'leaf' && nx.t === 'spine') hot.add(`ls:${e.su}:${e.rail}:${nx.idx}`);
    if (e.t === 'spine' && nx.t === 'leaf') hot.add(`ls:${nx.su}:${nx.rail}:${e.idx}`);
  });
  const nv = path.elems.find((e) => e.t === 'nvswitch');
  const nvFrom = path.elems[0], nvTo = nv ? path.elems[path.elems.indexOf(nv) + 1] : null;
  const relay = path.relay;
  const hiStroke = 'var(--accent)';
  const tag = (g: Gpu) => (g.node === src.node && g.gpu === src.gpu ? 'src' : g.node === dst.node && g.gpu === dst.gpu ? 'dst' : relay && g.node === relay.node && g.gpu === relay.gpu ? 'relay' : null);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]" role="img" aria-label={label}>
      {/* spine layer */}
      {f.spine && Array.from({ length: SPINES }, (_, i) => {
        const b = spineBox(i), used = on((e) => e.t === 'spine' && e.idx === i);
        return (
          <g key={`s${i}`}>
            <rect x={b.x} y={SPINE_Y} width={b.w} height={SPINE_H} rx={5} fill={used ? 'var(--accent-soft)' : 'var(--panel-2)'} stroke={used ? hiStroke : 'var(--border)'} strokeWidth={used ? 2.5 : 1} />
            <text x={b.x + b.w / 2} y={SPINE_Y + 17} fontSize={11} textAnchor="middle" fill={used ? 'var(--accent)' : 'var(--muted)'} fontFamily="var(--font-mono)" fontWeight={used ? 700 : 400}>spine {i + 1}</text>
          </g>
        );
      })}
      {!f.spine && <text x={W / 2} y={SPINE_Y + 17} fontSize={11} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">no spine layer (rail-only): each rail switch stands alone</text>}

      {/* leaf-spine wires (faint first, highlighted on top) */}
      {f.spine && [false, true].map((pass) => sus.flatMap((su) => Array.from({ length: GPUS }, (_, r) => Array.from({ length: SPINES }, (_, i) => {
        const isHot = hot.has(`ls:${su}:${r}:${i}`);
        if (isHot !== pass) return null;
        const l = leafBox(f.layout, su, r), s = spineBox(i);
        return <line key={`ls${su}${r}${i}`} x1={l.x + l.w / 2} y1={LEAF_Y} x2={s.x + s.w / 2} y2={SPINE_Y + SPINE_H}
          stroke={isHot ? hiStroke : 'var(--border)'} strokeWidth={isHot ? 3 : 0.75} />;
      }))))}

      {/* NIC-leaf wires */}
      {[false, true].map((pass) => Array.from({ length: NODES }, (_, n) => Array.from({ length: GPUS }, (_, r) => {
        const isHot = hot.has(`nl:${n}:${r}`);
        if (isHot !== pass) return null;
        const l = leafBox(f.layout, suOf(f.layout, n), r);
        return <line key={`nl${n}${r}`} x1={cellCx(n, r)} y1={NIC_Y} x2={l.x + l.w / 2} y2={LEAF_Y + LEAF_H}
          stroke={isHot ? hiStroke : 'var(--border)'} strokeWidth={isHot ? 3 : 1} />;
      })))}

      {/* leaves */}
      {sus.map((su) => Array.from({ length: GPUS }, (_, r) => {
        const b = leafBox(f.layout, su, r), used = on((e) => e.t === 'leaf' && e.su === su && e.rail === r);
        return (
          <g key={`l${su}${r}`}>
            <rect x={b.x} y={LEAF_Y} width={b.w} height={LEAF_H} rx={4} fill={used ? 'var(--accent-soft)' : 'var(--panel-2)'} stroke={used ? hiStroke : 'var(--border)'} strokeWidth={used ? 2.5 : 1} />
            <text x={b.x + b.w / 2} y={LEAF_Y + 19} fontSize={f.layout === '1su' ? 11 : 10} textAnchor="middle" fill={used ? 'var(--accent)' : 'var(--muted)'} fontFamily="var(--font-mono)" fontWeight={used ? 700 : 400}>
              {f.layout === '1su' ? `rail ${r}` : `R${r}`}
            </text>
          </g>
        );
      }))}
      {f.layout === '2su' && sus.map((su) => (
        <text key={`sul${su}`} x={nodeX(su * 2) + NW + NG / 2} y={LEAF_Y - 8} fontSize={10} textAnchor="middle" fill="var(--muted)" stroke="var(--panel)" strokeWidth={4} paintOrder="stroke" fontFamily="var(--font-mono)">SU {su + 1} rail leaves</text>
      ))}

      {/* nodes */}
      {Array.from({ length: NODES }, (_, n) => {
        const x = nodeX(n);
        const nvUsed = nv && nv.t === 'nvswitch' && nv.node === n;
        return (
          <g key={`n${n}`}>
            <rect x={x} y={NODE_Y} width={NW} height={NODE_B - NODE_Y} rx={8} fill="var(--panel)" stroke="var(--border)" />
            <text x={x + 6} y={NODE_B - 6} fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)" fontWeight={600}>node {nodeName(n)}</text>
            {f.layout === '2su' && <text x={x + NW - 6} y={NODE_B - 6} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">SU {suOf(f.layout, n) + 1}</text>}
            {Array.from({ length: GPUS }, (_, g) => {
              const nicUsed = on((e) => e.t === 'nic' && e.node === n && e.rail === g);
              const gpuUsed = on((e) => e.t === 'gpu' && e.node === n && e.gpu === g);
              return (
                <g key={g}>
                  <rect x={cellX(n, g)} y={NIC_Y} width={18} height={NIC_H} rx={2} fill={nicUsed ? 'var(--accent)' : 'var(--panel-2)'} stroke={nicUsed ? hiStroke : 'var(--border)'} />
                  <line x1={cellCx(n, g)} y1={NIC_Y + NIC_H} x2={cellCx(n, g)} y2={GPU_Y} stroke={nicUsed ? hiStroke : 'var(--border)'} strokeWidth={nicUsed ? 3 : 1} />
                  <rect x={cellX(n, g)} y={GPU_Y} width={18} height={GPU_H} rx={3} fill={gpuUsed ? 'var(--accent-soft)' : 'var(--panel-2)'} stroke={gpuUsed ? hiStroke : 'var(--border)'} strokeWidth={gpuUsed ? 2.5 : 1} />
                  <text x={cellCx(n, g)} y={GPU_Y + 14} fontSize={10} textAnchor="middle" fill={gpuUsed ? 'var(--accent)' : 'var(--muted)'} fontFamily="var(--font-mono)" fontWeight={gpuUsed ? 700 : 400}>{g}</text>
                </g>
              );
            })}
            <rect x={x + 6} y={NVS_Y} width={NW - 12} height={NVS_H} rx={3} fill={nvUsed ? 'color-mix(in srgb, var(--data) 15%, var(--panel))' : 'var(--panel-2)'} stroke={nvUsed ? 'var(--data)' : 'var(--border)'} strokeWidth={nvUsed ? 2 : 1} />
            <text x={x + NW / 2} y={NVS_Y + 12} fontSize={10} textAnchor="middle" fill={nvUsed ? 'var(--data)' : 'var(--muted)'} fontFamily="var(--font-mono)">NVLink / NVSwitch</text>
          </g>
        );
      })}

      {/* NVLink hop */}
      {nv && nv.t === 'nvswitch' && nvFrom.t === 'gpu' && nvTo && nvTo.t === 'gpu' && (
        <path d={`M${cellCx(nv.node, nvFrom.gpu)},${GPU_Y + GPU_H} V${NVS_Y} M${cellCx(nv.node, nvTo.gpu)},${NVS_Y} V${GPU_Y + GPU_H}`}
          fill="none" stroke="var(--data)" strokeWidth={3} strokeDasharray="6 3" />
      )}

      {/* src / dst / relay tags under the nodes (text, not only colour) */}
      {[src, dst, ...(relay ? [relay] : [])].map((g) => {
        const t = tag(g);
        if (!t) return null;
        const cx = cellCx(g.node, g.gpu);
        return (
          <g key={`${t}${g.node}${g.gpu}`}>
            <text x={cx} y={NODE_B + 20} fontSize={10} textAnchor="middle" fill={t === 'relay' ? 'var(--data)' : 'var(--accent)'} fontFamily="var(--font-mono)" fontWeight={700}>{t}</text>
            <line x1={cx} y1={NODE_B + 3} x2={cx} y2={NODE_B + 9} stroke={t === 'relay' ? 'var(--data)' : 'var(--accent)'} strokeWidth={2} />
          </g>
        );
      })}
      {path.elems.length === 0 && <text x={W / 2} y={LEAF_Y - 30} fontSize={12} textAnchor="middle" fill="var(--danger)" fontFamily="var(--font-mono)" fontWeight={700}>no network path between these rails</text>}
    </svg>
  );
}

// ---------- Explanations ----------

function explain(kind: PathKind, f: Fabric, src: Gpu, dst: Gpu): ReactNode {
  switch (kind) {
    case 'self': return 'Source and destination are the same GPU: nothing crosses any link. Pick a different destination.';
    case 'nvlink': return <>Both GPUs are in node {nodeName(src.node)}. NCCL uses the P2P transport over NVLink (through the NVSwitch on HGX-class boards): no NIC, no PCIe hop to a NIC, no network switch. This is where tensor parallelism lives.</>;
    case 'rail': return <>Same GPU index, same scalable unit: GPU {src.gpu} leaves through its own NIC {src.gpu}, crosses the rail-{src.gpu} leaf once and enters node {nodeName(dst.node)} on NIC {dst.gpu}. One switch hop, no spine. This is the pattern DP, FSDP and PP traffic follow, and the reason the fabric is wired by rail.</>;
    case 'rail-spine': return <>Same rail, but the nodes are in different scalable units, so the rail-{src.gpu} leaves differ: leaf, spine, leaf (3 switch hops). Spines carry this traffic in any design; the lesson notes that some designs group spines by rail ("rail planes"), which this model does not draw.</>;
    case 'cross-spine': return <>Different rails without PXN: GPU {src.gpu} sends through its own NIC {src.gpu} into the rail-{src.gpu} leaf, which has no port toward NIC {dst.gpu} of node {nodeName(dst.node)}, so the packet climbs to a spine and comes down the rail-{dst.gpu} leaf (3 switch hops). All-to-all (MoE expert parallelism) generates a lot of this, and every flow is now exposed to spine ECMP collisions.</>;
    case 'pxn': return <>PXN: GPU {src.gpu} first moves the data over NVLink to GPU {dst.gpu} of its own node, which sits on the destination's rail; the proxy of that intermediate GPU then sends it out of NIC {dst.gpu} through the rail-{dst.gpu} leaf. One switch hop and no spine, paid for with one NVLink transfer. Messages from several local GPUs to the same remote GPU can also be aggregated on that NIC.</>;
    case 'pxn-spine': return <>PXN still moves the data onto the destination's rail over NVLink (GPU {src.gpu} to GPU {dst.gpu} in node {nodeName(src.node)}), but the destination is in another scalable unit, so the rail-{dst.gpu} traffic still crosses leaf, spine, leaf. PXN removes the rail change, not the SU change.</>;
    case 'unreachable': return <>With no spine layer (a rail-only design), rail {src.gpu} and rail {dst.gpu} are separate networks: there is no network path between them{f.pxn ? '' : '. Rail-only designs depend on forwarding over NVLink first, PXN-style; turn PXN on to see that path'}.</>;
  }
}

const KIND_LABEL: Record<PathKind, string> = {
  self: 'same GPU', nvlink: 'intra-node NVLink', rail: 'same rail', 'rail-spine': 'same rail, other SU', 'cross-spine': 'cross-rail via spine',
  pxn: 'PXN: NVLink + rail', 'pxn-spine': 'PXN + spine (other SU)', unreachable: 'no path',
};

// ---------- Widget ----------

const PRESETS: { label: string; src: Gpu; dst: Gpu; need2su?: boolean }[] = [
  { label: 'Same node', src: { node: 0, gpu: 2 }, dst: { node: 0, gpu: 5 } },
  { label: 'Same rail', src: { node: 0, gpu: 3 }, dst: { node: 1, gpu: 3 } },
  { label: 'Cross-rail', src: { node: 0, gpu: 2 }, dst: { node: 1, gpu: 5 } },
  { label: 'Same rail, other SU', src: { node: 0, gpu: 3 }, dst: { node: 3, gpu: 3 }, need2su: true },
];

function GpuPicker({ id, label, value, onChange }: { id: string; label: string; value: Gpu; onChange: (g: Gpu) => void }) {
  const sel = 'rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm min-h-8';
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-node`} className="text-xs text-muted">Node</label>
        <select id={`${id}-node`} className={sel} value={value.node} onChange={(e) => onChange({ ...value, node: Number(e.target.value) })}>
          {Array.from({ length: NODES }, (_, n) => <option key={n} value={n}>{nodeName(n)}</option>)}
        </select>
        <label htmlFor={`${id}-gpu`} className="text-xs text-muted">GPU</label>
        <select id={`${id}-gpu`} className={sel} value={value.gpu} onChange={(e) => onChange({ ...value, gpu: Number(e.target.value) })}>
          {Array.from({ length: GPUS }, (_, g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
    </fieldset>
  );
}

export default function RailPathExplorer() {
  const [src, setSrc] = useState<Gpu>({ node: 0, gpu: 2 });
  const [dst, setDst] = useState<Gpu>({ node: 1, gpu: 5 });
  const [pxn, setPxn] = useState(true);
  const [layout, setLayout] = useState<Layout>('1su');
  const [spine, setSpine] = useState(true);

  const f: Fabric = { layout: spine ? layout : '1su', spine, pxn };
  const p = railPath(f, src, dst);
  const alt = railPath({ ...f, pxn: !pxn }, src, dst);
  const crossRail = src.node !== dst.node && src.gpu !== dst.gpu;

  const steps = p.elems.map(elemText);
  const label = p.kind === 'unreachable'
    ? `Rail-optimized fabric without spines. No network path from node ${nodeName(src.node)} GPU ${src.gpu} to node ${nodeName(dst.node)} GPU ${dst.gpu}.`
    : `Rail-optimized fabric, ${NODES} nodes of ${GPUS} GPUs, ${f.layout === '1su' ? 'one scalable unit' : 'two scalable units'}, ${spine ? `${SPINES} spines` : 'no spines'}. Path: ${steps.join(', then ')}. ${p.switchHops} network switch hops, ${p.nvlinkHops} NVLink hops.`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <GpuPicker id="rp-src" label="Source GPU" value={src} onChange={setSrc} />
        <GpuPicker id="rp-dst" label="Destination GPU" value={dst} onChange={setDst} />
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Example pairs">
        <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Try</span>
        {PRESETS.filter((x) => !x.need2su || (f.layout === '2su')).map((x) => {
          const active = x.src.node === src.node && x.src.gpu === src.gpu && x.dst.node === dst.node && x.dst.gpu === dst.gpu;
          return (
            <button key={x.label} type="button" aria-pressed={active} onClick={() => { setSrc(x.src); setDst(x.dst); }}
              className={`min-h-6 rounded-md border px-2 py-1 text-xs ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{x.label}</button>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Seg label="PXN (NCCL_PXN_DISABLE)" value={pxn} options={[true, false] as const} onChange={setPxn} render={(v) => (v ? 'on (default)' : 'off (=1)')} />
        <Seg label="Spine layer" value={spine} options={[true, false] as const} onChange={setSpine} render={(v) => (v ? 'leaf-spine' : 'none (rail-only)')} />
        {spine
          ? <Seg label="Scalable units" value={layout} options={['1su', '2su'] as const} onChange={setLayout} render={(v) => (v === '1su' ? '1 SU × 4 nodes' : '2 SUs × 2 nodes')} />
          : <div className="text-xs text-muted"><div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em]">Scalable units</div>Rail-only is drawn as one SU: each rail is a single switch.</div>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-panel p-2" tabIndex={0} role="region" aria-label="Rail-optimized fabric diagram (scrolls sideways on narrow screens)">
        <Diagram f={f} path={p} src={src} dst={dst} label={label} />
      </div>
      <div className="flex flex-wrap gap-2 text-[11px] text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="var(--accent)" strokeWidth="3" /></svg>network path (thick)</span>
        <span className="inline-flex items-center gap-1"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="var(--data)" strokeWidth="3" strokeDasharray="6 3" /></svg>NVLink hop (dashed)</span>
        <span>small boxes above each GPU: its NIC</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="Path" value={<span className="text-base">{KIND_LABEL[p.kind]}</span>} tone={p.kind === 'unreachable' ? 'text-danger' : p.spine ? 'text-warn' : 'text-accent'} />
        <Out label="Network switch hops" value={p.kind === 'unreachable' ? '—' : p.switchHops} sub={p.kind === 'unreachable' ? 'rails not connected' : p.netLinks ? `${p.netLinks} cables, ${p.pcieHops} GPU↔NIC PCIe crossings` : 'no NIC involved'} tone="text-data" />
        <Out label="NVLink hops" value={p.nvlinkHops} sub={p.relay ? `relay: GPU ${p.relay.gpu} of node ${nodeName(p.relay.node)}` : p.nvlinkHops ? 'GPU to GPU in one node' : 'none'} />
        <Out label="Spine crossed" value={p.kind === 'unreachable' ? '—' : p.spine ? 'yes' : 'no'} tone={p.spine ? 'text-warn' : 'text-fg'}
          sub={p.egressRail !== null ? `leaves node ${nodeName(src.node)} on NIC ${p.egressRail}` : undefined} />
      </div>

      <div aria-live="polite" className="space-y-3">
        {p.elems.length > 1 && (
          <div>
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Hop by hop</div>
            <ol className="list-decimal space-y-0.5 pl-5 text-sm text-muted">
              {p.elems.map((e, i) => <li key={i}><span className={e.t === 'nvswitch' ? 'text-data' : e.t === 'spine' ? 'text-warn' : 'text-fg'}>{elemText(e)}</span></li>)}
            </ol>
          </div>
        )}
        <p className="text-sm text-muted">{explain(p.kind, f, src, dst)}</p>
        {crossRail && (
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-muted">
            <span className="font-semibold text-fg">PXN {pxn ? 'off' : 'on'} instead:</span>{' '}
            {alt.kind === 'unreachable' ? 'no network path at all.' : <>{alt.switchHops} switch hop{alt.switchHops === 1 ? '' : 's'}, {alt.nvlinkHops} NVLink hop{alt.nvlinkHops === 1 ? '' : 's'}, spine {alt.spine ? 'crossed' : 'not crossed'}.</>}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>rail r = NIC r of every node → leaf r</Pill>
        <Pill>{spine ? `${SPINES} spines, every leaf to every spine` : 'rail-only: no spines'}</Pill>
        <Pill>NCCL_PXN_DISABLE=1 turns PXN off</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model: HGX-style nodes with 8 GPUs on an NVSwitch and one NIC per GPU under a shared PCIe switch; one leaf per rail per scalable unit; a two-tier
        Clos where every leaf reaches every spine (real designs may group spines into rail planes or add a third tier). The spine drawn is a stand-in
        for whatever ECMP or adaptive routing picks. Paths are for point-to-point traffic such as all-to-all and send/receive; NCCL builds ring and
        tree channels rail-aligned where it can, so those usually do not change rails at all. Whether NCCL uses PXN for a given operation also depends on the NCCL version and on
        NCCL_P2P_PXN_LEVEL (check the environment variable documentation for your release). Same-node traffic is drawn as one NVSwitch hop.
      </p>
    </div>
  );
}
