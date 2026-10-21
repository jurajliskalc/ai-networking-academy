import { Check, X } from 'lucide-react';
import type { Question } from '../types';
import Markdown from './Markdown';

/** One question. `revealed` shows correctness and every option's explanation. */
export default function QuestionCard({ q, index, total, chosen, onChange, revealed }: {
  q: Question; index: number; total: number; chosen: string[]; onChange: (ids: string[]) => void; revealed: boolean;
}) {
  const multi = q.type === 'multi';
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
        {q.options.map((o) => {
          const sel = chosen.includes(o.id);
          const state = !revealed ? (sel ? 'border-accent bg-accent-soft' : 'border-line hover:border-muted')
            : o.correct ? 'border-accent bg-accent-soft' : sel ? 'border-danger bg-danger/10' : 'border-line opacity-80';
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)} aria-pressed={sel}
              className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition ${state}`}>
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center border font-mono text-[10px] ${multi ? 'rounded' : 'rounded-full'} ${sel ? 'border-accent bg-accent text-[#04120a]' : 'border-muted'}`}>
                {revealed ? (o.correct ? <Check size={12} /> : sel ? <X size={12} /> : o.id) : o.id}
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
