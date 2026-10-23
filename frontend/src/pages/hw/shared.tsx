import { useMemo, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { AlertTriangle, Check, CircleHelp, Copy, Download, Info, OctagonAlert, UserCheck, XCircle } from 'lucide-react';
import type { ContentIndex, HandsOnLab } from '../../types';
import { defaults, sanitizeProfile, type Profile } from '../../hw/profile';
import { readiness, type Finding, type Readiness, type Report } from '../../hw/report';
import { useHw } from '../../hw/store';

/** The learner's profile, sanitised against the published variable list. */
export function useProfile(ix: ContentIndex) {
  const [hw, setHw] = useHw();
  const vars = ix.hardware.variables;
  const profile = useMemo(() => sanitizeProfile(hw.profile, vars), [hw.profile, vars]);
  const isDefault = useMemo(() => JSON.stringify(profile) === JSON.stringify(defaults(vars)), [profile, vars]);
  const setProfile = (p: Profile) => setHw((s) => ({ ...s, profile: p }));
  return { profile, vars, setProfile, isDefault, hw, setHw };
}

const SECTIONS_AFTER_SETUP = [{ id: 'connect', title: 'Connect' }, { id: 'live', title: 'Live' }, { id: 'labs', title: 'Labs' }];
const SHORT: Record<string, string> = { requirements: 'Requirements', 'host-setup': 'Host setup', 'network-setup': 'Network setup', toolkit: 'Toolkit', safety: 'Safety', troubleshooting: 'Troubleshooting' };

/** Sub-navigation shared by every /hw page. Guides come from content; Connect and Labs are app pages. */
export function HwShell({ ix, children }: { ix: ContentIndex; children: ReactNode }) {
  const guides = ix.hardware.guides;
  const tabs: { to: string; title: string; end?: boolean }[] = [];
  for (const g of guides) {
    if (g.order > 4 && !tabs.some((t) => t.to === '/hw/connect')) for (const s of SECTIONS_AFTER_SETUP) tabs.push({ to: `/hw/${s.id}`, title: s.title });
    tabs.push(g.id === 'overview' ? { to: '/hw', title: 'Overview', end: true } : { to: `/hw/${g.id}`, title: SHORT[g.id] ?? g.title });
  }
  if (!tabs.some((t) => t.to === '/hw/connect')) for (const s of SECTIONS_AFTER_SETUP) tabs.push({ to: `/hw/${s.id}`, title: s.title });
  if (!tabs.some((t) => t.to === '/hw')) tabs.unshift({ to: '/hw', title: 'Overview', end: true });
  return (
    <div>
      <div className="mb-1 font-mono text-xs uppercase tracking-[0.18em] text-accent">Bring your own gear</div>
      <h1 className="mb-5 text-2xl font-bold tracking-tight md:text-3xl">Real hardware labs</h1>
      <nav className="-mx-4 mb-8 overflow-x-auto border-b border-line px-4 lg:mx-0 lg:px-0" aria-label="Real hardware sections">
        <div className="flex min-w-max gap-1">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end ?? false}
              className={({ isActive }) => `-mb-px border-b-2 px-3 py-2 text-sm transition ${isActive ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-fg'}`}>
              {t.title}
            </NavLink>
          ))}
        </div>
      </nav>
      {children}
    </div>
  );
}

