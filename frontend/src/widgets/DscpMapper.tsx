import { useState } from 'react';
import { Pill } from '../components/ui';

export const ECN_NAMES = ['Not-ECT', 'ECT(1)', 'ECT(0)', 'CE'] as const; // RFC 3168 codepoints 00, 01, 10, 11

/** ToS / IPv6 Traffic Class byte = DSCP (upper 6 bits) << 2 | ECN (lower 2 bits). This is what NCCL_IB_TC and verbs traffic_class carry. */
export const tosOf = (dscp: number, ecn: number) => ((dscp & 63) << 2) | (ecn & 3);
export const dscpOf = (tos: number) => (tos >> 2) & 63;
export const ecnOf = (tos: number) => tos & 3;
/** Class-selector default map: the top three DSCP bits. */
export const csPriority = (dscp: number) => dscp >> 3;

/** Standard PHB name for a DSCP (RFC 2474 CS, RFC 2597 AF, RFC 3246 EF, RFC 5865 VOICE-ADMIT, RFC 8622 LE). */
export function dscpName(d: number): string {
  if (d === 0) return 'CS0 / default';
  if (d === 46) return 'EF';
  if (d === 44) return 'VOICE-ADMIT';
  if (d === 1) return 'LE';
  if (d % 8 === 0) return `CS${d / 8}`;
  const x = d >> 3, y = (d & 7) >> 1;
  if (x >= 1 && x <= 4 && (d & 1) === 0 && y >= 1 && y <= 3) return `AF${x}${y}`;
  return 'unassigned / local use';
}

export type MapKind = 'cs' | 'roce';
export type Trust = 'dscp' | 'pcp';
/** Illustrative explicit RoCE plan: only the planned DSCPs are mapped, everything else to priority 0. */
export function priorityFor(dscp: number, map: MapKind): number {
  if (map === 'cs') return csPriority(dscp);
  return dscp === 26 ? 3 : dscp === 48 ? 6 : 0;
}

export interface Trace { prio: number; via: string; lossless: boolean; tc: number; strict: boolean; ecnEligible: boolean; problems: string[] }

export function trace(dscp: number, ecn: number, trust: Trust, tagged: boolean, pcp: number, map: MapKind, losslessPrio = 3, cnpPrio = 6, defaultPrio = 0): Trace {
  const problems: string[] = [];
  let prio: number, via: string;
  if (trust === 'dscp') { prio = priorityFor(dscp, map); via = `DSCP ${dscp} → priority ${prio} (${map === 'cs' ? 'class-selector map' : 'RoCE plan'})`; }
  else if (tagged) { prio = pcp; via = `PCP ${pcp} in the 802.1Q tag → priority ${pcp} (DSCP ignored)`; }
  else {
    prio = defaultPrio; via = `untagged frame: no PCP, so the port default priority ${defaultPrio} applies (DSCP ignored)`;
    problems.push('Trust PCP on an untagged (routed) link: every frame gets the port default priority, whatever DSCP the host set.');
  }
  const lossless = prio === losslessPrio;
  const strict = prio === cnpPrio;
  const tc = prio; // 1:1 priority→TC, as in most RoCE profiles (check yours)
  const ecnEligible = prio === losslessPrio && ecn !== 0;
  if (trust === 'pcp' && tagged && pcp !== csPriority(dscp) && dscp !== 0) problems.push(`PCP ${pcp} and DSCP ${dscp} disagree: devices trusting different fields will classify this packet differently.`);
  if (!lossless && !strict && dscp !== 0 && (dscp >> 3) !== 3) problems.push(`DSCP ${dscp} is not the RoCE DSCP: if this is RoCE data it lands in a lossy queue with no PFC and no ECN profile.`);
  if (lossless && ecn === 0) problems.push('Not-ECT: the switch cannot set CE on this packet, so DCQCN never hears about congestion (it may be WRED-dropped instead).');
  if (trust === 'dscp' && map === 'roce' && (dscp >> 3) === 3 && dscp !== 26) problems.push(`The explicit plan maps only DSCP 26; DSCP ${dscp} would be priority 3 under a class-selector map but 0 here.`);
  return { prio, via, lossless, tc, strict, ecnEligible, problems };
}

const PRESETS = [
  { label: 'NCCL_IB_TC=106 (DSCP 26, ECT(0))', tos: 106, trust: 'dscp' as Trust, tagged: false },
  { label: 'NCCL_IB_TC=104', tos: 104, trust: 'dscp' as Trust, tagged: false },
  { label: 'NCCL_IB_TC=26 (mistake)', tos: 26, trust: 'dscp' as Trust, tagged: false },
  { label: 'CNP, DSCP 48', tos: 192, trust: 'dscp' as Trust, tagged: false },
  { label: 'trust PCP, untagged link', tos: 106, trust: 'pcp' as Trust, tagged: false },
];

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
            {render ? render(o) : String(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumIn({ label, value, max, set }: { label: string; value: number; max: number; set: (v: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <input type="number" min={0} max={max} value={value} onChange={(e) => set(Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))))}
        className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
    </label>
  );
}

function Stage({ k, title, value, tone = 'text-fg' }: { k: number; title: string; value: string; tone?: string }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line font-mono text-[10px] text-muted">{k}</span>
      <div><div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{title}</div><div className={`text-sm ${tone}`}>{value}</div></div>
    </li>
  );
}

