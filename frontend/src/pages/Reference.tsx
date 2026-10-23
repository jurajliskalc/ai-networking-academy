import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BadgeCheck, Search } from 'lucide-react';
import { useIndex } from '../content';
import { Card, Loading, PageHeader, Pill } from '../components/ui';
import StackToggle, { useStack } from '../components/StackToggle';
import { captureLabel, commandForStack, STACK_LABELS } from '../../scripts/stack-variants.mjs';
import type { CommandEntry } from '../types';

function CommandCard({ c }: { c: CommandEntry }) {
  const [stack] = useStack();
  const v = commandForStack(c, stack);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[0.92rem] font-semibold text-accent">{v.cmd}</code>{c.platform && <Pill>{c.platform}</Pill>}
        {c.stacks && <Pill className="ml-auto">{STACK_LABELS[stack]}</Pill>}
      </div>
      <p className="mt-1.5 text-sm">{c.summary}</p>
      {v.example && (
        <>
          {v.real && <div className="capture-label mt-3"><BadgeCheck size={12} aria-hidden />{captureLabel(v.real)}</div>}
          <pre tabIndex={0} aria-label={`Example output of ${v.cmd}`} className={`${v.real ? 'mt-0' : 'mt-3'} overflow-x-auto rounded-lg border border-line bg-[var(--code-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--code-text)]`}>{v.example.trimEnd()}</pre>
        </>
      )}
      {v.notes && <p className="mt-2 text-[13px] text-muted">{v.notes}</p>}
    </Card>
  );
}

export default function Reference() {
  const { data: ix, error } = useIndex();
  // ?tab=glossary&q=ECN deep links (used by site search) preselect the tab and the filter.
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'commands' | 'glossary'>(params.get('tab') === 'glossary' ? 'glossary' : 'commands');
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => {
    const t = params.get('tab');
    if (t === 'commands' || t === 'glossary') setTab(t);
    if (params.has('q')) setQ(params.get('q') ?? '');
  }, [params]);
  const [group, setGroup] = useState('all');
  const needle = q.trim().toLowerCase();

  const commands = useMemo(() => {
    if (!ix) return [];
    return ix.commands.filter((g) => group === 'all' || g.id === group).map((g) => ({
      ...g,
      commands: g.commands.filter((c) => !needle || [c.cmd, c.summary, c.notes ?? '', ...(c.tags ?? []), ...Object.values(c.stacks ?? {}).flatMap((v) => [v?.cmd ?? '', v?.notes ?? ''])].join(' ').toLowerCase().includes(needle)),
    })).filter((g) => g.commands.length);
  }, [ix, needle, group]);
  const terms = useMemo(() => (ix?.glossary ?? []).filter((t) => !needle || `${t.term} ${t.expansion ?? ''} ${t.definition}`.toLowerCase().includes(needle)), [ix, needle]);

  if (!ix) return <Loading error={error} />;
  return (
    <div>
      <PageHeader eyebrow="Reference" title="Commands and glossary">
        The tools of the trade, with what to look for in their output. Example output is illustrative unless it is labelled as a real
        capture; real output varies by version and platform. Where the distro (inbox) and NVIDIA DOCA-OFED driver stacks differ, an entry
        has a stack switch. Surprises seen on real adapters are collected under <Link to="/verified" className="text-data underline underline-offset-2">Verified on hardware</Link>.
      </PageHeader>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-xl border border-line bg-panel p-1" role="group" aria-label="Show">
          {(['commands', 'glossary'] as const).map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-4 py-2 text-sm capitalize ${tab === t ? 'bg-accent-soft font-medium text-accent' : 'text-muted'}`}>{t}</button>)}
        </div>
        <label className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 min-w-[220px] focus-within:border-accent">
          <Search size={16} className="text-muted" aria-hidden />
          <span className="sr-only">{tab === 'commands' ? 'Filter commands' : 'Filter glossary terms'}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'commands' ? 'Search commands, e.g. pause, gid, ber' : 'Search terms'} className="flex-1 bg-transparent text-sm outline-none" />
        </label>
        {tab === 'commands' && (
          <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Command category" className="rounded-xl border border-line bg-panel px-3 py-2 text-sm">
            <option value="all">All categories</option>
            {ix.commands.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        )}
        {tab === 'commands' && <StackToggle size="md" />}
      </div>
      {tab === 'commands' ? (
        <div className="space-y-10">
          {commands.map((g) => (
            <section key={g.id}>
              <h2 className="text-lg font-bold">{g.title}</h2>
              {g.description && <p className="mb-3 text-sm text-muted">{g.description}</p>}
              <div className="space-y-3">
                {g.commands.map((c, i) => <CommandCard key={i} c={c} />)}
              </div>
            </section>
          ))}
          {!commands.length && <p className="text-muted" role="status">No commands match.</p>}
        </div>
      ) : (
        <dl className="grid gap-3 md:grid-cols-2">
          {terms.map((t) => (
            <Card key={t.term} className="p-4">
              <dt className="font-semibold">{t.term}{t.expansion && <span className="ml-2 font-normal text-muted">{t.expansion}</span>}</dt>
              <dd className="mt-1 text-sm text-muted">{t.definition}{t.lesson && <> <Link to={`/lesson/${t.lesson}`} className="text-data underline underline-offset-2">Lesson<span className="sr-only"> about {t.term}</span> →</Link></>}</dd>
            </Card>
          ))}
        </dl>
      )}
    </div>
  );
}
