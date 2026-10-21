import { useState } from 'react';
import { Pill } from '../components/ui';

/* Illustrative 8-GPU server, loosely DGX/HGX H100-like: 2 sockets, 4 PCIe switch complexes (2 per socket),
   each complex = 1 upstream switch + 2 downstream switches, each downstream switch = 1 GPU + 1 NIC. */

type Kind = 'GPU' | 'NIC';
interface Dev { id: string; kind: Kind; idx: number; leaf: number; complex: number; socket: number; x: number; y: number }

const LEAF_X = (i: number) => 52 + i * 93.7;
const DEVS: Dev[] = Array.from({ length: 8 }, (_, i) => [
  { id: `GPU${i}`, kind: 'GPU' as const, idx: i, leaf: i, complex: i >> 1, socket: i >> 2, x: LEAF_X(i) - 21, y: 300 },
  { id: `NIC${i}`, kind: 'NIC' as const, idx: i, leaf: i, complex: i >> 1, socket: i >> 2, x: LEAF_X(i) + 21, y: 300 },
]).flat();
const ORDER = [...DEVS.filter((d) => d.kind === 'GPU'), ...DEVS.filter((d) => d.kind === 'NIC')];
const byId = (id: string) => DEVS.find((d) => d.id === id)!;
const CX = (c: number) => (LEAF_X(2 * c) + LEAF_X(2 * c + 1)) / 2;
const SX = (s: number) => (CX(2 * s) + CX(2 * s + 1)) / 2;
const Y = { cpu: 46, up: 140, leaf: 222, dev: 300, nvs: 378 };

type Code = 'X' | 'NV18' | 'PIX' | 'PXB' | 'PHB' | 'NODE' | 'SYS';
function code(a: Dev, b: Dev): Code {
  if (a.id === b.id) return 'X';
  if (a.kind === 'GPU' && b.kind === 'GPU') return 'NV18';
  if (a.leaf === b.leaf) return 'PIX';
  if (a.complex === b.complex) return 'PXB';
  if (a.socket === b.socket) return 'NODE';
  return 'SYS';
}

const INFO: Record<Code, { text: string; tone: string; gdr: string }> = {
  X: { text: 'Self.', tone: 'text-muted', gdr: '' },
  NV18: { text: 'Connection traversing a bonded set of 18 NVLinks (here via NVSwitch). GPU↔GPU traffic never touches PCIe.', tone: 'text-accent', gdr: 'Best possible GPU↔GPU path. NCCL also uses it for PXN: move data over NVLink to the GPU whose NIC is local, then send.' },
  PIX: { text: 'Traverses at most a single PCIe bridge (one switch).', tone: 'text-accent', gdr: 'Ideal for GPUDirect RDMA: peer-to-peer TLPs turn around in the switch at full bandwidth, never reaching the CPU.' },
  PXB: { text: 'Traverses multiple PCIe bridges, without crossing the PCIe host bridge.', tone: 'text-accent', gdr: 'Good for GPUDirect RDMA: still switch-local P2P. NCCL treats PXB as GDR-capable by default.' },
  PHB: { text: 'Traverses PCIe and a PCIe host bridge (typically the CPU root complex).', tone: 'text-warn', gdr: 'Poor: P2P goes up through the root complex; bandwidth depends on the CPU. Not present in this layout.' },
  NODE: { text: 'Traverses PCIe and the interconnect between PCIe host bridges within one NUMA node.', tone: 'text-warn', gdr: 'Poor: crosses the CPU\'s internal fabric. NCCL disables GDR by default beyond PXB (NCCL_NET_GDR_LEVEL).' },
  SYS: { text: 'Traverses PCIe and the SMP interconnect between NUMA nodes (UPI / xGMI).', tone: 'text-danger', gdr: 'Worst: crosses sockets. P2P across UPI is slow or unsupported; data is staged in host memory. Avoid pairing this GPU with this NIC.' },
};

const CPU_AFF = ['0-55,112-167', '56-111,168-223'];

function pathPoints(a: Dev, b: Dev): [number, number][] {
  if (a.id === b.id) return [];
  if (a.kind === 'GPU' && b.kind === 'GPU') return [[a.x, a.y + 16], [a.x, Y.nvs], [b.x, Y.nvs], [b.x, b.y + 16]];
  const up = (d: Dev): [number, number][] => [[d.x, d.y - 16], [LEAF_X(d.leaf), Y.leaf]];
  const c = code(a, b);
  const pa = up(a), pb = up(b);
  if (c === 'PIX') return [...pa, pb[0]];
  const mid: [number, number][] = [];
  mid.push([CX(a.complex), Y.up]);
  if (c === 'NODE' || c === 'SYS') mid.push([SX(a.socket), Y.cpu]);
  if (c === 'SYS') mid.push([SX(b.socket), Y.cpu]);
  if (c !== 'PXB') mid.push([CX(b.complex), Y.up]);
  return [...pa, ...mid, ...[...pb].reverse()];
}

