import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure calculation helpers (exported for unit tests) ----------

export interface LinkOption { id: string; label: string; lanes: number; laneGbps: number; mod: 'NRZ' | 'PAM4'; nominalGbps: number; stdFec: FecId }
export type FecId = 'none' | 'kr4' | 'kp4';
export interface FecCode { id: FecId; label: string; n: number; k: number; t: number }

// Lane signalling rates are the serial bit rates on the wire (Gb/s) for IEEE 802.3 RS-FEC PHYs:
// 25.78125 (NRZ, 25.78125 GBd), 53.125 (PAM4, 26.5625 GBd) and 106.25 (PAM4, 53.125 GBd).
export const LINKS: LinkOption[] = [
  { id: '100g-4x25', label: '100G 4×25G NRZ', lanes: 4, laneGbps: 25.78125, mod: 'NRZ', nominalGbps: 100, stdFec: 'kr4' },
  { id: '200g-4x50', label: '200G 4×50G PAM4', lanes: 4, laneGbps: 53.125, mod: 'PAM4', nominalGbps: 200, stdFec: 'kp4' },
  { id: '200g-2x100', label: '200G 2×100G PAM4', lanes: 2, laneGbps: 106.25, mod: 'PAM4', nominalGbps: 200, stdFec: 'kp4' },
  { id: '400g-8x50', label: '400G 8×50G PAM4', lanes: 8, laneGbps: 53.125, mod: 'PAM4', nominalGbps: 400, stdFec: 'kp4' },
  { id: '400g-4x100', label: '400G 4×100G PAM4', lanes: 4, laneGbps: 106.25, mod: 'PAM4', nominalGbps: 400, stdFec: 'kp4' },
  { id: '800g-8x100', label: '800G 8×100G PAM4', lanes: 8, laneGbps: 106.25, mod: 'PAM4', nominalGbps: 800, stdFec: 'kp4' },
];

export const FECS: FecCode[] = [
  { id: 'none', label: 'none', n: 0, k: 0, t: 0 },
  { id: 'kr4', label: 'RS(528,514) "KR4"', n: 528, k: 514, t: 7 },
  { id: 'kp4', label: 'RS(544,514) "KP4"', n: 544, k: 514, t: 15 },
];

/** Commonly quoted pre-FEC BER limits (not normative; check vendor specs). */
export const QUOTED_LIMIT: Record<Exclude<FecId, 'none'>, number> = { kr4: 5e-5, kp4: 2.4e-4 };
export const SYMBOL_BITS = 10;

export const lineRateBps = (l: LinkOption) => l.lanes * l.laneGbps * 1e9;

/** log10 of the probability that a 10-bit symbol has at least one bit error, assuming independent bit errors. */
export function log10SymbolErrorProb(ber: number, bits = SYMBOL_BITS): number {
  // p_s = 1 - (1 - BER)^m, computed as -expm1(m * log1p(-BER)) to keep precision at tiny BER
  return Math.log10(-Math.expm1(bits * Math.log1p(-ber)));
}

const logFactCache: number[] = [0];
function logFact(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  return logFactCache[n];
}

/** log10 P(X > t) for X ~ Binomial(n, p), summed in the log domain (log-sum-exp) so tiny tails do not underflow. */
export function log10BinomialTailAbove(n: number, t: number, p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  const terms: number[] = [];
  for (let i = t + 1; i <= n; i++) terms.push(logFact(n) - logFact(i) - logFact(n - i) + i * lp + (n - i) * lq);
  const m = Math.max(...terms);
  const s = terms.reduce((acc, x) => acc + Math.exp(x - m), 0);
  return Math.min(0, (m + Math.log(s)) / Math.LN10);
}

export interface FecResult {
  lineBps: number; bitErrPerSec: number; secPerBitErr: number;
  cwBits: number; cwPerSec: number; log10Ps: number; meanSymErrPerCw: number;
  log10Pcw: number; log10UncPerSec: number; log10PostFecBer: number; cwPerFrame: number; log10Flr: number;
  marginDecades: number | null;
}

/** Per-codeword payload: 514 symbols × 10 bits = 5140 bits = 20 × 257-bit transcoded blocks = 5120 MAC bits = 640 bytes. */
export const CW_PAYLOAD_BYTES = 640;

