import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

/* ---------- topology and routing model (pure, unit-testable) ---------- */

export const SPINES = ['S1', 'S2'] as const;
export const LEAVES = ['L1', 'L2', 'L3', 'L4'] as const;
const HOST_LEAF: Record<string, string> = { H1: 'L1', H2: 'L2', H3: 'L3', H4: 'L4' };
const isSpine = (n: string) => n[0] === 'S';
const isLeaf = (n: string) => n[0] === 'L';

export interface FlowDef { id: string; src: string; dst: string; pref: string; color: string }
export const FLOWS: FlowDef[] = [
  { id: 'F1', src: 'H1', dst: 'H4', pref: 'S1', color: 'var(--data)' },
  { id: 'F2', src: 'H2', dst: 'H3', pref: 'S2', color: 'var(--accent)' },
  { id: 'F3', src: 'H3', dst: 'H2', pref: 'S1', color: 'var(--warn)' },
  { id: 'F4', src: 'H4', dst: 'H1', pref: 'S2', color: 'var(--muted)' },
];

export const linkKey = (a: string, b: string) => (isSpine(a) ? `${a}-${b}` : `${b}-${a}`);
export interface RouteCfg { failed: string[]; valley: boolean; loop: boolean }
export interface Hop { q: string; cls: number } // q = "X>Y": the ingress buffer at Y for traffic from X; cls = bounces so far
export interface Path { hops: Hop[]; outcome: 'delivered' | 'ttl' | 'unreachable' }
export const MAX_HOPS = 14; // stands in for the IP TTL (64 on real hosts)

/**
 * Hop-by-hop forwarding. Up-down: a leaf only uses a spine that still reaches the destination leaf.
 * Valley (transient, before convergence): a leaf keeps its hashed spine as long as its own uplink is up;
 * a spine that lost the destination bounces the packet down to another leaf, which sends it up again.
 * Loop: L2 and S1 point at each other for L3's prefix (a convergence micro-loop).
 */
export function computePath(f: FlowDef, cfg: RouteCfg): Path {
  const up = (a: string, b: string) => !cfg.failed.includes(linkKey(a, b));
  const dst = HOST_LEAF[f.dst];
  const hops: Hop[] = [{ q: `${f.src}>${HOST_LEAF[f.src]}`, cls: 0 }];
  let prev = f.src, cur = HOST_LEAF[f.src], bounces = 0;
  for (;;) {
    if (cur === dst) return { hops, outcome: 'delivered' };
    if (hops.length >= MAX_HOPS) return { hops, outcome: 'ttl' };
    let next: string | null = null;
    if (cfg.loop && dst === 'L3' && cur === 'L2' && up('L2', 'S1')) next = 'S1';
    else if (cfg.loop && dst === 'L3' && cur === 'S1' && up('S1', 'L2')) next = 'L2';
    else if (isLeaf(cur)) {
      const ups = SPINES.filter((s) => up(cur, s) && s !== prev);
      const cands = cfg.valley && !isSpine(prev) ? ups : ups.filter((s) => up(s, dst));
      next = cands.includes(f.pref as 'S1') ? f.pref : cands[0] ?? null;
    } else if (up(cur, dst)) next = dst;
    else if (cfg.valley) {
      next = LEAVES.find((m) => m !== prev && m !== dst && up(cur, m) && SPINES.some((s2) => s2 !== cur && up(m, s2) && up(s2, dst))) ?? null;
    }
    if (!next) return { hops, outcome: 'unreachable' };
    if (isLeaf(cur) && isSpine(next) && isSpine(prev)) bounces++;
    hops.push({ q: `${cur}>${next}`, cls: bounces });
    prev = cur; cur = next;
  }
}

export interface Remedies { watchdog: boolean; updown: boolean; tagger: boolean; lossy: boolean }
/** Queue key = buffer + priority. With the per-bounce priority remedy a packet moves up one lossless priority per bounce; past the last one it is lossy. */
export const qKey = (h: Hop, r: Remedies) => `${h.q}#${r.tagger ? Math.min(h.cls, 2) : 0}`;
export const isLossy = (key: string, r: Remedies) => r.lossy || key.endsWith('#2');

