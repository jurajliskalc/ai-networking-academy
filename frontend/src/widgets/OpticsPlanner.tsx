import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

export type Speed = 100 | 200 | 400 | 800 | 1600;
export const SPEEDS: Speed[] = [100, 200, 400, 800, 1600];
export type MediaId = 'dac' | 'acc' | 'aec' | 'aoc' | 'sr' | 'dr' | 'fr' | 'lr';

interface Media {
  id: MediaId; name: string; kind: 'copper' | 'active cable' | 'transceiver';
  /** typical max reach in metres by port speed (null = not a common product at that speed) */
  reach: Record<Speed, number | null>;
  /** typical power per end / per module in W by port speed (order of magnitude) */
  watts: Record<Speed, number | null>;
  cost: 1 | 2 | 3 | 4; pros: string; cons: string;
}

// Order-of-magnitude values, consistent with the optics-cabling-power lesson: copper ~1-3 m at 100G/lane and shrinking at 200G/lane,
// AEC up to ~5-7 m, AOC tens of metres, multimode ~50-100 m, DR 500 m, FR 2 km, LR 10 km, 400G/800G optics ~8-20 W per module.
export const MEDIA: Media[] = [
  { id: 'dac', name: 'Passive DAC', kind: 'copper', reach: { 100: 5, 200: 3, 400: 3, 800: 2, 1600: 1 }, watts: { 100: 0, 200: 0, 400: 0, 800: 0, 1600: 0 }, cost: 1,
    pros: 'No electronics: ~0 W, lowest latency, cheapest, very reliable', cons: 'Reach only a few metres and shrinking with lane rate; thick, stiff, heavy bundles' },
  { id: 'acc', name: 'ACC (linear redriver)', kind: 'active cable', reach: { 100: 7, 200: 5, 400: 5, 800: 4, 1600: 2 }, watts: { 100: 0.5, 200: 1, 400: 1.5, 800: 2, 1600: 3 }, cost: 1,
    pros: 'A little beyond DAC at low power; thinner gauge', cons: 'Small reach gain; relies on host SerDes margin' },
  { id: 'aec', name: 'AEC (retimed copper)', kind: 'active cable', reach: { 100: 7, 200: 7, 400: 7, 800: 7, 1600: 5 }, watts: { 100: 2, 200: 3, 400: 6, 800: 10, 1600: 15 }, cost: 2,
    pros: 'Copper reach to ~5-7 m with thinner cable; reaches adjacent racks', cons: 'DSP in each end costs watts and some latency; still copper bulk' },
  { id: 'aoc', name: 'AOC (active optical cable)', kind: 'active cable', reach: { 100: 100, 200: 100, 400: 30, 800: 30, 1600: null }, watts: { 100: 2.5, 200: 5, 400: 8, 800: 13, 1600: null }, cost: 2,
    pros: 'Thin, light, tens of metres; no connector cleaning', cons: 'Fixed length, both ends replaced together; power like transceivers' },
  { id: 'sr', name: 'Multimode SR (SR4/SR8)', kind: 'transceiver', reach: { 100: 100, 200: 100, 400: 100, 800: 100, 1600: 50 }, watts: { 100: 2.5, 200: 5, 400: 8, 800: 13, 1600: 22 }, cost: 2,
    pros: 'Cheapest optics; ~50-100 m on OM3/OM4', cons: 'Parallel MPO fibre; short reach at high lane rates; cleaning' },
  { id: 'dr', name: 'Single-mode DR (DR4/DR8)', kind: 'transceiver', reach: { 100: 500, 200: 500, 400: 500, 800: 500, 1600: 500 }, watts: { 100: 3.5, 200: 6, 400: 9, 800: 15, 1600: 25 }, cost: 3,
    pros: '500 m: covers a hall; breakout-friendly (DR8 → 2×DR4)', cons: 'Parallel single-mode MPO; costlier than SR' },
  { id: 'fr', name: 'Single-mode FR (FR4/2×FR4)', kind: 'transceiver', reach: { 100: 2000, 200: 2000, 400: 2000, 800: 2000, 1600: 2000 }, watts: { 100: 3.5, 200: 6.5, 400: 10, 800: 17, 1600: 28 }, cost: 3,
    pros: '2 km on duplex fibre (WDM): fewer fibres, crosses buildings', cons: 'More power and cost than DR' },
  { id: 'lr', name: 'Single-mode LR (LR4/2×LR4)', kind: 'transceiver', reach: { 100: 10000, 200: 10000, 400: 10000, 800: 10000, 1600: null }, watts: { 100: 4.5, 200: 7, 400: 11, 800: 18, 1600: null }, cost: 4,
    pros: '10 km: campus and metro links', cons: 'Most expensive; rarely needed inside an AI fabric' },
];
export const mediaById = (id: MediaId) => MEDIA.find((m) => m.id === id)!;

