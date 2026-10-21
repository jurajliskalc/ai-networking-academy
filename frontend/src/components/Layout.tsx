import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  BarChart3, BookMarked, Boxes, FlaskConical, GraduationCap, Github, Layers, LayoutDashboard, Menu, Moon, Network, Settings, Sun, Terminal, Timer, X,
} from 'lucide-react';
import { useProgress } from '../store';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/path', label: 'Learning path', icon: Layers },
  { to: '/labs', label: 'Labs', icon: FlaskConical },
  { to: '/simulator', label: 'Fabric simulator', icon: Terminal },
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
    <svg viewBox="0 0 64 64" className="h-8 w-8" aria-hidden>
      <rect width="64" height="64" rx="14" fill="var(--code-bg)" />
      <g stroke="var(--accent)" strokeWidth="3" fill="none"><path d="M14 46 32 18 50 46" /><path d="M14 46h36" /><path d="M23 32h18" className="flow-dash" /></g>
      <g fill="var(--data)"><circle cx="14" cy="46" r="5" /><circle cx="50" cy="46" r="5" /><circle cx="32" cy="18" r="5" /></g>
    </svg>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { progress, update } = useProgress();
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const dark = document.documentElement.classList.contains('dark');
  const toggleTheme = () => update((p) => ({ ...p, settings: { ...p.settings, theme: dark ? 'light' : 'dark' } }));
  void progress.settings.theme;

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'}`}>
          <Icon size={17} />{label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-full">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-bg-soft px-4 py-5 lg:flex">
        <NavLink to="/" className="mb-7 flex items-center gap-3 px-2">
          <Logo />
          <div className="leading-tight"><div className="font-bold tracking-tight">AI Networking</div><div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Academy</div></div>
        </NavLink>
        {nav}
        <div className="mt-auto space-y-2 px-2 pt-6 text-xs text-muted">
          <div className="flex items-center gap-2"><GraduationCap size={14} />Noob → Master · 13 modules</div>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-fg"><Github size={14} />Source on GitHub</a>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:ml-64 lg:px-8">
        <button className="rounded-lg p-1.5 hover:bg-panel-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
        <div className="font-mono text-xs text-muted max-lg:hidden">RDMA · InfiniBand · RoCEv2 · NCCL · rail-optimized fabrics</div>
        <button className="rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-fg" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-line bg-bg-soft p-4">
            <div className="mb-6 flex items-center justify-between"><div className="flex items-center gap-2"><Logo /><b>AI Networking Academy</b></div><button onClick={() => setOpen(false)} aria-label="Close menu"><X size={20} /></button></div>
            {nav}
          </div>
        </div>
      )}

      <main className="px-4 py-8 lg:ml-64 lg:px-10 lg:py-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
