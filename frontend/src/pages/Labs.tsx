import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Server, Terminal } from 'lucide-react';
import { useIndex } from '../content';
import { useProgress } from '../store';
import { Card, LevelBadge, Loading, PageHeader, Pill } from '../components/ui';
import type { Lab } from '../types';

export default function Labs() {
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  const [tab, setTab] = useState<'sim' | 'handson'>('sim');
  if (!ix) return <Loading error={error} />;
  const labs = ix.labs.filter((l) => l.kind === tab).sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const lessonTitle = (id: string) => ix.lessons.find((l) => l.id === id)?.title.split(':')[0] ?? id;

  const card = (lab: Lab) => {
    const rec = progress.labs[lab.id];
    return (
      <Link key={lab.id} to={`/labs/${lab.id}`}>
        <Card className="flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-accent/60">
          <div className="flex items-center justify-between">
            <LevelBadge level={lab.level} />
            {rec?.solved && <span className="flex items-center gap-1 text-xs text-accent"><CheckCircle2 size={14} />Solved</span>}
          </div>
          <div className="mt-3 font-semibold leading-snug">{lab.title}</div>
          {lab.kind === 'sim' && lab.summary && <p className="mt-1.5 text-sm text-muted">{lab.summary}</p>}
          <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
            <Pill><Clock size={11} />{lab.estimated_minutes} min</Pill>
            {lab.kind === 'handson' && <Pill>{lab.environment}</Pill>}
            {lab.lessons.slice(0, 2).map((l) => <Pill key={l}>{lessonTitle(l)}</Pill>)}
          </div>
        </Card>
      </Link>
    );
  };

  return (
    <div>
      <PageHeader eyebrow="Practice" title="Labs">
        <b>Simulator labs</b> are incident tickets in a browser-simulated 32-GPU rail-optimized RoCE cluster: investigate with real tool syntax,
        name the root cause, fix it, and the lab grades the resulting fabric state. <b>Hands-on labs</b> run on your own Linux VM with
        containerlab, FRR and Soft-RoCE.
      </PageHeader>
      <div className="mb-6 inline-flex rounded-xl border border-line bg-panel p-1">
        {([['sim', 'Fabric simulator', Terminal], ['handson', 'Hands-on Linux', Server]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm ${tab === k ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-fg'}`}>
            <Icon size={15} />{label} <span className="font-mono text-xs opacity-70">{ix.labs.filter((l) => l.kind === k).length}</span>
          </button>
        ))}
      </div>
      {labs.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{labs.map(card)}</div> : <p className="text-muted">No labs of this kind yet.</p>}
    </div>
  );
}
