import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, Search as SearchIcon, X } from 'lucide-react';
import { fetchJson } from '../content';
import { group, highlight, prepare, search, tokenize, type PreparedIndex, type SearchIndexFile } from '../search';

let prepared: Promise<PreparedIndex> | null = null;
/** Fetches and tokenises search.json once per session. */
export function loadSearchIndex(): Promise<PreparedIndex> {
  prepared ??= fetchJson<SearchIndexFile>('search.json').then(prepare).catch((e) => {
    prepared = null;
    throw e;
  });
  return prepared;
}

function Hl({ text, terms }: { text: string; terms: string[] }) {
  return <>{highlight(text, terms).map((p, i) => (p.hit ? <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-fg">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

const EXAMPLES = ['pfc headroom', 'gid index', 'ib_write_bw', 'NCCL_IB_HCA', 'rail optimized', 'mtu'];

export default function SearchDialog({ onClose, initialQuery = '' }: { onClose: () => void; initialQuery?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [q, setQ] = useState(initialQuery);
  const [ix, setIx] = useState<PreparedIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const d = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    input.current?.focus();
    let alive = true;
    loadSearchIndex().then((x) => alive && setIx(x), (e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      opener?.focus?.();
    };
  }, []);

  const terms = useMemo(() => tokenize(q), [q]);
  const hits = useMemo(() => (ix && terms.length ? search(ix, q) : []), [ix, q, terms.length]);
  const groups = useMemo(() => group(hits), [hits]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (i: number) => {
    const h = flat[i];
    if (!h) return;
    navigate(h.href);
    onClose();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(active);
    } else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey && flat.length) {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : flat.length - 1);
    }
  };

  const status = !q.trim() ? '' : !ix ? 'Loading the search index' : flat.length ? `${flat.length} result${flat.length === 1 ? '' : 's'}` : 'No results';
  let n = -1;
  return (
    <dialog ref={dialog} onClose={onClose} aria-label="Search the academy"
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      className="mx-auto mb-auto mt-3 flex max-h-[min(42rem,calc(100dvh-1.5rem))] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/60 sm:mt-[10vh] [&:not([open])]:hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <SearchIcon size={18} className="shrink-0 text-muted" aria-hidden />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          type="search" role="combobox" aria-label="Search lessons, labs, commands and glossary" aria-expanded={flat.length > 0}
          aria-controls="search-results" aria-autocomplete="list" aria-activedescendant={flat.length ? `search-opt-${active}` : undefined}
          placeholder="Search lessons, labs, commands, terms…" autoComplete="off" spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden" />
        <button type="button" onClick={() => dialog.current?.close()} className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Close search"><X size={18} /></button>
      </div>
      <p role="status" className="sr-only">{status}</p>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {error && <p className="p-4 text-sm text-danger">Could not load the search index: {error}</p>}
        {!q.trim() && !error && (
          <div className="p-4 text-sm text-muted">
            <p>Search every lesson section, quiz, lab, hardware guide, command, glossary term and visualization.</p>
            <p className="mt-3">Try:{' '}{EXAMPLES.map((x, i) => <Fragment key={x}>{i > 0 && ' '}<button type="button" onClick={() => { setQ(x); input.current?.focus(); }} className="mr-1 mt-1 rounded-full border border-line px-2 py-0.5 font-mono text-xs text-fg hover:border-accent">{x}</button></Fragment>)}</p>
          </div>
        )}
        {q.trim() && ix && !flat.length && <p className="p-4 text-sm text-muted">No results for “{q.trim()}”. Try fewer or shorter words.</p>}
        {q.trim() && !ix && !error && <p className="p-4 text-sm text-muted">Loading the search index…</p>}
        <div id="search-results" role="listbox" aria-label="Search results" hidden={!flat.length}>
          {groups.map((g) => (
            <div key={g.type} role="group" aria-labelledby={`search-group-${g.type}`} className="mb-2">
              <div id={`search-group-${g.type}`} className="px-2 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{g.label}</div>
              {g.hits.map((h) => {
                const i = ++n;
                const sel = i === active;
                return (
                  <div key={h.href} id={`search-opt-${i}`} data-index={i} role="option" aria-selected={sel}
                    onClick={() => go(i)} onMouseMove={() => active !== i && setActive(i)}
                    className={`cursor-pointer rounded-lg px-3 py-2 ${sel ? 'bg-accent-soft ring-1 ring-accent/50' : 'hover:bg-panel-2'}`}>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className={`min-w-0 flex-1 truncate ${g.type === 'command' ? 'font-mono' : ''}`}><Hl text={h.doc.title} terms={terms} /></span>
                      {sel && <CornerDownLeft size={14} className="shrink-0 text-muted" aria-hidden />}
                    </div>
                    {h.doc.heading && <div className="truncate text-[13px] font-medium text-fg/85"><span aria-hidden className="text-muted">› </span><Hl text={h.doc.heading} terms={terms} /></div>}
                    {h.doc.snippet && <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted"><Hl text={h.doc.snippet} terms={terms} /></div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="hidden items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-muted sm:flex" aria-hidden>
        <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move</span>
        <span><kbd className="kbd">Enter</kbd> open</span>
        <span><kbd className="kbd">Esc</kbd> close</span>
      </div>
    </dialog>
  );
}
