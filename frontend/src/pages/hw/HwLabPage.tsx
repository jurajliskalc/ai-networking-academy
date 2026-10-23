import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, CheckCircle2, Circle, CircleDashed, FileUp, Info, Pencil, Settings2, SkipForward, XCircle } from 'lucide-react';
import { slug, useIndex, useLabBody } from '../../content';
import { useProgress } from '../../store';
import { bump, recordHwCheck } from '../../progress';
import { fill, placeholders } from '../../hw/profile';
import { mergeChecks, mergeTasks, parseCheckJson, taskView, VERDICT_LABEL, verdictDetail, type TaskViewStatus } from '../../hw/checks';
import Markdown, { goToSection, useSectionParam } from '../../components/Markdown';
import { Button, Card, LevelBadge, Loading, Pill } from '../../components/ui';
import type { ContentIndex, HandsOnLab } from '../../types';
import NotFound from '../NotFound';
import { ProfileBar } from './HwGuide';
import { CodeBox, RequirementList, TierBadge, useProfile } from './shared';
import { LiveCard } from './LivePanel';

function VerifyCard({ lab, ix }: { lab: HandsOnLab; ix: ContentIndex }) {
  const { progress, update } = useProgress();
  const { hw, setHw, profile } = useProfile(ix);
  const rec = progress.labs[lab.id];
  const check = hw.checks[lab.id];
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const importFile = async (f: File) => {
    try {
      const r = parseCheckJson(JSON.parse(await f.text()));
      if (r.lab !== lab.id) throw new Error(`That result is for ${r.lab}, not this lab.`);
      setHw((s) => ({ ...s, checks: mergeChecks(s.checks, [r]), tasks: mergeTasks(s.tasks ?? {}, [r]) }));
      if (r.only_task !== null) {
        const ok = r.verdict === 'PASSED';
        const how = ok ? 'passes.' : r.verdict === 'FAILED' ? `not passed yet (${r.counts.FAIL} FAIL).` : `${VERDICT_LABEL[r.verdict].toLowerCase()}: ${verdictDetail(r)}`;
        setMsg({ ok, text: `Task ${r.only_task} ${how} A single-task run updates the task progress; run the whole check to verify the lab.` });
        return;
      }
      update((p) => recordHwCheck(p, lab.id, r));
      setMsg({ ok: r.passed, text: r.passed ? 'Check passed: lab verified on your hardware.'
        : r.verdict === 'FAILED' ? `Check not passed yet (${r.counts.FAIL} FAIL).` : `${VERDICT_LABEL[r.verdict]}: ${verdictDetail(r)} The lab is not verified yet.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const toggle = () => update((p) => bump({ ...p, labs: { ...p.labs, [lab.id]: { ...(p.labs[lab.id] ?? { diagnosisCorrect: true, hintsUsed: 0 }), solved: !rec?.solved, attempts: (p.labs[lab.id]?.attempts ?? 0) + 1, at: new Date().toISOString() } } }));
  const cmd = lab.tier > 0 ? `cd ${profile.AINA_DIR}/labs\n./hw-toolkit/aina-hw check ${lab.id}` : `cd labs/${lab.id}\nsudo ./check.sh`;
  return (
    <Card className="p-5">
      <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Verify on your gear</div>
      <CodeBox code={cmd} title={lab.tier > 0 ? 'on host A' : 'on the VM'} />
      {lab.tier === 0 && <p className="mt-2 text-xs text-muted">Or run it through the toolkit for an importable result: <code>sudo labs/hw-toolkit/aina-hw check {lab.id}</code></p>}
      {check && (
        <div className={`mt-4 rounded-lg border p-3 text-xs ${check.passed ? 'border-accent/40 bg-accent-soft' : check.verdict === 'FAILED' ? 'border-danger/40 bg-danger/10' : 'border-warn/40 bg-warn/10'}`}>
          <div className={`mb-1.5 flex items-center gap-1.5 font-medium ${check.passed ? 'text-accent' : check.verdict === 'FAILED' ? 'text-danger' : 'text-warn'}`}>
            {check.passed ? <CheckCircle2 size={14} aria-hidden /> : check.verdict === 'FAILED' ? <XCircle size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}{VERDICT_LABEL[check.verdict]} · {check.counts.PASS} pass, {check.counts.FAIL} fail, {check.counts.WARN} warn
          </div>
          {!check.passed && <p className="mb-1 text-fg">{verdictDetail(check)}</p>}
          <div className="text-muted">{check.host ?? 'pasted output'} · {check.finished.slice(0, 16).replace('T', ' ')}</div>
          <details className="mt-2"><summary className="cursor-pointer text-muted hover:text-fg">Show lines</summary>
            <ul className="mt-2 space-y-0.5 font-mono">{check.results.map((x, i) => <li key={i} className={x.status === 'FAIL' ? 'text-danger' : x.status === 'WARN' ? 'text-warn' : x.status === 'PASS' ? 'text-accent' : 'text-muted'}>{x.status} <span className="text-fg">{x.text}</span></li>)}</ul>
          </details>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => fileRef.current?.click()}><FileUp size={15} />Import result</Button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-label="Check result file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        <Button variant={rec?.solved ? 'ghost' : 'primary'} onClick={toggle}>{rec?.solved ? <><CheckCircle2 size={15} />Completed</> : 'Mark completed'}</Button>
      </div>
      <p role="status" className={`mt-2 text-xs empty:hidden ${msg?.ok ? 'text-accent' : 'text-danger'}`}>{msg?.text}</p>
      {rec?.evidence && <p className="mt-3 flex items-center gap-1.5 text-xs text-accent"><BadgeCheck size={14} />Verified {rec.evidence.finished.slice(0, 10)}{rec.evidence.host ? ` on ${rec.evidence.host}` : ''} ({rec.evidence.pass} checks{rec.evidence.source === 'pasted' ? ', pasted' : ''})</p>}
      <p className="mt-3 text-[11px] text-muted">Results also arrive through the <Link to="/hw/connect" className="text-data underline underline-offset-2">local agent or file import</Link>.</p>
    </Card>
  );
}

function ValuesCard({ names, ix }: { names: string[]; ix: ContentIndex }) {
  const { profile, vars } = useProfile(ix);
  if (!names.length) return null;
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Your values</div>
        <Link to="/hw/connect" className="flex items-center gap-1 text-xs text-data hover:underline"><Pencil size={12} />Edit</Link>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {names.map((n) => (
          <div key={n} className="contents" title={vars.find((v) => v.name === n)?.label}>
            <dt className="font-mono text-muted">{n}</dt><dd className="truncate font-mono">{profile[n]}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ------------------------------------------------------------------ per-task progress

/** Go to the lab's "Task N" heading ("Before you start" for 0). Heading ids are slugs of the rendered text. */
function goToTask(n: number) {
  const hs = Array.from(document.querySelectorAll<HTMLElement>('main h2, main h3'));
  const want = n === 0 ? /^Before you start/i : new RegExp(`^Task\\s+${n}\\b`);
  const h = hs.find((x) => want.test(x.textContent ?? ''));
  if (h) goToSection(h.id || slug(h.textContent ?? ''));
}

const TASK_STYLE: Record<TaskViewStatus, { icon: typeof Circle; cls: string; label: string }> = {
  PASS: { icon: CheckCircle2, cls: 'text-accent', label: 'done' },
  FAIL: { icon: XCircle, cls: 'text-danger', label: 'failed' },
  WARN: { icon: AlertTriangle, cls: 'text-warn', label: 'done with warnings' },
  SKIP: { icon: SkipForward, cls: 'text-muted', label: 'skipped' },
  NONE: { icon: Info, cls: 'text-data', label: 'checked, information only' },
  unchecked: { icon: CircleDashed, cls: 'text-muted', label: 'not checked by check.sh' },
  notrun: { icon: Circle, cls: 'text-muted', label: 'not run yet' },
  NOTRUN: { icon: Circle, cls: 'text-muted', label: 'not run yet' },
  unknown: { icon: Circle, cls: 'text-muted', label: 'no result yet' },
};

function useTaskView(lab: HandsOnLab, ix: ContentIndex) {
  const { hw } = useProfile(ix);
  return useMemo(() => taskView(lab.toc, hw.tasks?.[lab.id]), [lab.toc, hw.tasks, lab.id]);
}

const plain = (s: string) => s.replace(/`/g, '');

function ResumeBanner({ lab, ix }: { lab: HandsOnLab; ix: ContentIndex }) {
  const { profile } = useProfile(ix);
  const v = useTaskView(lab, ix);
  if (!v.any) return null;
  const done = v.items.filter((i) => i.status === 'PASS' || i.status === 'WARN' || i.status === 'NONE').map((i) => i.n);
  const failed = v.items.filter((i) => i.status === 'FAIL').map((i) => i.n);
  const resumeTitle = v.items.find((i) => i.n === v.resume)?.title;
  const list = (ns: number[]) => `Task${ns.length > 1 ? 's' : ''} ${ns.join(', ')}`;
  return (
    <div className={`callout mb-6 text-sm ${v.resume !== null ? 'callout-warning' : 'callout-tip'}`} data-testid="resume-banner">
      <div className="callout-title">Your last check</div>
      <p>
        {done.length > 0 && `${list(done)} done. `}
        {failed.length > 0 && `${list(failed)} failed. `}
        {v.pre?.status === 'FAIL' && 'The prerequisites (Before you start) failed, so the tasks did not run. '}
        {v.resume === null && 'Every task the check covers passes.'}
      </p>
      {v.resume !== null && (
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => goToTask(v.resume!)} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-panel-2">
            Resume at {v.resume === 0 ? 'Before you start' : `Task ${v.resume}`}{v.resume !== 0 && resumeTitle ? `: ${plain(fill(resumeTitle, profile))}` : ''}
          </button>
          {v.resume > 0 && <span className="text-xs text-muted">then recheck just that part: <code>./hw-toolkit/aina-hw check {lab.id} --task {v.resume}</code></span>}
        </p>
      )}
    </div>
  );
}

function TaskCard({ lab, ix, raw }: { lab: HandsOnLab; ix: ContentIndex; raw: boolean }) {
  const { profile } = useProfile(ix);
  const v = useTaskView(lab, ix);
  if (!v.items.length) return null;
  const pre = v.pre ? TASK_STYLE[v.pre.status] : null;
  return (
    <Card className="p-5">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Task progress</div>
      {!v.any && <p className="mb-2 text-xs text-muted">Run the check (or one task with <code>--task N</code>) and import the result to see which tasks are done.</p>}
      <ol className="space-y-1.5 text-[13px]" aria-label="Task progress">
        {pre && (
          <li className="flex items-start gap-2">
            <pre.icon size={14} aria-hidden className={`mt-0.5 shrink-0 ${pre.cls}`} />
            <button type="button" className="text-left hover:text-accent" onClick={() => goToTask(0)}>Before you start<span className="sr-only">: {pre.label}</span></button>
          </li>
        )}
        {v.items.map((i) => {
          const s = TASK_STYLE[i.status];
          const Icon = s.icon;
          const fails = i.entry?.lines.filter((l) => l.status === 'FAIL') ?? [];
          return (
            <li key={i.n} className="flex items-start gap-2" title={i.entry ? `${s.label} · ${i.entry.finished.slice(0, 16).replace('T', ' ')}${i.entry.partial ? ' (single-task run)' : ''}` : s.label}>
              <Icon size={14} aria-hidden className={`mt-0.5 shrink-0 ${s.cls}`} />
              <div className="min-w-0">
                <button type="button" className="text-left hover:text-accent" onClick={() => goToTask(i.n)}>
                  <span className="font-mono text-[11px] text-muted">Task {i.n}</span> {plain(raw ? i.title : fill(i.title, profile))}<span className="sr-only">: {s.label}</span>
                </button>
                {fails.length > 0 && <div className="mt-0.5 text-[11px] text-danger">{fails[0].text}{fails.length > 1 ? ` (+${fails.length - 1} more)` : ''}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {v.resume !== null && <p className="mt-3 text-xs"><span className="text-muted">Resume at </span><button type="button" className="font-medium text-data hover:underline" onClick={() => goToTask(v.resume!)}>{v.resume === 0 ? 'Before you start' : `Task ${v.resume}`}</button></p>}
    </Card>
  );
}

export default function HwLabPage() {
  const { id = '' } = useParams();
  const { data: ix, error } = useIndex();
  const lab = useMemo(() => ix?.labs.find((l): l is HandsOnLab => l.id === id && l.kind === 'handson'), [ix, id]);
  if (!ix) return <Loading error={error} />;
  if (!lab) return <NotFound />;
  return <LabView key={lab.id} lab={lab} ix={ix} />;
}

function LabView({ lab, ix }: { lab: HandsOnLab; ix: ContentIndex }) {
  const { data, error } = useLabBody(lab.id);
  const { profile, hw } = useProfile(ix);
  const [raw, setRaw] = useState(false);
  const names = useMemo(() => (data ? placeholders(data.body) : []), [data]);
  const source = useMemo(() => (data ? (raw ? data.body : fill(data.body, profile)) : null), [data, raw, profile]);
  const tier = ix.hardware.tiers.find((t) => t.id === lab.tier);
  // Deep links (search, the Verified page) use ?s=<heading id>, as lessons do.
  useSectionParam(source !== null);
  return (
    <div>
      <div className="mb-3 text-sm text-muted"><Link to="/hw" className="hover:text-fg">Real hardware labs</Link> / <Link to={`/hw/labs?tier=${lab.tier}`} className="hover:text-fg">Tier {lab.tier}: {tier?.title}</Link></div>
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{lab.title}</h1>
      <p className="mt-2 max-w-3xl text-muted">{lab.summary}</p>
      <div className="mb-6 mt-3 flex flex-wrap gap-2">
        <TierBadge tier={lab.tier} title={tier?.title} />
        <LevelBadge level={lab.level} />
        <Pill>{lab.estimated_minutes} min</Pill>
        {lab.changes_config && <Pill className="text-warn"><Settings2 size={11} />changes settings · restore included</Pill>}
        {lab.lessons.map((l) => <Link key={l} to={`/lesson/${l}`}><Pill className="hover:text-fg">{ix.lessons.find((x) => x.id === l)?.title.split(':')[0] ?? l}</Pill></Link>)}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {!lab.verified && <div className="callout callout-warning mb-6 text-sm"><div className="callout-title">Status</div>This lab has been syntax-checked but not yet run end to end on reference {lab.tier > 0 ? 'hardware' : 'VM'}. Command output is illustrative. Please report anything that behaves differently on your gear.</div>}
          {lab.files && <p className="mb-6 text-sm text-muted">Lab files: <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono">{lab.files}</code> in the repository. Every lab ships a <code>check.sh</code> that prints PASS/FAIL lines.</p>}
          {names.length > 0 && <ProfileBar ix={ix} raw={raw} setRaw={setRaw} />}
          {lab.tier > 0 && <ResumeBanner lab={lab} ix={ix} />}
          {source !== null ? <Markdown source={source} /> : <Loading error={error} />}
        </div>
        <aside className="space-y-4 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto">
          <Card className="p-5">
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Requirements</div>
            <RequirementList lab={lab} ix={ix} profile={profile} report={hw.report} />
          </Card>
          <VerifyCard lab={lab} ix={ix} />
          {lab.tier > 0 && <TaskCard lab={lab} ix={ix} raw={raw} />}
          {lab.tier > 0 && <LiveCard />}
          <ValuesCard names={names} ix={ix} />
          <Card className="p-5">
            <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Steps</div>
            <ul className="space-y-1 text-[13px] text-muted">{lab.toc.filter((t) => t.depth <= 3).map((t, i) => <li key={i} className={t.depth === 3 ? 'pl-3' : ''}>{raw ? t.text : fill(t.text, profile)}</li>)}</ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