export default function PcieTopo() {
  const [sel, setSel] = useState<string[]>(['GPU0', 'NIC0']);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const a = byId(sel[0]);
  const b = sel[1] ? byId(sel[1]) : null;
  const c = b ? code(a, b) : null;
  const pts = b ? pathPoints(a, b) : [];

  const click = (id: string) => setSel((s) => (s.length === 1 ? (s[0] === id ? s : [s[0], id]) : [id]));
  const pick = (r: number, col: number) => setSel([ORDER[r].id, ORDER[col].id]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Click two devices (GPU↔NIC or GPU↔GPU), or a cell in the matrix. Illustrative layout, similar in spirit to an HGX H100 board.</p>
      <svg viewBox="0 0 760 400" className="w-full" role="img" aria-label="PCIe topology of an 8-GPU server">
        {/* static wiring */}
        <g stroke="var(--border)" strokeWidth={1.5} fill="none">
          <line x1={SX(0) + 60} y1={Y.cpu} x2={SX(1) - 60} y2={Y.cpu} strokeWidth={3} />
          {[0, 1, 2, 3].map((cx) => <line key={cx} x1={SX(cx >> 1)} y1={Y.cpu + 18} x2={CX(cx)} y2={Y.up - 14} />)}
          {Array.from({ length: 8 }, (_, i) => <line key={i} x1={CX(i >> 1)} y1={Y.up + 14} x2={LEAF_X(i)} y2={Y.leaf - 12} />)}
          {DEVS.map((d) => <line key={d.id} x1={LEAF_X(d.leaf)} y1={Y.leaf + 12} x2={d.x} y2={d.y - 16} />)}
          {DEVS.filter((d) => d.kind === 'GPU').map((d) => <line key={d.id} x1={d.x} y1={d.y + 16} x2={d.x} y2={Y.nvs - 10} stroke="var(--accent)" opacity={0.35} />)}
        </g>
        <text x={380} y={Y.cpu - 8} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">UPI / xGMI</text>
        {[0, 1].map((s) => (
          <g key={s}>
            <rect x={SX(s) - 60} y={Y.cpu - 18} width={120} height={36} rx={6} fill="var(--panel-2)" stroke="var(--muted)" />
            <text x={SX(s)} y={Y.cpu - 2} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--text)" fontFamily="var(--font-mono)">CPU{s}</text>
            <text x={SX(s)} y={Y.cpu + 12} textAnchor="middle" fontSize={9.5} fill="var(--muted)" fontFamily="var(--font-mono)">NUMA {s} · root complex</text>
          </g>
        ))}
        {[0, 1, 2, 3].map((cx) => (
          <g key={cx}>
            <rect x={CX(cx) - 52} y={Y.up - 14} width={104} height={28} rx={5} fill="var(--panel)" stroke="var(--data)" />
            <text x={CX(cx)} y={Y.up + 4} textAnchor="middle" fontSize={10.5} fill="var(--text)" fontFamily="var(--font-mono)">PCIe sw {cx}</text>
          </g>
        ))}
        {Array.from({ length: 8 }, (_, i) => (
          <g key={i}>
            <rect x={LEAF_X(i) - 26} y={Y.leaf - 12} width={52} height={24} rx={4} fill="var(--panel)" stroke="var(--data)" strokeDasharray="3 2" />
            <text x={LEAF_X(i)} y={Y.leaf + 4} textAnchor="middle" fontSize={9.5} fill="var(--muted)" fontFamily="var(--font-mono)">sw {i >> 1}.{i & 1}</text>
          </g>
        ))}
        <rect x={20} y={Y.nvs - 10} width={720} height={20} rx={5} fill="var(--accent-soft)" stroke="var(--accent)" />
        <text x={380} y={Y.nvs + 4} textAnchor="middle" fontSize={11} fill="var(--accent)" fontFamily="var(--font-mono)">NVSwitch fabric (NVLink, all-to-all)</text>

        {pts.length > 0 && (
          <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={c === 'SYS' ? 'var(--danger)' : c === 'NODE' ? 'var(--warn)' : 'var(--accent)'} strokeWidth={3.5} strokeLinejoin="round" className="flow-dash" />
        )}

        {DEVS.map((d) => {
          const on = sel.includes(d.id);
          const gpu = d.kind === 'GPU';
          return (
            <g key={d.id} onClick={() => click(d.id)} style={{ cursor: 'pointer' }} role="button" tabIndex={0} aria-label={d.id} aria-pressed={on}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(d.id); } }}>
              <rect x={d.x - 19} y={d.y - 16} width={38} height={32} rx={5} fill={on ? (gpu ? 'var(--accent-soft)' : 'var(--panel-2)') : 'var(--panel)'} stroke={on ? 'var(--text)' : gpu ? 'var(--accent)' : 'var(--data)'} strokeWidth={on ? 2.5 : 1.5} />
              <text x={d.x} y={d.y - 2} textAnchor="middle" fontSize={9} fill={gpu ? 'var(--accent)' : 'var(--data)'} fontFamily="var(--font-mono)">{d.kind}</text>
              <text x={d.x} y={d.y + 10} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--text)" fontFamily="var(--font-mono)">{d.idx}</text>
            </g>
          );
        })}
      </svg>

      <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
        {b && c ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{a.id} ↔ {b.id}</span>
              <span className={`rounded border border-current px-1.5 font-mono text-sm font-bold ${INFO[c].tone}`}>{c}</span>
              {a.kind !== b.kind && <Pill>NUMA {a.kind === 'GPU' ? a.socket : b.socket} for the GPU · NUMA {a.kind === 'NIC' ? a.socket : b.socket} for the NIC</Pill>}
            </div>
            <p className="mt-1.5">{INFO[c].text}</p>
            <p className={`mt-1 ${INFO[c].tone}`}>{INFO[c].gdr}</p>
          </>
        ) : <span className="text-muted">Selected {a.id}. Click a second device.</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-line" style={{ background: 'var(--code-bg)', color: 'var(--code-text)' }}>
        <div className="px-3 pt-2 font-mono text-[11px] opacity-70">$ nvidia-smi topo -m</div>
        <table className="m-2 border-collapse font-mono text-[11px]" onMouseLeave={() => setHover(null)}>
          <thead>
            <tr>
              <th className="px-1.5 py-0.5" />
              {ORDER.map((d, ci) => <th key={d.id} className={`px-1.5 py-0.5 font-normal ${hover?.[1] === ci ? 'text-[#4ade80]' : ''}`}>{d.id}</th>)}
              <th className="px-1.5 py-0.5 text-left font-normal">CPU Affinity</th>
              <th className="px-1.5 py-0.5 text-left font-normal">NUMA Affinity</th>
            </tr>
          </thead>
          <tbody>
            {ORDER.map((r, ri) => (
              <tr key={r.id}>
                <th className={`px-1.5 py-0.5 text-left font-normal ${hover?.[0] === ri ? 'text-[#4ade80]' : ''}`}>{r.id}</th>
                {ORDER.map((col, ci) => {
                  const cc = code(r, col);
                  const selected = (sel[0] === r.id && sel[1] === col.id) || (sel[1] === r.id && sel[0] === col.id);
                  const cross = hover && (hover[0] === ri || hover[1] === ci);
                  const color = cc === 'SYS' ? '#f87171' : cc === 'NODE' || cc === 'PHB' ? '#fbbf24' : cc === 'X' ? '#6b7a90' : '#4ade80';
                  return (
                    <td key={col.id} onMouseEnter={() => setHover([ri, ci])} onClick={() => cc !== 'X' && pick(ri, ci)}
                      className="cursor-pointer px-1.5 py-0.5 text-center"
                      style={{ color, background: selected ? 'rgba(74,222,128,.25)' : cross ? 'rgba(255,255,255,.07)' : undefined, outline: hover?.[0] === ri && hover?.[1] === ci ? '1px solid #4ade80' : undefined }}>
                      {cc}
                    </td>
                  );
                })}
                <td className="px-1.5 py-0.5">{r.kind === 'GPU' ? CPU_AFF[r.socket] : ''}</td>
                <td className="px-1.5 py-0.5">{r.kind === 'GPU' ? r.socket : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 pb-2 font-mono text-[10.5px] leading-relaxed opacity-70">
          NIC Legend: {Array.from({ length: 8 }, (_, i) => `NIC${i}: mlx5_${i}`).join('  ')}
          <br />Legend: X = Self · SYS = PCIe + SMP interconnect between NUMA nodes · NODE = PCIe + interconnect between host bridges in a NUMA node · PHB = PCIe + a host bridge · PXB = multiple PCIe bridges · PIX = at most one PCIe bridge · NV# = bonded set of # NVLinks
          {hover && <><br />Hovered: {ORDER[hover[0]].id} ↔ {ORDER[hover[1]].id} = {code(ORDER[hover[0]], ORDER[hover[1]])}</>}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Illustrative layout and CPU core ranges (2 × 56-core sockets with SMT); real boards differ, so always read the output on your system. Even a PIX/PXB pair only
        gets true peer-to-peer if the switch allows it: PCIe ACS (Access Control Services) can force P2P TLPs up to the root complex, and an enabled IOMMU
        may translate or block them. GPUDirect RDMA deployments usually disable ACS redirect on these switches and run the IOMMU off or in passthrough
        mode. Check with NCCL_DEBUG=INFO (look for GDRDMA / "via NET/IB/x/GDRDMA").
      </p>
    </div>
  );
}
