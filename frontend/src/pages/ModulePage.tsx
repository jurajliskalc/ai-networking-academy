import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Clock, FlaskConical, HelpCircle } from 'lucide-react';
import { labPath, useIndex } from '../content';
import { useProgress } from '../store';
import { lessonDone, moduleStats } from '../stats';
import { Bar, Card, LevelBadge, Loading, PageHeader, Pill } from '../components/ui';
import NotFound from './NotFound';

export default function ModulePage() {
  const { id } = useParams();
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  if (!ix) return <Loading error={error} />;
  const m = ix.modules.find((x) => x.id === id);
  if (!m) return <NotFound />;
  const st = moduleStats(ix, progress, m);
  const labs = ix.labs.filter((lab) => lab.lessons.some((l) => m.lessons.includes(l)));
  const prev = ix.modules.find((x) => x.order === m.order - 1);
  const next = ix.modules.find((x) => x.order === m.order + 1);
  return (
    <div>
      <div className="mb-3 text-sm text-muted"><Link to="/path" className="hover:text-fg">Learning path</Link> / Module {m.order}</div>
      <PageHeader eyebrow={`Module ${m.order}`} title={m.title}>{m.summary}</PageHeader>
      <div className="mb-8 flex flex-wrap items-center gap-4">
        <LevelBadge level={m.level} />
        <Pill><Clock size={12} />{Math.round(st.minutes / 6) / 10} h</Pill>
        <div className="flex w-64 items-center gap-3"><Bar value={st.pct} label="Module lessons mastered" /><span className="font-mono text-xs text-muted">{st.done}/{st.total}</span></div>
      </div>
      <div className="space-y-3">
        {st.lessons.map((l, i) => {
          const q = progress.quizzes[l.quiz];
          return (
            <Card key={l.id} className="p-5 transition hover:border-accent/50">
              <div className="flex flex-wrap items-start gap-4">
                <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border font-mono text-sm ${lessonDone(progress, l) ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'}`}>
                  {lessonDone(progress, l) ? <CheckCircle2 size={18} aria-label={`Lesson ${i + 1}, mastered`} /> : <span aria-label={`Lesson ${i + 1}`}>{i + 1}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <h2><Link to={`/lesson/${l.id}`} className="text-lg font-semibold hover:text-accent">{l.title}</Link></h2>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted">{l.objectives.slice(0, 3).map((o) => <li key={o}>{o}</li>)}</ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Pill><Clock size={11} />{l.minutes} min</Pill>
                    <Link to={`/quiz/${l.quiz}`}><Pill className={q?.passed ? 'border-accent/50 text-accent' : ''}><HelpCircle size={11} aria-hidden />Quiz{q ? ` · best ${q.best}%` : ''}{q?.passed ? ' · passed' : ''}</Pill></Link>
                    {l.labs.map((lab) => <Link key={lab} to={labPath(lab)}><Pill><FlaskConical size={11} />{lab}</Pill></Link>)}
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      {labs.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-bold">Labs for this module</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {labs.map((lab) => (
              <Link key={lab.id} to={labPath(lab)}><Card className="p-4 hover:border-accent/50"><div className="font-mono text-[11px] uppercase text-accent">{lab.kind === 'sim' ? 'Simulator' : lab.tier > 0 ? `Real HW · T${lab.tier}` : 'Hands-on VM'}</div><div className="font-semibold">{lab.title}</div></Card></Link>
            ))}
          </div>
        </section>
      )}
      <div className="mt-10 flex justify-between text-sm">
        {prev ? <Link to={`/module/${prev.id}`} className="text-data hover:underline"><span aria-hidden>← </span><span className="sr-only">Previous module: </span>{prev.title}</Link> : <span />}
        {next && <Link to={`/module/${next.id}`} className="text-data hover:underline"><span className="sr-only">Next module: </span>{next.title}<span aria-hidden> →</span></Link>}
      </div>
    </div>
  );
}
