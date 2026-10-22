import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

// ---------- Pure IPv4 math (unit-testable). Addresses are unsigned 32-bit numbers. ----------

export function parseIPv4(s: string): number | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

export function ipToString(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

export function parseCidr(s: string): { addr: number; len: number } | null {
  const [a, l, ...rest] = s.trim().split('/');
  if (rest.length || l === undefined || !/^\d{1,2}$/.test(l)) return null;
  const addr = parseIPv4(a);
  const len = Number(l);
  if (addr === null || len > 32) return null;
  return { addr, len };
}

export const maskOf = (len: number) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
export const blockSize = (len: number) => 2 ** (32 - len);
export const networkOf = (addr: number, len: number) => (addr & maskOf(len)) >>> 0;

export interface CidrInfo {
  network: number; broadcast: number | null; first: number; last: number; total: number; usable: number;
  mask: number; wildcard: number; note: string;
}

export function cidrInfo(addr: number, len: number): CidrInfo {
  const network = networkOf(addr, len);
  const total = blockSize(len);
  const mask = maskOf(len);
  const top = network + total - 1;
  if (len === 32) return { network, broadcast: null, first: network, last: network, total, usable: 1, mask, wildcard: 0, note: 'Host route: a single address (loopbacks, /32 host routes). No network or broadcast address.' };
  if (len === 31) return { network, broadcast: null, first: network, last: top, total, usable: 2, mask, wildcard: 1, note: 'RFC 3021 point-to-point link: both addresses are usable, there is no broadcast address.' };
  return { network, broadcast: top, first: network + 1, last: top - 1, total, usable: total - 2, mask, wildcard: total - 1, note: 'First address = network, last = broadcast; usable hosts = 2^(32 − len) − 2.' };
}

export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

export interface RailPlanInput { servers: number; rails: number; perLeaf: number; base: number; baseLen: number }
export interface RailPlan {
  error: string | null; base: number; leavesPerRail: number; leafBlock: number; leafLen: number;
  railBlock: number; railLen: number; used: number; available: number; minBaseLen: number;
}

/** /31 per host link. Each rail gets one aligned block; inside it each leaf gets an aligned block sized for perLeaf /31s. */
export function railPlan({ servers, rails, perLeaf, base, baseLen }: RailPlanInput): RailPlan {
  const n = Math.max(1, perLeaf);
  const leavesPerRail = Math.ceil(servers / n);
  const leafBlock = nextPow2(2 * n);
  const railBlock = nextPow2(leavesPerRail) * leafBlock;
  const used = rails * railBlock;
  const available = blockSize(baseLen);
  const minBaseLen = 32 - Math.ceil(Math.log2(used));
  const b = networkOf(base, baseLen);
  const error = used > available
    ? `Overflow: ${rails} rails × ${railBlock.toLocaleString('en-US')} addresses = ${used.toLocaleString('en-US')} addresses, but /${baseLen} holds only ${available.toLocaleString('en-US')}. Use a base prefix of /${minBaseLen} or shorter, fewer servers per leaf, or fewer rails.`
    : null;
  return { error, base: b, leavesPerRail, leafBlock, leafLen: 32 - Math.log2(leafBlock), railBlock, railLen: 32 - Math.log2(railBlock), used, available, minBaseLen };
}

/** Link addresses for server s (0-based) on rail r (0-based). The leaf takes the even address, the host the odd one. */
export function linkFor(p: RailPlan, perLeaf: number, s: number, r: number) {
  const leaf = Math.floor(s / perLeaf);
  const port = s % perLeaf;
  const net = p.base + r * p.railBlock + leaf * p.leafBlock + 2 * port;
  return { leaf, port, net, leafIp: net, hostIp: net + 1 };
}

// ---------- UI ----------

const fmt = (n: number) => n.toLocaleString('en-US');
const bin = (n: number, len: number) => {
  const b = n.toString(2).padStart(32, '0');
  return [0, 8, 16, 24].map((i) => b.slice(i, i + 8)).join('.').split('').map((c, i) => {
    const bitIndex = i - Math.floor(i / 9);
    return { c, net: c !== '.' && bitIndex < len };
  });
};

function Out({ label, value, tone = 'text-fg' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`break-all font-mono text-base font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function NumIn({ id, label, value, onChange, min, max }: { id: string; label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</label>
      <NumInput id={id} integer min={min} max={max} value={value} onValue={onChange}
        className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
    </div>
  );
}

const EXAMPLES = ['10.0.3.77/26', '10.0.3.11/24', '10.0.0.10/31', '10.255.0.1/32', '172.16.5.4/12'];
const PAGE = 64;

export default function SubnetCalculator() {
  const [cidr, setCidr] = useState('10.0.3.77/26');
  const parsed = parseCidr(cidr);
  const info = parsed ? cidrInfo(parsed.addr, parsed.len) : null;

  const [servers, setServers] = useState(64);
  const [rails, setRails] = useState(8);
  const [perLeaf, setPerLeaf] = useState(32);
  const [baseStr, setBaseStr] = useState('10.0.0.0/16');
  const [railFilter, setRailFilter] = useState<number | 'all'>('all');
  const [nodeFilter, setNodeFilter] = useState('');
  const [sortBy, setSortBy] = useState<'node' | 'rail'>('node');
  const [shown, setShown] = useState(PAGE);
  const baseParsed = parseCidr(baseStr);
  const baseAddr = baseParsed?.addr ?? -1, baseLen = baseParsed?.len ?? -1;
  const plan = useMemo(() => (baseAddr >= 0 ? railPlan({ servers, rails, perLeaf, base: baseAddr, baseLen }) : null), [servers, rails, perLeaf, baseAddr, baseLen]);

  const rows = useMemo(() => {
    if (!plan || plan.error) return [];
    const out: { s: number; r: number; leaf: number; port: number; net: number }[] = [];
    const q = nodeFilter.trim().toLowerCase();
    const railList = railFilter === 'all' ? Array.from({ length: rails }, (_, i) => i) : [railFilter];
    const push = (s: number, r: number) => {
      const name = `node${String(s + 1).padStart(3, '0')}`;
      if (q && !name.includes(q) && !String(s + 1).startsWith(q)) return;
      const l = linkFor(plan, perLeaf, s, r);
      out.push({ s, r, leaf: l.leaf, port: l.port, net: l.net });
    };
    if (sortBy === 'node') { for (let s = 0; s < servers; s++) for (const r of railList) push(s, r); }
    else { for (const r of railList) for (let s = 0; s < servers; s++) push(s, r); }
    return out;
  }, [plan, servers, rails, perLeaf, railFilter, nodeFilter, sortBy]);

  const leafRows = useMemo(() => {
    if (!plan || plan.error) return [];
    const out: { r: number; l: number; links: number; net: number }[] = [];
    for (let r = 0; r < rails; r++) {
      if (railFilter !== 'all' && r !== railFilter) continue;
      for (let l = 0; l < plan.leavesPerRail; l++) out.push({ r, l, links: Math.min(perLeaf, servers - l * perLeaf), net: plan.base + r * plan.railBlock + l * plan.leafBlock });
    }
    return out;
  }, [plan, rails, perLeaf, servers, railFilter]);

  return (
    <div className="space-y-6">
      {/* CIDR calculator */}
      <section className="space-y-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">1 · CIDR calculator</div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label htmlFor="sc-cidr" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">IPv4 address / prefix</label>
            <input id="sc-cidr" value={cidr} onChange={(e) => setCidr(e.target.value)} spellCheck={false} aria-invalid={!parsed}
              className={`w-full rounded-md border bg-panel px-2 py-1 font-mono text-sm ${parsed ? 'border-line' : 'border-danger'}`} />
          </div>
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setCidr(e)} aria-pressed={e === cidr}
              className={`rounded-md border px-2 py-1 font-mono text-xs ${e === cidr ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{e}</button>
          ))}
        </div>
        {!parsed || !info ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">Enter an address like 10.0.3.77/26 (four octets 0-255, prefix 0-32).</div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs" tabIndex={0} role="region" aria-label="Address in binary">
              <div className="whitespace-nowrap">{bin(parsed.addr, parsed.len).map((b, i) => <span key={i} className={b.c === '.' ? 'text-muted' : b.net ? 'text-accent' : 'text-data'}>{b.c}</span>)}</div>
              <div className="mt-1 text-[10px] text-muted"><span className="text-accent">{parsed.len} network bits</span> · <span className="text-data">{32 - parsed.len} host bits</span> · block of 2^{32 - parsed.len} = {fmt(info.total)} addresses</div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
              <Out label="Network" value={`${ipToString(info.network)}/${parsed.len}`} tone="text-accent" />
              <Out label="Broadcast" value={info.broadcast === null ? 'none' : ipToString(info.broadcast)} tone={info.broadcast === null ? 'text-muted' : 'text-fg'} />
              <Out label="First usable" value={ipToString(info.first)} />
              <Out label="Last usable" value={ipToString(info.last)} />
              <Out label="Usable hosts" value={fmt(info.usable)} tone="text-data" />
              <Out label="Addresses" value={fmt(info.total)} />
              <Out label="Netmask" value={ipToString(info.mask)} />
              <Out label="Wildcard" value={ipToString(info.wildcard)} />
            </div>
            <p className="text-sm text-muted">{info.note}{parsed.addr !== info.network && <> {ipToString(parsed.addr)} AND {ipToString(info.mask)} = {ipToString(info.network)}.</>}</p>
          </>
        )}
      </section>

      {/* Rail addressing plan */}
      <section className="space-y-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">2 · Rail addressing plan (/31 per host link)</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumIn id="sc-servers" label="Servers" value={servers} onChange={(v) => { setServers(v); setShown(PAGE); }} min={1} max={8192} />
          <NumIn id="sc-rails" label="Rails (NICs/server)" value={rails} onChange={(v) => { setRails(v); setRailFilter('all'); }} min={1} max={16} />
          <NumIn id="sc-perleaf" label="Servers per rail leaf" value={perLeaf} onChange={setPerLeaf} min={1} max={512} />
          <div>
            <label htmlFor="sc-base" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Base prefix</label>
            <input id="sc-base" value={baseStr} onChange={(e) => setBaseStr(e.target.value)} spellCheck={false} aria-invalid={!baseParsed}
              className={`w-full rounded-md border bg-panel px-2 py-1 font-mono text-sm ${baseParsed ? 'border-line' : 'border-danger'}`} />
          </div>
        </div>

        {!plan ? <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">Base prefix must look like 10.0.0.0/16.</div> : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>leaves per rail = ⌈{fmt(servers)} / {perLeaf}⌉ = <span className="font-mono text-fg">{plan.leavesPerRail}</span></li>
              <li>per leaf: {perLeaf} /31s = {2 * perLeaf} addresses → aligned block {fmt(plan.leafBlock)} = <span className="font-mono text-fg">/{plan.leafLen}</span></li>
              <li>per rail: {plan.leavesPerRail} leaf block(s), rounded up to {nextPow2(plan.leavesPerRail)} × {fmt(plan.leafBlock)} = {fmt(plan.railBlock)} = <span className="font-mono text-fg">/{plan.railLen}</span></li>
              <li>total: {rails} rails × {fmt(plan.railBlock)} = <span className="font-mono text-fg">{fmt(plan.used)}</span> of {fmt(plan.available)} addresses in /{baseParsed?.len} (needs /{plan.minBaseLen} or shorter)</li>
            </ol>
            {baseParsed && baseParsed.addr !== plan.base && <p className="text-xs text-warn">Base {ipToString(baseParsed.addr)} is not aligned to /{baseParsed.len}; using the network address {ipToString(plan.base)}.</p>}
            {plan.error ? <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">⚠ {plan.error}</div> : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill>{fmt(servers * rails)} host links = {fmt(servers * rails)} /31s</Pill>
                  <Pill>{fmt(rails * plan.leavesPerRail)} rail leaves</Pill>
                  <Pill>{((servers * rails * 2 / plan.available) * 100).toFixed(1)} % of base used by links</Pill>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Rail</div>
                    <div className="flex flex-wrap gap-1">
                      {(['all', ...Array.from({ length: rails }, (_, i) => i)] as (number | 'all')[]).map((r) => (
                        <button key={String(r)} type="button" aria-pressed={r === railFilter} aria-label={r === 'all' ? 'All rails' : `Rail ${r}`} onClick={() => { setRailFilter(r); setShown(PAGE); }}
                          className={`rounded-md border px-2 py-1 font-mono text-xs ${r === railFilter ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{r === 'all' ? 'all' : r}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label htmlFor="sc-node" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Node filter</label>
                    <input id="sc-node" value={nodeFilter} placeholder="e.g. node012" onChange={(e) => { setNodeFilter(e.target.value); setShown(PAGE); }}
                      className="w-36 rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs" />
                  </div>
                </div>

                <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Host link addresses">
                  <table className="w-full text-left text-xs">
                    <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                      <tr>
                        <th className="py-1 pr-3" aria-sort={sortBy === 'node' ? 'ascending' : 'none'}><button type="button" onClick={() => setSortBy('node')} aria-pressed={sortBy === 'node'} className={sortBy === 'node' ? 'text-accent' : ''}>Node {sortBy === 'node' ? '▾' : ''}</button></th>
                        <th className="py-1 pr-3" aria-sort={sortBy === 'rail' ? 'ascending' : 'none'}><button type="button" onClick={() => setSortBy('rail')} aria-pressed={sortBy === 'rail'} className={sortBy === 'rail' ? 'text-accent' : ''}>Rail {sortBy === 'rail' ? '▾' : ''}</button></th>
                        <th className="py-1 pr-3">Leaf / port</th><th className="py-1 pr-3">Link /31</th><th className="py-1 pr-3">Leaf IP</th><th className="py-1">Host IP</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {rows.slice(0, shown).map((x) => (
                        <tr key={`${x.s}-${x.r}`} className="border-t border-line">
                          <td className="py-1 pr-3">node{String(x.s + 1).padStart(3, '0')}</td><td className="py-1 pr-3">{x.r}</td>
                          <td className="py-1 pr-3 text-muted">r{x.r}-leaf{x.leaf + 1} / {x.port + 1}</td>
                          <td className="py-1 pr-3 text-muted">{ipToString(x.net)}/31</td><td className="py-1 pr-3 text-data">{ipToString(x.net)}</td><td className="py-1 text-accent">{ipToString(x.net + 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span aria-live="polite">showing {fmt(Math.min(shown, rows.length))} of {fmt(rows.length)} links</span>
                  {shown < rows.length && <button type="button" onClick={() => setShown(shown + 256)} className="rounded-md border border-line bg-panel px-2 py-1 hover:bg-panel-2">show 256 more</button>}
                </div>

                <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Rail leaf summary prefixes">
                  <table className="w-full text-left text-xs">
                    <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted"><tr><th className="py-1 pr-3">Rail leaf</th><th className="py-1 pr-3 text-right">/31s used</th><th className="py-1 pr-3">Summary prefix (advertise)</th><th className="py-1">Rail summary</th></tr></thead>
                    <tbody className="font-mono">
                      {leafRows.slice(0, PAGE).map((x) => (
                        <tr key={`${x.r}-${x.l}`} className="border-t border-line">
                          <td className="py-1 pr-3">r{x.r}-leaf{x.l + 1}</td><td className="py-1 pr-3 text-right">{x.links} / {plan.leafBlock / 2}</td>
                          <td className="py-1 pr-3 text-accent">{ipToString(x.net)}/{plan.leafLen}</td>
                          <td className="py-1 text-muted">{ipToString(plan.base + x.r * plan.railBlock)}/{plan.railLen}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {leafRows.length > PAGE && <div className="mt-1 text-xs text-muted">first {PAGE} of {fmt(leafRows.length)} leaves; filter by rail to see the rest</div>}
                </div>
              </>
            )}
          </>
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-muted">
        CIDR per RFC 4632; /31 per RFC 3021. Plan model: every NIC gets its own /31 to its rail leaf, the leaf takes the even (lower) address and the host
        the odd one; each leaf's block is sized for "servers per leaf" links and aligned, so the leaf can advertise one summary, and each rail is one
        aligned block so a spine can summarise a rail. Blocks are rounded up to powers of two, so some addresses stay unused. This is one illustrative
        convention: real plans also reserve loopbacks, leaf-spine /31s and growth space, and some designs use a shared subnet per rail leaf instead.
      </p>
    </div>
  );
}