/** Buffer dependency graph: edge A -> B when packets waiting in A need space in lossless buffer B. */
export function dependencyEdges(paths: Path[], r: Remedies): [string, string][] {
  const set = new Set<string>();
  for (const p of paths) for (let i = 0; i + 1 < p.hops.length; i++) {
    const a = qKey(p.hops[i], r), b = qKey(p.hops[i + 1], r);
    if (!isLossy(b, r) && !isLossy(a, r)) set.add(`${a}|${b}`);
  }
  return [...set].map((s) => s.split('|') as [string, string]);
}

/** Nodes that lie on at least one cycle (Tarjan strongly connected components). */
export function cyclicNodes(edges: [string, string][]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(b); if (!adj.has(b)) adj.set(b, []); }
  let idx = 0; const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), out = new Set<string>();
  const visit = (v: string) => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
    for (const w of adj.get(v)!) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []; let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || adj.get(v)!.includes(v)) comp.forEach((c) => out.add(c));
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) visit(v);
  return out;
}

/* ---------- discrete-time PFC simulation ---------- */

export const XOFF = 6, XON = 3, BUF = 8, WD_DETECT = 8, WD_RESTORE = 6, STALL_FROM = 4, STALL_TO = 30;
interface Pkt { f: number; i: number }
export interface Sim {
  t: number; q: Record<string, Pkt[]>; xoff: Record<string, boolean>; stuck: Record<string, number>; wdUntil: Record<string, number>;
  seed: number; delivered: number[]; recent: number[][]; drops: { ttl: number; route: number; wd: number; lossy: number }; wdEvents: number;
}
export const newSim = (): Sim => ({ t: 0, q: {}, xoff: {}, stuck: {}, wdUntil: {}, seed: 12345, delivered: [0, 0, 0, 0], recent: [], drops: { ttl: 0, route: 0, wd: 0, lossy: 0 }, wdEvents: 0 });

interface Cand { src: string | null; f: number; target: string | null; dst?: string }

