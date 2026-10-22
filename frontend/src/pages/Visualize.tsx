import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useIndex } from '../content';
import { TOPICS, WIDGETS, WidgetFrame, widgetById, type WidgetInfo } from '../widgets/registry';
import { Card, PageHeader, Pill } from '../components/ui';
import NotFound from './NotFound';

export default function Visualize() {
  const { id } = useParams();
  const { data: ix } = useIndex();
  const [query, setQuery] = useState('');
  if (id) {
    const w = widgetById(id);
    if (!w) return <NotFound />;
    const lessons = ix?.lessons.filter((l) => l.widgets.includes(id)) ?? [];
    return (
      <div>
        <div className="mb-3 text-sm text-muted"><Link to="/visualize" className="hover:text-fg">Visualizations</Link> / {w.title}</div>
        <PageHeader title={w.title}>{w.summary}</PageHeader>
        <WidgetFrame id={id} standalone />
        {lessons.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-2 text-sm text-muted">Used in:
            {lessons.map((l) => <Link key={l.id} to={`/lesson/${l.id}`}><Pill className="hover:text-fg">{l.title.split(':')[0]}</Pill></Link>)}
          </div>
        )}
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const match = (w: WidgetInfo) => !q || `${w.id} ${w.title} ${w.summary}`.toLowerCase().includes(q);
  const groups = TOPICS.map((t) => ({ ...t, widgets: t.ids.map((i) => widgetById(i)!).filter(match) })).filter((g) => g.widgets.length);
  const shown = groups.reduce((n, g) => n + g.widgets.length, 0);
  const usedIn = (id: string) => ix?.lessons.filter((l) => l.widgets.includes(id)).length ?? 0;
  return (
    <div>
      <PageHeader eyebrow="Interactive" title="Visualizations">
        {WIDGETS.length} models you can poke at, grouped by topic. Each one is also embedded in the lessons where it matters. They are teaching models, simplified on purpose; their assumptions are stated on each widget.
      </PageHeader>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <label htmlFor="viz-filter" className="sr-only">Filter visualizations</label>
        <input id="viz-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter, e.g. PFC, NCCL, InfiniBand"
          className="w-full max-w-sm rounded-lg border border-line bg-panel px-3 py-2 text-sm" />
        <span className="text-sm text-muted" aria-live="polite">{q ? `${shown} of ${WIDGETS.length} shown` : ''}</span>
      </div>
      {groups.length === 0 && <p className="text-sm text-muted">No visualization matches “{query}”.</p>}
      <div className="space-y-10">
        {groups.map((g) => (
          <section key={g.name} aria-labelledby={`topic-${slug(g.name)}`}>
            <h2 id={`topic-${slug(g.name)}`} className="mb-3 flex items-baseline gap-2 text-lg font-semibold">
              {g.name}<span className="font-mono text-xs font-normal text-muted">{g.widgets.length}</span>
            </h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {g.widgets.map((w) => {
                const n = usedIn(w.id);
                return (
                  <Link key={w.id} to={`/visualize/${w.id}`}>
                    <Card className="flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-accent/60">
                      <div className="font-mono text-[11px] text-accent">{w.id}</div>
                      <div className="mt-1 font-semibold">{w.title}</div>
                      <p className="mt-2 flex-1 text-sm text-muted">{w.summary}</p>
                      {n > 0 && <div className="mt-3 text-xs text-muted">Used in {n} lesson{n === 1 ? '' : 's'}</div>}
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
