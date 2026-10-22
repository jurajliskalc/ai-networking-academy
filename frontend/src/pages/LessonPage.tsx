import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, Check, Clock, ExternalLink, FlaskConical, HelpCircle, Target } from 'lucide-react';
import { labPath, slug, useIndex, useLessonBody } from '../content';
import { useProgress } from '../store';
import { bump } from '../progress';
import Markdown, { goToSection, useSectionParam } from '../components/Markdown';
import { Button, Card, LevelBadge, Loading, Pill } from '../components/ui';
import NotFound from './NotFound';

function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const obs = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: '-80px 0px -70% 0px' });
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [ids]);
  return active;
}

export default function LessonPage() {
  const { id = '' } = useParams();
  const { data: ix, error } = useIndex();
  const { data: body, error: bodyError } = useLessonBody(id);
  const { progress, update } = useProgress();
  const [readPct, setReadPct] = useState(0);
  const meta = ix?.lessons.find((l) => l.id === id);
  const tocIds = (meta?.toc ?? []).map((t) => slug(t.text));
  const active = useActiveHeading(body ? tocIds : []);
  useSectionParam(!!body);

  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      setReadPct(Math.min(100, (100 * h.scrollTop) / Math.max(1, h.scrollHeight - h.clientHeight)));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!ix) return <Loading error={error} />;
  if (!meta) return <NotFound />;
  const mod = ix.modules.find((m) => m.id === meta.module)!;
  const order = ix.modules.flatMap((m) => m.lessons).filter((l) => ix.lessons.some((x) => x.id === l));
  const pos = order.indexOf(id);
  const prev = ix.lessons.find((l) => l.id === order[pos - 1]);
  const next = ix.lessons.find((l) => l.id === order[pos + 1]);
  const done = !!progress.lessons[id];
  const quiz = progress.quizzes[meta.quiz];
  const markRead = () => update((p) => bump({ ...p, lessons: { ...p.lessons, [id]: new Date().toISOString() } }));
  const prereqs = meta.prerequisites.map((p) => ix.lessons.find((l) => l.id === p)).filter(Boolean);

  return (
    <div>
      <div className="fixed left-0 right-0 top-0 z-50 h-0.5 bg-transparent lg:left-64" aria-hidden><div className="h-full bg-accent transition-[width]" style={{ width: `${readPct}%` }} /></div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 xl:grid-cols-[minmax(0,1fr)_240px]">
        <article className="min-w-0">
          <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
            <Link to="/path" className="hover:text-fg">Path</Link> / <Link to={`/module/${mod.id}`} className="hover:text-fg">Module {mod.order}: {mod.title}</Link>
          </nav>
          <h1 className="text-3xl font-bold leading-tight tracking-tight md:text-[2.4rem]">{meta.title}</h1>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <LevelBadge level={meta.level} />
            <Pill><Clock size={11} />{meta.minutes} min</Pill>
            <Pill><BookOpen size={11} />{meta.words.toLocaleString('en')} words</Pill>
            {done && <Pill className="border-accent/50 text-accent"><Check size={11} />Read</Pill>}
            {quiz?.passed && <Pill className="border-accent/50 text-accent"><Check size={11} />Quiz passed</Pill>}
          </div>

          <Card className="mt-6 p-5">
            <h2 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-accent"><Target size={13} aria-hidden />You will be able to</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm">{meta.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
            {prereqs.length > 0 && (
              <div className="mt-4 text-sm text-muted">Builds on:{' '}
                {prereqs.map((p, i) => <span key={p!.id}>{i > 0 && ', '}<Link to={`/lesson/${p!.id}`} className="text-data underline underline-offset-2">{p!.title.split(':')[0]}</Link>{progress.lessons[p!.id] ? <><span aria-hidden> ✓</span><span className="sr-only"> (read)</span></> : ''}</span>)}
              </div>
            )}
          </Card>

          <div className="mt-8">{body ? <Markdown source={body.body} /> : <Loading error={bodyError} />}</div>

          {meta.further_reading.length > 0 && (
            <section className="mt-12">
              <h2 className="mb-3 text-lg font-bold">Further reading</h2>
              <ul className="space-y-2 text-sm">
                {meta.further_reading.map((r) => <li key={r.url}><a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-data hover:underline"><ExternalLink size={13} aria-hidden />{r.title}<span className="sr-only"> (opens in a new tab)</span></a></li>)}
              </ul>
            </section>
          )}

          <Card className="mt-12 p-6">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex-1">
                <h2 className="font-semibold">Done reading?</h2>
                <div className="text-sm text-muted">Mark it read, then lock it in with the quiz{meta.labs.length ? ' and the labs' : ''}.</div>
              </div>
              <Button variant={done ? 'ghost' : 'primary'} onClick={markRead}>{done ? <><Check size={16} />Read</> : 'Mark as read'}</Button>
              <Button variant="ghost" to={`/quiz/${meta.quiz}`}><HelpCircle size={16} />Take the quiz{quiz ? ` (best ${quiz.best}%)` : ''}</Button>
            </div>
            {meta.labs.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                {meta.labs.map((l) => { const lab = ix.labs.find((x) => x.id === l); return <Link key={l} to={labPath(l)}><Pill><FlaskConical size={11} />{lab?.title ?? l}</Pill></Link>; })}
              </div>
            )}
          </Card>

          <nav className="mt-8 grid gap-3 sm:grid-cols-2" aria-label="Previous and next lesson">
            {prev ? <Link to={`/lesson/${prev.id}`} className="rounded-xl border border-line p-4 hover:border-accent/50"><div className="flex items-center gap-1 text-xs text-muted"><ArrowLeft size={12} />Previous</div><div className="mt-1 text-sm font-medium">{prev.title}</div></Link> : <span />}
            {next && <Link to={`/lesson/${next.id}`} className="rounded-xl border border-line p-4 text-right hover:border-accent/50"><div className="flex items-center justify-end gap-1 text-xs text-muted">Next<ArrowRight size={12} /></div><div className="mt-1 text-sm font-medium">{next.title}</div></Link>}
          </nav>
        </article>

        <aside className="hidden xl:block" aria-labelledby="toc-label">
          <nav className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-auto" aria-labelledby="toc-label">
            <div id="toc-label" className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">On this page</div>
            <ul className="space-y-1 border-l border-line text-[13px]">
              {meta.toc.map((t, i) => {
                const sid = slug(t.text);
                return (
                  <li key={i}>
                    <a href={`#${sid}`} onClick={(e) => { e.preventDefault(); goToSection(sid); }} aria-current={active === sid ? 'location' : undefined}
                      className={`-ml-px block border-l py-0.5 ${t.depth === 3 ? 'pl-6' : 'pl-3'} ${active === sid ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg'}`}>
                      {t.text.replace(/[`*]/g, '')}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>
      </div>
    </div>
  );
}
