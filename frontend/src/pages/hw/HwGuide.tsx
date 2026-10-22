import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Braces, Cpu, FileCheck2, PlugZap, Server, ShieldCheck, Wrench } from 'lucide-react';
import { slug, useGuideBody, useIndex } from '../../content';
import { useProgress } from '../../store';
import { fill } from '../../hw/profile';
import { review } from '../../hw/report';
import Markdown, { goToSection, useSectionParam } from '../../components/Markdown';
import { Card, Loading } from '../../components/ui';
import type { ContentIndex, HandsOnLab } from '../../types';
import NotFound from '../NotFound';
import { HwShell, TierBadge, useProfile } from './shared';

/** A personalisation bar shown above any content with {{VAR}} placeholders. */
export function ProfileBar({ ix, raw, setRaw }: { ix: ContentIndex; raw: boolean; setRaw: (v: boolean) => void }) {
  const { profile, isDefault } = useProfile(ix);
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2 text-muted">
        <Braces size={15} className="text-accent" />
        {raw ? <span>Showing placeholders such as <code>{'{{A_RDMA_DEV}}'}</code></span>
          : isDefault ? <span>Commands use <b>example values</b>. <Link to="/hw/connect" className="text-data underline underline-offset-2">Set up your lab profile</Link> to personalise them.</span>
            : <span>Commands personalised for <b className="text-fg">{profile.LAB_NAME}</b> ({profile.HOST_A}, {profile.HOST_B}{profile.HOST_COUNT === '3' ? `, ${profile.HOST_C}` : ''}) · <Link to="/hw/connect" className="text-data underline underline-offset-2">edit<span className="sr-only"> lab profile</span></Link></span>}
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} className="accent-[var(--accent)]" />Show placeholders
      </label>
    </div>
  );
}

const STEPS = [
  { icon: Server, t: 'Pick your tier', d: 'What gear you have decides which labs you can run.', to: '/hw/requirements' },
  { icon: Wrench, t: 'Prepare hosts and network', d: 'Drivers, tools, IPs, MTU, SSH, and the switch baseline.', to: '/hw/host-setup' },
  { icon: PlugZap, t: 'Build your profile and connect', d: 'Generate lab.env, inventory every host, review fabric health.', to: '/hw/connect' },
  { icon: FileCheck2, t: 'Run labs, verify with check scripts', d: 'aina-hw check records evidence the academy imports.', to: '/hw/labs' },
];

