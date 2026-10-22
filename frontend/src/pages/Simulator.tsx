import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { createFabric, LEAVES, NODES, SPINES } from '../sim/fabric';
import Terminal from '../components/Terminal';
import { Button, Card, PageHeader } from '../components/ui';

function Topology() {
  const w = 760;
  const leafX = (r: number) => 50 + r * ((w - 100) / 7);
  const nodeX = (n: number) => 110 + n * ((w - 220) / 3);
  return (
    <svg viewBox={`0 0 ${w} 250`} className="w-full" role="img" aria-label="Cluster topology: 2 spines, 8 rail leaves, 4 GPU nodes">
      {SPINES.map((_, s) => LEAVES.map((_, r) => <line key={`${s}${r}`} x1={w / 2 - 120 + s * 240} y1={34} x2={leafX(r)} y2={118} stroke="var(--border)" />))}
      {LEAVES.map((_, r) => NODES.map((_, n) => <line key={`${r}${n}`} x1={leafX(r)} y1={130} x2={nodeX(n) - 42 + r * 12} y2={206} stroke={r === 3 ? 'var(--accent)' : 'var(--border)'} strokeOpacity={r === 3 ? 0.9 : 0.6} />))}
      {SPINES.map((s, i) => <g key={s}><rect x={w / 2 - 160 + i * 240} y={14} width="80" height="24" rx="6" fill="var(--panel-2)" stroke="var(--data)" /><text x={w / 2 - 120 + i * 240} y={30} textAnchor="middle" fontSize="11" fill="var(--text)" fontFamily="monospace">{s}</text></g>)}
      {LEAVES.map((l, r) => <g key={l}><rect x={leafX(r) - 32} y={110} width="64" height="22" rx="6" fill="var(--panel-2)" stroke={r === 3 ? 'var(--accent)' : 'var(--border)'} /><text x={leafX(r)} y={125} textAnchor="middle" fontSize="10" fill="var(--text)" fontFamily="monospace">{l}</text></g>)}
      {NODES.map((n, i) => (
        <g key={n}>
          <rect x={nodeX(i) - 56} y={200} width="112" height="40" rx="8" fill="var(--panel)" stroke="var(--border)" />
          <text x={nodeX(i)} y={214} textAnchor="middle" fontSize="11" fill="var(--text)" fontFamily="monospace">{n}</text>
          {Array.from({ length: 8 }, (_, g) => <rect key={g} x={nodeX(i) - 46 + g * 12} y={222} width="8" height="10" rx="1.5" fill={g === 3 ? 'var(--accent)' : 'var(--muted)'} opacity={g === 3 ? 1 : 0.5} />)}
        </g>
      ))}
      <text x={w - 6} y={160} textAnchor="end" fontSize="10" fill="var(--accent)" fontFamily="monospace">rail 3: mlx5_3 of every node → leaf04</text>
    </svg>
  );
}

export default function Simulator() {
  const [state, setState] = useState(createFabric);
  const [gen, setGen] = useState(0);
  const [params] = useSearchParams();
  const autorun = useMemo(() => params.getAll('run').slice(0, 20), [params]);
  return (
    <div>
      <PageHeader eyebrow="Sandbox" title="Fabric simulator">
        A healthy 32-GPU cluster to explore freely: 4 nodes × 8 H100-class GPUs, 8 × 400G RoCE NICs per node, 8 rail leaves and 2 spines.
        Break things on purpose and watch the counters. Share a session by link: <code>#/simulator?run=ibdev2netdev&amp;run=nvidia-smi%20topo%20-m</code>. For guided incidents, open a <Link to="/labs" className="text-data underline underline-offset-2">simulator lab</Link>.
        The model and its limits are described in <code>docs/SIMULATOR.md</code>.
      </PageHeader>
      <Card className="mb-6 p-4"><Topology /></Card>
      <div className="mb-3 flex justify-end"><Button variant="ghost" onClick={() => { setState(createFabric()); setGen((g) => g + 1); }}><RotateCcw size={15} aria-hidden />Reset cluster</Button></div>
      <div className="h-[70vh]"><Terminal key={gen} autoFocus state={state} start="node01" onChange={() => {}} autorun={gen === 0 ? autorun : undefined} banner={'Fabric Simulator sandbox. Healthy cluster. Try: ibdev2netdev, nvidia-smi topo -m, all_reduce_perf -b 8 -e 8G -f 2 -g 1, ssh leaf04'} /></div>
    </div>
  );
}
