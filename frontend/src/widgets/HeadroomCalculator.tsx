import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

export type MarginMode = 'none' | 'percent' | 'cells';
export interface HeadroomInput {
  gbps: number; meters: number; nsPerM: number; mtu: number;
  resp: number; respUnit: 'ns' | 'bits';
  margin: MarginMode; marginPct: number; cell: number; pkt: number;
}
export interface Headroom {
  propNs: number; cable: number; frames: number; response: number; base: number;
  cellFactor: number; total: number;
}

/** Bytes that arrive at `gbps` during `ns` nanoseconds: Gb/s × ns = bits. */
export const bytesAt = (gbps: number, ns: number) => (gbps * ns) / 8;

/** Preamble + SFD (8 B) + minimum inter-frame gap (12 B): wire bytes that never reach the buffer. */
export const WIRE_OVERHEAD = 20;

/** Buffer bytes consumed per wire byte when packets of `pkt` bytes are stored in cells of `cell` bytes. */
export function cellFactor(pkt: number, cell: number): number {
  return (Math.ceil(pkt / cell) * cell) / (pkt + WIRE_OVERHEAD);
}

/**
 * PFC headroom for one lossless priority group on one port (802.1Qbb / 802.1Q Annex N style model):
 *   rate × (2 × cable propagation + response delays) + 2 × max frame, then an optional margin.
 */
export function headroom(i: HeadroomInput): Headroom {
  const propNs = i.meters * i.nsPerM;
  const cable = bytesAt(i.gbps, 2 * propNs);
  const response = i.respUnit === 'ns' ? bytesAt(i.gbps, i.resp) : i.resp / 8;
  const frames = 2 * i.mtu;
  const base = cable + response + frames;
  let total = base, f = 1;
  if (i.margin === 'percent') total = base * (1 + i.marginPct / 100);
  if (i.margin === 'cells') {
    f = cellFactor(i.pkt, i.cell);
    const rounded = (cable + response) * f + 2 * Math.ceil(i.mtu / i.cell) * i.cell;
    total = Math.ceil(rounded / i.cell) * i.cell;
  }
  return { propNs, cable, frames, response, base, cellFactor: f, total };
}

export function totalReserved(perPgBytes: number, pgs: number, ports: number) {
  return perPgBytes * pgs * ports;
}

const SPEEDS = [25, 50, 100, 200, 400, 800];
const LENGTHS = [3, 30, 100, 500, 2000];
const MTUS = [1500, 4200, 9216];
const kb = (b: number) => `${(b / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`;
const mb = (b: number) => `${(b / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} MB`;
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');

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

function Num({ label, value, set, min, max, step = 1 }: { label: string; value: number; set: (v: number) => void; min: number; max: number; step?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <NumInput value={value} min={min} max={max} step={step} onValue={set}
        className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
    </label>
  );
}

