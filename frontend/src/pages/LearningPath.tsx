import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, CircleDot, Clock } from 'lucide-react';
import { LEVELS, useIndex } from '../content';
import { useProgress } from '../store';
import { lessonDone, moduleStats } from '../stats';
import { Bar, LevelBadge, Loading, PageHeader } from '../components/ui';

export default function LearningPath() {
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  if (!ix) return <Loading error={error} />;
  const byLevel = [1, 2, 3, 4].map((lv) => ({ lv, modules: ix.modules.filter((m) => m.level === lv) }));
  return (
    <div>
      <PageHeader eyebrow="Curriculum" title="Learning path">
        Thirteen modules in four levels. Each lesson ends with a quiz; a lesson is mastered when you have read it and passed its quiz.
        Modules build on each other, but experienced engineers can jump ahead: every lesson lists its prerequisites.
      </PageHeader>
      <div className="space-y-12">
        {byLevel.map(({ lv, modules }) => (
          <section key={lv}>
            <div className="mb-4 flex items-center gap-3">
              <LevelBadge level={lv} />
              <h2 className="text-lg font-bold">{LEVELS[lv].name}</h2>
              <div className="h-px flex-1 bg-line" />
            </div>
            <div className="relative space-y-4 border-l border-line pl-6">
              {modules.map((m) => {
                const st = moduleStats(ix, progress, m);
                return (
                  <div key={m.id} className="relative rounded-2xl border border-line bg-panel p-5">
                    <span className={`absolute -left-[31px] top-6 h-3 w-3 rounded-full border-2 ${st.done === st.total && st.total ? 'border-accent bg-accent' : st.read ? 'border-accent bg-bg' : 'border-line bg-bg'}`} />
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-mono text-xs text-muted">Module {m.order}</div>
                        <Link to={`/module/${m.id}`} className="text-lg font-semibold hover:text-accent">{m.title}</Link>
                        <p className="mt-1 max-w-3xl text-sm text-muted">{m.summary}</p>
                      </div>
                      <div className="w-40 text-right font-mono text-xs text-muted">
                        <div className="mb-1.5 flex items-center justify-end gap-1"><Clock size={12} />{Math.round(st.minutes / 60 * 10) / 10} h</div>
                        <Bar value={st.pct} />
                        <div className="mt-1">{st.done}/{st.total} mastered</div>
                      </div>
                    </div>
                    <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
                      {st.lessons.map((l) => {
                        const done = lessonDone(progress, l);
                        const Icon = done ? CheckCircle2 : progress.lessons[l.id] ? CircleDot : Circle;
                        return (
                          <li key={l.id}>
                            <Link to={`/lesson/${l.id}`} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2">
                              <Icon size={16} className={`mt-0.5 shrink-0 ${done ? 'text-accent' : 'text-muted'}`} />
                              <span>{l.title}</span>
                            </Link>
                          </li>
                        );
                      })}
                      {m.lessons.length > st.lessons.length && <li className="px-2 py-1.5 text-sm italic text-muted">{m.lessons.length - st.lessons.length} lesson(s) coming soon</li>}
                    </ol>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
