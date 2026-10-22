import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import { MIN_FRAME, WIRE_OVERHEAD, l3HeaderBytes } from './EthernetFrame';
import NumInput from '../components/NumInput';

// ---------- Pure calculation (unit-testable) ----------
// Header sizes: IBTA InfiniBand Architecture Specification Vol. 1 (LRH 8, BTH 12, RETH 16, ICRC 4, VCRC 2) and
// RoCEv2 Annex A17 (Ethernet 14 + IP + UDP 8 + BTH ... ICRC 4 + FCS 4). Preamble/SFD + IFG and the 64-byte
// minimum frame come from EthernetFrame.tsx so both widgets agree.

export const IB_LRH = 8;
export const IB_BTH = 12;
export const IB_RETH = 16; // only on the FIRST (or ONLY) packet of an RDMA WRITE
export const IB_ICRC = 4;
export const IB_VCRC = 2;
export const ETH_HDR = 14; // dst MAC + src MAC + EtherType (no VLAN tag)
export const ETH_FCS = 4;
export const UDP_HDR = 8;
export const MIB = 1048576; // 2^20

/** perftest -a sweeps 2^1 .. 2^23 bytes: write_bw.c `for (i = 1; i < 24; ++i) size = 1 << i` (MAX_SIZE 8388608). */
export const SWEEP: number[] = Array.from({ length: 23 }, (_, i) => 2 ** (i + 1));
export const MAX_SIZE = 8388608;

export type Transport = 'ib' | 'roce4' | 'roce6';
export const TRANSPORT_LABEL: Record<Transport, string> = { ib: 'InfiniBand', roce4: 'RoCEv2 / IPv4', roce6: 'RoCEv2 / IPv6' };

/** Bytes one packet occupies on the wire. IB: LRH..VCRC (link-layer framing symbols not modelled).
 *  RoCEv2: preamble+SFD .. IFG, padded to the 64-byte minimum frame. Payload is padded to 4 B (BTH PadCnt). */
export function packetWireBytes(payload: number, first: boolean, t: Transport): number {
  const pad = (4 - (payload % 4)) % 4;
  const ibPart = IB_BTH + (first ? IB_RETH : 0) + payload + pad + IB_ICRC;
  if (t === 'ib') return IB_LRH + ibPart + IB_VCRC;
  const frame = Math.max(MIN_FRAME, ETH_HDR + l3HeaderBytes(t === 'roce4' ? 'ipv4' : 'ipv6') + UDP_HDR + ibPart + ETH_FCS);
  return frame + WIRE_OVERHEAD;
}

export const packetCount = (size: number, mtu: number) => Math.max(1, Math.ceil(size / mtu));

/** Wire bytes for one RDMA WRITE message of `size` bytes at path MTU `mtu`. */
export function wireBytes(size: number, mtu: number, t: Transport): number {
  const n = packetCount(size, mtu);
  if (n === 1) return packetWireBytes(size, true, t);
  const last = size - mtu * (n - 1);
  return packetWireBytes(mtu, true, t) + (n - 2) * packetWireBytes(mtu, false, t) + packetWireBytes(last, false, t);
}

export interface Model { t: Transport; mtu: number; gbps: number; alphaUs: number; mrM: number }

/** Serialization time of one message, seconds (nominal data rate, i.e. after line coding and FEC). */
export const serS = (size: number, m: Model) => (wireBytes(size, m.mtu, m.t) * 8) / (m.gbps * 1e9);

/** Streaming (ib_write_bw, many WRs in flight): each message costs max(serialization, 1 / message-rate ceiling).
 *  Returns payload bits per second, the quantity perftest reports. */
export function bwBps(size: number, m: Model): number {
  return (size * 8) / Math.max(serS(size, m), 1 / (m.mrM * 1e6));
}
export const limitedBy = (size: number, m: Model): 'message rate' | 'link' => (serS(size, m) < 1 / (m.mrM * 1e6) ? 'message rate' : 'link');
export const msgRateM = (size: number, m: Model) => bwBps(size, m) / (size * 8) / 1e6;

