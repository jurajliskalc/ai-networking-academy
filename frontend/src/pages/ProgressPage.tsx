import { Link } from 'react-router-dom';
import { useIndex } from '../content';
import { useProgress } from '../store';
import { streak, today } from '../progress';
import { moduleStats, overall, rankFor, RANKS } from '../stats';
import { Bar, Card, Loading, PageHeader, Stat } from '../components/ui';

function Heatmap({ activity }: { activity: Record<string, number> }) {
  const days = 7 * 18;
  const cells = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const k = today(d);
    return { k, v: activity[k] ?? 0 };
  });
  const level = (v: number) => (v === 0 ? 0.08 : v < 3 ? 0.35 : v < 8 ? 0.65 : 1);
  return (
    <div className="overflow-x-auto">
      <div className="grid w-max grid-flow-col grid-rows-7 gap-[3px]">
        {cells.map((c) => <div key={c.k} title={`${c.k}: ${c.v} actions`} className="h-3 w-3 rounded-[3px] bg-accent" style={{ opacity: level(c.v) }} />)}
      </div>
    </div>
  );
}

export default function ProgressPage() {
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  if (!ix) return <Loading error={error} />;
  const o = overall(ix, progress);
  const rank = rankFor(o.pct);
  const quizScores = Object.values(progress.quizzes);
  const avg = quizScores.length ? Math.round(quizScores.reduce((s, q) => s + q.best, 0) / quizScores.length) : 0;
  const weakest = ix.lessons
    .filter((l) => progress.quizzes[l.quiz] && !progress.quizzes[l.quiz].passed)
    .sort((a, b) => progress.quizzes[a.quiz].best - progress.quizzes[b.quiz].best)
    .slice(0, 6);
  const domainTotals: Record<string, [number, number]> = {};
  for (const e of progress.exams) for (const [d, [r, t]] of Object.entries(e.byDomain)) domainTotals[d] = [(domainTotals[d]?.[0] ?? 0) + r, (domainTotals[d]?.[1] ?? 0) + t];

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Analytics" title="Your progress">Evidence-based: lessons count as mastered only when their quiz is passed; labs count only when the fabric verifies.</PageHeader>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Overall" value={`${Math.round(o.pct)}%`} sub={rank.title} />
        <Stat label="Average best quiz" value={`${avg}%`} sub={`${quizScores.length} quizzes attempted`} />
        <Stat label="Labs" value={`${o.labsSolved}/${o.labsTotal}`} sub="solved" />
        <Stat label="Streak" value={streak(progress.activity)} sub="days in a row" />
      </div>
      <Card className="p-5"><div className="mb-3 text-sm font-semibold">Activity, last 18 weeks</div><Heatmap activity={progress.activity} /></Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 text-sm font-semibold">Modules</div>
          <div className="space-y-3">
            {ix.modules.map((m) => {
              const st = moduleStats(ix, progress, m);
              return <div key={m.id}><div className="mb-1 flex justify-between text-sm"><Link to={`/module/${m.id}`} className="hover:text-accent">{m.order}. {m.title}</Link><span className="font-mono text-xs text-muted">{st.done}/{st.total}</span></div><Bar value={st.pct} /></div>;
            })}
          </div>
        </Card>
        <div className="space-y-6">
          <Card className="p-5">
            <div className="mb-3 text-sm font-semibold">Review next</div>
            {weakest.length ? <ul className="space-y-2 text-sm">{weakest.map((l) => <li key={l.id} className="flex justify-between gap-3"><Link to={`/lesson/${l.id}`} className="hover:text-accent">{l.title}</Link><span className="font-mono text-warn">{progress.quizzes[l.quiz].best}%</span></li>)}</ul> : <p className="text-sm text-muted">No failed quizzes. Keep going.</p>}
          </Card>
          <Card className="p-5">
            <div className="mb-3 text-sm font-semibold">Mock exam domains (all attempts)</div>
            {Object.keys(domainTotals).length ? <div className="space-y-3">{Object.entries(domainTotals).map(([d, [r, t]]) => <div key={d}><div className="mb-1 flex justify-between text-sm"><span>{d}</span><span className="font-mono text-xs text-muted">{Math.round((100 * r) / t)}%</span></div><Bar value={(100 * r) / t} /></div>)}</div> : <p className="text-sm text-muted">Take a mock exam to see your domain profile.</p>}
          </Card>
          <Card className="p-5">
            <div className="mb-3 text-sm font-semibold">Ranks</div>
            <ol className="space-y-1 text-sm">{RANKS.map((r) => <li key={r.title} className={r.title === rank.title ? 'font-semibold text-accent' : 'text-muted'}>{r.min}% · {r.title}</li>)}</ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
