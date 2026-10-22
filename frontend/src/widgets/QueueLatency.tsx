import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure calculation (unit-testable). Decimal units: 1 KB = 1e3 B, 1 MB = 1e6 B. ----------

export const WIRE_EXTRA = 20; // preamble+SFD 8 + minimum IPG 12, per frame

/** Time to clock one frame onto the wire, seconds. */
export const serializationS = (frameBytes: number, gbps: number) => ((frameBytes + WIRE_EXTRA) * 8) / (gbps * 1e9);
/** Queueing delay for bytes already queued ahead (the lesson's formula: depth / rate). */
export const queueDelayS = (depthBytes: number, gbps: number) => (depthBytes * 8) / (gbps * 1e9);
export const packetsPerSecond = (frameBytes: number, gbps: number) => 1 / serializationS(frameBytes, gbps);

export interface IncastResult {
  excessBps: number; fillS: number; burstS: number; peakUnbounded: number; peak: number; drops: number;
  endS: number; maxDelayS: number; points: [number, number][]; dropFrom: number | null; dropTo: number | null;
}

/** N senders, each at line rate, each sending burstBytes to one egress port of the same rate with bufferBytes for this queue. */
export function incast(n: number, burstBytes: number, bufferBytes: number, gbps: number, lossless: boolean): IncastResult {
  const R = (gbps * 1e9) / 8; // bytes per second
  const excessBps = (n - 1) * gbps * 1e9;
  const fillS = n > 1 ? bufferBytes / ((n - 1) * R) : Infinity;
  const burstS = burstBytes / R; // every sender transmits for this long
  const peakUnbounded = (n - 1) * burstBytes; // arrivals N·B minus drained B during the burst
  const overflow = peakUnbounded > bufferBytes; // ⇔ N·B > buffer + B
  const peak = Math.min(peakUnbounded, bufferBytes);
  const drops = lossless ? 0 : Math.max(0, peakUnbounded - bufferBytes);
  const endS = (n * burstBytes - drops) / R;
  const points: [number, number][] = [[0, 0]];
  let dropFrom: number | null = null, dropTo: number | null = null;
  if (!overflow) points.push([burstS, peak], [burstS + peak / R, 0]);
  else if (!lossless) { points.push([fillS, peak], [burstS, peak], [burstS + peak / R, 0]); dropFrom = fillS; dropTo = burstS; }
  else points.push([fillS, peak], [endS - peak / R, peak], [endS, 0]); // senders paused; idealised PFC, no headroom modelled
  return { excessBps, fillS, burstS, peakUnbounded, peak, drops, endS, maxDelayS: peak / R, points, dropFrom, dropTo };
}

// ---------- formatting ----------

export function fmtTime(s: number): string {
  if (!isFinite(s)) return '∞';
  if (s < 1e-6) return `${(s * 1e9).toFixed(s < 1e-8 ? 2 : 1)} ns`;
  if (s < 1e-3) return `${(s * 1e6).toFixed(s < 1e-5 ? 2 : 1)} µs`;
  return `${(s * 1e3).toFixed(2)} ms`;
}
export function fmtBytes(b: number): string {
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e7 ? 1 : 2)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}
const fmtRate = (bps: number) => (bps >= 1e12 ? `${(bps / 1e12).toFixed(2)} Tb/s` : `${(bps / 1e9).toFixed(0)} Gb/s`);

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