export default function DscpMapper() {
  const [tos, setTos] = useState(106);
  const [trust, setTrust] = useState<Trust>('dscp');
  const [tagged, setTagged] = useState(false);
  const [pcp, setPcp] = useState(3);
  const [map, setMap] = useState<MapKind>('cs');
  const dscp = dscpOf(tos), ecn = ecnOf(tos);
  const t = trace(dscp, ecn, trust, tagged, pcp, map);
  const bits = tos.toString(2).padStart(8, '0');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => { setTos(p.tos); setTrust(p.trust); setTagged(p.tagged); }}
            className="rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] hover:bg-panel-2">{p.label}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NumIn label="DSCP (0-63)" value={dscp} max={63} set={(d) => setTos(tosOf(d, ecn))} />
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">ECN bits</span>
          <select value={ecn} onChange={(e) => setTos(tosOf(dscp, Number(e.target.value)))} className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm">
            {ECN_NAMES.map((n, i) => <option key={n} value={i}>{i.toString(2).padStart(2, '0')} {n}</option>)}
          </select>
        </label>
        <NumIn label="ToS byte = NCCL_IB_TC" value={tos} max={255} set={setTos} />
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Hex</div>
          <div className="rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-sm">0x{tos.toString(16).toUpperCase().padStart(2, '0')}</div>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="flex flex-wrap items-center gap-1 font-mono text-sm" role="img" aria-label={`ToS byte bits ${bits}: DSCP bits ${bits.slice(0, 6)}, ECN bits ${bits.slice(6)}`}>
          {bits.split('').map((b, i) => (
            <span key={i} className={`flex h-7 w-7 items-center justify-center rounded border ${i < 6 ? 'border-data/50 text-data' : 'border-warn/50 text-warn'} ${i === 6 ? 'ml-2' : ''}`}>{b}</span>
          ))}
        </div>
        <div className="mt-2 font-mono text-xs text-muted">
          DSCP {dscp} ({dscpName(dscp)}) × 4 + ECN {ecn} ({ECN_NAMES[ecn]}) = {dscp * 4} + {ecn} = <span className="text-fg">{tos}</span>
          {' '}· class selector DSCP &gt;&gt; 3 = <span className="text-fg">{csPriority(dscp)}</span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Seg label="Switch trust mode" value={trust} options={['dscp', 'pcp'] as const} onChange={setTrust} render={(v) => `trust ${v}`} />
        <Seg label="DSCP → priority map" value={map} options={['cs', 'roce'] as const} onChange={setMap} render={(v) => (v === 'cs' ? 'class selector' : 'explicit RoCE plan')} />
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">VLAN tag</div>
          <div className="flex flex-wrap items-center gap-1">
            <button type="button" aria-pressed={tagged} onClick={() => setTagged(!tagged)}
              className={`rounded-md border px-2 py-1 font-mono text-xs ${tagged ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{tagged ? '802.1Q tagged' : 'untagged'}</button>
            {tagged && (
              <label className="flex items-center gap-1 font-mono text-xs">PCP
                <select value={pcp} onChange={(e) => setPcp(Number(e.target.value))} className="rounded border border-line bg-panel px-1 py-0.5">
                  {Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
      </div>

      <ol className="space-y-2 rounded-xl border border-line p-3">
        <Stage k={1} title="Packet arrives" value={`DSCP ${dscp}, ECN ${ECN_NAMES[ecn]}${tagged ? `, PCP ${pcp}` : ', no VLAN tag'}`} />
        <Stage k={2} title={`Trust ${trust}`} value={t.via} tone={trust === 'pcp' && !tagged ? 'text-danger' : 'text-fg'} />
        <Stage k={3} title="Switch priority" value={`priority ${t.prio}`} tone="text-data" />
        <Stage k={4} title="Ingress PG / egress TC (queue)" value={`PG for priority ${t.prio}; TC ${t.tc} / queue ${t.tc}`} />
        <Stage k={5} title="Lossless?" value={t.lossless ? 'yes: PFC on priority 3, headroom reserved' : t.strict ? 'no PFC: strict-priority queue (CNP class)' : 'no: lossy, tail-drop / WRED under congestion'}
          tone={t.lossless ? 'text-accent' : t.strict ? 'text-data' : 'text-warn'} />
        <Stage k={6} title="ECN marking eligible?" value={t.ecnEligible ? (ecn === 3 ? 'already CE (marked upstream)' : `yes: queue ${t.tc} marks CE above its ECN threshold`) : t.lossless ? 'no: packet is Not-ECT' : 'no ECN profile on this queue'}
          tone={t.ecnEligible ? 'text-accent' : 'text-warn'} />
      </ol>

      <div aria-live="polite">{t.problems.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger">
          {t.problems.map((p) => <li key={p}><span aria-hidden>⚠ </span><span className="sr-only">Problem: </span>{p}</li>)}
        </ul>
      ) : (
        <div className="rounded-lg border border-accent/40 px-3 py-2 text-sm text-accent">✓ Classified as the plan intends{t.strict ? ' (CNP class)' : t.lossless ? ' (RoCE data class)' : ''}.</div>
      )}</div>

      <div className="flex flex-wrap gap-2">
        <Pill>RoCE data: DSCP 26 → ToS 104 / 106 → prio 3 lossless</Pill>
        <Pill>CNP: DSCP 48 → ToS 192 → prio 6 strict</Pill>
        <Pill>TC 26 = DSCP 6 + ECT(0) → prio 0</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        ToS = DSCP × 4 + ECN (RFC 2474, RFC 3168). NCCL_IB_TC, verbs traffic_class and perftest --tclass take the whole byte. DSCP 26 / priority 3
        lossless and DSCP 48 / priority 6 for CNPs is the common NVIDIA convention, not a standard. The "explicit RoCE plan" map (only 26 and 48 mapped)
        and the 1:1 priority-to-TC mapping are illustrative; real profiles (Cumulus, SONiC, other vendors) differ, and the port default priority for
        untagged traffic under PCP trust is configurable. Whether the NIC overrides the ECN bits you pass is implementation-specific: verify on the wire.
      </p>
    </div>
  );
}
