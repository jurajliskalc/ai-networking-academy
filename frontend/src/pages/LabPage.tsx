import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Circle, Eye, Lightbulb, RotateCcw, ShieldCheck, Ticket, XCircle } from 'lucide-react';
import { useIndex, useLabBody } from '../content';
import { useProgress } from '../store';
import { bump } from '../progress';
import { labState, runChecks } from '../sim/lab';
import type { FabricState } from '../sim/fabric';
import Markdown from '../components/Markdown';
import Terminal from '../components/Terminal';
import QuestionCard from '../components/QuestionCard';
import { Button, Card, LevelBadge, Loading, Pill } from '../components/ui';
import type { HandsOnLab, SimLab } from '../types';
import NotFound from './NotFound';

const simKey = (id: string) => `aina.sim.${id}`;

function loadSim(lab: SimLab): FabricState {
  try {
    const raw = localStorage.getItem(simKey(lab.id));
    if (raw) return JSON.parse(raw) as FabricState;
  } catch {
    /* fall through to a fresh state */
  }
  return labState(lab.faults);
}

function SimLabView({ lab }: { lab: SimLab }) {
  const { progress, update } = useProgress();
  const [state, setState] = useState<FabricState>(() => loadSim(lab));
  const [gen, setGen] = useState(0);
  const [hints, setHints] = useState(0);
  const [answer, setAnswer] = useState<string[]>([]);
  const [answered, setAnswered] = useState(false);
  const [results, setResults] = useState<ReturnType<typeof runChecks> | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const rec = progress.labs[lab.id];
  const diagnosisCorrect = answered && lab.diagnosis.options.find((o) => o.id === answer[0])?.correct === true;

  const persist = useCallback(() => {
    try {
      localStorage.setItem(simKey(lab.id), JSON.stringify(state));
    } catch {
      /* not persisted */
    }
  }, [lab.id, state]);

  const reset = () => {
    try {
      localStorage.removeItem(simKey(lab.id));
    } catch {
      /* ignore */
    }
    setState(labState(lab.faults));
    setGen((g) => g + 1);
    setResults(null);
  };

  const grade = () => {
    const r = runChecks(state, lab.checks);
    setResults(r);
    const solved = diagnosisCorrect && r.every((x) => x.pass);
    update((p) => bump({
      ...p,
      labs: {
        ...p.labs,
        [lab.id]: {
          solved: (p.labs[lab.id]?.solved ?? false) || solved, diagnosisCorrect: diagnosisCorrect || (p.labs[lab.id]?.diagnosisCorrect ?? false),
          attempts: (p.labs[lab.id]?.attempts ?? 0) + 1, hintsUsed: Math.max(hints, p.labs[lab.id]?.hintsUsed ?? 0), at: new Date().toISOString(),
        },
      },
    }));
  };

  const allPass = results?.every((r) => r.pass) ?? false;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-warn"><Ticket size={13} />Ticket</div>
          <div className="text-sm [&_.prose]:text-[0.95rem]"><Markdown source={lab.ticket} /></div>
        </Card>
        {lab.hints.length > 0 && (
          <Card className="p-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-data"><Lightbulb size={13} />Hints {hints}/{lab.hints.length}</div>
              {hints < lab.hints.length && <button className="text-xs text-data hover:underline" onClick={() => setHints(hints + 1)}>Reveal next hint</button>}
            </div>
            {hints === 0 ? <p className="text-sm text-muted">Try first. Hints are counted.</p> : <ol className="list-decimal space-y-1.5 pl-5 text-sm">{lab.hints.slice(0, hints).map((h) => <li key={h}><Markdown source={h} /></li>)}</ol>}
          </Card>
        )}
        <Card className="p-5">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">1 · Diagnosis</div>
          <QuestionCard q={{ id: 'diagnosis', type: 'single', prompt: lab.diagnosis.prompt, options: lab.diagnosis.options }} index={0} total={1} chosen={answer} onChange={setAnswer} revealed={answered} seed={lab.id} />
          {!answered && <Button className="mt-4" onClick={() => setAnswered(true)} disabled={!answer.length}>Commit diagnosis</Button>}
        </Card>
        <Card className="p-5">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">2 · Fix and verify</div>
          {lab.checks.length ? (
            <ul className="space-y-2 text-sm">
              {lab.checks.map((c, k) => {
                const r = results?.[k];
                const Icon = !r ? Circle : r.pass ? CheckCircle2 : XCircle;
                return <li key={c.description} className="flex items-start gap-2"><Icon size={16} className={`mt-0.5 shrink-0 ${!r ? 'text-muted' : r.pass ? 'text-accent' : 'text-danger'}`} />{c.description}</li>;
              })}
            </ul>
          ) : <p className="text-sm text-muted">This lab is graded on the diagnosis only.</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={grade} disabled={!answered}><ShieldCheck size={16} />Grade the fabric</Button>
            <Button variant="ghost" onClick={reset}><RotateCcw size={16} />Reset lab</Button>
          </div>
          {!answered && <p className="mt-2 text-xs text-muted">Commit a diagnosis first.</p>}
          {results && (
            <div className={`mt-4 rounded-lg border p-3 text-sm ${allPass && diagnosisCorrect ? 'border-accent/50 bg-accent-soft text-accent' : 'border-warn/40 bg-warn/10 text-warn'}`}>
              {allPass && diagnosisCorrect ? 'Incident resolved. Root cause identified and the fabric verifies clean.' : !diagnosisCorrect ? 'The fabric state is graded, but the diagnosis was not right. Read the explanations, then Reset and try again.' : 'Not fixed yet. Keep investigating.'}
            </div>
          )}
          {(rec?.solved || results) && (
            <button className="mt-4 flex items-center gap-1.5 text-xs text-muted hover:text-fg" onClick={() => setShowSolution(!showSolution)}><Eye size={13} />{showSolution ? 'Hide' : 'Show'} the reference solution</button>
          )}
          {showSolution && <div className="mt-3 border-t border-line pt-3 text-sm"><Markdown source={lab.solution} /></div>}
        </Card>
      </div>
      <div className="xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)]">
        <Terminal key={gen} state={state} start={(lab as SimLab & { start?: string }).start ?? 'node01'} onChange={() => { persist(); setState((s) => s); }}
          banner={`Fabric Simulator · ${lab.id}\nYou are on node01, the jump host.
Type "help" for commands. Lab state is saved in this browser.`} />
      </div>
    </div>
  );
}