/** Ping-pong (ib_write_lat, one message in flight), reported one-way: alpha + serialization of the message. */
export const latUs = (size: number, m: Model) => m.alphaUs + serS(size, m) * 1e6;

/** Large-message ceiling: the bandwidth at the largest sweep size. */
export const peakBps = (m: Model) => bwBps(MAX_SIZE, m);

/** Half-bandwidth point of the streaming curve: smallest size (bytes) whose bandwidth reaches half the peak.
 *  BTH padding makes bandwidth non-monotonic by a few bytes (a 97 B payload costs the same wire bytes as 100 B), but a
 *  size never does better than the next multiple of 4, which has no padding. So: binary search over multiples of 4
 *  (monotonic up to the crossing; dips at packet boundaries past one MTU stay far above half), then check the three sizes
 *  just below. The crossing is usually message-rate limited; with a high ceiling on a slow link it is link-limited. */
export function nHalfStream(m: Model): number {
  const half = peakBps(m) / 2;
  let lo = 1, hi = MAX_SIZE / 4;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (bwBps(4 * mid, m) >= half) hi = mid; else lo = mid + 1;
  }
  for (let s = Math.max(1, 4 * lo - 3); s < 4 * lo; s++) if (bwBps(s, m) >= half) return s;
  return 4 * lo;
}

/** Hockney's n½ for one message in flight: t(s) = alpha + s / r_inf reaches r_inf / 2 at s = alpha * r_inf. */
export function nHalfPingPong(m: Model): number {
  const rInfBytes = MAX_SIZE / serS(MAX_SIZE, m); // payload bytes per second at the large-message limit
  return m.alphaUs * 1e-6 * rInfBytes;
}

// perftest bandwidth units (perftest_parameters.c, print_report_bw): format_factor = 0x100000 for the default
// (MiB/s; labelled "MB/sec" up to release 24.04 and "MiB/sec" from 24.07, commit 1d202bb, Aug 2024) and 125000000 for --report_gbits (Gb/s = 10^9 bit).
export const mibToGbps = (mib: number) => (mib * MIB * 8) / 1e9;
export const gbpsToMib = (gbps: number) => (gbps * 1e9) / 8 / MIB;
export const pctOf = (gbps: number, line: number) => (100 * gbps) / line;

/** Rule of thumb from the perftest-benchmarking lesson: large-message BW average lands in the mid-90s % of nominal
 *  on a healthy link; well below (the lesson's examples: 75 % or 50 %) means something is wrong. The 90 % and 80 %
 *  cuts are this widget's choice. Non-finite input reads as 'wrong'. */
export function verdict(pct: number): 'expected' | 'below' | 'wrong' {
  if (!Number.isFinite(pct)) return 'wrong';
  if (pct >= 90) return 'expected';
  if (pct >= 80) return 'below';
  return 'wrong';
}

/** perftest's bandwidth header (perftest_parameters.h RESULT_FMT / RESULT_FMT_G). */
export const bwHeader = (gbits: boolean, legacy = false) =>
  gbits ? ' #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]'
    : ` #bytes     #iterations    BW peak[${legacy ? 'MB' : 'MiB'}/sec]    BW average[${legacy ? 'MB' : 'MiB'}/sec]   MsgRate[Mpps]`;
/** perftest's latency header (RESULT_FMT_LAT). */
export const LAT_HEADER = ' #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]   99% percentile[usec]   99.9% percentile[usec] ';

/** One row in REPORT_FMT layout (" %-7lu    %-10lu       %-7.2lf            %-7.2lf  ...  %-7.6lf"), tabs as spaces. */
export function bwRow(size: number, iters: number, peak: number, avg: number, mpps: number): string {
  return ` ${String(size).padEnd(7)}    ${String(iters).padEnd(10)}       ${peak.toFixed(2).padEnd(7)}            ${avg.toFixed(2).padEnd(7)}             ${mpps.toFixed(6)}`;
}