/** One tick. Every link carries at most one packet per tick; senders obey PAUSE state as it was at the start of the tick. */
export function step(s: Sim, paths: (Path | null)[], r: Remedies, o: { stall: boolean; senders: boolean }): Sim {
  const n: Sim = { ...s, t: s.t + 1, q: Object.fromEntries(Object.entries(s.q).map(([k, v]) => [k, [...v]])), xoff: { ...s.xoff }, stuck: { ...s.stuck }, wdUntil: { ...s.wdUntil }, delivered: [...s.delivered], drops: { ...s.drops } };
  const occ = (k: string) => s.q[k]?.length ?? 0;
  for (const k of Object.keys(s.q)) if (!isLossy(k, r)) { if (occ(k) >= XOFF) n.xoff[k] = true; else if (occ(k) <= XON) n.xoff[k] = false; }
  const xo = (k: string) => !isLossy(k, r) && !!n.xoff[k];
  const byLink = new Map<string, Cand[]>();
  const add = (link: string, c: Cand) => { if (!byLink.has(link)) byLink.set(link, []); byLink.get(link)!.push(c); };
  const pop: string[] = [];
  for (const [k, pk] of Object.entries(s.q)) {
    if (!pk.length) continue;
    const p = pk[0], path = paths[p.f]!;
    if (p.i === path.hops.length - 1) {
      if (path.outcome === 'delivered') { const leaf = path.hops[p.i].q.split('>')[1]; add(`${leaf}>${FLOWS[p.f].dst}`, { src: k, f: p.f, target: null, dst: FLOWS[p.f].dst }); }
      else { pop.push(k); if (path.outcome === 'ttl') n.drops.ttl++; else n.drops.route++; }
      continue;
    }
    const h = path.hops[p.i + 1];
    add(h.q, { src: k, f: p.f, target: qKey(h, r) });
  }
  if (o.senders) paths.forEach((p, f) => { if (p) add(p.hops[0].q, { src: null, f, target: qKey(p.hops[0], r) }); });
  const push: [string, Pkt][] = [];
  const recent = [0, 0, 0, 0];
  for (const cands of byLink.values()) {
    const ok: Cand[] = [];
    const blocked = new Set<string>();
    for (const c of cands) {
      if (c.target === null) { if (!(o.stall && (c.dst === 'H3' || c.dst === 'H4'))) ok.push(c); continue; }
      const wdOn = r.watchdog && (n.wdUntil[c.target] ?? 0) > s.t;
      if (wdOn) { if (c.src) pop.push(c.src); n.drops.wd++; continue; } // watchdog drop action: discard instead of waiting
      if (xo(c.target)) { blocked.add(c.target); continue; }
      n.stuck[c.target] = 0;
      ok.push(c);
    }
    // Arbitration between buffers competing for one link: seeded pseudo-random (reproducible), not perfectly fair.
    if (ok.length > 1) n.seed = (n.seed * 1103515245 + 12345) % 2147483648;
    const pick = ok.length ? ok[ok.length > 1 ? Math.floor((n.seed / 2147483648) * ok.length) : 0] : null;
    if (pick) {
      if (pick.src) pop.push(pick.src);
      const i = pick.src ? s.q[pick.src][0].i + 1 : 0;
      if (pick.target === null) { n.delivered[pick.f]++; recent[pick.f]++; }
      else if (isLossy(pick.target, r) && occ(pick.target) >= BUF) n.drops.lossy++;
      else push.push([pick.target, { f: pick.f, i }]);
    }
    for (const b of blocked) {
      n.stuck[b] = (n.stuck[b] ?? 0) + 1;
      if (r.watchdog && n.stuck[b] >= WD_DETECT) { n.wdUntil[b] = n.t + WD_RESTORE; n.stuck[b] = 0; n.wdEvents++; }
    }
  }
  for (const k of pop) n.q[k] = n.q[k].slice(1);
  for (const [k, p] of push) (n.q[k] ??= []).push(p);
  n.recent = [...s.recent.slice(-59), recent];
  return n;
}

/** True deadlock: a cycle of paused buffers, each with a head packet that needs the next (paused) buffer. Absorbing unless something drops. */
export function waitCycle(s: Sim, paths: (Path | null)[], r: Remedies): string[] {
  const nxt = new Map<string, string>();
  for (const [k, pk] of Object.entries(s.q)) {
    if (!pk.length || isLossy(k, r)) continue;
    const p = pk[0], path = paths[p.f]!;
    if (p.i + 1 >= path.hops.length) continue;
    const t = qKey(path.hops[p.i + 1], r);
    if (!isLossy(t, r) && s.xoff[t] && (s.q[t]?.length ?? 0) > XON) nxt.set(k, t);
  }
  for (const start of nxt.keys()) {
    const seen: string[] = []; let v: string | undefined = start;
    while (v && !seen.includes(v)) { seen.push(v); v = nxt.get(v); }
    if (v) return seen.slice(seen.indexOf(v));
  }
  return [];
}

/* ---------- UI ---------- */

const POS: Record<string, [number, number]> = { S1: [190, 34], S2: [330, 34], L1: [70, 132], L2: [210, 132], L3: [310, 132], L4: [450, 132], H1: [70, 214], H2: [210, 214], H3: [310, 214], H4: [450, 214] };
const ALL_LINKS = SPINES.flatMap((s) => LEAVES.map((l) => `${s}-${l}`));
const short = (k: string) => { const [q, c] = k.split('#'); return `${q.replace('>', '→')}${c !== '0' ? ` p${c}` : ''}`; };

