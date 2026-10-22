import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- pure model (eBGP path-vector on a 2-tier Clos, RFC 7938 numbering) ----------

export const LEAVES = 4;
export interface Router { id: string; kind: 'spine' | 'leaf'; idx: number; asn: number; name: string }

/** RFC 7938: all spines share one ASN; every leaf has its own. `uniqueSpines` builds the anti-pattern. */
export function routers(nSpines: number, uniqueSpines = false): Router[] {
  const sp = Array.from({ length: nSpines }, (_, i) => ({ id: `S${i + 1}`, kind: 'spine' as const, idx: i, asn: uniqueSpines ? 65001 + i : 65000, name: `spine${i + 1}` }));
  const lf = Array.from({ length: LEAVES }, (_, i) => ({ id: `L${i + 1}`, kind: 'leaf' as const, idx: i, asn: 65101 + i, name: `leaf${i + 1}` }));
  return [...sp, ...lf];
}

export const linkKey = (s: number, l: number) => `S${s + 1}-L${l + 1}`;

export interface RxPath { from: string; asPath: number[]; loop: boolean }
export interface RibEntry { prefix: number; local: boolean; paths: RxPath[]; best: RxPath | null; ecmp: string[] }
export type Ribs = Record<string, RibEntry[]>;

/**
 * Synchronous path-vector iteration to a fixed point. Every router advertises only its best path
 * (no add-path); the receiver prepends the sender's ASN and drops any path that already contains its
 * own ASN (eBGP AS_PATH loop prevention). Best = shortest AS_PATH, tie-break lowest router (stand-in
 * for lowest router-ID). Multipath: equal length AND identical AS_PATH, or just equal length with
 * multipath-relax, capped at maximum-paths.
 */
export function simulate(nSpines: number, failed: ReadonlySet<string>, uniqueSpines: boolean, relax: boolean, maxPaths: number): Ribs {
  const rs = routers(nSpines, uniqueSpines);
  const byId = new Map(rs.map((r) => [r.id, r]));
  const nbrs = new Map<string, string[]>(rs.map((r) => [r.id, []]));
  for (let s = 0; s < nSpines; s++) for (let l = 0; l < LEAVES; l++) {
    if (failed.has(linkKey(s, l))) continue;
    nbrs.get(`S${s + 1}`)!.push(`L${l + 1}`);
    nbrs.get(`L${l + 1}`)!.push(`S${s + 1}`);
  }
  // best[router][prefix] = AS_PATH as held by that router ([] = locally originated)
  let best: Record<string, (number[] | null)[]> = {};
  for (const r of rs) best[r.id] = Array.from({ length: LEAVES }, (_, p) => (r.kind === 'leaf' && r.idx === p ? [] : null));
  const rx = (r: Router, p: number, cur: typeof best): RxPath[] =>
    nbrs.get(r.id)!.filter((m) => cur[m][p] !== null).map((m) => {
      const asPath = [byId.get(m)!.asn, ...cur[m][p]!];
      return { from: m, asPath, loop: asPath.includes(r.asn) };
    });
  const pick = (paths: RxPath[]) => paths.filter((x) => !x.loop).sort((a, b) => a.asPath.length - b.asPath.length || order(a.from) - order(b.from))[0] ?? null;
  const order = (id: string) => rs.findIndex((r) => r.id === id);
  for (let round = 0; round < 30; round++) {
    const next: typeof best = {};
    let changed = false;
    for (const r of rs) {
      next[r.id] = best[r.id].map((cur, p) => {
        if (r.kind === 'leaf' && r.idx === p) return [];
        const b = pick(rx(r, p, best));
        const v = b ? b.asPath : null;
        if (JSON.stringify(v) !== JSON.stringify(cur)) changed = true;
        return v;
      });
    }
    best = next;
    if (!changed) break;
  }
  const out: Ribs = {};
  for (const r of rs) {
    out[r.id] = Array.from({ length: LEAVES }, (_, p) => {
      const local = r.kind === 'leaf' && r.idx === p;
      const paths = local ? [] : rx(r, p, best).sort((a, b) => order(a.from) - order(b.from));
      const b = local ? null : pick(paths);
      const ecmp = b ? paths.filter((x) => !x.loop && x.asPath.length === b.asPath.length && (relax || x.asPath.join() === b.asPath.join()))
        .sort((a, c) => (a === b ? -1 : c === b ? 1 : order(a.from) - order(c.from))).slice(0, Math.max(1, maxPaths)).map((x) => x.from) : [];
      return { prefix: p, local, paths, best: b, ecmp };
    });
  }
  return out;
}