// ---------- formatting ----------

export function fmtSize(b: number): string {
  if (b >= MIB) return `${+(b / MIB).toFixed(2)} MiB`;
  if (b >= 1024) return `${+(b / 1024).toFixed(b % 1024 === 0 ? 0 : 1)} KiB`;
  return `${Math.round(b)} B`;
}
const fmtUs = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(us < 10 ? 2 : 1)} µs`);
const fmtG = (bps: number) => `${(bps / 1e9).toFixed(bps < 1e10 ? 2 : 1)} Gb/s`;
const fmtMib = (bps: number) => `${Math.round(bps / 8 / MIB).toLocaleString('en-US')} MiB/s`;

// ---------- UI ----------

const btn = (on: boolean) => `min-h-6 rounded-md border px-2 py-1 font-mono text-xs ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value} className={btn(o === value)}>
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

const TICKS = [2, 64, 1024, 32768, MIB, MAX_SIZE];

function Chart({ points, yLog, yMax, yMin = 0, cursor, label, fmtY, yTicks, refs = [], vMark }: {
  points: [number, number][]; yLog: boolean; yMax: number; yMin?: number; cursor: number; label: string; fmtY: (v: number) => string;
  yTicks: number[]; refs?: { y: number; text: string; tone: string }[]; vMark?: { x: number; text: string };
}) {
  const W = 640, H = 210, L = 64, B = 28, T = 12, R = 14;
  const lx = (s: number) => Math.log2(s);
  const x = (s: number) => L + ((lx(s) - 1) / (lx(MAX_SIZE) - 1)) * (W - L - R);
  const y = (v: number) => {
    const f = yLog ? (Math.log10(v) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin)) : (v - yMin) / (yMax - yMin);
    return H - B - Math.max(0, Math.min(1, f)) * (H - B - T);
  };
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const cur = points.find((p) => p[0] === cursor);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[460px]" role="img" aria-label={label}>
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="var(--border)" />
      <line x1={L} y1={T} x2={L} y2={H - B} stroke="var(--border)" />
      {TICKS.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={H - B} x2={x(t)} y2={H - B + 4} stroke="var(--muted)" />
          <text x={x(t)} y={H - B + 16} fontSize={11} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtSize(t).replace(' ', '')}</text>
        </g>
      ))}
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={L - 6} y={y(v) + 4} fontSize={11} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtY(v)}</text>
        </g>
      ))}
      {refs.map((r) => (
        <g key={r.text}>
          <line x1={L} y1={y(r.y)} x2={W - R} y2={y(r.y)} stroke={r.tone} strokeDasharray="6 4" />
          <text x={W - R - 4} y={y(r.y) - 4} fontSize={11} textAnchor="end" fill={r.tone} fontFamily="var(--font-mono)">{r.text}</text>
        </g>
      ))}
      {vMark && (
        <g>
          <line x1={x(vMark.x)} y1={T} x2={x(vMark.x)} y2={H - B} stroke="var(--warn)" strokeDasharray="4 3" />
          <text x={x(vMark.x) + 4} y={T + 12} fontSize={11} fill="var(--warn)" fontFamily="var(--font-mono)">{vMark.text}</text>
        </g>
      )}
      <path d={d} fill="none" stroke="var(--data)" strokeWidth={2} />
      {points.map((p) => <circle key={p[0]} cx={x(p[0])} cy={y(p[1])} r={2} fill="var(--data)" />)}
      {cur && (
        <g>
          <line x1={x(cur[0])} y1={T} x2={x(cur[0])} y2={H - B} stroke="var(--accent)" />
          <circle cx={x(cur[0])} cy={y(cur[1])} r={5} fill="var(--panel)" stroke="var(--accent)" strokeWidth={2} />
        </g>
      )}
    </svg>
  );
}

const SHOW_ROWS = [2, 64, 1024, 4096, 65536, MIB, MAX_SIZE];
const RATES = [100, 200, 400, 800] as const;
const MR_OPTIONS = [2, 5, 10, 20, 50, 100] as const;

