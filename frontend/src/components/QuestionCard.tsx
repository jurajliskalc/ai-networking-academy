import { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import type { Option, Question } from '../types';
import Markdown from './Markdown';

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

/** One question. `revealed` shows correctness and every option's explanation. `seed` varies the option order per attempt. */
export default function QuestionCard({ q, index, total, chosen, onChange, revealed, seed = '' }: {
  q: Question; index: number; total: number; chosen: string[]; onChange: (ids: string[]) => void; revealed: boolean; seed?: string;
}) {
  const multi = q.type === 'multi';
  const options = useMemo(() => shuffleOptions(q.options, `${seed}:${q.id}:${q.prompt.length}`), [q, seed]);
  const toggle = (id: string) => {
    if (revealed) return;
    if (multi) onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
    else onChange([id]);
  };
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 font-mono text-xs text-muted">
        <span>Question {index + 1} / {total}</span>
        <span className="rounded border border-line px-1.5 py-0.5 uppercase">{q.type === 'scenario' ? 'scenario' : multi ? 'select all that apply' : 'single answer'}</span>
        {q.domain && <span className="rounded border border-line px-1.5 py-0.5">{q.domain}</span>}
      </div>
      <div className="mb-5 text-[1.05rem] leading-relaxed [&_.prose]:max-w-none"><Markdown source={q.prompt} /></div>
      <div className="space-y-2.5" role={multi ? 'group' : 'radiogroup'}>
        {options.map((o, pos) => {
          const sel = chosen.includes(o.id);
          const state = !revealed ? (sel ? 'border-accent bg-accent-soft' : 'border-line hover:border-muted')
            : o.correct ? 'border-accent bg-accent-soft' : sel ? 'border-danger bg-danger/10' : 'border-line opacity-80';
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)} aria-pressed={sel}
              className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition ${state}`}>
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border font-mono text-[10px] ${multi ? 'rounded' : 'rounded-full'} ${sel ? 'border-accent bg-accent text-[#04120a]' : 'border-muted'}`}>
                {revealed && o.correct ? <Check size={12} /> : revealed && sel ? <X size={12} /> : String.fromCharCode(65 + pos)}
              </span>
              <span className="flex-1">
                <span className="block text-sm leading-relaxed">{o.text}</span>
                {revealed && <span className={`mt-1.5 block text-[13px] leading-relaxed ${o.correct ? 'text-accent' : 'text-muted'}`}>{o.explanation}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {revealed && q.explanation && <div className="callout callout-note mt-4 text-sm">{q.explanation}</div>}
    </div>
  );
}