function Toggle({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={() => set(!on)}
      className={`rounded-md border px-2 py-1 text-left font-mono text-xs transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{children}</button>
  );
}

function Topology({ cfg, paths }: { cfg: RouteCfg; paths: (Path | null)[] }) {
  return (
    <svg viewBox="0 0 520 240" className="w-full" role="img"
      aria-label={`Leaf-spine topology: spines S1 and S2, leaves L1 to L4 each with one host. Failed links: ${cfg.failed.length ? cfg.failed.join(', ') : 'none'}. Paths: ${paths.map((p, i) => p && `${FLOWS[i].id} ${[FLOWS[i].src, ...p.hops.map((h) => h.q.split('>')[1])].join(' to ')}${p.outcome === 'delivered' ? ` to ${FLOWS[i].dst}` : p.outcome === 'ttl' ? ', looping' : ', no route'}`).filter(Boolean).join('; ') || 'none'}.`}>
      <defs>{FLOWS.map((f) => <marker key={f.id} id={`ah-${f.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill={f.color} /></marker>)}</defs>
      {ALL_LINKS.map((k) => { const [s, l] = k.split('-'); const dead = cfg.failed.includes(k); const [x1, y1] = POS[s], [x2, y2] = POS[l];
        return <g key={k}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={dead ? 'var(--danger)' : 'var(--border)'} strokeWidth={dead ? 1.5 : 2} strokeDasharray={dead ? '5 4' : undefined} />
          {dead && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + 4} textAnchor="middle" fontSize={14} fill="var(--danger)" fontWeight={700}>×</text>}</g>; })}
      {LEAVES.map((l, i) => <line key={l} x1={POS[l][0]} y1={POS[l][1]} x2={POS[`H${i + 1}`][0]} y2={POS[`H${i + 1}`][1]} stroke="var(--border)" strokeWidth={2} />)}
      {paths.map((p, fi) => p && p.hops.slice(1).map((h, hi) => {
        const [a, b] = h.q.split('>'); const [x1, y1] = POS[a], [x2, y2] = POS[b]; const off = (fi - 1.5) * 4 + (hi > 4 ? 2 : 0);
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), nx = (-dy / len) * off, ny = (dx / len) * off;
        return <line key={`${fi}-${hi}`} x1={x1 + nx + dx * 0.12} y1={y1 + ny + dy * 0.12} x2={x2 + nx - dx * 0.14} y2={y2 + ny - dy * 0.14} stroke={FLOWS[fi].color} strokeWidth={2} markerEnd={`url(#ah-${FLOWS[fi].id})`} opacity={0.9} />;
      }))}
      {Object.entries(POS).map(([n, [x, y]]) => (
        <g key={n}><rect x={x - 20} y={y - 12} width={40} height={24} rx={5} fill="var(--panel-2)" stroke={isSpine(n) ? 'var(--data)' : isLeaf(n) ? 'var(--accent)' : 'var(--border)'} strokeWidth={1.5} />
          <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill="var(--text)">{n}</text></g>
      ))}
    </svg>
  );
}

