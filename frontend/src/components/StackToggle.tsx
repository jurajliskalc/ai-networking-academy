import { useLayoutEffect, useRef } from 'react';
import { Cpu } from 'lucide-react';
import { STACK_HINTS, STACK_LABELS, STACKS, type Stack } from '../../scripts/stack-variants.mjs';
import { useProgress } from '../store';

/** The learner's driver-stack preference (progress.settings.stack) and a setter. */
export function useStack(): [Stack, (s: Stack) => void] {
  const { progress, update } = useProgress();
  return [progress.settings.stack, (s) => update((p) => ({ ...p, settings: { ...p.settings, stack: s } }))];
}

/**
 * Compact segmented control for the driver stack. It changes the global preference, so every variant block on
 * every page follows; the control keeps its position on screen while blocks above it change height.
 */
export default function StackToggle({ size = 'sm', className = '' }: { size?: 'sm' | 'md'; className?: string }) {
  const [stack, setStack] = useStack();
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (anchor.current === null || !ref.current) return;
    const dy = ref.current.getBoundingClientRect().top - anchor.current;
    anchor.current = null;
    if (Math.abs(dy) > 1) window.scrollBy(0, dy);
  }, [stack]);
  const pick = (s: Stack) => {
    if (s === stack) return;
    anchor.current = ref.current?.getBoundingClientRect().top ?? null;
    setStack(s);
  };
  const pad = size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2 py-0.5 text-[11px]';
  return (
    <div ref={ref} role="group" aria-label="Driver stack" className={`stack-toggle inline-flex items-center gap-1 ${className}`}>
      <span className={`flex items-center gap-1 font-mono uppercase tracking-[0.12em] text-muted ${size === 'md' ? 'text-xs' : 'text-[10px]'}`} aria-hidden><Cpu size={size === 'md' ? 13 : 11} />Stack</span>
      <span className="inline-flex rounded-lg border border-line bg-panel p-0.5">
        {STACKS.map((s) => (
          <button key={s} type="button" aria-pressed={stack === s} title={STACK_HINTS[s]} onClick={() => pick(s)}
            className={`rounded-md font-medium ${pad} ${stack === s ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}>
            {STACK_LABELS[s]}
          </button>
        ))}
      </span>
    </div>
  );
}
