import { Clock, ListChecks, Timer } from 'lucide-react';
import { useIndex } from '../content';
import { useProgress } from '../store';
import { Button, Card, Loading, PageHeader, Pill } from '../components/ui';

export default function Exams() {
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  if (!ix) return <Loading error={error} />;
  return (
    <div>
      <PageHeader eyebrow="Assessment" title="Mock exams">
        Timed, original practice assessments. Answers are revealed only at the end, with a per-domain breakdown so you know what to review.
        They are not questions from any real certification exam.
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        {ix.exams.map((e, i) => {
          const attempts = progress.exams.filter((a) => a.exam === e.id);
          const best = attempts.length ? Math.max(...attempts.map((a) => a.score)) : null;
          return (
            <Card key={e.id} className="flex flex-col p-6">
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Assessment {i + 1}</div>
              <div className="mt-1 text-lg font-semibold">{e.title}</div>
              <p className="mt-2 text-sm text-muted">{e.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Pill><ListChecks size={11} />{e.count} questions</Pill>
                <Pill><Clock size={11} />{e.duration_minutes} min</Pill>
                <Pill>pass {e.pass_pct}%</Pill>
              </div>
              <div className="mt-auto pt-6">
                {best !== null && <div className={`mb-3 text-sm ${best >= e.pass_pct ? 'text-accent' : 'text-warn'}`}>Best {best}% · {attempts.length} attempt(s)</div>}
                <Button to={`/exams/${e.id}`}><Timer size={16} />Start</Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