export interface Candidate { m: Media; reach: number | null; watts: number | null; fits: boolean; linkW: number | null }
/** Every medium at this speed with its reach, power and whether it reaches the routed length (table order). */
export function candidates(speed: Speed, metres: number): Candidate[] {
  return MEDIA.map((m) => {
    const reach = m.reach[speed], watts = m.watts[speed];
    return { m, reach, watts, fits: reach !== null && watts !== null && metres <= reach, linkW: watts === null ? null : 2 * watts };
  });
}
/** Lowest-power medium that reaches (ties keep table order). */
export const recommended = (c: Candidate[]) =>
  c.filter((x) => x.fits).reduce<Candidate | null>((best, x) => (best === null || (x.watts ?? Infinity) < (best.watts ?? Infinity) ? x : best), null);

export interface Row { name: string; links: number; speed: Speed; media: MediaId; perModule: 1 | 2; wOverride: number | null }
/** Ends (modules or active cable ends) = links × 2 / ports per module. Each end is the module class at speed × ports per module. */
export function rowPower(r: Row): { ends: number; w: number | null; kw: number | null; modSpeed: Speed | null } {
  const modSpeed = (r.speed * r.perModule) as Speed;
  const ok = SPEEDS.includes(modSpeed);
  const ends = Math.ceil((r.links * 2) / r.perModule);
  const w = r.wOverride ?? (ok ? mediaById(r.media).watts[modSpeed] : null);
  return { ends: r.media === 'dac' ? 0 : ends, w, kw: w === null ? null : (r.media === 'dac' ? 0 : ends * w) / 1000, modSpeed: ok ? modSpeed : null };
}

const fmt = (n: number, d = 1) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const sp = (s: number) => (s >= 1000 ? `${s / 1000}T` : `${s}G`);
const reachTxt = (m: number | null) => (m === null ? 'n/a' : m >= 1000 ? `~${m / 1000} km` : `~${m} m`);

function Seg<T extends string | number>({ label, value, options, onChange, render }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>{options.map((o) => (
        <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
          className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{render ? render(o) : String(o)}</button>
      ))}</div>
    </div>
  );
}

const DIST_STEPS = [0.5, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000];

const DEFAULT_ROWS: Row[] = [
  { name: 'Server ↔ leaf', links: 1024, speed: 400, media: 'dr', perModule: 2, wOverride: null },
  { name: 'Leaf ↔ spine', links: 1024, speed: 400, media: 'dr', perModule: 2, wOverride: null },
  { name: 'Spine ↔ super-spine', links: 0, speed: 800, media: 'dr', perModule: 1, wOverride: null },
];

