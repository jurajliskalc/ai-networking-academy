import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Pure model ----------

export interface Gen { gen: number; gts: number; encoding: string; num: number; den: number; signal: string; status: string; specOnly?: boolean }

// Encoding factors as used by the Linux kernel's PCIE_SPEED2MBS_ENC (Gen6 counted 1/1: FLIT overhead not subtracted).
export const GENS: Gen[] = [
  { gen: 1, gts: 2.5, encoding: '8b/10b', num: 8, den: 10, signal: 'NRZ', status: '2003' },
  { gen: 2, gts: 5, encoding: '8b/10b', num: 8, den: 10, signal: 'NRZ', status: '2007' },
  { gen: 3, gts: 8, encoding: '128b/130b', num: 128, den: 130, signal: 'NRZ', status: '2010' },
  { gen: 4, gts: 16, encoding: '128b/130b', num: 128, den: 130, signal: 'NRZ', status: '2017' },
  { gen: 5, gts: 32, encoding: '128b/130b', num: 128, den: 130, signal: 'NRZ', status: '2019' },
  { gen: 6, gts: 64, encoding: 'FLIT (256 B, with FEC)', num: 1, den: 1, signal: 'PAM4', status: '2022' },
  { gen: 7, gts: 128, encoding: 'FLIT (256 B, with FEC)', num: 1, den: 1, signal: 'PAM4', status: 'spec 2025, products later', specOnly: true },
];
export const WIDTHS = [1, 4, 8, 16];
export const NICS = [100, 200, 400, 800];
/** PCIe 6.0+ FLIT: 236 B TLP + 6 B DLP + 8 B CRC + 6 B FEC = 256 B, so 236/256 of the FLIT carries TLPs. */
export const FLIT_TLP_SHARE = 236 / 256;

/** Per-lane Mb/s per direction exactly as the kernel computes it (integer arithmetic, truncated). */
export function laneMbps(g: Gen): number {
  return Math.floor((g.gts * 1000 * g.num) / g.den);
}
/** Link bandwidth per direction in Gb/s, kernel style (e.g. Gen5 x16 = 504.112 Gb/s). */
export function linkGbps(g: Gen, width: number): number {
  return (laneMbps(g) * width) / 1000;
}
/** Rough usable DMA throughput: link rate x FLIT factor (Gen6+) x assumed TLP/protocol efficiency. */
export function usableGbps(g: Gen, width: number, efficiency: number): number {
  return linkGbps(g, width) * (g.gen >= 6 ? FLIT_TLP_SHARE : 1) * efficiency;
}
export type Verdict = 'ok' | 'marginal' | 'short';
export function verdict(g: Gen, width: number, needGbps: number, efficiency: number): Verdict {
  if (usableGbps(g, width, efficiency) >= needGbps) return 'ok';
  return linkGbps(g, width) >= needGbps ? 'marginal' : 'short';
}

// ---------- UI ----------

const f3 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
const show = (gbps: number, unit: 'Gb' | 'GB') => (unit === 'Gb' ? f3(gbps) : (gbps / 8).toFixed(gbps / 8 < 10 ? 2 : 1));

function Seg<T extends string | number>({ label, value, options, onChange, fmt }: { label: string; value: T; options: T[]; onChange: (v: T) => void; fmt?: (v: T) => string }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{fmt ? fmt(o) : String(o)}</button>
        ))}
      </div>
    </div>
  );
}

const V: Record<Verdict, { cls: string; text: string }> = {
  ok: { cls: 'border-accent/50 bg-accent/10 text-accent', text: 'The slot can feed the port at line rate (by this estimate).' },
  marginal: { cls: 'border-warn/50 bg-warn/10 text-warn', text: 'Raw link rate exceeds the port, but after protocol overhead it probably cannot sustain line rate.' },
  short: { cls: 'border-danger/50 bg-danger/10 text-danger', text: 'The PCIe link is slower than the port even before overhead: PCIe, not the network, is the bottleneck.' },
};

