import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  BarChart3, BookMarked, Boxes, FlaskConical, GraduationCap, Github, Layers, LayoutDashboard, Menu, Network, Server, Settings, Terminal, Timer, X,
} from 'lucide-react';
import Search from './Search';
import AppearanceMenu from './AppearanceMenu';
import VisitorCount from './VisitorCount';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/path', label: 'Learning path', icon: Layers },
  { to: '/labs', label: 'Simulator labs', icon: FlaskConical },
  { to: '/simulator', label: 'Fabric simulator', icon: Terminal },
  { to: '/hw', label: 'Real HW labs', icon: Server },
  { to: '/visualize', label: 'Visualizations', icon: Network },
  { to: '/exams', label: 'Mock exams', icon: Timer },
  { to: '/flashcards', label: 'Flashcards', icon: Boxes },
  { to: '/reference', label: 'Reference', icon: BookMarked },
  { to: '/progress', label: 'Progress', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export const REPO_URL = 'https://github.com/jurajliskalc/ai-networking-academy';

function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="h-8 w-8 shrink-0" aria-hidden>
      <rect width="64" height="64" rx="14" fill="var(--code-bg)" />
      <g stroke="var(--accent)" strokeWidth="3" fill="none"><path d="M14 46 32 18 50 46" /><path d="M14 46h36" /><path d="M23 32h18" className="flow-dash" /></g>
      <g fill="var(--data)"><circle cx="14" cy="46" r="5" /><circle cx="50" cy="46" r="5" /><circle cx="32" cy="18" r="5" /></g>
    </svg>
  );
}

const SITE = 'AI Networking Academy';

/** Keeps document.title in step with the page's <h1>, which pages render (often after loading content). */
function useTitleFromHeading(main: RefObject<HTMLElement | null>, pathname: string) {
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const sync = () => {
      const h1 = el.querySelector('h1')?.textContent?.trim();
      const t = pathname === '/' || !h1 ? SITE : `${h1} · ${SITE}`;
      if (document.title !== t) document.title = t;
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [main, pathname]);
}

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  useTitleFromHeading(main, loc.pathname);
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
    // After client-side navigation, move focus to the new page so keyboard and screen reader users start
    // there, unless the page already put focus somewhere inside itself (a field, a deep-linked section).
    if (first.current) {
      first.current = false;
      return;
    }
    const a = document.activeElement;
    if (!main.current?.contains(a) || a === document.body) main.current?.focus({ preventScroll: true });
  }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const d = drawer.current;
    d?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key !== 'Tab' || !d) return;
      // Keep Tab inside the open drawer.
      const f = [...d.querySelectorAll<HTMLElement>('a[href], button')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    const btn = menuButton.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      if (document.activeElement === document.body || d?.contains(document.activeElement)) btn?.focus();
    };
  }, [open]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'}`}>
          <Icon size={17} aria-hidden />{label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-full">
      <a href="#main-content" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}
        className="sr-only z-[60] rounded-lg bg-accent text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:px-4 focus:py-2">
        Skip to content
      </a>
      <aside aria-label="Sidebar" className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-bg-soft px-4 py-5 lg:flex">
        <NavLink to="/" className="mb-7 flex items-center gap-3 rounded-lg px-2">
          <Logo />
          <div className="leading-tight"><div className="font-bold tracking-tight">AI Networking</div><div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Academy</div></div>
        </NavLink>
        {nav}
        <div className="mt-auto space-y-2 px-2 pt-6 text-xs text-muted">
          <div className="flex items-center gap-2"><GraduationCap size={14} aria-hidden />Beginner → Master · 13 modules</div>
          <VisitorCount />
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-fg"><Github size={14} aria-hidden />Source on GitHub<span className="sr-only"> (opens in a new tab)</span></a>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:ml-64 lg:px-8">
        <button ref={menuButton} className="rounded-lg p-1.5 hover:bg-panel-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} aria-controls="nav-drawer"><Menu size={20} aria-hidden /></button>
        <div className="font-mono text-xs text-muted max-xl:hidden">RDMA · InfiniBand · RoCEv2 · NCCL · rail-optimized fabrics</div>
        <div className="flex min-w-0 items-center gap-2">
          <Search />
          <AppearanceMenu />
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <div ref={drawer} id="nav-drawer" role="dialog" aria-modal="true" aria-label="Menu" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-bg-soft p-4">
            <div className="mb-6 flex items-center justify-between"><div className="flex items-center gap-2"><Logo /><b>{SITE}</b></div><button className="rounded-lg p-1 hover:bg-panel-2" onClick={() => setOpen(false)} aria-label="Close menu"><X size={20} aria-hidden /></button></div>
            {nav}
          </div>
        </div>
      )}

      <main id="main-content" ref={main} tabIndex={-1} className="px-4 py-8 outline-none lg:ml-64 lg:px-10 lg:py-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      <footer className="border-t border-line px-4 py-5 text-xs text-muted lg:ml-64 lg:px-10">
        <div className="mx-auto max-w-6xl">
          © 2026 Juraj Liska · {SITE}. Free for noncommercial use: code under PolyForm Noncommercial 1.0.0, content under
          CC BY-NC-SA 4.0. Commercial use needs a license from the author. <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className="underline hover:text-fg">License<span className="sr-only"> (opens in a new tab)</span></a>
        </div>
      </footer>
    </div>
  );
}
