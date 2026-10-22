import { Link } from 'react-router-dom';
import { ArrowRight, Boxes, Flame, FlaskConical, Layers, Network, Server, Terminal, Timer } from 'lucide-react';
import { useIndex } from '../content';
import { useProgress } from '../store';
import { isDue, streak } from '../progress';
import { moduleStats, nextLesson, overall, rankFor } from '../stats';
import { Bar, Button, Card, LevelBadge, Loading, Stat } from '../components/ui';

function Hero() {
  // A small animated rail-optimized fabric: 2 spines, 4 rail leaves, 4 servers.
  const leaves = [0, 1, 2, 3];
  return (
    <svg viewBox="0 0 420 220" className="w-full max-w-md" aria-hidden>
      {[0, 1].map((s) => leaves.map((l) => <line key={`${s}${l}`} x1={150 + s * 120} y1={30} x2={60 + l * 100} y2={110} stroke="var(--border)" strokeWidth="1.5" />))}
      {leaves.map((l) => [0, 1, 2, 3].map((n) => (
        <line key={`${l}${n}`} x1={60 + l * 100} y1={110} x2={45 + n * 110 + l * 8} y2={190} stroke={l === 1 ? 'var(--accent)' : 'var(--border)'} strokeWidth={l === 1 ? 2 : 1} className={l === 1 ? 'flow-dash' : ''} />
      )))}
      {[0, 1].map((s) => <rect key={s} x={125 + s * 120} y={16} width="50" height="26" rx="6" fill="var(--panel-2)" stroke="var(--data)" />)}
      {[0, 1].map((s) => <text key={s} x={150 + s * 120} y={33} textAnchor="middle" fontSize="10" fill="var(--text)" fontFamily="monospace">spine{s + 1}</text>)}
      {leaves.map((l) => <g key={l}><rect x={35 + l * 100} y={98} width="50" height="24" rx="6" fill="var(--panel-2)" stroke={l === 1 ? 'var(--accent)' : 'var(--border)'} /><text x={60 + l * 100} y={114} textAnchor="middle" fontSize="9" fill="var(--text)" fontFamily="monospace">rail {l}</text></g>)}
      {[0, 1, 2, 3].map((n) => <g key={n}><rect x={15 + n * 110} y={180} width="80" height="28" rx="6" fill="var(--panel)" stroke="var(--border)" />{[0, 1, 2, 3].map((g) => <rect key={g} x={22 + n * 110 + g * 18} y={187} width="13" height="14" rx="2" fill={g === 1 ? 'var(--accent)' : 'var(--muted)'} opacity={g === 1 ? 1 : 0.45} />)}</g>)}
    </svg>
  );
}