function OverviewPanel({ ix }: { ix: ContentIndex }) {
  const { profile, isDefault, hw } = useProfile(ix);
  const { progress } = useProgress();
  const labs = ix.labs.filter((l): l is HandsOnLab => l.kind === 'handson');
  const findings = useMemo(() => (hw.report ? review(hw.report, profile) : []), [hw.report, profile]);
  const verified = labs.filter((l) => progress.labs[l.id]?.evidence).length;
  const done = labs.filter((l) => progress.labs[l.id]?.solved).length;
  return (
    <div className="mb-12 space-y-6">
      <p className="max-w-3xl text-muted">
        Simulator labs teach the reasoning; this track puts it on <b className="text-fg">your own servers, NICs, cables and switches</b>. Every lab is
        personalised with your lab profile, ships a check script that grades the real state of your gear, and saves evidence the academy imports.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {ix.hardware.tiers.map((t) => {
          const tl = labs.filter((l) => l.tier === t.id);
          const td = tl.filter((l) => progress.labs[l.id]?.solved).length;
          return (
            <Link key={t.id} to={`/hw/labs?tier=${t.id}`}>
              <Card className="flex h-full flex-col p-4 transition hover:-translate-y-0.5 hover:border-accent/60">
                <div className="flex items-center justify-between"><TierBadge tier={t.id} /><span className="font-mono text-[11px] text-muted">{td}/{tl.length} labs</span></div>
                <div className="mt-2.5 font-semibold">{t.title}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted">{t.summary}</p>
                <p className="mt-auto pt-3 text-[11px] leading-relaxed text-muted"><Cpu size={11} className="mr-1 inline" />{t.gear}</p>
              </Card>
            </Link>
          );
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card className="p-5">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Your lab</div>
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Profile</dt><dd>{isDefault ? <Link to="/hw/connect" className="text-data hover:underline">not set up yet</Link> : <span><b>{profile.LAB_NAME}</b> · {profile.FABRIC === 'ib' ? 'InfiniBand' : 'RoCEv2'} · {profile.HOST_COUNT} hosts</span>}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Inventory</dt><dd>{hw.report ? <span>{hw.report.hosts.length} host(s), {hw.report.generated.slice(0, 10)}</span> : <Link to="/hw/connect" className="text-data hover:underline">no report imported</Link>}</dd></div>
            {hw.report && <div className="flex justify-between gap-3"><dt className="text-muted">Health review</dt><dd><span className="text-danger">{findings.filter((f) => f.severity === 'error').length} errors</span> · <span className="text-warn">{findings.filter((f) => f.severity === 'warn').length} warnings</span></dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-muted">Labs</dt><dd>{done}/{labs.length} completed · <span className="text-accent">{verified} verified by check</span></dd></div>
          </dl>
        </Card>
        <Card className="p-5">
          <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-accent">How it works</div>
          <ol className="grid gap-3 sm:grid-cols-2">
            {STEPS.map(({ icon: Icon, t, d, to }, i) => (
              <li key={t}>
                <Link to={to} className="group flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Icon size={16} /></span>
                  <span className="text-sm"><span className="font-medium group-hover:text-accent">{i + 1}. {t}</span><span className="block text-xs text-muted">{d}</span></span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <ShieldCheck size={14} className="text-accent" />Read-only by default. Labs that change settings say so up front, save the original state, and ship a restore script.
        <Link to="/hw/safety" className="inline-flex items-center gap-1 text-data hover:underline">Safety and lab discipline<ArrowRight size={12} /></Link>
      </div>
    </div>
  );
}

export default function HwGuide() {
  const { section = 'overview' } = useParams();
  const { data: ix, error } = useIndex();
  const { data: body, error: bodyError } = useGuideBody(section);
  const [raw, setRaw] = useState(false);
  if (!ix) return <Loading error={error} />;
  const guide = ix.hardware.guides.find((g) => g.id === section);
  if (!guide) return <NotFound />;
  return (
    <HwShell ix={ix}>
      {section === 'overview' && <OverviewPanel ix={ix} />}
      <GuideBody ix={ix} body={body?.body ?? null} error={bodyError} raw={raw} setRaw={setRaw} title={section === 'overview' ? null : guide.title} summary={guide.summary} toc={guide.toc} />
    </HwShell>
  );
}

function GuideBody({ ix, body, error, raw, setRaw, title, summary, toc }: {
  ix: ContentIndex; body: string | null; error: string | null; raw: boolean; setRaw: (v: boolean) => void; title: string | null; summary: string; toc: { depth: number; text: string }[];
}) {
  const { profile } = useProfile(ix);
  const source = useMemo(() => (body === null ? null : raw ? body : fill(body, profile)), [body, raw, profile]);
  const personal = !!body && /\{\{[A-Z]/.test(body);
  useSectionParam(source !== null);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10 xl:grid-cols-[minmax(0,1fr)_220px]">
      <div>
        {title && <><h2 className="text-2xl font-bold tracking-tight md:text-3xl">{title}</h2><p className="mb-6 mt-2 max-w-3xl text-muted">{summary}</p></>}
        {personal && <ProfileBar ix={ix} raw={raw} setRaw={setRaw} />}
        {source !== null ? <Markdown source={source} /> : <Loading error={error} />}
      </div>
      <aside className="hidden xl:block" aria-labelledby="hw-toc-label">
        <div className="sticky top-20">
          <div id="hw-toc-label" className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">On this page</div>
          <ul className="space-y-1 text-[13px]">
            {toc.filter((t) => t.depth === 2).map((t) => raw ? t.text : fill(t.text, profile)).map((text) => (
              <li key={text}><a href={`#${slug(text)}`} onClick={(e) => { e.preventDefault(); goToSection(slug(text)); }} className="text-muted hover:text-fg">{text}</a></li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