function DepGraph({ nodes, edges, cyc, sim, dead, r }: { nodes: string[]; edges: [string, string][]; cyc: Set<string>; sim: Sim; dead: string[]; r: Remedies }) {
  const N = nodes.length, cx = 260, cy = 150, R = 112;
  const pos = new Map(nodes.map((k, i) => [k, [cx + R * Math.cos((2 * Math.PI * i) / N - Math.PI / 2), cy + R * Math.sin((2 * Math.PI * i) / N - Math.PI / 2)] as [number, number]]));
  return (
    <svg viewBox="0 0 520 300" className="w-full" role="img"
      aria-label={`Buffer dependency graph: ${N} lossless buffers, ${edges.length} dependencies. ${cyc.size ? `On a cycle: ${nodes.filter((k) => cyc.has(k)).map(short).join(', ')}.` : 'No cycle.'} ${dead.length ? `Deadlocked: ${dead.map(short).join(', ')}.` : ''} Paused: ${nodes.filter((k) => !isLossy(k, r) && sim.xoff[k]).map(short).join(', ') || 'none'}.`}>
      <defs><marker id="dep-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" /></marker>
        <marker id="dep-ah-c" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" /></marker></defs>
      {N === 0 && <text x={cx} y={cy} textAnchor="middle" fontSize={12} fill="var(--muted)">No lossless buffers in use: no PAUSE, so no dependencies.</text>}
      {edges.map(([a, b]) => { const [x1, y1] = pos.get(a)!, [x2, y2] = pos.get(b)!; const c = cyc.has(a) && cyc.has(b);
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, sh = 30 / len;
        return <line key={`${a}${b}`} x1={x1 + dx * sh} y1={y1 + dy * sh} x2={x2 - dx * sh} y2={y2 - dy * sh} stroke={c ? 'var(--danger)' : 'var(--muted)'} strokeWidth={c ? 2.2 : 1} opacity={c ? 1 : 0.6} markerEnd={`url(#${c ? 'dep-ah-c' : 'dep-ah'})`} />; })}
      {nodes.map((k) => { const [x, y] = pos.get(k)!; const o = sim.q[k]?.length ?? 0; const paused = !isLossy(k, r) && sim.xoff[k]; const d = dead.includes(k);
        return <g key={k}>
          <rect x={x - 30} y={y - 15} width={60} height={30} rx={5} fill="var(--panel)" stroke={d ? 'var(--danger)' : paused ? 'var(--warn)' : cyc.has(k) ? 'var(--danger)' : 'var(--border)'} strokeWidth={d || paused ? 2.5 : 1.2} strokeDasharray={cyc.has(k) && !d && !paused ? '3 2' : undefined} />
          <text x={x} y={y - 2} textAnchor="middle" fontSize={9.5} fontFamily="var(--font-mono)" fill="var(--text)">{short(k)}</text>
          <rect x={x - 24} y={y + 4} width={48} height={5} rx={2} fill="var(--panel-2)" />
          <rect x={x - 24} y={y + 4} width={(48 * Math.min(o, BUF)) / BUF} height={5} rx={2} fill={paused ? 'var(--warn)' : 'var(--data)'} />
        </g>; })}
    </svg>
  );
}