export default function PcieBandwidth() {
  const [unit, setUnit] = useState<'Gb' | 'GB'>('Gb');
  const [gen, setGen] = useState(5);
  const [width, setWidth] = useState(16);
  const [nic, setNic] = useState(400);
  const [ports, setPorts] = useState(1);
  const [eff, setEff] = useState(85);

  const g = GENS[gen - 1];
  const need = nic * ports;
  const link = linkGbps(g, width);
  const usable = usableGbps(g, width, eff / 100);
  const v = verdict(g, width, need, eff / 100);
  const minWidth = WIDTHS.find((w) => verdict(g, w, need, eff / 100) === 'ok');
  const max = Math.max(link, need) * 1.08;
  const bars = [
    { label: `Gen${gen} x${width} link`, val: link, color: 'var(--data)' },
    { label: 'estimated usable', val: usable, color: 'var(--accent)' },
    { label: `${ports > 1 ? `${ports}×` : ''}${nic}G port demand`, val: need, color: 'var(--warn)' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted">Per direction (each lane is full duplex: the same again the other way).</div>
        <div className="flex gap-1">
          {(['Gb', 'GB'] as const).map((u) => (
            <button key={u} type="button" onClick={() => setUnit(u)} aria-pressed={unit === u}
              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${unit === u ? 'border-fg text-fg' : 'border-line text-muted'}`}>{u}/s</button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              <th className="py-1.5 pr-2">Gen</th><th className="pr-2">GT/s</th><th className="pr-2">Signal</th><th className="pr-2">Encoding</th>
              {WIDTHS.map((w) => <th key={w} className="pr-2 text-right">x{w} {unit}/s</th>)}<th className="pl-2">Spec</th>
            </tr>
          </thead>
          <tbody>
            {GENS.map((r) => (
              <tr key={r.gen} onClick={() => setGen(r.gen)} className={`cursor-pointer border-b border-line ${r.gen === gen ? 'bg-accent-soft' : 'hover:bg-panel-2'} ${r.specOnly ? 'text-muted' : ''}`}>
                <td className="py-1.5 pr-2 font-semibold">
                  <button type="button" onClick={() => setGen(r.gen)} aria-pressed={r.gen === gen} className="font-semibold">{r.gen}.0</button>
                </td>
                <td className="pr-2 font-mono">{r.gts}</td>
                <td className="pr-2 font-mono text-xs">{r.signal}</td>
                <td className="pr-2 text-xs">{r.encoding}{r.gen >= 6 ? '*' : ''}</td>
                {WIDTHS.map((w) => <td key={w} className={`pr-2 text-right font-mono ${w === width && r.gen === gen ? 'text-accent font-semibold' : ''}`}>{show(linkGbps(r, w), unit)}</td>)}
                <td className="pl-2 text-xs">{r.specOnly ? <span className="text-warn">{r.status}</span> : r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted">
        Values are link rate after line encoding, computed like the Linux kernel's "available PCIe bandwidth" message: per-lane Mb/s = GT/s × encoding, truncated to an
        integer, × width. That is why Gen5 x16 shows 504.112 Gb/s (31,507 Mb/s × 16) rather than 504.123. *Gen6 and Gen7 are shown at the raw 1 bit per transfer (the kernel counts Gen6 this way);
        their 256-byte FLIT carries 236 B of TLPs, 6 B of data-link payload (DLP), 8 B CRC and 6 B FEC, so 236/256 ≈ 92.2% is left for TLPs (944 Gb/s ≈ 118 GB/s for Gen6 x16).
        FLIT mode also drops per-TLP framing, sequence number and LCRC, so the net effect versus Gen5 is not a simple subtraction. Gen7 (128 GT/s) is a published
        specification; check for shipping products. Years are specification release dates.
      </p>

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Can this slot feed the NIC?</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Seg label="PCIe generation" value={gen} options={GENS.map((r) => r.gen)} onChange={setGen} fmt={(o) => `Gen${o}${o === 7 ? ' (spec)' : ''}`} />
          <Seg label="Width" value={width} options={WIDTHS} onChange={setWidth} fmt={(o) => `x${o}`} />
          <Seg label="NIC port speed" value={nic} options={NICS} onChange={setNic} fmt={(o) => `${o}G`} />
          <Seg label="Ports at line rate" value={ports} options={[1, 2]} onChange={setPorts} />
        </div>
        <div className="mt-3">
          <label htmlFor="pcie-eff" className="mb-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <span>Assumed TLP / protocol efficiency (illustrative)</span><span className="text-fg">{eff}%</span>
          </label>
          <input id="pcie-eff" type="range" min={70} max={100} step={1} value={eff} onChange={(e) => setEff(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </div>

        <svg viewBox="0 0 640 108" className="mt-3 w-full" role="img" aria-label={`Link ${f3(link)} Gb/s, usable about ${usable.toFixed(0)} Gb/s, port demand ${need} Gb/s`}>
          {bars.map((b, i) => (
            <g key={b.label}>
              <text x={0} y={i * 34 + 18} fontSize={11} fill="var(--text)">{b.label}</text>
              <rect x={170} y={i * 34 + 6} width={440} height={18} rx={3} fill="var(--panel)" stroke="var(--border)" />
              <rect x={170} y={i * 34 + 6} width={Math.max(1, (b.val / max) * 440)} height={18} rx={3} fill={b.color} opacity={0.85} />
              <text x={174 + Math.min(400, (b.val / max) * 440)} y={i * 34 + 19} fontSize={10} fill="var(--text)">{b.val.toFixed(b.val < 10 ? 2 : 0)} Gb/s</text>
            </g>
          ))}
          <line x1={170 + (need / max) * 440} x2={170 + (need / max) * 440} y1={2} y2={104} stroke="var(--warn)" strokeDasharray="3 3" />
        </svg>

        <div className={`mt-2 rounded-md border p-2 text-sm ${V[v].cls}`}>{V[v].text}</div>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>link = ⌊{g.gts * 1000} × {g.num}/{g.den}⌋ Mb/s × {width} = {laneMbps(g).toLocaleString('en-US')} × {width} = <b className="font-mono text-fg">{f3(link)} Gb/s</b> = {(link / 8).toFixed(1)} GB/s per direction</li>
          <li>usable ≈ {f3(link)}{g.gen >= 6 ? ' × 236/256' : ''} × {eff}% = <b className="font-mono text-fg">{usable.toFixed(1)} Gb/s</b> ({(usable / 8).toFixed(1)} GB/s)</li>
          <li>port demand = {ports} × {nic} Gb/s = <b className="font-mono text-fg">{need} Gb/s</b> ({need / 8} GB/s) per direction; headroom = {(usable - need).toFixed(1)} Gb/s</li>
          <li>{minWidth ? <>narrowest Gen{gen} width that feeds it: <b className="text-fg">x{minWidth}</b></> : <>no Gen{gen} width up to x16 feeds {need} Gb/s: use a newer generation or more host links</>}</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>Gen4 x16 = 252.048 Gb/s &lt; 400G</Pill>
        <Pill>Gen5 x16 = 504.112 Gb/s ≥ 400G</Pill>
        <Pill>800G needs Gen6 x16 or 2 × Gen5 x16</Pill>
      </div>
      <p className="text-[11px] text-muted">
        Real DMA throughput is lower than the link rate: every TLP carries header and framing (roughly 20-30 bytes on a 256-512 byte max payload), reads need
        completions, and flow-control updates share the link. Usable throughput is typically on the order of 10-20% below the link rate for large transfers;
        the efficiency slider is an assumption, not a measurement. The NIC also moves descriptors, completions and doorbells over the same link. Measure with
        your NIC vendor's tools (e.g. ib_write_bw) and check LnkSta in lspci -vv for the negotiated speed and width.
      </p>
    </div>
  );
}
