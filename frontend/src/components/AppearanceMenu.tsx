import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Palette } from 'lucide-react';
import { useProgress } from '../store';
import { SCHEMES, type Scheme, type Theme } from '../progress';

export const SCHEME_NAMES: Record<Scheme, string> = {
  noc: 'NOC', ocean: 'Ocean', violet: 'Violet', sepia: 'Sepia', contrast: 'High contrast',
};
const MODES: { id: Theme; label: string }[] = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' }];

/** Four colour chips drawn with the scheme's own tokens (index.css matches data-scheme on any element). */
function Swatch({ scheme }: { scheme: Scheme }) {
  return (
    <span data-scheme={scheme} aria-hidden className="flex shrink-0 items-center gap-0.5 rounded-md border border-line bg-bg p-1">
      {['bg-panel', 'bg-accent', 'bg-data', 'bg-warn'].map((c) => <span key={c} className={`h-3 w-2.5 rounded-sm border border-line/50 ${c}`} />)}
    </span>
  );
}

/** Header dropdown for the colour mode (light, dark, system) and the colour scheme. */
export default function AppearanceMenu() {
  const { progress, update } = useProgress();
  const { theme, scheme } = progress.settings;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
  const close = (focusButton = true) => { setOpen(false); if (focusButton) button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    // Focus the checked scheme (or the first item) when the menu opens.
    (items().find((el) => el.getAttribute('aria-checked') === 'true' && el.dataset.kind === 'scheme') ?? items()[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); close(e.key === 'Escape'); }
  };

  const setTheme = (t: Theme) => update((p) => ({ ...p, settings: { ...p.settings, theme: t } }));
  const setScheme = (s: Scheme) => update((p) => ({ ...p, settings: { ...p.settings, scheme: s } }));
  const item = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <div className="relative">
      <button ref={button} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-controls="appearance-menu"
        aria-label={`Appearance: ${SCHEME_NAMES[scheme]}, ${dark ? 'dark' : 'light'}`}
        className="flex items-center gap-1 rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-fg">
        <Palette size={17} aria-hidden /><ChevronDown size={14} aria-hidden className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div ref={menu} id="appearance-menu" role="menu" aria-label="Appearance" onKeyDown={onKey}
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-line bg-panel p-2 shadow-xl">
          <div role="group" aria-labelledby="appearance-mode" className="mb-2">
            <div id="appearance-mode" className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Mode</div>
            <div className="grid grid-cols-3 gap-1">
              {MODES.map((m) => (
                <button key={m.id} type="button" role="menuitemradio" aria-checked={theme === m.id} data-kind="mode" tabIndex={-1} onClick={() => setTheme(m.id)}
                  className={`rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${theme === m.id ? 'bg-accent font-semibold text-on-accent' : 'border border-line hover:bg-panel-2'}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div role="group" aria-labelledby="appearance-scheme" className="border-t border-line pt-2">
            <div id="appearance-scheme" className="px-2 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Colour scheme</div>
            {SCHEMES.map((s) => (
              <button key={s} type="button" role="menuitemradio" aria-checked={scheme === s} data-kind="scheme" tabIndex={-1} onClick={() => setScheme(s)} className={item}>
                <Swatch scheme={s} />
                <span className="flex-1">{SCHEME_NAMES[s]}</span>
                {scheme === s && <Check size={15} aria-hidden className="text-accent" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
