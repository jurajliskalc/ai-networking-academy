import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BadgeCheck, CheckCircle2, FileUp, Pencil, Settings2, XCircle } from 'lucide-react';
import { useIndex, useLabBody } from '../../content';
import { useProgress } from '../../store';
import { bump, recordHwCheck } from '../../progress';
import { fill, placeholders } from '../../hw/profile';
import { mergeChecks, parseCheckJson } from '../../hw/checks';
import Markdown from '../../components/Markdown';
import { Button, Card, LevelBadge, Loading, Pill } from '../../components/ui';
import type { ContentIndex, HandsOnLab } from '../../types';
import NotFound from '../NotFound';
import { ProfileBar } from './HwGuide';
import { CodeBox, RequirementList, TierBadge, useProfile } from './shared';

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
      setHw((s) => ({ ...s, checks: mergeChecks(s.checks, [r]) }));
      update((p) => recordHwCheck(p, lab.id, r));
      setMsg({ ok: r.passed, text: r.passed ? 'Check passed: lab verified on your hardware.' : `Check not passed yet (${r.counts.FAIL} FAIL).` });
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
        <div className={`mt-4 rounded-lg border p-3 text-xs ${check.passed ? 'border-accent/40 bg-accent-soft' : 'border-danger/40 bg-danger/10'}`}>
          <div className={`mb-1.5 flex items-center gap-1.5 font-medium ${check.passed ? 'text-accent' : 'text-danger'}`}>
            {check.passed ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}{check.passed ? 'Passed' : 'Not passed'} · {check.counts.PASS} pass, {check.counts.FAIL} fail, {check.counts.WARN} warn
          </div>
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
          {source !== null ? <Markdown source={source} /> : <Loading error={error} />}
        </div>
        <aside className="space-y-4 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto">
          <Card className="p-5">
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Requirements</div>
            <RequirementList lab={lab} ix={ix} profile={profile} report={hw.report} />
          </Card>
          <VerifyCard lab={lab} ix={ix} />
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
