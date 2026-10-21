import { Link, useParams } from 'react-router-dom';
import { useIndex } from '../content';
import { WIDGETS, WidgetFrame, widgetById } from '../widgets/registry';
import { Card, PageHeader, Pill } from '../components/ui';
import NotFound from './NotFound';

export default function Visualize() {
  const { id } = useParams();
  const { data: ix } = useIndex();
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
  return (
    <div>
      <PageHeader eyebrow="Interactive" title="Visualizations">
        Models you can poke at. Each one is also embedded in the lessons where it matters. They are teaching models, simplified on purpose; their assumptions are stated on each widget.
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {WIDGETS.map((w) => (
          <Link key={w.id} to={`/visualize/${w.id}`}>
            <Card className="h-full p-5 transition hover:-translate-y-0.5 hover:border-accent/60">
              <div className="font-mono text-[11px] text-accent">{w.id}</div>
              <div className="mt-1 font-semibold">{w.title}</div>
              <p className="mt-2 text-sm text-muted">{w.summary}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
