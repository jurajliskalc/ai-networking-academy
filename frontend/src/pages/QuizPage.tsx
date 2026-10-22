import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, RotateCcw, Trophy } from 'lucide-react';
import { useIndex, useQuiz } from '../content';
import { useProgress } from '../store';
import { isCorrect, recordQuiz } from '../progress';
import QuestionCard from '../components/QuestionCard';
import { Bar, Button, Card, Loading, PageHeader } from '../components/ui';

export default function QuizPage() {
  const { id = '' } = useParams();
  const { data: ix } = useIndex();
  const { data: quiz, error } = useQuiz(id);
  const { progress, update } = useProgress();
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [finished, setFinished] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Move focus to the new question (or the result) so keyboard and screen reader users follow along.
  const questionRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) { moved.current = true; return; }
    (finished ? resultRef : questionRef).current?.focus();
  }, [i, finished]);

  const score = useMemo(() => {
    if (!quiz) return 0;
    const right = quiz.questions.filter((q) => isCorrect(q.options, answers[q.id] ?? [])).length;
    return Math.round((100 * right) / quiz.questions.length);
  }, [quiz, answers]);

  if (!quiz) return <Loading error={error} />;
  const lesson = ix?.lessons.find((l) => l.id === quiz.lesson);
  const q = quiz.questions[i];
  const chosen = answers[q.id] ?? [];
  const revealed = !!checked[q.id];
  const best = progress.quizzes[quiz.id]?.best;

  const finish = () => {
    setFinished(true);
    update((p) => recordQuiz(p, quiz.id, score, quiz.pass_pct));
  };
  const restart = () => {
    setAnswers({});
    setChecked({});
    setI(0);
    setFinished(false);
    setAttempt((a) => a + 1);
  };

  if (finished) {
    const passed = score >= quiz.pass_pct;
    const wrong = quiz.questions.filter((x) => !isCorrect(x.options, answers[x.id] ?? []));
    return (
      <div className="mx-auto max-w-3xl">
        <Card className="p-8 text-center">
          <div ref={resultRef} tabIndex={-1} role="status" className="outline-none">
            <h1 className="sr-only">Quiz results: {quiz.title.replace(/^Knowledge check:\s*/, '')}</h1>
            <Trophy size={40} aria-hidden className={`mx-auto ${passed ? 'text-accent' : 'text-muted'}`} />
            <div className="mt-3 text-5xl font-extrabold tabular-nums"><span className="sr-only">Your score: </span><span>{score}%</span></div>
            <div className={`mt-2 font-semibold ${passed ? 'text-accent' : 'text-warn'}`}>{passed ? 'Passed' : `Not yet: ${quiz.pass_pct}% needed`}</div>
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button variant="ghost" onClick={restart}><RotateCcw size={16} />Retry</Button>
            {lesson && <Button variant="ghost" to={`/lesson/${lesson.id}`}><ArrowLeft size={16} />Back to lesson</Button>}
            {lesson && <Button to={`/module/${lesson.module}`}>Module overview <ArrowRight size={16} /></Button>}
          </div>
        </Card>
        {wrong.length > 0 && (
          <div className="mt-8 space-y-6">
            <h2 className="text-lg font-bold">Review what you missed</h2>
            {wrong.map((x) => (
              <Card key={x.id} className="p-5">
                <QuestionCard q={x} index={quiz.questions.indexOf(x)} total={quiz.questions.length} chosen={answers[x.id] ?? []} onChange={() => {}} revealed seed={`${quiz.id}-${attempt}`} />
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl" key={attempt}>
      <div className="mb-3 text-sm text-muted">{lesson && <Link to={`/lesson/${lesson.id}`} className="hover:text-fg">← {lesson.title}</Link>}</div>
      <PageHeader eyebrow="Knowledge check" title={quiz.title.replace(/^Knowledge check:\s*/, '')}>
        Check each answer to see why every option is right or wrong. Pass mark {quiz.pass_pct}%{best !== undefined ? ` · your best ${best}%` : ''}.
      </PageHeader>
      <Bar value={(100 * Object.keys(checked).length) / quiz.questions.length} label="Questions checked" className="mb-6" />
      <Card className="p-6">
        <div ref={questionRef} tabIndex={-1} className="outline-none" role="group" aria-label={`Question ${i + 1} of ${quiz.questions.length}`}>
        <QuestionCard q={q} index={i} total={quiz.questions.length} chosen={chosen} onChange={(ids) => setAnswers((a) => ({ ...a, [q.id]: ids }))} revealed={revealed} seed={`${quiz.id}-${attempt}`} />
        </div>
        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" onClick={() => setI(i - 1)} disabled={i === 0}><ArrowLeft size={16} />Back</Button>
          {!revealed
            ? <Button onClick={() => setChecked((c) => ({ ...c, [q.id]: true }))} disabled={!chosen.length}>Check answer</Button>
            : i < quiz.questions.length - 1
              ? <Button onClick={() => setI(i + 1)}>Next <ArrowRight size={16} /></Button>
              : <Button onClick={finish} disabled={Object.keys(checked).length < quiz.questions.length}>See results</Button>}
        </div>
      </Card>
      <nav className="mt-4 flex flex-wrap justify-center gap-1.5" aria-label="Questions">
        {quiz.questions.map((x, k) => {
          const st = checked[x.id] ? (isCorrect(x.options, answers[x.id] ?? []) ? 'correct' : 'incorrect') : 'not checked';
          return (
            // A 24 px tall hit area around the slim dot (WCAG 2.5.8 target size).
            <button key={x.id} type="button" onClick={() => setI(k)} aria-label={`Question ${k + 1}, ${st}`} aria-current={k === i ? 'step' : undefined} className="group flex h-6 items-center">
              <span className={`block h-2.5 w-6 rounded-full border ${k === i ? 'border-fg bg-fg' : checked[x.id] ? (st === 'correct' ? 'border-accent bg-accent' : 'border-danger bg-danger') : 'border-muted/60 bg-panel-2 group-hover:border-muted'}`} />
            </button>
          );
        })}
      </nav>
    </div>
  );
}