export interface Change { router: string; prefix: number; removed: string[]; added: string[]; lost: boolean; gained: boolean }
/** Next-hop set differences between two converged states (what the FIB on each router had to change). */
export function diff(a: Ribs, b: Ribs): Change[] {
  const res: Change[] = [];
  for (const id of Object.keys(b)) b[id].forEach((e, p) => {
    const old = a[id]?.[p];
    if (!old || e.local) return;
    const removed = old.ecmp.filter((x) => !e.ecmp.includes(x)), added = e.ecmp.filter((x) => !old.ecmp.includes(x));
    if (removed.length || added.length) res.push({ router: id, prefix: p, removed, added, lost: old.ecmp.length > 0 && e.ecmp.length === 0, gained: old.ecmp.length === 0 && e.ecmp.length > 0 });
  });
  return res;
}

// ---------- UI ----------

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
            {render ? render(o) : String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

const M = ({ children, className = 'text-fg' }: { children: ReactNode; className?: string }) => <span className={`font-mono ${className}`}>{children}</span>;

export default function BgpPathSim() {
  const [nSpines, setNSpines] = useState(4);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState('L1');
  const [pfx, setPfx] = useState<'24' | '32'>('24');
  const [unique, setUnique] = useState(false);
  const [relax, setRelax] = useState(true);
  const [maxPaths, setMaxPaths] = useState(64);
  const [last, setLast] = useState<{ what: string; changes: Change[]; downLinks: string[] } | null>(null);

  const rs = useMemo(() => routers(nSpines, unique), [nSpines, unique]);
  const ribs = useMemo(() => simulate(nSpines, failed, unique, relax, maxPaths), [nSpines, failed, unique, relax, maxPaths]);
  const name = (id: string) => rs.find((r) => r.id === id)?.name ?? id;
  const asnOf = (id: string) => rs.find((r) => r.id === id)?.asn ?? 0;
  const prefixStr = (p: number) => (pfx === '24' ? `10.1.${p + 1}.0/24` : `10.0.0.${11 + p}/32`);

  const apply = (next: Set<string>, what: string) => {
    const before = simulate(nSpines, failed, unique, relax, maxPaths);
    const after = simulate(nSpines, next, unique, relax, maxPaths);
    const downLinks = [...next].filter((k) => !failed.has(k));
    setLast({ what, changes: diff(before, after), downLinks });
    setFailed(next);
  };
  const toggle = (s: number, l: number) => {
    const k = linkKey(s, l), n = new Set(failed);
    if (n.has(k)) n.delete(k); else n.add(k);
    apply(n, `${n.has(k) ? 'Failed' : 'Restored'} link ${name(`S${s + 1}`)}–${name(`L${l + 1}`)}`);
  };
  const isolated = (l: number) => Array.from({ length: nSpines }, (_, s) => failed.has(linkKey(s, l))).every(Boolean);
  const isolate = (l: number) => {
    const n = new Set(failed), iso = isolated(l);
    for (let s = 0; s < nSpines; s++) { if (iso) n.delete(linkKey(s, l)); else n.add(linkKey(s, l)); }
    apply(n, `${iso ? 'Reconnected' : 'Isolated'} ${name(`L${l + 1}`)} (all uplinks ${iso ? 'up' : 'down'})`);
  };
  const reset = (fn: () => void) => { fn(); setFailed(new Set()); setLast(null); };

  const W = 640, spX = (s: number) => (W / (nSpines + 1)) * (s + 1), lfX = (l: number) => (W / (LEAVES + 1)) * (l + 1);
  const selR = rs.find((r) => r.id === sel) ?? rs[nSpines];
  const rib = ribs[selR.id];
  const multiAsn = unique && !relax;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Seg label="Spines" value={nSpines} options={[2, 3, 4] as const} onChange={(v) => reset(() => setNSpines(v))} />
        <Seg label="Each leaf originates" value={pfx} options={['24', '32'] as const} onChange={setPfx} render={(v) => (v === '24' ? 'server /24' : 'loopback /32')} />
        <Seg label="Spine ASN plan" value={unique ? 'u' : 's'} options={['s', 'u'] as const} onChange={(v) => reset(() => setUnique(v === 'u'))} render={(v) => (v === 's' ? 'shared 65000 (RFC 7938)' : 'unique per spine')} />
        <Seg label="as-path multipath-relax" value={relax ? 'on' : 'off'} options={['on', 'off'] as const} onChange={(v) => setRelax(v === 'on')} />
        <Seg label="maximum-paths" value={maxPaths} options={[1, 2, 64] as const} onChange={setMaxPaths} />
        <div className="flex items-end"><button type="button" onClick={() => reset(() => undefined)} className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:bg-panel-2">Restore all links</button></div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <svg viewBox={`0 0 ${W} 250`} className="w-full" role="img" aria-label="Leaf-spine topology; click a link to fail or restore it">
          {Array.from({ length: nSpines }, (_, s) => Array.from({ length: LEAVES }, (_, l) => {
            const down = failed.has(linkKey(s, l));
            const onSel = selR.kind === 'leaf' ? selR.idx === l : selR.idx === s;
            return (
              <g key={linkKey(s, l)} onClick={() => toggle(s, l)} style={{ cursor: 'pointer' }}>
                <line x1={spX(s)} y1={52} x2={lfX(l)} y2={180} stroke="transparent" strokeWidth={14} />
                <line x1={spX(s)} y1={52} x2={lfX(l)} y2={180} stroke={down ? 'var(--danger)' : onSel ? 'var(--accent)' : 'var(--border)'}
                  strokeWidth={down ? 1.5 : onSel ? 2.5 : 1.5} strokeDasharray={down ? '5 4' : undefined} />
                {down && <text x={(spX(s) + lfX(l)) / 2} y={120} fontSize={14} textAnchor="middle" fill="var(--danger)">✕</text>}
              </g>
            );
          }))}
          {rs.map((r) => {
            const x = r.kind === 'spine' ? spX(r.idx) : lfX(r.idx), y = r.kind === 'spine' ? 20 : 180, on = r.id === selR.id;
            return (
              <g key={r.id} onClick={() => setSel(r.id)} style={{ cursor: 'pointer' }}>
                <rect x={x - 46} y={y} width={92} height={34} rx={6} fill={on ? 'var(--panel-2)' : 'var(--panel)'} stroke={r.kind === 'spine' ? 'var(--data)' : 'var(--accent)'} strokeWidth={on ? 2.5 : 1.2} />
                <text x={x} y={y + 14} fontSize={12} textAnchor="middle" fill="var(--text)" fontFamily="var(--font-mono)" fontWeight={700}>{r.name}</text>
                <text x={x} y={y + 28} fontSize={10} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">AS {r.asn}</text>
                {r.kind === 'leaf' && <text x={x} y={y + 50} fontSize={10} textAnchor="middle" fill={isolated(r.idx) ? 'var(--danger)' : 'var(--muted)'} fontFamily="var(--font-mono)">{prefixStr(r.idx)}</text>}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Links (click in the diagram or here)</div>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr><th className="p-1" />{Array.from({ length: LEAVES }, (_, l) => <th key={l} className="p-1 font-mono font-normal text-muted">leaf{l + 1}</th>)}</tr></thead>
              <tbody>
                {Array.from({ length: nSpines }, (_, s) => (
                  <tr key={s}><td className="p-1 font-mono text-muted">spine{s + 1}</td>
                    {Array.from({ length: LEAVES }, (_, l) => {
                      const down = failed.has(linkKey(s, l));
                      return <td key={l} className="p-0.5"><button type="button" aria-pressed={down} aria-label={`Link spine${s + 1} to leaf${l + 1}: ${down ? 'failed' : 'up'}`} onClick={() => toggle(s, l)}
                        className={`w-full rounded border px-2 py-0.5 font-mono ${down ? 'border-danger/50 bg-danger/10 text-danger' : 'border-line bg-panel hover:bg-panel-2 text-accent'}`}>{down ? 'down' : 'up'}</button></td>;
                    })}</tr>
                ))}
                <tr><td className="p-1 font-mono text-muted">isolate</td>
                  {Array.from({ length: LEAVES }, (_, l) => <td key={l} className="p-0.5"><button type="button" aria-pressed={isolated(l)} onClick={() => isolate(l)}
                    className={`w-full rounded border px-2 py-0.5 font-mono ${isolated(l) ? 'border-danger/50 bg-danger/10 text-danger' : 'border-line bg-panel hover:bg-panel-2'}`}>{isolated(l) ? 'undo' : 'cut'}</button></td>)}</tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Show RIB of</div>
          <div className="flex flex-wrap gap-1">
            {rs.map((r) => <button key={r.id} type="button" aria-pressed={r.id === selR.id} onClick={() => setSel(r.id)}
              className={`rounded-md border px-2 py-1 font-mono text-xs ${r.id === selR.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{r.name}</button>)}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill>{selR.name} AS {selR.asn}</Pill>
            <Pill>{failed.size} link(s) down</Pill>
            {unique && <Pill className="text-warn">anti-pattern: spines in different ASNs</Pill>}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            <tr><th className="py-1 pr-3">Prefix</th><th className="py-1 pr-3">Paths received (from: AS_PATH)</th><th className="py-1">Installed next hops</th></tr>
          </thead>
          <tbody>
            {rib.map((e) => (
              <tr key={e.prefix} className="border-t border-line align-top">
                <td className="py-1.5 pr-3 font-mono">{prefixStr(e.prefix)}<div className="text-[11px] text-muted">from leaf{e.prefix + 1}</div></td>
                <td className="py-1.5 pr-3">
                  {e.local ? <M className="text-accent">local (connected / network statement), AS_PATH empty</M>
                    : e.paths.length === 0 ? <M className="text-danger">no paths: prefix withdrawn everywhere</M>
                      : <ul className="space-y-0.5">{e.paths.map((p) => (
                        <li key={p.from} className={`font-mono text-xs ${p.loop ? 'text-muted line-through' : ''}`}>
                          {name(p.from)}: {p.asPath.join(' ')}
                          {p === e.best && <span className="ml-1 text-accent">best</span>}
                          {!p.loop && p !== e.best && e.ecmp.includes(p.from) && <span className="ml-1 text-data">multipath</span>}
                          {!p.loop && !e.ecmp.includes(p.from) && <span className="ml-1 text-warn">{p.asPath.length > (e.best?.asPath.length ?? 0) ? 'longer' : 'not multipath'}</span>}
                          {p.loop && <span className="ml-1 no-underline">(dropped: own AS {selR.asn} in path)</span>}
                        </li>))}</ul>}
                </td>
                <td className="py-1.5 font-mono text-xs">
                  {e.local ? <span className="text-muted">—</span> : e.ecmp.length ? <span className="text-data">{e.ecmp.map(name).join(', ')} <span className="text-muted">({e.ecmp.length}-way)</span></span> : <span className="text-danger">unreachable</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {multiAsn && <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">Paths via different spine ASNs have equal length but are not identical, so without <M className="text-warn">bgp bestpath as-path multipath-relax</M> only one next hop is installed.</div>}
      {selR.kind === 'leaf' && isolated(selR.idx) && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {selR.name} is isolated: it still has its own {prefixStr(selR.idx)} as a connected/local route (servers on it can reach each other), but it has no BGP sessions, so it learns
          no remote prefixes and every other leaf has withdrawn {prefixStr(selR.idx)}. Hosts behind it are cut off from the fabric, and nobody attracts traffic it cannot deliver.
        </div>
      )}

      {last && (
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
          <div className="mb-1 font-semibold">{last.what}: what changed in the forwarding tables</div>
          {last.changes.length === 0 ? <div className="text-muted">No next-hop set changed (for example, the restored path was not needed or maximum-paths caps the set).</div> : (
            <ul className="space-y-0.5 text-xs">
              {last.changes.map((c, i) => {
                const local = (m: string) => last.downLinks.some((k) => k.split('-').includes(c.router) && k.split('-').includes(m));
                return (
                  <li key={i} className="font-mono">
                    <span className="text-fg">{name(c.router)}</span> {prefixStr(c.prefix)}:{' '}
                    {c.removed.map((m) => <span key={m} className="text-danger">−{name(m)} ({local(m) ? 'session down, local detection' : `withdrawal/update from ${name(m)}`}) </span>)}
                    {c.added.map((m) => <span key={m} className="text-accent">+{name(m)} (UPDATE from {name(m)}) </span>)}
                    {c.lost && <span className="text-danger">→ unreachable</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-1 text-[11px] text-muted">Only routers and prefixes listed here changed. A single spine–leaf failure touches the failed leaf (loses that spine for every remote prefix) and, via the spine's withdrawals, every other leaf only for the failed leaf's prefix.</div>
        </div>
      )}

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">How the routes are built</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>leaf<M>N</M> originates its prefix with an empty AS_PATH and sends it to each spine; the spine stores <M>[{asnOf('L2')}]</M> for leaf2 (sender's ASN prepended).</li>
          <li>The spine re-advertises its best path to the other leaves, prepending its own ASN: leaf1 sees leaf2's prefix as <M>[{unique ? '6500x' : '65000'} {asnOf('L2')}]</M> from every spine.</li>
          <li>Leaves send that best path on to the spines: <M>[{asnOf('L1')} {unique ? '6500x' : 65000} {asnOf('L2')}]</M>. {unique ? 'With unique spine ASNs another spine accepts it as a longer backup path, which is what allows path hunting after a failure.' : 'Every spine sees its own AS 65000 in it and drops it: a withdrawal is final at once, no path hunting.'} A leaf also drops its own prefix coming back (own ASN in the path).</li>
          <li>Best path = shortest AS_PATH. ECMP set = paths of equal length with an identical AS_PATH ({unique ? 'differs here per spine' : `here always ${65000} + leaf ASN`}), or any equal-length AS_PATH with multipath-relax, capped at maximum-paths.</li>
        </ol>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Simplified model: one link per spine–leaf pair, every router advertises only its best path (no add-path), all other attributes (weight, local-pref, origin, MED)
        equal, ties broken by lowest router as a stand-in for router-ID. Real convergence also involves BFD/hold timers and update batching; with link-down detection and
        MRAI 0 a single-link failure typically converges in well under a second, but timing is implementation-specific. ASNs are from the 16-bit private range (RFC 6996).
      </p>
    </div>
  );
}