export default function Dashboard() {
  const { data: ix, error } = useIndex();
  const { progress } = useProgress();
  if (!ix) return <Loading error={error} />;
  const o = overall(ix, progress);
  const next = nextLesson(ix, progress);
  const rank = rankFor(o.pct);
  const days = streak(progress.activity);
  const due = ix.glossary.filter((t) => isDue(progress.cards[t.term])).length;
  const started = o.read > 0;
  const words = ix.lessons.reduce((s, l) => s + l.words, 0);
  const questions = ix.quizzes.reduce((s, q) => s + q.count, 0);

  return (
    <div className="space-y-10">
      <section className="fabric-bg relative overflow-hidden rounded-3xl border border-line bg-panel p-6 md:p-10">
        <div className="grid items-center gap-8 md:grid-cols-[1.3fr_1fr]">
          <div>
            <div className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-accent">From beginner to master</div>
            <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight md:text-5xl">The network is the computer<br /><span className="text-accent">that trains the model.</span></h1>
            <p className="mt-4 max-w-xl text-muted">
              Learn AI cluster networking end to end: RDMA, InfiniBand, RoCEv2 and lossless Ethernet, NCCL collectives,
              rail-optimized fabrics and the troubleshooting skills to keep thousands of GPUs busy.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              {next ? <Button to={`/lesson/${next.id}`}>{started ? 'Continue' : 'Start learning'}: {next.title.split(':')[0]} <ArrowRight size={16} /></Button> : <Button to="/exams">Take a mock exam <ArrowRight size={16} /></Button>}
              <Button variant="ghost" to="/labs/sim-00-orientation"><Terminal size={16} />Try the fabric simulator</Button>
            </div>
          </div>
          <div className="flex justify-center"><Hero /></div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Rank" value={<span className="text-xl">{rank.title}</span>} sub={<Bar value={o.pct} label="Progress to the next rank" className="mt-2" />} />
        <Stat label="Lessons mastered" value={`${o.passed}/${o.total}`} sub={`${o.read} read · quiz passed counts as mastered`} />
        <Stat label="Labs solved" value={`${o.labsSolved}/${o.labsTotal}`} sub={`${o.examsPassed}/${o.examsTotal} mock exams passed`} />
        <Stat label="Streak" value={<span className="flex items-center gap-2">{days}<Flame size={22} className={days ? 'text-warn' : 'text-muted'} /></span>} sub={`${due} flashcards due`} />
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-xl font-bold">Learning path</h2>
          <Link to="/path" className="text-sm text-data hover:underline">All modules →</Link>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ix.modules.map((m) => {
            const st = moduleStats(ix, progress, m);
            return (
              <Link key={m.id} to={`/module/${m.id}`} className="group rounded-2xl border border-line bg-panel p-4 transition hover:-translate-y-0.5 hover:border-accent/60">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-muted">M{String(m.order).padStart(2, '0')}</span>
                  <LevelBadge level={m.level} />
                </div>
                <div className="mt-2 font-semibold group-hover:text-accent">{m.title}</div>
                <div className="mt-3 flex items-center gap-3"><Bar value={st.pct} label={`${m.title} mastered`} /><span className="font-mono text-[11px] text-muted">{st.done}/{st.total}</span></div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {[
          { to: '/labs', icon: FlaskConical, t: 'Simulator labs', d: `${ix.labs.filter((l) => l.kind === 'sim').length} break/fix incidents in a simulated 32-GPU RoCE cluster.` },
          { to: '/hw', icon: Server, t: 'Real HW labs', d: `${ix.labs.filter((l) => l.kind === 'handson').length} labs on your own VM, RDMA hosts, switch or GPU nodes, with a toolkit that checks your gear.` },
          { to: '/visualize', icon: Network, t: 'Visualizations', d: 'Packet anatomy, PFC/ECN, ECMP collisions, all-reduce, fabric sizing and more.' },
          { to: '/exams', icon: Timer, t: 'Mock exams', d: `${ix.exams.length} timed assessments with per-domain scoring.` },
          { to: '/flashcards', icon: Boxes, t: 'Flashcards', d: `${ix.glossary.length} terms with SM-2 spaced repetition.` },
        ].map(({ to, icon: Icon, t, d }) => (
          <Link key={to} to={to}><Card className="h-full p-5 transition hover:border-accent/60"><Icon className="text-accent" size={22} /><div className="mt-3 font-semibold">{t}</div><div className="mt-1 text-sm text-muted">{d}</div></Card></Link>
        ))}
      </section>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-dashed border-line px-5 py-4 font-mono text-xs text-muted">
        <span><Layers size={12} className="mr-1 inline" />{ix.modules.length} modules</span>
        <span>{ix.lessons.length} lessons</span>
        <span>{Math.round(words / 1000)}k words</span>
        <span>{questions} quiz questions</span>
        <span>{ix.exams.reduce((s, e) => s + e.count, 0)} exam questions</span>
        <span>{ix.commands.reduce((s, c) => s + c.commands.length, 0)} commands</span>
        <span className="ml-auto">Progress is stored only in this browser · export it in Settings</span>
      </section>
    </div>
  );
}
