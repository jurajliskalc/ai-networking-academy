import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RotateCw } from 'lucide-react';
import { useIndex } from '../content';
import { useProgress } from '../store';
import { bump, isDue, review } from '../progress';
import { Button, Card, Loading, PageHeader } from '../components/ui';

const GRADES = [
  { g: 1, label: 'Again', cls: 'border-danger/50 text-danger' },
  { g: 3, label: 'Hard', cls: 'border-warn/50 text-warn' },
  { g: 4, label: 'Good', cls: 'border-data/50 text-data' },
  { g: 5, label: 'Easy', cls: 'border-accent/50 text-accent' },
];

export default function Flashcards() {
  const { data: ix, error } = useIndex();
  const { progress, update } = useProgress();
  const [flipped, setFlipped] = useState(false);
  const [session, setSession] = useState(0);
  const [mode, setMode] = useState<'due' | 'all'>('due');
  const queue = useMemo(() => {
    if (!ix) return [];
    const terms = mode === 'due' ? ix.glossary.filter((t) => isDue(progress.cards[t.term])) : ix.glossary;
    // Deterministic shuffle per session so cards do not always appear alphabetically.
    return [...terms].sort((a, b) => ((a.term.length * 31 + session * 7) % 13) - ((b.term.length * 31 + session * 7) % 13) || a.term.localeCompare(b.term));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix, mode, session]);
  const [pos, setPos] = useState(0);
  if (!ix) return <Loading error={error} />;
  const card = queue[pos];
  const learned = Object.values(progress.cards).filter((c) => c.reps >= 2).length;

  const grade = (g: number) => {
    update((p) => bump({ ...p, cards: { ...p.cards, [card.term]: review(p.cards[card.term], g) } }));
    setFlipped(false);
    setPos((x) => x + 1);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow="Spaced repetition" title="Flashcards">
        {ix.glossary.length} glossary terms scheduled with the SM-2 algorithm. {learned} learned so far.
      </PageHeader>
      <div className="mb-4 flex gap-2">
        {(['due', 'all'] as const).map((m) => <Button key={m} variant={mode === m ? 'primary' : 'ghost'} pressed={mode === m} onClick={() => { setMode(m); setPos(0); setFlipped(false); setSession((s) => s + 1); }}>{m === 'due' ? 'Due today' : 'Cram all'}</Button>)}
      </div>
      {!card ? (
        <Card className="p-10 text-center">
          <div className="text-lg font-semibold">Nothing due. Nice.</div>
          <p className="mt-2 text-sm text-muted">Come back tomorrow, or cram all cards.</p>
        </Card>
      ) : (
        <>
          <div className="mb-2 text-right font-mono text-xs text-muted"><span className="sr-only">Card </span>{pos + 1} / {queue.length}</div>
          {/* The card is one toggle button; the lesson link sits outside it (no nested interactive elements). */}
          <button type="button" onClick={() => setFlipped(!flipped)} aria-expanded={flipped} aria-controls="flashcard-answer" className="block w-full rounded-2xl text-left">
            <Card className="flex min-h-[260px] flex-col items-center justify-center p-8 text-center transition hover:border-accent/50">
              {!flipped ? (
                <>
                  <div className="text-3xl font-bold">{card.term}</div>
                  {card.expansion && <div className="mt-2 text-muted">{card.expansion}</div>}
                  <div className="mt-6 flex items-center gap-1.5 text-xs text-muted"><RotateCw size={12} aria-hidden />Click or press Enter to reveal</div>
                </>
              ) : (
                <>
                  <div className="font-mono text-xs uppercase tracking-[0.14em] text-accent">{card.term}</div>
                  <p className="mt-3 text-[1.05rem] leading-relaxed">{card.definition}</p>
                </>
              )}
            </Card>
          </button>
          <div id="flashcard-answer" aria-live="polite" className="sr-only">{flipped ? `${card.term}: ${card.definition}` : ''}</div>
          {flipped && card.lesson && <div className="mt-3 text-center"><Link to={`/lesson/${card.lesson}`} className="text-sm text-data underline underline-offset-2">Open the lesson about {card.term} →</Link></div>}
          {flipped && (
            <div className="mt-4 grid grid-cols-4 gap-2" role="group" aria-label="How well did you know it?">
              {GRADES.map(({ g, label, cls }) => <button key={g} type="button" onClick={() => grade(g)} className={`rounded-lg border bg-panel py-2.5 text-sm font-medium hover:bg-panel-2 ${cls}`}>{label}</button>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
