import { lazy, Suspense, useEffect, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';

const SearchDialog = lazy(() => import('./SearchDialog'));

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Header search button; "/" and Ctrl/Cmd+K open the search dialog from anywhere. */
export default function Search() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const prefetch = () => void import('./SearchDialog').then((m) => m.loadSearchIndex()).catch(() => {});

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} onPointerEnter={prefetch} onFocus={prefetch}
        aria-haspopup="dialog" aria-keyshortcuts={`/ ${isMac ? 'Meta+K' : 'Control+K'}`}
        className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-muted transition hover:border-accent/60 hover:text-fg sm:w-64">
        <SearchIcon size={16} aria-hidden className="shrink-0" />
        <span className="flex-1 text-left">Search<span className="max-sm:hidden">…</span></span>
        <kbd className="kbd max-sm:hidden" aria-hidden>{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      {open && <Suspense fallback={null}><SearchDialog onClose={() => setOpen(false)} /></Suspense>}
    </>
  );
}
