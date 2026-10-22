import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

// ---------- pure model: 2 switches, 4 HCAs, simplified OpenSM sweep ----------

export interface IbNode { id: string; kind: 'sw' | 'ca'; name: string; guid: bigint; lid: number }
/** GUIDs: EUI-64 style, 24-bit OUI 00:02:c9 + 40-bit vendor-assigned part (illustrative values). */
export const NODES: IbNode[] = [
  { id: 'A', kind: 'ca', name: 'hostA (SM)', guid: 0x0002c90300b1a001n, lid: 0x0001 },
  { id: 'SW1', kind: 'sw', name: 'SW1', guid: 0x0002c903000a0100n, lid: 0x0002 },
  { id: 'B', kind: 'ca', name: 'hostB', guid: 0x0002c90300b1a002n, lid: 0x0003 },
  { id: 'SW2', kind: 'sw', name: 'SW2', guid: 0x0002c903000a0200n, lid: 0x0004 },
  { id: 'C', kind: 'ca', name: 'hostC', guid: 0x0002c90300b1a003n, lid: 0x0005 },
  { id: 'D', kind: 'ca', name: 'hostD', guid: 0x0002c90300b1a004n, lid: 0x0006 },
];
export interface Link { a: string; ap: number; b: string; bp: number; id: string }
export const LINKS: Link[] = [
  { a: 'SW1', ap: 1, b: 'A', bp: 1, id: 'l1' }, { a: 'SW1', ap: 2, b: 'B', bp: 1, id: 'l2' },
  { a: 'SW1', ap: 3, b: 'SW2', bp: 3, id: 'isl3' }, { a: 'SW1', ap: 4, b: 'SW2', bp: 4, id: 'isl4' },
  { a: 'SW2', ap: 1, b: 'C', bp: 1, id: 'l3' }, { a: 'SW2', ap: 2, b: 'D', bp: 1, id: 'l4' },
];

export const hex = (n: number | bigint, w: number) => `0x${n.toString(16).padStart(w, '0')}`;
export function guidStr(g: bigint) { return hex(g, 16); }
/** Default GID = 64-bit subnet prefix fe80:0000:0000:0000 followed by the 64-bit port GUID. */
export function defaultGid(g: bigint) {
  const h = g.toString(16).padStart(16, '0');
  return `fe80:0000:0000:0000:${h.slice(0, 4)}:${h.slice(4, 8)}:${h.slice(8, 12)}:${h.slice(12)}`;
}

/** Peer at the other end of (node, port), or null if no cable / link failed. */
export function peer(node: string, port: number, up: (l: Link) => boolean): { node: string; port: number } | null {
  for (const l of LINKS) {
    if (!up(l)) continue;
    if (l.a === node && l.ap === port) return { node: l.b, port: l.bp };
    if (l.b === node && l.bp === port) return { node: l.a, port: l.ap };
  }
  return null;
}

export type Engine = 'minhop' | 'updn';
export type Lft = Record<string, Record<number, number>>; // switch -> DLID -> out port

/**
 * Simplified routing: for every switch and every destination LID take the output ports on minimum-hop
 * paths, then pick the least-used one (tie: lowest port), processing LIDs in ascending order: minhop's
 * balancing idea. updn first ranks switches by distance from a root (SW1) and keeps only paths that
 * never go down then up; on this two-switch topology no shortest path goes down then up, so that removes nothing, so both give the same LFTs.
 */