export function compute(link: LinkOption, fec: FecCode, ber: number, frameBytes: number): FecResult {
  const lineBps = lineRateBps(link);
  const bitErrPerSec = lineBps * ber;
  const secPerBitErr = 1 / bitErrPerSec;
  const log10Ps = log10SymbolErrorProb(ber);
  if (fec.id === 'none') {
    // Without FEC every bit error reaches the MAC; a frame of L bits is lost with probability 1-(1-BER)^L.
    const bits = frameBytes * 8;
    const log10Flr = Math.log10(-Math.expm1(bits * Math.log1p(-ber)));
    return { lineBps, bitErrPerSec, secPerBitErr, cwBits: 0, cwPerSec: 0, log10Ps, meanSymErrPerCw: 0, log10Pcw: 0,
      log10UncPerSec: Math.log10(bitErrPerSec), log10PostFecBer: Math.log10(ber), cwPerFrame: 0, log10Flr, marginDecades: null };
  }
  const cwBits = fec.n * SYMBOL_BITS;
  const cwPerSec = lineBps / cwBits;
  const ps = Math.pow(10, log10Ps);
  const log10Pcw = log10BinomialTailAbove(fec.n, fec.t, ps);
  const log10UncPerSec = log10Pcw + Math.log10(cwPerSec);
  // Rough post-FEC BER: a failed codeword carries at least t+1 bad symbols (≈1 bad bit each at low BER) out of n×10 bits.
  const log10PostFecBer = log10Pcw + Math.log10((fec.t + 1) / cwBits);
  // Worst-case alignment: an L-byte frame touches at most ⌈(L−1)/640⌉ + 1 codewords; FLR ≈ m × P_cw while that is ≪ 1.
  const cwPerFrame = Math.ceil((frameBytes - 1) / CW_PAYLOAD_BYTES) + 1;
  const log10Flr = Math.min(0, log10Pcw + Math.log10(cwPerFrame));
  const limit = QUOTED_LIMIT[fec.id];
  return { lineBps, bitErrPerSec, secPerBitErr, cwBits, cwPerSec, log10Ps, meanSymErrPerCw: fec.n * ps, log10Pcw, log10UncPerSec,
    log10PostFecBer, cwPerFrame, log10Flr, marginDecades: Math.log10(limit / ber) };
}

// ---------- Formatting ----------

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const sup = (n: number) => String(n).split('').map((c) => SUP[c] ?? c).join('');
/** Format a value given as log10 in scientific notation, e.g. -14.3 → 5.0×10⁻¹⁵. */
export function sciFromLog(l: number): string {
  if (!Number.isFinite(l)) return '0';
  let e = Math.floor(l);
  let m = Math.pow(10, l - e);
  if (m >= 9.95) { m = 1; e += 1; }
  return e === 0 ? m.toFixed(2) : `${m.toFixed(1)}×10${sup(e)}`;
}
const sci = (x: number) => (x === 0 ? '0' : sciFromLog(Math.log10(x)));

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '∞';
  const units: [number, string][] = [[3.156e7, 'years'], [86400, 'days'], [3600, 'h'], [60, 'min'], [1, 's'], [1e-3, 'ms'], [1e-6, 'µs'], [1e-9, 'ns'], [1e-12, 'ps']];
  if (sec >= 3.156e7 * 1e4) return `${sciFromLog(Math.log10(sec / 3.156e7))} years`;
  for (const [u, name] of units) if (sec >= u) return `${(sec / u).toPrecision(3)} ${name}`;
  return `${sec.toExponential(1)} s`;
}
const durFromLog = (l: number) => (l > 300 ? `${sciFromLog(l - Math.log10(3.156e7))} years` : fmtDuration(Math.pow(10, l)));

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