export function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CodeBox({ code, file, title, className = '' }: { code: string; file?: string; title?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <div className={`overflow-hidden rounded-xl border border-line ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-3 py-1.5">
        <div className="truncate font-mono text-[11px] text-muted">{title ?? file}</div>
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={copy} className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted hover:bg-panel hover:text-fg" aria-label={copied ? 'Copied' : `Copy ${file?.split('/').pop() ?? 'code'}`}>{copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}{copied ? 'Copied' : 'Copy'}</button>
          {file && <button type="button" onClick={() => download(file.split('/').pop()!, code)} className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted hover:bg-panel hover:text-fg" aria-label={`Download ${file.split('/').pop()}`}><Download size={12} aria-hidden />Download</button>}
        </div>
      </div>
      <pre tabIndex={0} aria-label={typeof title === 'string' ? title : file ?? 'Code'} className="m-0 max-h-[28rem] overflow-auto bg-[var(--code-bg)] p-4 font-mono text-[12.5px] leading-relaxed text-[var(--code-text)]">{code}</pre>
    </div>
  );
}

const TIER_STYLE: Record<number, string> = {
  0: 'border-line bg-panel-2 text-muted',
  1: 'border-data/40 bg-data/10 text-data',
  2: 'border-warn/40 bg-warn/10 text-warn',
  3: 'border-accent/40 bg-accent/10 text-accent',
};
export function TierBadge({ tier, title }: { tier: number; title?: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] ${TIER_STYLE[tier] ?? ''}`}>T{tier}{title ? ` · ${title}` : ''}</span>;
}

export const SEVERITY = {
  error: { icon: OctagonAlert, cls: 'text-danger', ring: 'border-danger/40 bg-danger/10', label: 'Error' },
  warn: { icon: AlertTriangle, cls: 'text-warn', ring: 'border-warn/40 bg-warn/10', label: 'Warning' },
  info: { icon: Info, cls: 'text-data', ring: 'border-data/40 bg-data/10', label: 'Info' },
} as const;

export function FindingRow({ f }: { f: Finding }) {
  const s = SEVERITY[f.severity];
  const Icon = s.icon;
  return (
    <li className="flex gap-3 border-b border-line py-3 last:border-0">
      <Icon size={17} aria-hidden className={`mt-0.5 shrink-0 ${s.cls}`} />
      <div className="min-w-0 text-sm">
        <div className="font-medium"><span className="sr-only">{s.label}: </span>{f.title}{f.where && <span className="ml-2 font-mono text-[11px] text-muted">{f.where}</span>}</div>
        <div className="mt-0.5 text-muted">{f.detail}</div>
        {f.fix && <div className="mt-1"><span className="font-mono text-[11px] uppercase tracking-wider text-accent">Fix</span> {f.fix}</div>}
        {(f.lesson || f.lab) && (
          <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
            {f.lesson && <a className="text-data hover:underline" href={`#/lesson/${f.lesson}`}>Lesson: {f.lesson}</a>}
            {f.lab && <a className="text-data hover:underline" href={`#/hw/labs/${f.lab}`}>Lab: {f.lab}</a>}
          </div>
        )}
      </div>
    </li>
  );
}

const READY: Record<Readiness, { icon: typeof Check; cls: string; tip: string }> = {
  ready: { icon: Check, cls: 'text-accent', tip: 'detected in your inventory report' },
  missing: { icon: XCircle, cls: 'text-danger', tip: 'not available in your lab' },
  unknown: { icon: CircleHelp, cls: 'text-muted', tip: 'import an inventory report to check' },
  self: { icon: UserCheck, cls: 'text-muted', tip: 'cannot be detected: confirm it yourself' },
};

export function RequirementList({ lab, ix, profile, report, compact = false }: { lab: HandsOnLab; ix: ContentIndex; profile: Profile; report: Report | null; compact?: boolean }) {
  const r = readiness(lab, profile, report);
  const title = (id: string) => (id === 'fabric' ? `${lab.fabric === 'ib' ? 'InfiniBand' : 'RoCE'} fabric` : ix.hardware.requirements.find((x) => x.id === id)?.title ?? id);
  return (
    <ul className={compact ? 'flex flex-wrap gap-x-3 gap-y-1' : 'space-y-1.5'}>
      {r.items.map((it) => {
        const s = READY[it.state];
        const Icon = s.icon;
        return (
          <li key={it.id} className="flex items-center gap-1.5 text-xs" title={s.tip}>
            <Icon size={13} aria-hidden className={`shrink-0 ${s.cls}`} /><span className="sr-only">{it.state === 'ready' ? 'Available' : it.state === 'missing' ? 'Missing' : it.state === 'unknown' ? 'Unknown' : 'Confirm yourself'}: </span>
            <span className={it.state === 'missing' ? 'text-danger' : 'text-muted'}>{title(it.id)}{it.note && !compact ? ` (${it.note})` : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}