export function computeLfts(islDown: boolean, engine: Engine): { lft: Lft; forbidden: number } {
  const up = (l: Link) => !(islDown && l.id === 'isl4');
  const sws = NODES.filter((n) => n.kind === 'sw');
  const ports = (n: string) => LINKS.filter((l) => up(l) && (l.a === n || l.b === n)).map((l) => (l.a === n ? l.ap : l.bp)).sort((x, y) => x - y);
  // hop distance from every node to every destination node (BFS over node graph)
  const dist = (dst: string) => {
    const d: Record<string, number> = { [dst]: 0 }; const q = [dst];
    while (q.length) { const n = q.shift()!; for (const p of ports(n)) { const o = peer(n, p, up)!; if (d[o.node] === undefined) { d[o.node] = d[n] + 1; q.push(o.node); } } }
    return d;
  };
  const lft: Lft = {}; let forbidden = 0;
  const rank: Record<string, number> = { SW1: 0, SW2: 1 }; // updn root = SW1
  for (const sw of sws) {
    lft[sw.id] = {};
    const use: Record<number, number> = {};
    for (const dst of [...NODES].sort((a, b) => a.lid - b.lid)) {
      if (dst.id === sw.id) { lft[sw.id][dst.lid] = 0; continue; }
      const d = dist(dst.id);
      if (d[sw.id] === undefined) continue;
      let cands = ports(sw.id).filter((p) => d[peer(sw.id, p, up)!.node] === d[sw.id] - 1);
      if (engine === 'updn') {
        // a hop SW2 -> SW1 is "up", SW1 -> SW2 "down"; a path down then up is illegal. With two switches
        // and hosts as leaves, no shortest path contains down-then-up, so nothing is filtered.
        const legal = cands.filter((p) => { const nx = peer(sw.id, p, up)!.node; return !(rank[nx] !== undefined && rank[nx] > rank[sw.id] && dst.kind === 'sw' && rank[dst.id] < rank[nx]); });
        forbidden += cands.length - legal.length; cands = legal;
      }
      const best = cands.sort((x, y) => (use[x] ?? 0) - (use[y] ?? 0) || x - y)[0];
      lft[sw.id][dst.lid] = best;
      use[best] = (use[best] ?? 0) + 1;
    }
  }
  return { lft, forbidden };
}

export interface Hop { at: string; inPort: number; outPort: number; next: string }
/** Follow LRH.DLID through the LFTs from source HCA to destination. */
export function trace(src: string, dst: string, lft: Lft, islDown: boolean): Hop[] {
  const up = (l: Link) => !(islDown && l.id === 'isl4');
  const dlid = NODES.find((n) => n.id === dst)!.lid;
  const hops: Hop[] = [];
  let cur = peer(src, 1, up)!;
  for (let i = 0; i < 6 && cur; i++) {
    const out = lft[cur.node]?.[dlid];
    if (out === undefined) break;
    const nx = peer(cur.node, out, up);
    hops.push({ at: cur.node, inPort: cur.port, outPort: out, next: nx?.node ?? '?' });
    if (!nx || nx.node === dst) break;
    cur = nx;
  }
  return hops;
}

export type Member = 'none' | 'limited' | 'full';
/** Two ports can talk in a partition only if both are members and at least one is a full member. */
export const canTalk = (a: Member, b: Member) => a !== 'none' && b !== 'none' && (a === 'full' || b === 'full');
export const pkeyValue = (base: number, m: Member) => (m === 'full' ? base | 0x8000 : base & 0x7fff);

// ---------- UI ----------

const STEPS = ['Links trained', 'Discover (SMPs)', 'Assign LIDs', 'Compute routes', 'Program LFTs', 'Activate ports'];
const node = (id: string) => NODES.find((n) => n.id === id)!;
const POS: Record<string, [number, number]> = { SW1: [180, 50], SW2: [460, 50], A: [90, 170], B: [270, 170], C: [370, 170], D: [550, 170] };
const DISCOVERY: [string, string, string][] = [
  ['(local)', 'A', 'NodeInfo: CA, 1 port, port GUID'],
  ['1', 'SW1', 'NodeInfo: switch; SwitchInfo; PortInfo of ports 1-4'],
  ['1,2', 'B', 'NodeInfo: CA'],
  ['1,3', 'SW2', 'NodeInfo: switch (new GUID)'],
  ['1,4', 'SW2', 'same node GUID again → second SW1-SW2 link, not a new node'],
  ['1,3,1', 'C', 'NodeInfo: CA'],
  ['1,3,2', 'D', 'NodeInfo: CA'],
];

