import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Flag, Timer } from 'lucide-react';
import { useExam } from '../content';
import { useProgress } from '../store';
import { bump, isCorrect } from '../progress';
import QuestionCard from '../components/QuestionCard';
import { Bar, Button, Card, Loading, PageHeader } from '../components/ui';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

export default function ExamSession() {
  const { id = '' } = useParams();
  const { data: exam, error } = useExam(id);
  const { update } = useProgress();
  const [started, setStarted] = useState(false);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [left, setLeft] = useState(0);
  const [done, setDone] = useState(false);
  const startedAt = useRef(0);
  const questionRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!started) return;
    if (!moved.current) { moved.current = true; return; }
    questionRef.current?.focus();
  }, [i, started]);
  // Announce time only at a few thresholds; a per-second live timer would be unusable with a screen reader.
  const timeNotice = left <= 60 && left > 0 ? '1 minute left.' : left <= 300 && left > 0 ? '5 minutes left.' : '';

  useEffect(() => {
    if (!started || done) return;
    const t = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(t);
  }, [started, done]);

  const result = useMemo(() => {
    if (!exam) return null;
    const byDomain: Record<string, [number, number]> = {};
    let right = 0;
    for (const q of exam.questions) {
      const ok = isCorrect(q.options, answers[q.id] ?? []);
      if (ok) right++;
      const d = q.domain ?? 'other';
      byDomain[d] = [(byDomain[d]?.[0] ?? 0) + (ok ? 1 : 0), (byDomain[d]?.[1] ?? 0) + 1];
    }
    return { score: Math.round((100 * right) / exam.questions.length), right, byDomain };
  }, [exam, answers]);

  const submit = () => {
    if (!exam || !result || done) return;
    setDone(true);
    update((p) => bump({ ...p, exams: [...p.exams, { exam: exam.id, score: result.score, passed: result.score >= exam.pass_pct, at: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt.current) / 1000), byDomain: result.byDomain }] }));
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    if (started && !done && left <= 0) submit();
  });

  if (!exam) return <Loading error={error} />;

  if (!started) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader eyebrow="Mock exam" title={exam.title}>{exam.description}</PageHeader>
        <Card className="space-y-3 p-6 text-sm">
          <p><b>{exam.questions.length}</b> questions · <b>{exam.duration_minutes}</b> minutes · pass mark <b>{exam.pass_pct}%</b>.</p>
          <p className="text-muted">Answers are not revealed until you submit. You can flag questions and jump around. When time runs out the exam is submitted automatically.</p>
          <p className="text-muted">Domains: {exam.domains.map((d) => d.title).join(' · ')}</p>
          <Button onClick={() => { setStarted(true); setLeft(exam.duration_minutes * 60); startedAt.current = Date.now(); }}><Timer size={16} />Begin</Button>
        </Card>
      </div>
    );
  }

  if (done && result) {
    const passed = result.score >= exam.pass_pct;
    return (
      <div className="mx-auto max-w-3xl">
        <Card className="p-8">
          <div className="text-center" role="status">
            <h1 className="font-mono text-xs uppercase tracking-[0.14em] text-muted"><span className="sr-only">Results: </span>{exam.title}</h1>
            <div className="mt-2 text-6xl font-extrabold tabular-nums"><span className="sr-only">Your score: </span><span>{result.score}%</span></div>
            <div className={`mt-1 font-semibold ${passed ? 'text-accent' : 'text-warn'}`}>{passed ? 'Pass' : 'Below the pass mark'} · {result.right}/{exam.questions.length} correct</div>
          </div>
          <div className="mt-8 space-y-3">
            {exam.domains.map((d) => {
              const [r, t] = result.byDomain[d.id] ?? [0, 0];
              const pct = t ? (100 * r) / t : 0;
              return (
                <div key={d.id}>
                  <div className="mb-1 flex justify-between text-sm"><span>{d.title}</span><span className="font-mono text-muted">{r}/{t}</span></div>
                  <Bar value={pct} label={`${d.title}: score`} />
                </div>
              );
            })}
          </div>
          <div className="mt-8 flex justify-center gap-3"><Button variant="ghost" to="/exams">All exams</Button><Button onClick={() => location.reload()}>Retake</Button></div>
        </Card>
        <h2 className="mb-4 mt-10 text-lg font-bold">Review</h2>
        <div className="space-y-5">
          {exam.questions.map((q, k) => (
            <Card key={q.id} className={`p-5 ${isCorrect(q.options, answers[q.id] ?? []) ? '' : 'border-danger/40'}`}>
              <QuestionCard q={q} index={k} total={exam.questions.length} chosen={answers[q.id] ?? []} onChange={() => {}} revealed seed={String(startedAt.current)} />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const q = exam.questions[i];
  const answered = Object.values(answers).filter((a) => a.length).length;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="sr-only">{exam.title}</h1>
      <div className="sticky top-14 z-10 -mx-4 mb-6 flex items-center gap-4 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur">
        <Link to="/exams" className="text-sm text-muted hover:text-fg">Exit<span className="sr-only"> the exam (answers are not saved)</span></Link>
        <Bar value={(100 * answered) / exam.questions.length} label="Questions answered" />
        <span className="font-mono text-xs text-muted">{answered}/{exam.questions.length}</span>
        <span className={`flex items-center gap-1 font-mono text-sm tabular-nums ${left < 300 ? 'text-danger' : ''}`}><Timer size={15} aria-hidden /><span className="sr-only">Time left: </span><span>{fmt(left)}</span></span>
        <span role="status" className="sr-only">{timeNotice}</span>
      </div>
      <Card className="p-6">
        <div ref={questionRef} tabIndex={-1} className="outline-none" role="group" aria-label={`Question ${i + 1} of ${exam.questions.length}${flags[q.id] ? ', flagged' : ''}`}>
          <QuestionCard q={q} index={i} total={exam.questions.length} chosen={answers[q.id] ?? []} onChange={(ids) => setAnswers((a) => ({ ...a, [q.id]: ids }))} revealed={false} seed={String(startedAt.current)} />
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={() => setI(i - 1)} disabled={i === 0}><ArrowLeft size={16} />Back</Button>
          <button type="button" aria-pressed={!!flags[q.id]} onClick={() => setFlags((f) => ({ ...f, [q.id]: !f[q.id] }))} className={`flex min-h-6 items-center gap-1.5 text-sm ${flags[q.id] ? 'text-warn' : 'text-muted hover:text-fg'}`}><Flag size={15} aria-hidden />{flags[q.id] ? 'Flagged' : 'Flag'}</button>
          {i < exam.questions.length - 1 ? <Button onClick={() => setI(i + 1)}>Next <ArrowRight size={16} /></Button> : <Button onClick={submit}>Submit exam</Button>}
        </div>
      </Card>
      <nav className="mt-6 grid grid-cols-10 gap-1.5" aria-label="Jump to question">
        {exam.questions.map((x, k) => {
          const st = [answers[x.id]?.length ? 'answered' : 'unanswered', flags[x.id] ? 'flagged' : ''].filter(Boolean).join(', ');
          return (
            <button key={x.id} type="button" onClick={() => setI(k)} aria-label={`Question ${k + 1}, ${st}`} aria-current={k === i ? 'step' : undefined}
              className={`relative h-8 rounded-md border font-mono text-xs ${k === i ? 'border-fg' : flags[x.id] ? 'border-warn text-warn' : answers[x.id]?.length ? 'border-accent/50 bg-accent-soft' : 'border-line text-muted'}`}>
              {k + 1}{flags[x.id] && <Flag size={9} aria-hidden className="absolute right-0.5 top-0.5" />}
            </button>
          );
        })}
      </nav>
      <div className="mt-6 text-center"><Button variant="ghost" onClick={submit}>Submit now ({exam.questions.length - answered} unanswered)</Button></div>
    </div>
  );
}
