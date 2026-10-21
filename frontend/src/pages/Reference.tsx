import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useIndex } from '../content';
import { Card, Loading, PageHeader, Pill } from '../components/ui';

export default function Reference() {
  const { data: ix, error } = useIndex();
  const [tab, setTab] = useState<'commands' | 'glossary'>('commands');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all');
  const needle = q.trim().toLowerCase();

  const commands = useMemo(() => {
    if (!ix) return [];
    return ix.commands.filter((g) => group === 'all' || g.id === group).map((g) => ({
      ...g,
      commands: g.commands.filter((c) => !needle || [c.cmd, c.summary, c.notes ?? '', ...(c.tags ?? [])].join(' ').toLowerCase().includes(needle)),
    })).filter((g) => g.commands.length);
  }, [ix, needle, group]);
  const terms = useMemo(() => (ix?.glossary ?? []).filter((t) => !needle || `${t.term} ${t.expansion ?? ''} ${t.definition}`.toLowerCase().includes(needle)), [ix, needle]);

  if (!ix) return <Loading error={error} />;
  return (
    <div>
      <PageHeader eyebrow="Reference" title="Commands and glossary">
        The tools of the trade, with what to look for in their output. Example output is illustrative; real output varies by version and platform.
      </PageHeader>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-xl border border-line bg-panel p-1">
          {(['commands', 'glossary'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-4 py-2 text-sm capitalize ${tab === t ? 'bg-accent-soft font-medium text-accent' : 'text-muted'}`}>{t}</button>)}
        </div>
        <label className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 min-w-[220px]">
          <Search size={16} className="text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'commands' ? 'Search commands, e.g. pause, gid, ber' : 'Search terms'} className="flex-1 bg-transparent text-sm outline-none" />
        </label>
        {tab === 'commands' && (
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-xl border border-line bg-panel px-3 py-2 text-sm">
            <option value="all">All categories</option>
            {ix.commands.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        )}
      </div>
      {tab === 'commands' ? (
        <div className="space-y-10">
          {commands.map((g) => (
            <section key={g.id}>
              <h2 className="text-lg font-bold">{g.title}</h2>
              {g.description && <p className="mb-3 text-sm text-muted">{g.description}</p>}
              <div className="space-y-3">
                {g.commands.map((c, i) => (
                  <Card key={i} className="p-4">
                    <div className="flex flex-wrap items-center gap-2"><code className="font-mono text-[0.92rem] font-semibold text-accent">{c.cmd}</code>{c.platform && <Pill>{c.platform}</Pill>}</div>
                    <p className="mt-1.5 text-sm">{c.summary}</p>
                    {c.example && <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-[var(--code-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--code-text)]">{c.example.trimEnd()}</pre>}
                    {c.notes && <p className="mt-2 text-[13px] text-muted">{c.notes}</p>}
                  </Card>
                ))}
              </div>
            </section>
          ))}
          {!commands.length && <p className="text-muted">No commands match.</p>}
        </div>
      ) : (
        <dl className="grid gap-3 md:grid-cols-2">
          {terms.map((t) => (
            <Card key={t.term} className="p-4">
              <dt className="font-semibold">{t.term}{t.expansion && <span className="ml-2 font-normal text-muted">{t.expansion}</span>}</dt>
              <dd className="mt-1 text-sm text-muted">{t.definition}{t.lesson && <> <Link to={`/lesson/${t.lesson}`} className="text-data hover:underline">Lesson →</Link></>}</dd>
            </Card>
          ))}
        </dl>
      )}
    </div>
  );
}