export default function OpticsPlanner() {
  const [speed, setSpeed] = useState<Speed>(400);
  const [di, setDi] = useState(3);
  const dist = DIST_STEPS[di];
  const [where, setWhere] = useState<'intra' | 'inter'>('intra');
  const [rows, setRows] = useState<Row[]>(DEFAULT_ROWS);
  const [gpus, setGpus] = useState(1024);

  const cands = useMemo(() => candidates(speed, dist), [speed, dist]);
  const best = recommended(cands);
  const per = rows.map(rowPower);
  const totalEnds = per.reduce((a, p) => a + p.ends, 0);
  const totalKw = per.reduce((a, p) => a + (p.kw ?? 0), 0);
  const upd = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Seg label="Port speed" value={speed} options={SPEEDS} onChange={setSpeed} render={sp} />
        <div>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted"><span>Routed cable length</span><span className="text-base font-semibold normal-case tracking-normal text-fg">{dist} m</span></div>
          <input type="range" min={0} max={DIST_STEPS.length - 1} step={1} value={di} onChange={(e) => setDi(Number(e.target.value))}
            aria-label="Routed cable length in metres" aria-valuetext={`${dist} m`} className="w-full accent-[var(--accent)]" />
        </div>
        <Seg label="Placement" value={where} options={['intra', 'inter'] as const} onChange={setWhere} render={(w) => (w === 'intra' ? 'intra-rack' : 'inter-rack')} />
      </div>

      <div className="flex flex-wrap gap-2" aria-live="polite">
        {best ? <Pill className="border-accent/40 text-accent">lowest power that reaches: {best.m.name} ({best.watts} W/end)</Pill> : <Pill className="text-danger">nothing in this table reaches {dist} m at {sp(speed)}</Pill>}
        {where === 'inter' && best && best.m.kind !== 'transceiver' && <Pill className="text-warn">across racks: check cable routing, bend radius and tray fill for copper</Pill>}
        {where === 'intra' && dist > 3 && <Pill className="text-warn">{dist} m is long for one rack: is this really intra-rack?</Pill>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={`Cable and optics options at ${sp(speed)}`}>
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-panel-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            <tr><th className="px-2 py-1.5">Medium</th><th className="px-2 py-1.5">Typical reach @ {sp(speed)}</th><th className="px-2 py-1.5">W per end</th><th className="px-2 py-1.5">W per link</th><th className="px-2 py-1.5">Cost</th><th className="px-2 py-1.5">Pros</th><th className="px-2 py-1.5">Cons</th></tr>
          </thead>
          <tbody>
            {cands.map((c) => (
              <tr key={c.m.id} className={`border-t border-line align-top ${c === best ? 'bg-accent-soft' : c.fits ? '' : 'text-muted'}`}>
                <td className="px-2 py-1.5"><div className={`font-semibold ${c === best ? 'text-accent' : ''}`}>{c.m.name}{c === best && <span className="sr-only"> (recommended)</span>}</div><div className="text-[10px] text-muted">{c.fits ? '✓ reaches' : c.reach === null ? 'not common at this speed' : '✕ too short'}</div></td>
                <td className="px-2 py-1.5 font-mono">{reachTxt(c.reach)}</td>
                <td className="px-2 py-1.5 font-mono">{c.watts === null ? '—' : c.watts === 0 ? '~0' : `~${c.watts}`}</td>
                <td className="px-2 py-1.5 font-mono">{c.linkW === null ? '—' : c.linkW === 0 ? '~0' : `~${c.linkW}`}</td>
                <td className="px-2 py-1.5 font-mono text-warn">{'$'.repeat(c.m.cost)}</td>
                <td className="px-2 py-1.5">{c.m.pros}</td><td className="px-2 py-1.5 text-muted">{c.m.cons}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted">
        <span className="font-semibold text-fg">Why DAC wins where it reaches:</span> a passive cable has no laser, no DSP and no connector to clean, so it adds ~0 W, almost no latency and
        the lowest failure rate of any option. Every metre you can keep servers and their leaf within copper reach removes two powered ends per link. The catch is reach: at 100G per
        lane it is a few metres, and it shrinks again at 200G per lane, so the rack layout decides whether copper is possible.
      </p>

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Fabric optics power</div>
          <label className="flex items-center gap-2 text-xs text-muted">GPUs <input type="number" min={1} value={gpus} onChange={(e) => setGpus(Math.max(1, Number(e.target.value) || 1))} className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs text-fg" /></label>
        </div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Fabric optics power by link class">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted"><tr><th className="py-1 pr-2">Link class</th><th className="pr-2">Links</th><th className="pr-2">Speed</th><th className="pr-2">Medium</th><th className="pr-2">Ports / module</th><th className="pr-2">W / module</th><th className="pr-2">Modules (ends)</th><th>kW</th></tr></thead>
            <tbody>
              {rows.map((r, i) => { const p = per[i]; return (
                <tr key={r.name} className="border-t border-line">
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="pr-2"><input type="number" min={0} value={r.links} aria-label={`${r.name} links`} onChange={(e) => upd(i, { links: Math.max(0, Number(e.target.value) || 0) })} className="w-20 rounded border border-line bg-panel px-1 py-0.5 font-mono" /></td>
                  <td className="pr-2"><select value={r.speed} aria-label={`${r.name} speed`} onChange={(e) => upd(i, { speed: Number(e.target.value) as Speed, wOverride: null })} className="rounded border border-line bg-panel px-1 py-0.5 font-mono">{SPEEDS.map((s) => <option key={s} value={s}>{sp(s)}</option>)}</select></td>
                  <td className="pr-2"><select value={r.media} aria-label={`${r.name} medium`} onChange={(e) => upd(i, { media: e.target.value as MediaId, wOverride: null })} className="rounded border border-line bg-panel px-1 py-0.5">{MEDIA.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
                  <td className="pr-2"><select value={r.perModule} aria-label={`${r.name} ports per module`} onChange={(e) => upd(i, { perModule: Number(e.target.value) as 1 | 2, wOverride: null })} className="rounded border border-line bg-panel px-1 py-0.5 font-mono"><option value={1}>1</option><option value={2}>2 (twin-port)</option></select></td>
                  <td className="pr-2"><input type="number" min={0} step={0.5} value={p.w ?? ''} aria-label={`${r.name} watts per module`} onChange={(e) => upd(i, { wOverride: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} className="w-16 rounded border border-line bg-panel px-1 py-0.5 font-mono" />
                    <span className="ml-1 text-[10px] text-muted">{p.modSpeed ? `${sp(p.modSpeed)} class` : 'n/a'}</span></td>
                  <td className="pr-2 font-mono">{fmt(p.ends, 0)}</td>
                  <td className="font-mono">{p.kw === null ? '—' : fmt(p.kw, 2)}</td>
                </tr>); })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
          {[['Powered ends', fmt(totalEnds, 0)], ['Optics power', `${fmt(totalKw, 2)} kW`], ['Per GPU', `${fmt((totalKw * 1000) / gpus, 1)} W`], ['Modules per GPU', fmt(totalEnds / gpus, 2)]].map(([l, v]) => (
            <div key={l} className="rounded-lg border border-line bg-panel px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{l}</div><div className="font-mono text-lg font-semibold tabular-nums text-data">{v}</div></div>
          ))}
        </div>
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted">
          {rows.map((r, i) => r.links > 0 && <li key={r.name}>{r.name}: {fmt(r.links, 0)} links × 2 ends / {r.perModule} port{r.perModule > 1 ? 's' : ''} per module = {fmt(per[i].ends, 0)} {r.media === 'dac' ? '(passive: 0 powered ends)' : `× ${per[i].w ?? '?'} W = ${per[i].kw === null ? '?' : fmt(per[i].kw! * 1000, 0)} W`}</li>)}
          <li>Default rows: the four-SU example from the SuperPOD lesson (1,024 GPUs, 400G links on twin-port 800G-class modules: 2,048 modules). Set every W to 15 to reproduce the optics lesson's 15 W-average arithmetic.</li>
        </ol>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        All reach and power values are typical orders of magnitude for current products, not limits: real reach depends on lane rate (100G vs 200G per lane), fibre grade (OM3/OM4, OS2),
        connector loss and the specific part, and power varies by vendor and generation (LPO and other linear designs draw less). 1.6T values are early and product-specific. Design with the
        datasheet of the exact module and the host's supported-cable list. Cost classes are relative. Twin-port modules carry two links; breakout cables likewise let one module end terminate two ports.
      </p>
    </div>
  );
}
