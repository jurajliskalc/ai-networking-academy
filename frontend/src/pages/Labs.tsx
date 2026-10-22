import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock, Server } from 'lucide-react';
import { labPath, useIndex } from '../content';
import { useProgress } from '../store';
import { Card, LevelBadge, Loading, PageHeader, Pill } from '../components/ui';
import type { Lab } from '../types';

export default function Labs() {
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  if (!ix) return <Loading error={error} />;
  const labs = ix.labs.filter((l) => l.kind === 'sim').sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const lessonTitle = (id: string) => ix.lessons.find((l) => l.id === id)?.title.split(':')[0] ?? id;

  const card = (lab: Lab) => {
    const rec = progress.labs[lab.id];
    return (
      <Link key={lab.id} to={labPath(lab)}>
        <Card className="flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-accent/60">
          <div className="flex items-center justify-between">
            <LevelBadge level={lab.level} />
            {rec?.solved && <span className="flex items-center gap-1 text-xs text-accent"><CheckCircle2 size={14} />Solved</span>}
          </div>
          <div className="mt-3 font-semibold leading-snug">{lab.title}</div>
          {lab.summary && <p className="mt-1.5 text-sm text-muted">{lab.summary}</p>}
          <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
            <Pill><Clock size={11} />{lab.estimated_minutes} min</Pill>
            {lab.lessons.slice(0, 2).map((l) => <Pill key={l}>{lessonTitle(l)}</Pill>)}
          </div>
        </Card>
      </Link>
    );
  };

  const hw = ix.labs.filter((l) => l.kind === 'handson').length;
  return (
    <div>
      <PageHeader eyebrow="Practice in the browser" title="Simulator labs">
        Incident tickets in a browser-simulated 32-GPU rail-optimized RoCE cluster: investigate with real tool syntax, name the root cause, fix it, and
        the lab grades the resulting fabric state. Nothing to install.
      </PageHeader>
      <Link to="/hw" className="mb-8 flex items-center justify-between gap-4 rounded-2xl border border-line bg-panel p-4 transition hover:border-accent/60">
        <span className="flex items-center gap-3 text-sm">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Server size={18} /></span>
          <span><b>Have your own servers, NICs or a VM?</b> <span className="text-muted">The Real HW track has {hw} labs that run on your gear, from a single VM to GPU nodes, with setup scripts and automatic checks.</span></span>
        </span>
        <ArrowRight size={16} className="shrink-0 text-muted" />
      </Link>
      {labs.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{labs.map(card)}</div> : <p className="text-muted">No simulator labs yet.</p>}
    </div>
  );
}