export default function HeadroomCalculator() {
  const [gbps, setGbps] = useState(400);
  const [meters, setMeters] = useState(100);
  const [nsPerM, setNsPerM] = useState(5);
  const [mtu, setMtu] = useState(9216);
  const [resp, setResp] = useState(1000);
  const [respUnit, setRespUnit] = useState<'ns' | 'bits'>('ns');
  const [margin, setMargin] = useState<MarginMode>('none');
  const [marginPct, setMarginPct] = useState(20);
  const [cell, setCell] = useState(256);
  const [pkt, setPkt] = useState(64);
  const [pgs, setPgs] = useState(1);
  const [ports, setPorts] = useState(64);
  const [bufMB, setBufMB] = useState(64);

  const h = useMemo(() => headroom({ gbps, meters, nsPerM, mtu, resp, respUnit, margin, marginPct, cell, pkt }),
    [gbps, meters, nsPerM, mtu, resp, respUnit, margin, marginPct, cell, pkt]);
  const total = totalReserved(h.total, pgs, ports);
  const share = total / (bufMB * 1e6);
  const respNs = respUnit === 'ns' ? resp : resp / gbps; // 1 bit time at G Gb/s = 1/G ns

  const switchUnit = (u: 'ns' | 'bits') => {
    if (u === respUnit) return;
    setResp(Math.round(u === 'bits' ? resp * gbps : resp / gbps));
    setRespUnit(u);
  };

  const parts = [
    { label: 'Cable round trip', v: h.cable, color: 'var(--data)' },
    { label: 'Response delays', v: h.response, color: 'var(--warn)' },
    { label: '2 × max frame', v: h.frames, color: 'var(--accent)' },
    { label: 'Margin', v: Math.max(0, h.total - h.base), color: 'var(--muted)' },
  ];
  const sum = parts.reduce((a, p) => a + p.v, 0) || 1;
  let x = 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Seg label="Port speed" value={gbps} options={SPEEDS} onChange={setGbps} render={(v) => `${v}G`} />
        <Seg label="Max frame / port MTU (bytes)" value={mtu} options={MTUS} onChange={setMtu} />
        <div>
          <Seg label="Cable length (m)" value={meters} options={LENGTHS} onChange={setMeters} />
          <input type="range" min={1} max={2000} value={meters} onChange={(e) => setMeters(Number(e.target.value))} aria-label="Cable length in metres" aria-valuetext={`${meters} m`}
            className="mt-2 w-full accent-[var(--accent)]" />
          <div className="font-mono text-xs text-muted">{meters} m · {nsPerM} ns/m → one way {n0(h.propNs)} ns</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Num label={`Response delay (${respUnit === 'ns' ? 'ns' : 'bit times'})`} value={resp} set={setResp} min={0} max={respUnit === 'ns' ? 100000 : 100000000} />
          <Num label="Propagation (ns/m)" value={nsPerM} set={setNsPerM} min={3} max={6} step={0.1} />
          <div className="col-span-2"><Seg label="Response unit" value={respUnit} options={['ns', 'bits'] as const} onChange={switchUnit} render={(v) => (v === 'ns' ? 'nanoseconds' : 'bit times')} /></div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Seg label="Margin" value={margin} options={['none', 'percent', 'cells'] as const} onChange={setMargin}
          render={(v) => ({ none: 'none', percent: '+ % margin', cells: 'cell rounding' }[v])} />
        {margin === 'percent' && <Num label="Margin (%)" value={marginPct} set={setMarginPct} min={0} max={200} />}
        {margin === 'cells' && (
          <div className="grid grid-cols-2 gap-2">
            <Num label="Cell size (B)" value={cell} set={setCell} min={64} max={1024} />
            <Num label="Worst-case packet (B)" value={pkt} set={setPkt} min={64} max={9216} />
          </div>
        )}
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <svg viewBox="0 0 600 46" className="w-full" role="img" aria-label={`Headroom components, total ${kb(h.total)} per PG per port: ${parts.filter((p) => p.v > 0).map((p) => `${p.label} ${n0(p.v)} bytes`).join(', ')}`}>
          {parts.map((p) => {
            const w = (p.v / sum) * 600;
            const r = <rect key={p.label} x={x} y={4} width={Math.max(0, w)} height={22} fill={p.color} opacity={0.85} />;
            x += w;
            return r;
          })}
          <text x={0} y={42} fontSize={12} fill="var(--muted)" fontFamily="var(--font-mono)">0</text>
          <text x={600} y={42} fontSize={12} fill="var(--text)" fontFamily="var(--font-mono)" textAnchor="end">{kb(h.total)} per PG per port</text>
        </svg>
        <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted">
          {parts.filter((p) => p.v > 0).map((p) => (
            <span key={p.label} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />{p.label}</span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Headroom calculation">
        <table className="w-full min-w-[480px] text-left text-xs">
          <thead className="text-muted"><tr><th className="py-1 pr-2">Component</th><th className="pr-2">Calculation</th><th className="text-right">Bytes</th></tr></thead>
          <tbody className="font-mono">
            <tr className="border-t border-line"><td className="py-1 pr-2 font-sans">Cable, round trip</td><td className="pr-2">2 × {meters} m × {nsPerM} ns/m = {n0(2 * h.propNs)} ns × {gbps} Gb/s ÷ 8</td><td className="text-right text-data">{n0(h.cable)}</td></tr>
            <tr className="border-t border-line"><td className="py-1 pr-2 font-sans">Response delays (PHY, FEC, MAC, scheduler)</td><td className="pr-2">{respUnit === 'ns' ? `${n0(resp)} ns × ${gbps} Gb/s ÷ 8` : `${n0(resp)} bit times ÷ 8 (= ${n0(respNs)} ns at ${gbps}G)`}</td><td className="text-right text-warn">{n0(h.response)}</td></tr>
            <tr className="border-t border-line"><td className="py-1 pr-2 font-sans">Frame in progress at receiver (PFC waits behind it) + at sender (cannot abort)</td><td className="pr-2">2 × {mtu}</td><td className="text-right text-accent">{n0(h.frames)}</td></tr>
            <tr className="border-t border-line"><td className="py-1 pr-2 font-sans font-semibold">Total before margin</td><td><span className="sr-only">sum of the above</span></td><td className="text-right font-semibold">{n0(h.base)}</td></tr>
            {margin === 'percent' && <tr className="border-t border-line"><td className="py-1 pr-2 font-sans">With margin</td><td className="pr-2">× {(1 + marginPct / 100).toFixed(2)}</td><td className="text-right">{n0(h.total)}</td></tr>}
            {margin === 'cells' && <tr className="border-t border-line"><td className="py-1 pr-2 font-sans">With cell rounding</td>
              <td className="pr-2">rate terms × ⌈{pkt}/{cell}⌉·{cell}/({pkt}+20) = ×{h.cellFactor.toFixed(2)}; frames as ⌈{mtu}/{cell}⌉ cells; total to whole cells</td><td className="text-right">{n0(h.total)}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Num label="Lossless priorities" value={pgs} set={(v) => setPgs(Math.round(v))} min={1} max={8} />
        <Num label="Ports" value={ports} set={(v) => setPorts(Math.round(v))} min={1} max={512} />
        <Num label="Switch buffer (MB)" value={bufMB} set={setBufMB} min={1} max={1000} />
      </div>

      <div aria-live="polite" className={`rounded-lg border px-3 py-2 text-sm ${share > 0.5 ? 'border-danger/50 text-danger' : share > 0.2 ? 'border-warn/50 text-warn' : 'border-line'}`}>
        <span className="font-mono">{kb(h.total)} × {pgs} PG × {ports} ports = <b>{mb(total)}</b></span>
        <span className="text-muted"> of {bufMB} MB buffer = </span><b className="font-mono">{(share * 100).toFixed(1)} %</b>
        <span className="text-muted"> reserved as headroom{share > 1 ? ': does not fit at all' : share > 0.5 ? ': most of the buffer is idle reserve' : ''}.</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>lesson example: 400G, 100 m, 9216, 1 µs → {kb(118432)}</Pill>
        <Pill>1 bit time at {gbps}G = {(1 / gbps).toFixed(4)} ns</Pill>
        <Pill>every rate term doubles when speed doubles</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model: headroom ≈ rate × (2 × propagation + response delays) + 2 × max frame (the frame the downstream port is sending when it decides to pause,
        and the frame the upstream port cannot abort), as in the IEEE 802.1Qbb / 802.1Q Annex N headroom discussion. ~5 ns/m is typical for fibre;
        copper is similar. The 1 µs response delay is a placeholder, not a standard value: IEEE 802.3 bounds MAC Control and PHY delays per PHY type in
        bit times, and real 400G/800G ports add FEC and ASIC latency on top, so use your vendor's figure. Cell size and the 20-byte preamble/IFG adjustment
        are illustrative; switches compute headroom with their own buffer manager from port speed, cable length and MTU. KB and MB here are decimal (1000).
      </p>
    </div>
  );
}