export default function PfcDeadlock() {
  const [failed, setFailed] = useState<string[]>(['S1-L4', 'S2-L3']);
  const [valley, setValley] = useState(true);
  const [loop, setLoop] = useState(false);
  const [on, setOn] = useState([true, true, false, false]);
  const [burst, setBurst] = useState(true);
  const [rem, setRem] = useState<Remedies>({ watchdog: false, updown: false, tagger: false, lossy: false });
  const [senders, setSenders] = useState(true);
  const [sim, setSim] = useState<Sim>(newSim);
  const [running, setRunning] = useState(false);
  const reduced = useRef(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const cfg: RouteCfg = { failed, valley: valley && !rem.updown, loop };
  const paths = useMemo(() => FLOWS.map((f, i) => (on[i] ? computePath(f, { failed, valley: valley && !rem.updown, loop }) : null)), [failed, valley, loop, on, rem.updown]);
  const live = paths.filter((p): p is Path => !!p);
  const edges = useMemo(() => dependencyEdges(live, rem), [live, rem]);
  const cyc = useMemo(() => cyclicNodes(edges), [edges]);
  const nodes = useMemo(() => {
    const all = [...new Set(live.flatMap((p) => p.hops.map((h) => qKey(h, rem))))].filter((k) => !isLossy(k, rem));
    return [...all.filter((k) => cyc.has(k)), ...all.filter((k) => !cyc.has(k))];
  }, [live, rem, cyc]);
  const dead = waitCycle(sim, paths, rem);

  // Routing, flow or remedy changes restart the run; watchdog and "stop senders" act on the live run.
  const routeSig = JSON.stringify([failed, valley, loop, on, rem.updown, rem.tagger, rem.lossy]);
  useEffect(() => { setSim(newSim()); setRunning(false); }, [routeSig]);
  const tick = (k = 1) => setSim((s0) => { let s = s0; for (let i = 0; i < k; i++) s = step(s, paths, rem, { stall: burst && s.t >= STALL_FROM && s.t < STALL_TO, senders }); return s; });
  useEffect(() => { if (!running) return; const id = setInterval(() => tick(), reduced.current ? 600 : 220); return () => clearInterval(id); });

  const last10 = FLOWS.map((_, f) => sim.recent.slice(-10).reduce((a, r) => a + r[f], 0));
  const stalled = burst && sim.t >= STALL_FROM && sim.t < STALL_TO;
  const status = dead.length ? { tone: 'border-danger/40 bg-danger/10 text-danger', text: `DEADLOCK: ${dead.map(short).join(' → ')} → (back). Every buffer on the cycle is paused by the next one. Throughput through it is 0 and stays 0 even if every sender stops.` }
    : stalled ? { tone: 'border-warn/40 bg-warn/10 text-warn', text: `Transient congestion: receivers H3 and H4 are slow (ticks ${STALL_FROM}-${STALL_TO}). Queues fill and PAUSE propagates upstream.` }
    : cyc.size ? { tone: 'border-warn/40 bg-warn/10 text-warn', text: 'A cyclic buffer dependency exists. Traffic still moves, but enough load can lock it. Step on.' }
    : { tone: 'border-accent/40 bg-accent-soft text-accent', text: 'No cycle in the buffer dependency graph: deadlock is impossible with these routes and remedies.' };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Failed links</div>
          <div className="flex flex-wrap gap-1">{ALL_LINKS.map((k) => <Toggle key={k} on={failed.includes(k)} set={(v) => setFailed(v ? [...failed, k] : failed.filter((x) => x !== k))}>{k.replace('-', '–')}</Toggle>)}</div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Flows (lossless priority)</div>
          <div className="flex flex-wrap gap-1">{FLOWS.map((f, i) => <Toggle key={f.id} on={on[i]} set={(v) => setOn(on.map((x, j) => (j === i ? v : x)))}><span style={{ color: f.color }} aria-hidden>■</span> {f.id} {f.src}→{f.dst}</Toggle>)}</div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Routing state</div>
          <div className="flex flex-wrap gap-1">
            <Toggle on={valley} set={setValley}>valley paths (transient)</Toggle>
            <Toggle on={loop} set={setLoop}>micro-loop L2↔S1 for H3</Toggle>
            <Toggle on={burst} set={setBurst}>congestion burst</Toggle>
          </div>
        </div>
      </div>
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Remedies</div>
        <div className="flex flex-wrap gap-1">
          <Toggle on={rem.watchdog} set={(v) => setRem({ ...rem, watchdog: v })}>PFC watchdog (drop)</Toggle>
          <Toggle on={rem.updown} set={(v) => setRem({ ...rem, updown: v })}>strict up-down routing</Toggle>
          <Toggle on={rem.tagger} set={(v) => setRem({ ...rem, tagger: v })}>new lossless priority per bounce</Toggle>
          <Toggle on={rem.lossy} set={(v) => setRem({ ...rem, lossy: v })}>lossy (no PFC)</Toggle>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Topology and paths in use</div>
          <Topology cfg={cfg} paths={paths} />
          <ul className="space-y-0.5 font-mono text-[11px] text-muted">
            {paths.map((p, i) => p && <li key={i}><span style={{ color: FLOWS[i].color }}>{FLOWS[i].id}</span> {[FLOWS[i].src, ...p.hops.map((h) => h.q.split('>')[1])].join('→')}{p.outcome === 'delivered' ? `→${FLOWS[i].dst}` : p.outcome === 'ttl' ? ' … (loops until TTL expires)' : ' ✕ no route (dropped)'}</li>)}
          </ul>
        </div>
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Buffer dependency graph (ingress queue X→Y at Y)</div>
          <DepGraph nodes={nodes} edges={edges} cyc={cyc} sim={sim} dead={dead} r={rem} />
          <div className="flex flex-wrap gap-3 text-[11px] text-muted">
            <span><span className="text-danger">━</span> edge on a cycle</span><span><span className="text-warn">▢</span> paused (≥ XOFF {XOFF})</span><span>bar = occupancy / {BUF}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => tick()} className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:bg-panel-2">Step</button>
        <button type="button" onClick={() => tick(20)} className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:bg-panel-2">+20 ticks</button>
        <button type="button" aria-pressed={running} onClick={() => setRunning(!running)} className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-sm text-accent">{running ? 'Pause' : 'Run'}</button>
        <button type="button" onClick={() => { setSim(newSim()); setRunning(false); }} className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:bg-panel-2">Reset</button>
        <button type="button" aria-pressed={!senders} onClick={() => setSenders(!senders)} className={`rounded-md border px-3 py-1.5 text-sm ${!senders ? 'border-warn text-warn' : 'border-line bg-panel hover:bg-panel-2'}`}>{senders ? 'Stop all senders' : 'Senders stopped'}</button>
        <Pill>tick {sim.t}</Pill>
        <Pill>delivered (last 10) {last10.map((d, i) => (on[i] ? `${FLOWS[i].id}:${d}` : null)).filter(Boolean).join(' ')}</Pill>
        <Pill>drops: wd {sim.drops.wd} · lossy {sim.drops.lossy} · TTL {sim.drops.ttl} · no-route {sim.drops.route}</Pill>
        {rem.watchdog && <Pill>watchdog events {sim.wdEvents}</Pill>}
      </div>

      <div className={`rounded-lg border px-3 py-2 text-sm ${status.tone}`} role="status">{status.text}</div>

      <div className="flex h-10 items-end gap-px rounded-md border border-line bg-panel-2 p-1" role="img"
        aria-label={`Delivered packets per tick over the last ${sim.recent.length} ticks: ${sim.recent.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0)} in total, ${last10.reduce((a, b) => a + b, 0)} in the last 10.`}>
        {sim.recent.map((r, i) => { const v = r.reduce((a, b) => a + b, 0); return <div key={i} className="flex-1 rounded-sm bg-accent" style={{ height: `${Math.max(4, v * 25)}%`, opacity: v ? 1 : 0.25 }} />; })}
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">How the model works</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Each node of the graph is an ingress buffer "X→Y" at switch Y, per priority. Edge A → B when a flow's packets in A must move into B next: they wait for B's space.</li>
          <li>Up-down paths (leaf → spine → leaf) only create edges from up-buffers to down-buffers: no cycle. A <em>bounce</em> (spine → leaf → spine) adds a down → up edge; two bounces in opposite directions close a loop.</li>
          <li>A buffer at ≥ {XOFF} packets sends PAUSE to X (XON at ≤ {XON}). Every link carries one packet per tick, so the two links shared by both flows are overloaded.</li>
          <li>Deadlock = a cycle of paused buffers whose head packets each need the next buffer. Nothing on it can ever move: it outlives the burst and survives stopping all senders.</li>
          <li>Watchdog: a buffer that keeps its sender paused with no progress for {WD_DETECT} ticks triggers drop of packets heading into it for {WD_RESTORE} ticks. It breaks the deadlock but it can re-form; the routes still contain the cycle.</li>
        </ol>
      </div>
      <p className="text-[11px] leading-relaxed text-muted">
        Toy model of a cyclic buffer dependency (CBD). Guo et al., "RDMA over Commodity Ethernet at Scale" (SIGCOMM 2016), showed that PFC can deadlock even a Clos
        fabric with up-down routing; the incident they describe came from flooded lossless packets (ARP entry present, MAC entry missing). The variant built here,
        down-up bounces after link failures and transient routing loops, is analysed by Hu et al. (HotNets 2016 and the Tagger paper).
        "Valley paths" models the transient state before routing converges (the leaf still hashes to a spine that has lost the destination; that spine reroutes through another leaf).
        "New lossless priority per bounce" follows the idea in Hu et al., "Tagger" (CoNEXT 2017): a packet that bounces moves to the next lossless priority, and past the last one it becomes lossy, which removes the cycle at the cost of more lossless queues.
        Thresholds, tick timing and the watchdog timer are illustrative; real watchdog detection times are typically configured in the tens to hundreds of milliseconds (check your platform).
      </p>
    </div>
  );
}