export default function IbAddressing() {
  const [step, setStep] = useState(0);
  const [engine, setEngine] = useState<Engine>('minhop');
  const [islDown, setIslDown] = useState(false);
  const [src, setSrc] = useState('B');
  const [dst, setDst] = useState('D');
  const [mem, setMem] = useState<Record<string, Member>>({ A: 'full', B: 'limited', C: 'limited', D: 'full' });
  const { lft, forbidden } = useMemo(() => computeLfts(islDown, engine), [islDown, engine]);
  const hops = useMemo(() => trace(src, dst, lft, islDown), [src, dst, lft, islDown]);
  const cas = NODES.filter((n) => n.kind === 'ca');
  const lidsOn = step >= 2, active = step >= 5;
  const portState = step >= 5 ? 'Active' : 'Init';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1">
        {STEPS.map((s, i) => (
          <button key={s} type="button" aria-pressed={i === step} onClick={() => setStep(i)}
            className={`rounded-md border px-2 py-1 font-mono text-xs ${i === step ? 'border-accent bg-accent-soft text-accent' : i < step ? 'border-line bg-panel-2' : 'border-line bg-panel hover:bg-panel-2'}`}>{i}. {s}</button>
        ))}
        <button type="button" onClick={() => setStep(Math.min(5, step + 1))} disabled={step === 5} className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:bg-panel-2 disabled:opacity-40">Next ▶</button>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <svg viewBox="0 0 640 225" className="w-full" role="img" aria-label="InfiniBand subnet with two switches and four HCAs">
          {LINKS.map((l) => {
            const down = islDown && l.id === 'isl4';
            const [x1, y1] = POS[l.a], [x2, y2] = POS[l.b];
            const isl = l.id.startsWith('isl'), off = l.id === 'isl3' ? -8 : 8;
            // Port labels sit just outside the switch box: ISL labels beside the box edge (isl3 above its line, isl4 below),
            // host-link labels 10 px below the box, on the outer side of the link.
            const islY = y1 + off + (off < 0 ? -3 : 11);
            const hx = x1 + (x2 - x1) * (28 / (y2 - y1)), hLeft = x2 < x1;
            const onPath = active && hops.some((h) => (h.at === l.a && h.outPort === l.ap) || (h.at === l.b && h.outPort === l.bp) || (h.at === l.a && h.inPort === l.ap) || (h.at === l.b && h.inPort === l.bp));
            return (
              <g key={l.id}>
                <line x1={x1} y1={y1 + (isl ? off : 0)} x2={x2} y2={y2 + (isl ? off : 0)} stroke={down ? 'var(--danger)' : onPath ? 'var(--data)' : step >= 1 ? 'var(--accent)' : 'var(--border)'} strokeWidth={onPath ? 3 : 1.5} strokeDasharray={down ? '5 4' : undefined} />
                {isl
                  ? <text x={x1 + 52} y={islY} fontSize={10} textAnchor="start" fill="var(--muted)" fontFamily="var(--font-mono)">p{l.ap}</text>
                  : <text x={hLeft ? hx - 6 : hx + 6} y={y1 + 28} fontSize={10} textAnchor={hLeft ? 'end' : 'start'} fill="var(--muted)" fontFamily="var(--font-mono)">p{l.ap}</text>}
                {isl && <text x={x2 - 52} y={islY} fontSize={10} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">p{l.bp}</text>}
              </g>
            );
          })}
          {NODES.map((n) => {
            const [x, y] = POS[n.id], sw = n.kind === 'sw', found = step >= 1;
            return (
              <g key={n.id}>
                <rect x={x - 48} y={y - 18} width={96} height={36} rx={6} fill="var(--panel-2)" stroke={sw ? 'var(--data)' : 'var(--accent)'} strokeWidth={found ? 1.6 : 0.8} opacity={found || n.id === 'A' ? 1 : 0.55} />
                <text x={x} y={y - 3} fontSize={11} textAnchor="middle" fill="var(--text)" fontFamily="var(--font-mono)" fontWeight={700}>{n.name}</text>
                <text x={x} y={y + 11} fontSize={10} textAnchor="middle" fill={lidsOn ? 'var(--data)' : 'var(--muted)'} fontFamily="var(--font-mono)">LID {lidsOn ? hex(n.lid, 4) : '0x0000'}</text>
                {!sw && <text x={x} y={y + 32} fontSize={9} textAnchor="middle" fill={active ? 'var(--accent)' : 'var(--warn)'} fontFamily="var(--font-mono)">LinkUp / {portState}</text>}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm">
        {step === 0 && <p>All cables have trained: physical state <b>LinkUp</b>, logical state <b>Init</b>. No port has a LID (0x0000) and no switch has a forwarding table, so no data can flow yet. Only the SM on hostA can talk, using directed-route SMPs on QP0 / VL15.</p>}
        {step === 1 && (
          <div className="overflow-x-auto">
            <p className="mb-2">The SM walks the fabric with <b>directed-route</b> SMPs: the path is a list of output ports, hop by hop, so it works before any LID exists. Each reply carries the node GUID, so a node reached twice is recognised.</p>
            <table className="w-full min-w-[440px] text-left text-xs"><thead className="font-mono text-[10px] uppercase text-muted"><tr><th className="pr-2">DR path (out ports)</th><th className="pr-2">Reached</th><th className="pr-2">Node GUID</th><th>Learned</th></tr></thead>
              <tbody>{DISCOVERY.map(([p, n, w]) => <tr key={p} className="border-t border-line"><td className="py-1 pr-2 font-mono">{p}</td><td className="pr-2 font-mono">{node(n).name}</td><td className="pr-2 font-mono">{guidStr(node(n).guid)}</td><td className="text-muted">{w}</td></tr>)}</tbody></table>
          </div>
        )}
        {step === 2 && (
          <div className="overflow-x-auto">
            <p className="mb-2">The SM assigns unicast LIDs from <b>0x0001-0xBFFF</b> (LMC 0: one per port). HCAs get a LID per port; a switch gets one LID, on its management port 0. GUIDs never change; LIDs are the SM's choice (here in discovery order; OpenSM keeps a GUID-to-LID cache to keep them stable).</p>
            <table className="w-full min-w-[520px] text-left text-xs"><thead className="font-mono text-[10px] uppercase text-muted"><tr><th className="pr-2">Node</th><th className="pr-2">Port GUID (OUI · vendor part)</th><th className="pr-2">LID</th><th>Default GID (port 1 / switch port 0)</th></tr></thead>
              <tbody>{NODES.map((n) => { const g = guidStr(n.guid); return <tr key={n.id} className="border-t border-line"><td className="py-1 pr-2 font-mono">{n.name}</td><td className="pr-2 font-mono"><span className="text-data">{g.slice(0, 8)}</span>{g.slice(8)}</td><td className="pr-2 font-mono text-accent">{hex(n.lid, 4)}</td><td className="font-mono text-muted">{defaultGid(n.guid)}</td></tr>; })}</tbody></table>
          </div>
        )}
        {(step === 3 || step === 4) && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-1">{(['minhop', 'updn'] as const).map((e) => <button key={e} type="button" aria-pressed={engine === e} onClick={() => setEngine(e)}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${engine === e ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{e}</button>)}</div>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={islDown} onChange={(e) => setIslDown(e.target.checked)} className="accent-[var(--accent)]" />Fail SW1 p4 ↔ SW2 p4 (heavy sweep, recompute)</label>
            </div>
            <p>{step === 3 ? 'For each switch and each destination LID the engine picks an output port on a shortest path, balancing destinations across the two inter-switch links.' : 'The SM writes each switch\'s Linear Forwarding Table with SubnSet(LinearForwardingTable) SMPs, in blocks of 64 LIDs (block 0 = LIDs 0-63 covers this whole subnet).'}{' '}
              {engine === 'updn' ? `Up/Down: root SW1 (rank 0), SW2 rank 1; paths may go up then down, never down then up. ${forbidden} candidate port(s) removed: with two switches and hosts only at the edge, no shortest path goes down then up, so the tables equal minhop's. On meshes or rings that restriction is what prevents credit loops.` : 'minhop: shortest paths with per-port balancing; it does not guarantee deadlock freedom on topologies with cycles.'}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {['SW1', 'SW2'].map((s) => (
                <div key={s} className="overflow-x-auto"><div className="font-mono text-xs font-semibold">{s} LFT {step === 4 ? <span className="text-accent">(programmed)</span> : <span className="text-muted">(computed)</span>}</div>
                  <table className="w-full text-left text-xs"><thead className="font-mono text-[10px] uppercase text-muted"><tr><th className="pr-2">DLID</th><th className="pr-2">→ out port</th><th>leads to</th></tr></thead>
                    <tbody>{Object.entries(lft[s]).map(([d, p]) => { const n = NODES.find((x) => x.lid === Number(d))!; const nx = p === 0 ? 'this switch (port 0)' : node(peer(s, p, (l) => !(islDown && l.id === 'isl4'))!.node).name; return <tr key={d} className="border-t border-line"><td className="py-0.5 pr-2 font-mono">{hex(Number(d), 4)} <span className="text-muted">{n.name}</span></td><td className="pr-2 font-mono text-data">{p}</td><td className="text-muted">{nx}</td></tr>; })}</tbody></table>
                </div>
              ))}
            </div>
          </div>
        )}
        {step === 5 && <p>Every port is set to <b>Armed</b>, then <b>Active</b>. Before that, each HCA port was given (via PortInfo and related SubnSet SMPs) its LID, the SM LID ({hex(1, 4)}), its P_Key table and SL2VL table. Now data packets are forwarded: try a packet below.</p>}
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 text-sm font-semibold">Forward a packet by LRH DLID</div>
        <div className="flex flex-wrap gap-4">
          {[['Source', src, setSrc], ['Destination', dst, setDst]].map(([label, v, set]) => (
            <div key={label as string}><div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label as string}</div>
              <div className="flex gap-1">{cas.map((c) => <button key={c.id} type="button" aria-pressed={v === c.id} onClick={() => (set as (x: string) => void)(c.id)}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${v === c.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{c.id}</button>)}</div></div>
          ))}
        </div>
        {!active ? <p className="mt-2 text-sm text-warn">Ports are not Active yet (step {step} of 5): HCAs have {lidsOn ? 'LIDs but ' : 'no LIDs and '}cannot send data. Step through the sweep first.</p>
          : src === dst ? <p className="mt-2 text-sm text-muted">Pick two different hosts.</p> : (
            <div className="mt-2 space-y-1 text-sm">
              <div className="font-mono text-xs">LRH: SLID <span className="text-accent">{hex(node(src).lid, 4)}</span> · DLID <span className="text-accent">{hex(node(dst).lid, 4)}</span> · SL 0 · LNH = BTH (no GRH inside one subnet)</div>
              <ol className="list-decimal pl-5 text-xs text-muted">
                {hops.map((h, i) => <li key={i}><span className="text-fg">{h.at}</span>: in on port {h.inPort}, LFT[{hex(node(dst).lid, 4)}] = port <span className="text-data">{h.outPort}</span> → {node(h.next).name}</li>)}
                <li>{node(dst).name} HCA: DLID matches its LID; checks P_Key, QP and PSN, then delivers.</li>
              </ol>
              <div className="text-xs text-muted">Destination GID (used in a GRH or by RDMA CM): <span className="font-mono">{defaultGid(node(dst).guid)}</span></div>
            </div>
          )}
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 text-sm font-semibold">P_Key membership: partition 0x0001</div>
        <div className="flex flex-wrap gap-4">
          {cas.map((c) => (
            <div key={c.id}><div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{c.name} · {mem[c.id] === 'none' ? 'no entry' : hex(pkeyValue(0x0001, mem[c.id]), 4)}</div>
              <div className="flex gap-1">{(['none', 'limited', 'full'] as const).map((m) => <button key={m} type="button" aria-pressed={mem[c.id] === m} onClick={() => setMem({ ...mem, [c.id]: m })}
                className={`rounded-md border px-2 py-0.5 font-mono text-xs ${mem[c.id] === m ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{m}</button>)}</div></div>
          ))}
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="text-xs"><thead><tr><th className="p-1" />{cas.map((c) => <th key={c.id} className="p-1 font-mono font-normal text-muted">{c.id}</th>)}</tr></thead>
            <tbody>{cas.map((a) => <tr key={a.id}><td className="p-1 font-mono text-muted">{a.id}</td>{cas.map((b) => {
              const ok = a.id === b.id ? null : canTalk(mem[a.id], mem[b.id]);
              return <td key={b.id} className={`p-1 text-center font-mono ${ok === null ? 'text-muted' : ok ? 'text-accent' : 'text-danger'}`}>{ok === null ? '·' : ok ? 'yes' : 'no'}</td>;
            })}</tr>)}</tbody></table>
        </div>
        <p className="mt-1 text-xs text-muted">Bit 15 of the 16-bit P_Key is the membership bit: 0x8001 = full, 0x0001 = limited member of partition 0x0001. Rule: both ports must hold the partition and at least one must be full, so two limited members cannot talk (try B and C). Default partition: 0xFFFF full / 0x7FFF limited.</p>
      </div>

      <div className="flex flex-wrap gap-2"><Pill>unicast LIDs 0x0001-0xBFFF</Pill><Pill>multicast 0xC000-0xFFFE</Pill><Pill>permissive 0xFFFF</Pill><Pill>GID = fe80::/64 prefix + port GUID</Pill></div>
      <p className="text-[11px] leading-relaxed text-muted">
        Simplified sweep: GUIDs, LID order and DR paths are illustrative (OUI 00:02:c9 is a Mellanox/NVIDIA OUI; on many HCAs port 1's GUID equals the node GUID, check ibstat).
        Real OpenSM minhop/updn balance differently in detail, ftree is the usual choice for fat trees, and the SM also programs multicast tables, SL2VL and VL arbitration.
        A switch's external ports have no LIDs of their own; the switch is addressed via port 0.
      </p>
    </div>
  );
}
