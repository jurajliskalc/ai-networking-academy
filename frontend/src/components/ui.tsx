import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LEVELS } from '../content';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-panel ${className}`}>{children}</div>;
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-8">
      {eyebrow && <div className="mb-2 font-mono text-xs uppercase tracking-[0.18em] text-accent">{eyebrow}</div>}
      <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
      {children && <div className="mt-3 max-w-3xl text-muted">{children}</div>}
    </header>
  );
}

const levelColors: Record<number, string> = {
  1: 'text-data border-data/40 bg-data/10',
  2: 'text-accent border-accent/40 bg-accent/10',
  3: 'text-warn border-warn/40 bg-warn/10',
  4: 'text-danger border-danger/40 bg-danger/10',
};

export function LevelBadge({ level }: { level: number }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] ${levelColors[level] ?? ''}`}>{LEVELS[level]?.label ?? `L${level}`}</span>;
}

export function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted ${className}`}>{children}</span>;
}

/** A progress bar; `label` is its accessible name (required: a bare progressbar is announced without context). */
export function Bar({ value, label, className = '' }: { value: number; label: string; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-panel-2 ${className}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${v}%` }} />
    </div>
  );
}

export function Button({ children, onClick, variant = 'primary', disabled, to, className = '', type = 'button', pressed, label }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; to?: string; className?: string; type?: 'button' | 'submit';
  /** For toggle and segmented-choice buttons: exposed as aria-pressed. */
  pressed?: boolean;
  /** Accessible name when the visible content is not enough. */
  label?: string;
}) {
  const cls = {
    primary: 'bg-accent text-on-accent hover:brightness-110 font-semibold',
    ghost: 'border border-line bg-panel hover:bg-panel-2',
    danger: 'border border-danger/40 text-danger hover:bg-danger/10',
  }[variant];
  const base = `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${cls} ${className}`;
  if (to) return <Link to={to} className={base} aria-label={label}>{children}</Link>;
  return <button type={type} className={base} onClick={onClick} disabled={disabled} aria-pressed={pressed} aria-label={label}>{children}</button>;
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">Could not load content: {error}. Did you run <code>npm run content</code>?</div>;
  return <div className="space-y-3" role="status" aria-label="Loading"><div className="h-8 w-2/3 animate-pulse rounded bg-panel-2" /><div className="h-4 w-full animate-pulse rounded bg-panel-2" /><div className="h-4 w-5/6 animate-pulse rounded bg-panel-2" /></div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-2 text-3xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </Card>
  );
}
