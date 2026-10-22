import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BadgeCheck, CheckCircle2, Clock, Settings2 } from 'lucide-react';
import { useIndex } from '../../content';
import { useProgress } from '../../store';
import { readiness } from '../../hw/report';
import { Card, LevelBadge, Loading, Pill } from '../../components/ui';
import type { ContentIndex, HandsOnLab } from '../../types';
import { HwShell, RequirementList, TierBadge, useProfile } from './shared';

const FABRIC_LABEL = { any: 'RoCE or IB', roce: 'RoCEv2', ib: 'InfiniBand' } as const;

export default function HwLabs() {
  const { data: ix, error } = useIndex();
  if (!ix) return <Loading error={error} />;
  return <LabList ix={ix} />;
}

function LabList({ ix }: { ix: ContentIndex }) {
  const [params, setParams] = useSearchParams();
  const { progress } = useProgress();
  const { profile, hw } = useProfile(ix);
  const tierFilter = params.get('tier');
  const runnable = params.get('runnable') === '1';
  const labs = useMemo(() => ix.labs.filter((l): l is HandsOnLab => l.kind === 'handson').sort((a, b) => a.tier - b.tier || a.level - b.level || a.id.localeCompare(b.id)), [ix]);
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(params);
    if (v === null) n.delete(k);
    else n.set(k, v);
    setParams(n, { replace: true });
  };
  const visible = labs.filter((l) => (tierFilter === null || String(l.tier) === tierFilter) && (!runnable || readiness(l, profile, hw.report).status !== 'blocked'));
  const tiers = ix.hardware.tiers.filter((t) => visible.some((l) => l.tier === t.id));
  return (
    <HwShell ix={ix}>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={tierFilter === null} onClick={() => set('tier', null)} className={`rounded-lg border px-3 py-1.5 text-xs ${tierFilter === null ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line bg-panel text-muted hover:text-fg'}`}>All tiers <span className="font-mono">{labs.length}</span></button>
        {ix.hardware.tiers.map((t) => (
          <button key={t.id} type="button" aria-pressed={tierFilter === String(t.id)} onClick={() => set('tier', String(t.id))} className={`rounded-lg border px-3 py-1.5 text-xs ${tierFilter === String(t.id) ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line bg-panel text-muted hover:text-fg'}`}>
            T{t.id} {t.title} <span className="font-mono">{labs.filter((l) => l.tier === t.id).length}</span>
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={runnable} onChange={(e) => set('runnable', e.target.checked ? '1' : null)} className="accent-[var(--accent)]" />Hide labs my lab cannot run
        </label>
      </div>
      {!hw.report && <p className="mb-6 text-sm text-muted">Requirement checks get sharper once you <Link to="/hw/connect" className="text-data underline underline-offset-2">import an inventory report</Link>; until then they rely on your profile.</p>}
      {tiers.map((t) => (
        <section key={t.id} className="mb-10">
          <div className="mb-3 flex flex-wrap items-baseline gap-3">
            <TierBadge tier={t.id} title={t.title} />
            <p className="text-sm text-muted">{t.summary}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.filter((l) => l.tier === t.id).map((lab) => {
              const rec = progress.labs[lab.id];
              const blocked = readiness(lab, profile, hw.report).status === 'blocked';
              return (
                <Link key={lab.id} to={`/hw/labs/${lab.id}`}>
                  <Card className={`flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-accent/60 ${blocked ? 'border-dashed' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <LevelBadge level={lab.level} />
                      {rec?.evidence ? <span className="flex items-center gap-1 text-xs text-accent" title={`Verified ${rec.evidence.finished.slice(0, 10)}${rec.evidence.host ? ` on ${rec.evidence.host}` : ''}`}><BadgeCheck size={14} />Verified</span>
                        : rec?.solved && <span className="flex items-center gap-1 text-xs text-accent"><CheckCircle2 size={14} />Completed</span>}
                    </div>
                    <div className="mt-3 font-semibold leading-snug">{lab.title}{blocked && <span className="sr-only"> (your lab is missing a requirement)</span>}</div>
                    <p className="mt-1.5 text-sm text-muted">{lab.summary}</p>
                    <div className="mt-auto pt-4">
                      <RequirementList lab={lab} ix={ix} profile={profile} report={hw.report} compact />
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Pill><Clock size={11} />{lab.estimated_minutes} min</Pill>
                        {lab.tier > 0 && <Pill>{FABRIC_LABEL[lab.fabric]}</Pill>}
                        {lab.tier === 0 && <Pill>{lab.environment}</Pill>}
                        {lab.changes_config && <Pill className="text-warn"><Settings2 size={11} />changes settings</Pill>}
                      </div>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
      {!visible.length && <p className="text-muted">No labs match these filters.</p>}
    </HwShell>
  );
}