export default function PerftestExplorer() {
  const [gbps, setGbps] = useState<number>(400);
  const [t, setT] = useState<Transport>('roce4');
  const [mtu, setMtu] = useState(4096);
  const [alphaUs, setAlpha] = useState(1.0);
  const [mrM, setMr] = useState<number>(10);
  const [idx, setIdx] = useState(15); // 64 KiB
  const [gbits, setGbits] = useState(true);
  const [legacy, setLegacy] = useState(false);
  const [convVal, setConvVal] = useState(46000);
  const [convUnit, setConvUnit] = useState<'MiB/s' | 'Gb/s'>('MiB/s');

  const m: Model = { t, mtu, gbps, alphaUs, mrM };
  const size = SWEEP[idx];
  const bw = bwBps(size, m);
  const lat = latUs(size, m);
  const peak = peakBps(m);
  const n2 = nHalfStream(m);
  const n2pp = nHalfPingPong(m);
  const wire = wireBytes(size, mtu, t);
  const pk = packetCount(size, mtu);
  const lim = limitedBy(size, m);

  const bwPts = useMemo(() => SWEEP.map((s) => [s, bwBps(s, { t, mtu, gbps, alphaUs, mrM }) / 1e9] as [number, number]), [t, mtu, gbps, alphaUs, mrM]);
  const latPts = useMemo(() => SWEEP.map((s) => [s, latUs(s, { t, mtu, gbps, alphaUs, mrM })] as [number, number]), [t, mtu, gbps, alphaUs, mrM]);
  const latMax = latPts[latPts.length - 1][1];
  const latTicks = [1, 10, 100, 1000, 10000].filter((v) => v >= alphaUs * 0.5 && v <= latMax * 1.5);

  const convGbps = convUnit === 'MiB/s' ? mibToGbps(convVal) : convVal;
  const convMib = convUnit === 'MiB/s' ? convVal : gbpsToMib(convVal);
  const pctNom = pctOf(convGbps, gbps);
  const pctCeil = (100 * convGbps * 1e9) / peak;
  const v = verdict(pctNom);
  const vText = { expected: 'in the expected range for large messages', below: 'below what a healthy link usually gives: recheck the setup', wrong: 'well below: something is wrong (host, PCIe, link or path)' }[v];
  const vTone = { expected: 'text-accent', below: 'text-warn', wrong: 'text-danger' }[v];

  const unit = gbits ? 'Gb/sec' : legacy ? 'MB/sec' : 'MiB/sec';
  const outRows = SHOW_ROWS.map((s) => {
    const b = bwBps(s, m);
    const val = gbits ? b / 1e9 : b / 8 / MIB;
    return bwRow(s, 5000, val, val, msgRateM(s, m));
  });
  const cmd = `ib_write_bw -d mlx5_0 -a${gbits ? ' --report_gbits' : ''}${t === 'roce4' ? ' -x 3' : t === 'roce6' ? ' -x <RoCEv2 IPv6 GID index>' : ''} 10.0.0.12`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Seg label="Link data rate" value={gbps} options={RATES} onChange={setGbps} render={(v) => `${v}G`} />
        <Seg label="Transport" value={t} options={['ib', 'roce4', 'roce6'] as const} onChange={setT} render={(v) => TRANSPORT_LABEL[v]} />
        <Seg label="Path MTU (bytes; perftest -m)" value={mtu} options={[1024, 2048, 4096]} onChange={setMtu} />
        <div>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <label htmlFor="pe-alpha">Base latency alpha (small message, one way)</label><span className="text-sm font-semibold normal-case tracking-normal text-fg">{alphaUs.toFixed(1)} µs</span>
          </div>
          <input id="pe-alpha" type="range" min={0.5} max={5} step={0.1} value={alphaUs} aria-valuetext={`${alphaUs.toFixed(1)} microseconds`}
            onChange={(e) => setAlpha(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </div>
        <Seg label="Message-rate ceiling (M msgs/s, streaming)" value={mrM} options={MR_OPTIONS} onChange={setMr} />
        <div>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <label htmlFor="pe-size">Message size (-s)</label><span className="text-sm font-semibold normal-case tracking-normal text-fg">{fmtSize(size)}</span>
          </div>
          <input id="pe-size" type="range" min={0} max={SWEEP.length - 1} step={1} value={idx} aria-valuetext={`${size.toLocaleString('en-US')} bytes`}
            onChange={(e) => setIdx(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label={`Packets at MTU ${mtu}`} value={pk.toLocaleString('en-US')} sub={`${wire.toLocaleString('en-US')} B on the wire, ${((100 * size) / wire).toFixed(1)} % payload`} />
        <Out label="ib_write_lat (t_typical)" value={fmtUs(lat)} sub={`α + wire bytes × 8 / ${gbps}G`} />
        <Out label="ib_write_bw (BW average)" value={fmtG(bw)} tone="text-data" sub={`${fmtMib(bw)} · ${((100 * bw) / (gbps * 1e9)).toFixed(1)} % of ${gbps}G`} />
        <Out label="Limited by" value={lim} tone={lim === 'link' ? 'text-accent' : 'text-warn'} sub={`${msgRateM(size, m).toFixed(3)} M msgs/s`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Bandwidth vs message size (ib_write_bw -a), Gb/s</div>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Bandwidth chart">
          <Chart points={bwPts} yLog={false} yMax={gbps * 1.08} cursor={size} fmtY={(v) => `${v}`}
            yTicks={[0.25, 0.5, 0.75, 1].map((f) => f * gbps)}
            refs={[{ y: gbps, text: `nominal ${gbps}G`, tone: 'var(--muted)' }]}
            vMark={{ x: Math.max(2, n2), text: `n½ ≈ ${fmtSize(n2)}` }}
            label={`Bandwidth rises from ${fmtG(bwPts[0][1] * 1e9)} at 2 bytes to ${fmtG(peak)} at 8 MiB on a ${gbps}G ${TRANSPORT_LABEL[t]} link; it reaches half of that at about ${fmtSize(n2)}. Selected ${fmtSize(size)}: ${fmtG(bw)}.`} />
          </div>
        </div>
        <div className="rounded-lg border border-line bg-panel p-2">
          <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Latency vs message size (ib_write_lat -a), microseconds, log scale</div>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Latency chart">
          <Chart points={latPts} yLog yMin={alphaUs * 0.5} yMax={latMax * 1.5} cursor={size} fmtY={(v) => `${v}`} yTicks={latTicks}
            label={`One-way latency stays near ${fmtUs(latPts[0][1])} for small messages and grows to ${fmtUs(latMax)} at 8 MiB, where serialization dominates. Selected ${fmtSize(size)}: ${fmtUs(lat)}.`} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-live="polite">
        <Out label="Large-message ceiling" value={fmtG(peak)} sub={`${fmtMib(peak)} · ${((100 * peak) / (gbps * 1e9)).toFixed(1)} % of nominal (headers only)`} />
        <Out label="n½ streaming (ib_write_bw)" value={fmtSize(n2)} tone="text-warn" sub={`${n2.toLocaleString('en-US')} B: half of the ceiling, many messages in flight`} />
        <Out label="n½ one in flight (ping-pong)" value={fmtSize(n2pp)} sub={`α × rate = ${alphaUs.toFixed(1)} µs × ${(peak / 8 / 1e9).toFixed(1)} GB/s`} />
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">What the sweep prints</span>
          <button type="button" aria-pressed={gbits} onClick={() => setGbits(!gbits)} className={btn(gbits)}>--report_gbits</button>
          {!gbits && <button type="button" aria-pressed={legacy} onClick={() => setLegacy(!legacy)} className={btn(legacy)}>perftest 24.04 or older (label "MB/sec")</button>}
        </div>
        <pre className="overflow-x-auto rounded-lg p-3 font-mono text-[11.5px] leading-relaxed" style={{ background: 'var(--code-bg)', color: 'var(--code-text)' }} tabIndex={0} role="region" aria-label="Illustrative ib_write_bw -a output from this model">
          {`$ ${cmd}\n...\n${bwHeader(gbits, legacy)}\n${outRows.join('\n')}`}
        </pre>
        <p className="mt-1 text-xs text-muted">
          Illustrative: numbers come from this model, not a measurement; the layout follows perftest's source and varies by version. #iterations is
          the default 5000 for write bandwidth tests; real BW peak is the best interval and usually a little above BW average. {gbits ? 'Gb/sec means 10^9 bit/s.' : `${unit} means 2^20 bytes per second (MiB/s), whatever the label says.`} MsgRate is in millions of messages per second.
        </p>
        <div className="mt-3 text-xs text-muted">
          <div className="mb-1 font-semibold text-fg">ib_write_lat columns</div>
          <pre className="overflow-x-auto rounded-lg p-2 font-mono text-[11px]" style={{ background: 'var(--code-bg)', color: 'var(--code-text)' }} tabIndex={0} role="region" aria-label="perftest latency header">{LAT_HEADER}</pre>
          <p className="mt-1">t_typical is the median; 99 % and 99.9 % are percentiles of the per-iteration samples. Write and send tests report half the measured round trip; ib_read_lat and atomics report the full time. This model has no jitter, so it predicts only t_typical: <span className="font-mono text-fg">{fmtUs(lat)}</span> at {fmtSize(size)}.</p>
        </div>
      </div>

      <div className="rounded-lg border border-line p-3">
        <div className="mb-2 text-sm font-semibold">Convert a perftest number</div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="pe-conv" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">BW average</label>
            <NumInput id="pe-conv" min={0} max={1e9} step="any" value={convVal} onValue={setConvVal}
              className="w-32 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
          </div>
          <Seg label="Unit printed" value={convUnit} options={['MiB/s', 'Gb/s'] as const} onChange={setConvUnit} render={(u) => (u === 'MiB/s' ? 'MB/sec or MiB/sec (default)' : 'Gb/sec (--report_gbits)')} />
          <Seg label="Against link" value={gbps} options={RATES} onChange={setGbps} render={(v) => `${v}G`} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
          <Out label="In Gb/s" value={convGbps.toFixed(2)} sub={convUnit === 'MiB/s' ? `${convVal} × 2^20 × 8 / 10^9` : 'as printed'} />
          <Out label="In MiB/s" value={Math.round(convMib).toLocaleString('en-US')} sub={convUnit === 'Gb/s' ? `${convVal} × 10^9 / 8 / 2^20` : 'as printed'} />
          <Out label={`% of nominal ${gbps}G`} value={`${pctNom.toFixed(1)} %`} tone={vTone} sub={`${pctCeil.toFixed(1)} % of the header ceiling`} />
          <Out label="Reading" value={v === 'expected' ? 'expected' : v === 'below' ? 'below typical' : 'something wrong'} tone={vTone} sub={vText} />
        </div>
        <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="What good looks like at each link speed">
          <table className="w-full min-w-[460px] text-left text-xs">
            <caption className="mb-1 text-left text-xs text-muted">What good looks like for large messages ({TRANSPORT_LABEL[t]}, MTU {mtu})</caption>
            <thead className="font-mono text-[10px] uppercase text-muted">
              <tr><th className="pr-3">Link</th><th className="pr-3">Nominal in MiB/s</th><th className="pr-3">Header ceiling</th><th>90 % of nominal</th></tr>
            </thead>
            <tbody>
              {RATES.map((r) => {
                const c = peakBps({ ...m, gbps: r });
                return (
                  <tr key={r} className={`border-t border-line ${r === gbps ? 'font-semibold' : ''}`}>
                    <td className="py-1 pr-3 font-mono">{r}G{r === gbps ? ' ◂' : ''}</td>
                    <td className="pr-3 font-mono">{Math.round(gbpsToMib(r)).toLocaleString('en-US')}</td>
                    <td className="pr-3 font-mono text-data">{(c / 1e9).toFixed(1)} Gb/s · {fmtMib(c)}</td>
                    <td className="font-mono">{(0.9 * r).toFixed(0)} Gb/s · {Math.round(gbpsToMib(0.9 * r)).toLocaleString('en-US')} MiB/s</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>packets = ⌈{size.toLocaleString('en-US')} / {mtu}⌉ = {pk}; per packet {t === 'ib'
            ? <>LRH 8 + BTH 12 + ICRC 4 + VCRC 2 = <span className="font-mono text-fg">26 B</span></>
            : <>preamble/SFD 8 + Ethernet 14 + {t === 'roce4' ? 'IPv4 20' : 'IPv6 40'} + UDP 8 + BTH 12 + ICRC 4 + FCS 4 + IFG 12 = <span className="font-mono text-fg">{t === 'roce4' ? 82 : 102} B</span> (64 B minimum frame)</>}, plus RETH 16 B on the first packet → <span className="font-mono text-fg">{wire.toLocaleString('en-US')} B</span> on the wire</li>
          <li>serialization = {wire.toLocaleString('en-US')} × 8 / {gbps}e9 = <span className="font-mono text-fg">{fmtUs(serS(size, m) * 1e6)}</span>; latency = α + serialization = <span className="font-mono text-fg">{fmtUs(lat)}</span></li>
          <li>streaming: each message takes max(serialization, 1 / {mrM} M/s = {fmtUs(1 / mrM)}) → BW = size × 8 / that = <span className="font-mono text-fg">{fmtG(bw)}</span> ({lim}-limited)</li>
          <li>n½ (streaming) is the smallest size whose bandwidth reaches ceiling / 2 = {fmtG(peak / 2)}: {limitedBy(n2, m) === 'message rate'
            ? <>there the message rate limits, so size × 8 × {mrM}e6 = ceiling / 2</>
            : <>here even small messages are link-limited (the {mrM} M/s ceiling never binds), so headers and the minimum frame set it</>} → about <span className="font-mono text-fg">{n2.toLocaleString('en-US')} B</span>; with one message in flight it is α × rate = <span className="font-mono text-fg">{Math.round(n2pp).toLocaleString('en-US')} B</span>, which is why bandwidth tests keep many WRs in flight (-t, default 128)</li>
          <li>MiB/s → Gb/s: × 2^20 × 8 / 10^9 = × 0.008388608; {gbps} Gb/s = {Math.round(gbpsToMib(gbps)).toLocaleString('en-US')} MiB/s</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>1 MiB = 1,048,576 B</Pill><Pill>1 Gb = 10^9 bit</Pill><Pill>46,000 MiB/s ≈ 385.9 Gb/s</Pill><Pill>-a: 2 B to 8 MiB</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model, not a measurement. Latency is α plus the serialization of the whole message at the nominal data rate (encoding and FEC already removed);
        it ignores PCIe and DMA time, per-hop switch latency and store-and-forward effects. Streaming bandwidth is the smaller of the link limit and a
        single message-rate ceiling: real adapters reach their best message rates only with several QPs, and both α and the ceiling depend on adapter,
        firmware, CPU and settings, so the defaults here are illustrative. Header bytes are counted for an RDMA WRITE (RETH on the first packet) without VLAN
        tag or GRH; InfiniBand link-layer framing, flow-control packets and ACKs on the reverse direction are not modelled, so real large-message
        results sit a little below the header ceiling. Units follow perftest's source: default bandwidth in 2^20-byte MiB/s (printed as "MB/sec" by releases up to 24.04), --report_gbits in 10^9-bit Gb/s. The 90 % / 80 % reading bands are this widget's rule of thumb; compare against identical hosts in your fabric.
      </p>
    </div>
  );
}