function Chart({ r, buffer }: { r: IncastResult; buffer: number }) {
  const W = 640, H = 220, L = 58, B = 30, T = 12, Rr = 12;
  const tMax = Math.max(...r.points.map((p) => p[0])) * 1.05 || 1;
  const yMax = Math.max(buffer, r.peak) * 1.15 || 1;
  const x = (t: number) => L + (t / tMax) * (W - L - Rr);
  const y = (q: number) => H - B - (q / yMax) * (H - B - T);
  const d = r.points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * tMax / 1.05);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Queue depth over time: peak ${fmtBytes(r.peak)}, empty after ${fmtTime(r.endS)}`}>
      <line x1={L} y1={H - B} x2={W - Rr} y2={H - B} stroke="var(--border)" />
      <line x1={L} y1={T} x2={L} y2={H - B} stroke="var(--border)" />
      {ticks.map((t) => (
        <g key={t}><line x1={x(t)} y1={H - B} x2={x(t)} y2={H - B + 4} stroke="var(--muted)" />
          <text x={x(t)} y={H - B + 16} fontSize={11} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtTime(t)}</text></g>
      ))}
      <line x1={L} y1={y(buffer)} x2={W - Rr} y2={y(buffer)} stroke="var(--danger)" strokeDasharray="5 4" />
      <text x={L + 4} y={y(buffer) - 4} fontSize={11} fill="var(--danger)" fontFamily="var(--font-mono)">buffer {fmtBytes(buffer)}</text>
      <text x={L - 6} y={y(0) + 4} fontSize={11} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">0</text>
      <text x={L - 6} y={y(r.peak) + 4} fontSize={11} textAnchor="end" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtBytes(r.peak)}</text>
      {r.dropFrom !== null && r.dropTo !== null && (
        <rect x={x(r.dropFrom)} y={T} width={Math.max(1, x(r.dropTo) - x(r.dropFrom))} height={H - B - T} fill="var(--danger)" opacity={0.12} />
      )}
      <path d={`${d} L${x(r.points[r.points.length - 1][0])},${y(0)} Z`} fill="var(--data)" opacity={0.15} />
      <path d={d} fill="none" stroke="var(--data)" strokeWidth={2} />
      <line x1={x(r.burstS)} y1={T} x2={x(r.burstS)} y2={H - B} stroke="var(--muted)" strokeDasharray="2 3" />
      <text x={x(r.burstS) + 4} y={T + 10} fontSize={11} fill="var(--muted)" fontFamily="var(--font-mono)">burst ends</text>
    </svg>
  );
}

const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || lo));

export default function QueueLatency() {
  const [gbps, setGbps] = useState(400);
  const [frame, setFrame] = useState(4158);
  const [depth, setDepth] = useState(1000);
  const [depthUnit, setDepthUnit] = useState<'KB' | 'packets'>('KB');
  const [bufferMB, setBufferMB] = useState(2);
  const [n, setN] = useState(8);
  const [burstKB, setBurstKB] = useState(1000);
  const [lossless, setLossless] = useState(false);

  const ser = serializationS(frame, gbps);
  const pps = packetsPerSecond(frame, gbps);
  const depthPkts = depthUnit === 'packets' ? depth : (depth * 1e3) / frame;
  const depthBytes = depthUnit === 'packets' ? depth * frame : depth * 1e3;
  const qSimple = queueDelayS(depthBytes, gbps);
  const qWire = depthPkts * ser;
  const buffer = bufferMB * 1e6;
  const burst = burstKB * 1e3;
  const r = incast(n, burst, buffer, gbps, lossless);
  const overflow = r.peakUnbounded > buffer;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Seg label="Link speed" value={gbps} options={[100, 200, 400, 800] as const} onChange={setGbps} render={(v) => `${v}G`} />
        <div>
          <label htmlFor="ql-frame" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Frame size (B, without preamble/IPG)</label>
          <div className="flex flex-wrap items-center gap-1">
            <input id="ql-frame" type="number" min={64} max={9216} value={frame} onChange={(e) => setFrame(Math.floor(num(e.target.value, 64, 9216)))}
              className="w-20 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
            {[64, 1518, 4158, 9018].map((f) => (
              <button key={f} type="button" aria-pressed={f === frame} onClick={() => setFrame(f)}
                className={`rounded-md border px-1.5 py-1 font-mono text-xs ${f === frame ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{f}</button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="ql-depth" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Current queue depth</label>
          <div className="flex items-center gap-1">
            <input id="ql-depth" type="number" min={0} max={1e6} value={depth} onChange={(e) => setDepth(num(e.target.value, 0, 1e6))}
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
            {(['KB', 'packets'] as const).map((u) => (
              <button key={u} type="button" aria-pressed={u === depthUnit} onClick={() => setDepthUnit(u)}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${u === depthUnit ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{u}</button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="ql-buf" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Buffer for this queue (MB)</label>
          <div className="flex flex-wrap items-center gap-1">
            <input id="ql-buf" type="number" min={0.01} max={500} step={0.5} value={bufferMB} onChange={(e) => setBufferMB(num(e.target.value, 0.01, 500))}
              className="w-20 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
            {[1, 2, 10, 32].map((b) => (
              <button key={b} type="button" aria-pressed={b === bufferMB} onClick={() => setBufferMB(b)}
                className={`rounded-md border px-1.5 py-1 font-mono text-xs ${b === bufferMB ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{b}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <label htmlFor="ql-n">Incast degree N (senders)</label><span className="text-base font-semibold normal-case tracking-normal text-fg">{n}:1</span>
          </div>
          <input id="ql-n" type="range" min={1} max={64} value={n} onChange={(e) => setN(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </div>
        <div>
          <label htmlFor="ql-burst" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Burst per sender (KB)</label>
          <div className="flex flex-wrap items-center gap-1">
            <input id="ql-burst" type="number" min={1} max={100000} value={burstKB} onChange={(e) => setBurstKB(num(e.target.value, 1, 100000))}
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
            {[64, 256, 1000, 4000].map((b) => (
              <button key={b} type="button" aria-pressed={b === burstKB} onClick={() => setBurstKB(b)}
                className={`rounded-md border px-1.5 py-1 font-mono text-xs ${b === burstKB ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{b}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label="Serialization / frame" value={fmtTime(ser)} sub={`(${frame} + 20) × 8 / ${gbps}G`} />
        <Out label="Packet rate" value={`${(pps / 1e6).toFixed(1)} Mpps`} sub="one port, line rate" />
        <Out label="Queueing delay now" value={fmtTime(qSimple)} tone="text-data" sub={`${fmtBytes(depthBytes)} ≈ ${depthPkts.toFixed(depthPkts < 10 ? 1 : 0)} pkts; ${fmtTime(qWire)} with IPG`} />
        <Out label="Delay at full buffer" value={fmtTime(queueDelayS(buffer, gbps))} sub={`${fmtBytes(buffer)} / ${gbps}G`} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">When the buffer is full</div>
        {([false, true] as const).map((v) => (
          <button key={String(v)} type="button" aria-pressed={lossless === v} onClick={() => setLossless(v)}
            className={`rounded-md border px-2 py-1 font-mono text-xs ${lossless === v ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{v ? 'pause senders (idealised PFC)' : 'tail drop'}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label="Excess arrival" value={n > 1 ? fmtRate(r.excessBps) : '0'} sub={`(${n} − 1) × ${gbps}G`} />
        <Out label="Time to fill buffer" value={n > 1 ? fmtTime(r.fillS) : 'never'} tone={overflow ? 'text-warn' : 'text-fg'} sub={`${fmtBytes(buffer)} / excess`} />
        <Out label="Peak queue" value={fmtBytes(r.peak)} sub={`max delay ${fmtTime(r.maxDelayS)}`} tone="text-data" />
        <Out label={lossless ? 'Dropped (paused instead)' : 'Dropped'} value={fmtBytes(r.drops)} tone={r.drops > 0 ? 'text-danger' : 'text-accent'}
          sub={r.drops > 0 ? `${((r.drops / (n * burst)) * 100).toFixed(1)} % of ${fmtBytes(n * burst)}` : lossless && overflow ? 'senders paused, congestion spreads' : 'fits'} />
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Queue depth during the burst</div>
        <Chart r={r} buffer={buffer} />
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>queueing delay = depth × 8 / rate = {fmtBytes(depthBytes)} × 8 / {gbps}e9 = <span className="font-mono text-fg">{fmtTime(qSimple)}</span> (counting 20 B preamble+IPG per queued frame: {fmtTime(qWire)})</li>
          <li>each sender transmits {fmtBytes(burst)} at line rate for {fmtBytes(burst)} × 8 / {gbps}e9 = <span className="font-mono text-fg">{fmtTime(r.burstS)}</span>; arrivals {n} × {gbps}G, drain {gbps}G → growth (N − 1) × rate</li>
          <li>time to fill = buffer / excess = {fmtBytes(buffer)} × 8 / {fmtRate(r.excessBps)} = <span className="font-mono text-fg">{n > 1 ? fmtTime(r.fillS) : '∞'}</span></li>
          <li>arrived N·B = {fmtBytes(n * burst)}; drained during the burst = B = {fmtBytes(burst)}; {overflow ? <>N·B &gt; buffer + B → {lossless ? 'senders are paused' : <>drops = (N − 1)·B − buffer = <span className="font-mono text-danger">{fmtBytes(r.drops)}</span></>}</> : <>N·B ≤ buffer + B → no overflow, peak = (N − 1)·B = {fmtBytes(r.peak)}</>}</li>
          <li>queue empty after <span className="font-mono text-fg">{fmtTime(r.endS)}</span> = (bytes delivered) / rate; the last byte waited {fmtTime(r.maxDelayS)}</li>
        </ol>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-muted">
        <span className="font-semibold text-fg">Little's law:</span> L = λ·W. Average packets queued = arrival rate × average time in queue. A port draining
        {' '}{(pps / 1e6).toFixed(1)} Mpps with an average of {depthPkts.toFixed(0)} packets queued gives W = L / λ = <span className="font-mono text-fg">{fmtTime(depthPkts / pps)}</span>;
        holding the queue shorter is the only way to cut that delay at a given throughput.
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>{gbps}G drains {fmtBytes((gbps * 1e9) / 8 / 1e6)} per µs</Pill>
        <Pill>excess fills {n > 1 ? fmtBytes(r.excessBps / 8 / 1e6) : '0 B'} per µs</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Fluid model: all N senders start together at full line rate, no congestion control reacts during the burst, the egress port runs at the same rate
        and the "buffer" is the share this queue may use (a slice of the shared ASIC buffer; check your platform). Tail drop discards the excess; the
        PFC option idealises pausing (no headroom, no XOFF/XON thresholds, no victim flows). Real ECN/DCQCN starts cutting rates after about one RTT, so
        measured peaks are usually lower. Decimal units (1 MB = 10^6 B) as in the lessons.
      </p>
    </div>
  );
}
