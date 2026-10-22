import { useId, useMemo, useRef, type KeyboardEvent } from 'react';
import { Check, X } from 'lucide-react';
import type { Option, Question } from '../types';
import Markdown from './Markdown';
import { isCorrect } from '../progress';

/** Deterministic shuffle: authors list the right answer first, so display order must not follow source order. */
export function shuffleOptions(options: Option[], seed: string): Option[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const out = [...options];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One question. `revealed` shows correctness and every option's explanation. `seed` varies the option order per attempt.
 * Single-answer questions are an ARIA radio group (arrow keys move and select, one tab stop); multi-answer questions are
 * a group of checkboxes. Correctness is stated in text, not only by colour.
 */
export default function QuestionCard({ q, index, total, chosen, onChange, revealed, seed = '' }: {
  q: Question; index: number; total: number; chosen: string[]; onChange: (ids: string[]) => void; revealed: boolean; seed?: string;
}) {
  const multi = q.type === 'multi';
  const uid = useId();
  const options = useMemo(() => shuffleOptions(q.options, `${seed}:${q.id}:${q.prompt.length}`), [q, seed]);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const toggle = (id: string) => {
    if (revealed) return;
    if (multi) onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
    else onChange([id]);
  };
  // Roving tab stop for the radio group: the chosen option, else the first.
  const focusIdx = Math.max(0, options.findIndex((o) => chosen.includes(o.id)));
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, pos: number) => {
    if (multi) return;
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (pos + d + options.length) % options.length;
    refs.current[next]?.focus();
    if (!revealed) onChange([options[next].id]);
  };
  const right = isCorrect(q.options, chosen);
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 font-mono text-xs text-muted">
        <span>Question {index + 1} / {total}</span>
        <span className="rounded border border-line px-1.5 py-0.5 uppercase">{q.type === 'scenario' ? 'scenario' : multi ? 'select all that apply' : 'single answer'}</span>
        {q.domain && <span className="rounded border border-line px-1.5 py-0.5">{q.domain}</span>}
      </div>
      <div id={`${uid}-prompt`} className="mb-5 text-[1.05rem] leading-relaxed [&_.prose]:max-w-none"><Markdown source={q.prompt} /></div>
      <div className="space-y-2.5" role={multi ? 'group' : 'radiogroup'} aria-labelledby={`${uid}-prompt`} aria-describedby={multi ? `${uid}-hint` : undefined}>
        {multi && <span id={`${uid}-hint`} className="sr-only">Select all that apply.</span>}
        {options.map((o, pos) => {
          const sel = chosen.includes(o.id);
          const state = !revealed ? (sel ? 'border-accent bg-accent-soft' : 'border-line hover:border-muted')
            : o.correct ? 'border-accent bg-accent-soft' : sel ? 'border-danger bg-danger/10' : 'border-line';
          const verdict = !revealed ? '' : o.correct ? (sel ? 'Correct answer, you chose it.' : 'Correct answer.') : sel ? 'Incorrect, you chose it.' : '';
          return (
            <button key={o.id} ref={(el) => { refs.current[pos] = el; }} type="button" onClick={() => toggle(o.id)} onKeyDown={(e) => onKey(e, pos)}
              role={multi ? 'checkbox' : 'radio'} aria-checked={sel} aria-disabled={revealed || undefined}
              tabIndex={multi || pos === focusIdx ? 0 : -1}
              aria-labelledby={`${uid}-o${pos}`} aria-describedby={revealed ? `${uid}-e${pos}` : undefined}
              className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition ${state}`}>
              <span aria-hidden className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border font-mono text-[10px] ${multi ? 'rounded' : 'rounded-full'} ${sel ? 'border-accent bg-accent text-on-accent' : 'border-muted'}`}>
                {revealed && o.correct ? <Check size={12} /> : revealed && sel ? <X size={12} /> : String.fromCharCode(65 + pos)}
              </span>
              <span className="flex-1">
                <span id={`${uid}-o${pos}`} className="block text-sm leading-relaxed">{o.text}</span>
                {revealed && (
                  <span id={`${uid}-e${pos}`} className={`mt-1.5 block text-[13px] leading-relaxed ${o.correct ? 'text-accent' : 'text-muted'}`}>
                    {verdict && <span className="sr-only">{verdict} </span>}{o.explanation}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {/* Announced when the answer is checked; also visible so the verdict is not conveyed by colour alone. */}
      <div role="status" className="mt-3 min-h-[1.25rem] text-sm font-semibold">
        {revealed && chosen.length > 0 && (right
          ? <span className="inline-flex items-center gap-1.5 text-accent"><Check size={15} aria-hidden />Correct</span>
          : <span className="inline-flex items-center gap-1.5 text-danger"><X size={15} aria-hidden />Not quite: the correct answer{q.options.filter((o) => o.correct).length > 1 ? 's are' : ' is'} marked with a tick</span>)}
      </div>
      {revealed && q.explanation && <div className="callout callout-note mt-2 text-sm">{q.explanation}</div>}
    </div>
  );
}