function HandsOnView({ lab }: { lab: HandsOnLab }) {
  const { data, error } = useLabBody(lab.id);
  const { progress, update } = useProgress();
  const solved = progress.labs[lab.id]?.solved;
  const toggle = () => update((p) => bump({ ...p, labs: { ...p.labs, [lab.id]: { solved: !solved, diagnosisCorrect: true, attempts: (p.labs[lab.id]?.attempts ?? 0) + 1, hintsUsed: 0, at: new Date().toISOString() } } }));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 xl:grid-cols-[minmax(0,1fr)_220px]">
      <div>
        {!lab.verified && <div className="callout callout-warning mb-6 text-sm"><div className="callout-title">Status</div>This lab has been syntax-checked but not yet run end to end on a reference VM. Please report anything that does not work.</div>}
        {lab.files && <p className="mb-6 text-sm text-muted">Lab files: <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono">{lab.files}</code> in the repository. Every lab ships a <code>check.sh</code> that prints PASS/FAIL.</p>}
        {data ? <Markdown source={data.body} /> : <Loading error={error} />}
        <Card className="mt-10 flex items-center justify-between gap-4 p-5">
          <div className="text-sm">Ran <code>check.sh</code> and everything passed?</div>
          <Button variant={solved ? 'ghost' : 'primary'} onClick={toggle}>{solved ? <><CheckCircle2 size={16} />Completed</> : 'Mark lab completed'}</Button>
        </Card>
      </div>
      <aside className="hidden xl:block"><div className="sticky top-20"><div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Steps</div><ul className="space-y-1 text-[13px] text-muted">{lab.toc.filter((t) => t.depth <= 3).map((t, i) => <li key={i} className={t.depth === 3 ? 'pl-3' : ''}>{t.text}</li>)}</ul></div></aside>
    </div>
  );
}

export default function LabPage() {
  const { id = '' } = useParams();
  const { data: ix, error } = useIndex();
  const lab = useMemo(() => ix?.labs.find((l) => l.id === id), [ix, id]);
  if (!ix) return <Loading error={error} />;
  if (!lab) return <NotFound />;
  return (
    <div>
      <div className="mb-3 text-sm text-muted"><Link to="/labs" className="hover:text-fg">Labs</Link> / {lab.kind === 'sim' ? 'Fabric simulator' : 'Hands-on'}</div>
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{lab.title}</h1>
      <div className="mb-6 mt-3 flex flex-wrap gap-2">
        <LevelBadge level={lab.level} />
        <Pill>{lab.estimated_minutes} min</Pill>
        {lab.lessons.map((l) => <Link key={l} to={`/lesson/${l}`}><Pill className="hover:text-fg">{ix.lessons.find((x) => x.id === l)?.title.split(':')[0] ?? l}</Pill></Link>)}
      </div>
      {lab.kind === 'sim' ? <SimLabView key={lab.id} lab={lab} /> : <HandsOnView lab={lab} />}
    </div>
  );
}