function Out({ label, value, sub, tone = 'text-fg' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

const FRAMES = [1518, 4158, 9018] as const;

/** Horizontal BER scale 1e-12..1e-3 with the operating point and the quoted cliffs. */
function BerScale({ ber, fec }: { ber: number; fec: FecId }) {
  const x = (b: number) => 20 + ((Math.log10(b) + 12) / 9) * 720;
  const marks = [-12, -11, -10, -9, -8, -7, -6, -5, -4, -3];
  return (
    <svg viewBox="0 0 760 70" className="w-full" role="img" aria-label="Pre-FEC BER scale with FEC limits">
      <rect x={x(1e-8)} y={14} width={x(1e-6) - x(1e-8)} height={16} fill="var(--accent)" opacity={0.18} />
      <text x={(x(1e-8) + x(1e-6)) / 2} y={10} fontSize={10} textAnchor="middle" fill="var(--muted)">typical vendor acceptance band (illustrative)</text>
      <line x1={20} y1={30} x2={740} y2={30} stroke="var(--border)" strokeWidth={2} />
      {marks.map((m) => (
        <g key={m}>
          <line x1={x(10 ** m)} y1={26} x2={x(10 ** m)} y2={34} stroke="var(--muted)" />
          <text x={x(10 ** m)} y={48} fontSize={10} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">1e{m}</text>
        </g>
      ))}
      {(['kr4', 'kp4'] as const).map((f) => (
        <g key={f} opacity={fec === f ? 1 : 0.45}>
          <line x1={x(QUOTED_LIMIT[f])} y1={12} x2={x(QUOTED_LIMIT[f])} y2={36} stroke="var(--danger)" strokeWidth={2} strokeDasharray="3 2" />
          <text x={x(QUOTED_LIMIT[f]) + (f === 'kp4' ? 4 : -4)} y={64} fontSize={10} textAnchor={f === 'kp4' ? 'start' : 'end'} fill="var(--danger)" fontFamily="var(--font-mono)">{f.toUpperCase()} ~{QUOTED_LIMIT[f].toExponential(1)}</text>
        </g>
      ))}
      <circle cx={x(ber)} cy={30} r={6} fill="var(--data)" stroke="var(--panel)" strokeWidth={2} />
    </svg>
  );
}

export default function BerFec() {
  const [linkId, setLinkId] = useState('400g-4x100');
  const [fecId, setFecId] = useState<FecId>('kp4');
  const [exp, setExp] = useState(-6);
  const [frame, setFrame] = useState<(typeof FRAMES)[number]>(4158);
  const link = LINKS.find((l) => l.id === linkId)!;
  const fec = FECS.find((f) => f.id === fecId)!;
  const ber = Math.pow(10, exp);
  const r = useMemo(() => compute(link, fec, ber, frame), [link, fec, ber, frame]);

  const nonStd = fecId !== link.stdFec;
  const lineG = link.lanes * link.laneGbps;
  const marginTone = r.marginDecades === null ? 'text-muted' : r.marginDecades >= 2 ? 'text-accent' : r.marginDecades >= 0.5 ? 'text-warn' : 'text-danger';
  const uncTone = r.log10UncPerSec < Math.log10(1 / 86400) ? 'text-accent' : r.log10UncPerSec < 0 ? 'text-warn' : 'text-danger';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Seg label="Link (lanes × lane rate)" value={linkId} options={LINKS.map((l) => l.id)} onChange={(v) => { setLinkId(v); setFecId(LINKS.find((l) => l.id === v)!.stdFec); }} render={(v) => LINKS.find((l) => l.id === v)!.label} /></div>
        <Seg label="FEC" value={fecId} options={FECS.map((f) => f.id)} onChange={setFecId} render={(v) => FECS.find((f) => f.id === v)!.label} />
        <Seg label="Frame size for loss estimate (bytes)" value={frame} options={FRAMES} onChange={setFrame} render={(v) => (v === 4158 ? '4158 (RoCE, 4096 B payload)' : String(v))} />
        <div className="sm:col-span-2">
          <label htmlFor="ber-exp" className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <span>Pre-FEC (raw) BER</span><span className="text-base font-semibold normal-case tracking-normal text-fg">{sci(ber)}</span>
          </label>
          <input id="ber-exp" type="range" min={-12} max={-3} step={0.1} value={exp} onChange={(e) => setExp(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2"><BerScale ber={ber} fec={fecId} /></div>

      <div className="flex flex-wrap gap-2">
        <Pill>line rate {lineG.toFixed(lineG % 1 ? 3 : 0)} Gb/s = {link.lanes} × {link.laneGbps} Gb/s {link.mod}</Pill>
        {fec.id !== 'none' && <Pill>{fec.n} symbols × 10 bits = {fec.n * 10} bits / codeword</Pill>}
        {fec.id !== 'none' && <Pill>corrects up to t = (n−k)/2 = {fec.t} symbols</Pill>}
      </div>
      {nonStd && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn" role="alert">
          ⚠ {fecId === 'none' ? `Running ${link.mod} lanes without FEC is not a standard mode; the link either will not come up or will drop packets constantly.` : `${link.label} normally uses ${link.stdFec.toUpperCase()}; this combination is shown for comparison only.`}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label="Raw bit errors / s" value={sci(r.bitErrPerSec)} sub={`${sci(r.lineBps)} b/s × ${sci(ber)}`} />
        <Out label="Time between raw errors" value={fmtDuration(r.secPerBitErr)} />
        <Out label="Margin to quoted limit" tone={marginTone}
          value={r.marginDecades === null ? 'n/a' : r.marginDecades >= 0 ? `${r.marginDecades.toFixed(1)} decades` : `${(-r.marginDecades).toFixed(1)} over`}
          sub={fec.id === 'none' ? 'no FEC' : `vs ~${QUOTED_LIMIT[fec.id].toExponential(1)} (${fec.id.toUpperCase()})`} />
        <Out label="Symbol error prob p_s" value={sciFromLog(r.log10Ps)} sub="1 − (1 − BER)¹⁰" />
        {fec.id !== 'none' && <>
          <Out label="Codewords / s" value={sci(r.cwPerSec)} sub={`line rate / ${r.cwBits} bits`} />
          <Out label="Mean bad symbols / codeword" value={r.meanSymErrPerCw < 1e-3 ? sci(r.meanSymErrPerCw) : r.meanSymErrPerCw.toFixed(3)} sub={`n × p_s, limit ${fec.t}`} />
          <Out label="P(uncorrectable codeword)" value={sciFromLog(r.log10Pcw)} tone={uncTone} sub={`P(X > ${fec.t}), X ~ Bin(${fec.n}, p_s)`} />
          <Out label="Uncorrectable codewords" value={durFromLog(-r.log10UncPerSec)} tone={uncTone} sub="mean time between (random errors)" />
        </>}
        <Out label={fec.id === 'none' ? 'Bit errors reaching the MAC' : 'Post-FEC BER (rough)'} value={sciFromLog(r.log10PostFecBer)} />
        <Out label={`Frame loss ratio (${frame} B)`} value={sciFromLog(r.log10Flr)} tone={r.log10Flr < -12 ? 'text-accent' : r.log10Flr < -9 ? 'text-warn' : 'text-danger'}
          sub={fec.id === 'none' ? `1 − (1 − BER)^${frame * 8}` : `≈ ${r.cwPerFrame} codewords × P_cw`} />
        <Out label="Frames lost at line rate" value={durFromLog(-(r.log10Flr + Math.log10((link.nominalGbps * 1e9) / ((frame + 20) * 8))))} sub={`at ${link.nominalGbps}G MAC rate, 20 B preamble+IPG`} />
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>raw errors/s = line rate × BER = {sci(r.lineBps)} × {sci(ber)} = <span className="font-mono text-fg">{sci(r.bitErrPerSec)}</span>; one every {fmtDuration(r.secPerBitErr)}</li>
          <li>symbol error probability (independent bit errors): p_s = 1 − (1 − BER)¹⁰ ≈ 10 × BER = <span className="font-mono text-fg">{sciFromLog(r.log10Ps)}</span></li>
          {fec.id !== 'none' ? <>
            <li>{fec.label}: k = 514 data symbols + {fec.n - fec.k} parity symbols; a Reed-Solomon code corrects t = ({fec.n} − 514)/2 = <span className="font-mono text-fg">{fec.t}</span> bad symbols per codeword</li>
            <li>P(uncorrectable) = Σ<sub>i={fec.t + 1}..{fec.n}</sub> C({fec.n}, i) p_s<sup>i</sup> (1 − p_s)<sup>{fec.n}−i</sup> = <span className="font-mono text-fg">{sciFromLog(r.log10Pcw)}</span> (summed in log space)</li>
            <li>uncorrectable codewords/s = {sci(r.cwPerSec)} × {sciFromLog(r.log10Pcw)} = <span className="font-mono text-fg">{sciFromLog(r.log10UncPerSec)}</span></li>
            <li>each codeword carries 5140 data bits = 20 × 257-bit blocks = 640 bytes of MAC data, so a {frame}-byte frame touches at most ⌈({frame} − 1)/640⌉ + 1 = {r.cwPerFrame} codewords; FLR ≈ {r.cwPerFrame} × P_cw = <span className="font-mono text-fg">{sciFromLog(r.log10Flr)}</span></li>
          </> : <li>no FEC: every raw bit error corrupts a frame; FLR = 1 − (1 − BER)^({frame} × 8) = <span className="font-mono text-fg">{sciFromLog(r.log10Flr)}</span></li>}
        </ol>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        <strong className="text-warn">This is an optimistic lower bound.</strong> The binomial model assumes independent, random bit errors. Real PAM4 links
        have bursty errors (DFE error propagation in the SerDes, crosstalk, connector events), so errors cluster into the same codeword and the true uncorrectable
        rate can be many orders of magnitude worse than shown; that is why vendors specify their own limits and measure uncorrectable blocks directly
        (<span className="font-mono">mlxlink -c</span>, <span className="font-mono">ethtool -I --show-fec</span>). Interleaving lanes (as 802.3 PHYs do) helps
        spread bursts but does not make errors independent. The KR4 (~5e-5) and KP4 (~2.4e-4) figures are commonly quoted pre-FEC limits, not normative values;
        IEEE 802.3 objectives are of order 1e-12 to 1e-13 post-FEC depending on the project. Lane rates are the 802.3 serial rates; InfiniBand rates and FEC
        modes differ by generation, and the acceptance band is illustrative: check your vendor's specification. The post-FEC BER uses the rough assumption that a
        failed codeword carries t + 1 single-bit symbol errors.
      </p>
    </div>
  );
}
