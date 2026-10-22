import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';
import { GENS as PCIE_GENS, FLIT_TLP_SHARE, linkGbps as pcieLinkGbps } from './PcieBandwidth';

// ---------- data and pure formulas ----------

export interface Gen {
  name: string; signal: number; encoding: string; laneData: number; year: string; yearNum: number; connector: string;
  common: number[]; hedge?: boolean;
}

/**
 * laneData = usable data rate per lane (Gb/s). 8b/10b: signal × 8/10; 64b/66b: signal × 64/66.
 * PAM4 generations: the per-lane signalling rate includes FEC and framing; laneData is the nominal
 * port speed / 4. 53.125 = 50 × 257/256 × 544/514 is the Ethernet 50G-lane arithmetic, which gives the same
 * serial rate; the exact InfiniBand framing is defined by the IBTA spec.
 */
export const GENS: Gen[] = [
  { name: 'SDR', signal: 2.5, encoding: '8b/10b, NRZ', laneData: 2.5 * 0.8, year: 'early 2000s', yearNum: 2001, connector: 'CX4', common: [1, 4, 12] },
  { name: 'DDR', signal: 5, encoding: '8b/10b, NRZ', laneData: 5 * 0.8, year: 'mid 2000s', yearNum: 2005, connector: 'CX4 / QSFP', common: [4, 12] },
  { name: 'QDR', signal: 10, encoding: '8b/10b, NRZ', laneData: 10 * 0.8, year: '~2008', yearNum: 2008, connector: 'QSFP', common: [4, 12] },
  { name: 'FDR10', signal: 10.3125, encoding: '64b/66b, NRZ', laneData: (10.3125 * 64) / 66, year: '~2011', yearNum: 2011, connector: 'QSFP', common: [4] },
  { name: 'FDR', signal: 14.0625, encoding: '64b/66b, NRZ', laneData: (14.0625 * 64) / 66, year: '~2011', yearNum: 2011.1, connector: 'QSFP', common: [4] },
  { name: 'EDR', signal: 25.78125, encoding: '64b/66b, NRZ, RS-FEC', laneData: (25.78125 * 64) / 66, year: '~2014', yearNum: 2014, connector: 'QSFP28', common: [4] },
  { name: 'HDR', signal: 53.125, encoding: 'PAM4, RS-FEC', laneData: 50, year: '~2018-2019', yearNum: 2018, connector: 'QSFP56', common: [2, 4] },
  { name: 'NDR', signal: 106.25, encoding: 'PAM4, RS-FEC', laneData: 100, year: '~2021-2022', yearNum: 2021, connector: 'OSFP, QSFP112', common: [2, 4] },
  { name: 'XDR', signal: 212.5, encoding: 'PAM4, FEC', laneData: 200, year: '~2024-2025', yearNum: 2024, connector: 'OSFP', common: [4], hedge: true },
];
export const WIDTHS = [1, 2, 4, 8, 12] as const;

export const linkData = (g: Gen, width: number) => g.laneData * width;
export const linkSignal = (g: Gen, width: number) => g.signal * width;
export const efficiency = (g: Gen) => g.laneData / g.signal;

export interface Pcie { gen: number; gts: number; eff: number; enc: string }
export const PCIE: Pcie[] = [
  { gen: 3, gts: 8, eff: 128 / 130, enc: '128b/130b' },
  { gen: 4, gts: 16, eff: 128 / 130, enc: '128b/130b' },
  { gen: 5, gts: 32, eff: 128 / 130, enc: '128b/130b' },
  { gen: 6, gts: 64, eff: FLIT_TLP_SHARE, enc: 'PAM4 FLIT, 236 of 256 bytes are TLP' },
];
/**
 * PCIe bandwidth per direction after line encoding / FLIT overhead, before TLP header overhead (Gb/s).
 * Uses the PcieBandwidth widget's kernel-style per-lane rate (Gen5 x16 = 504.112 Gb/s) and, for Gen6,
 * the same 236/256 FLIT share (Gen6 x16 = 1024 × 236/256 = 944 Gb/s), so both widgets agree.
 */
export const pcieGbps = (p: Pcie, lanes: number) => {
  const g = PCIE_GENS.find((x) => x.gen === p.gen)!;
  return pcieLinkGbps(g, lanes) * (p.gen >= 6 ? FLIT_TLP_SHARE : 1);
};

const f = (n: number, d = 1) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(d));

// ---------- UI ----------

type SortKey = 'order' | 'signal' | 'lane' | 'x4' | 'year';

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
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

export default function IbSpeeds() {
  const [sort, setSort] = useState<SortKey>('order');
  const [desc, setDesc] = useState(false);
  const [gen, setGen] = useState('NDR');
  const [width, setWidth] = useState<number>(4);
  const [ports, setPorts] = useState(1);
  const [pg, setPg] = useState(5);
  const [pl, setPl] = useState(16);

  const rows = useMemo(() => {
    const key = (g: Gen) => ({ order: GENS.indexOf(g), signal: g.signal, lane: g.laneData, x4: linkData(g, 4), year: g.yearNum }[sort]);
    return [...GENS].sort((a, b) => (key(a) - key(b)) * (desc ? -1 : 1));
  }, [sort, desc]);
  const g = GENS.find((x) => x.name === gen)!;
  const p = PCIE.find((x) => x.gen === pg)!;
  const link = linkData(g, width), total = link * ports, slot = pcieGbps(p, pl);
  const ratio = total / slot;

  const Th = ({ k, children }: { k: SortKey; children: string }) => (
    <th className="py-1 pr-3" aria-sort={sort === k ? (desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(false); } }} className="min-h-6 font-mono text-[10px] uppercase tracking-[0.12em] hover:text-fg">
        {children}<span aria-hidden>{sort === k ? (desc ? ' ▼' : ' ▲') : ''}</span>
      </button>
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="InfiniBand generations">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-muted">
            <tr>
              <Th k="order">Gen</Th><Th k="signal">Lane signalling</Th><th className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.12em]">Encoding</th><Th k="lane">Lane data</Th>
              {WIDTHS.map((w) => w === 4 ? <Th key={w} k="x4">4x data</Th> : <th key={w} className="py-1 pr-3 font-mono text-[10px] uppercase tracking-[0.12em]">{w}x</th>)}
              <Th k="year">Year</Th><th className="py-1 font-mono text-[10px] uppercase tracking-[0.12em]">Connector</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={`border-t border-line ${r.name === gen ? 'bg-accent-soft' : ''}`}>
                <td className="py-1.5 pr-3"><button type="button" aria-pressed={r.name === gen} onClick={() => setGen(r.name)} className="min-h-6 font-mono font-semibold text-accent hover:underline">{r.name}{r.hedge ? '*' : ''}</button></td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">{r.hedge ? '~' : ''}{r.signal} Gb/s</td>
                <td className="py-1.5 pr-3 text-xs">{r.encoding}</td>
                <td className="py-1.5 pr-3 font-mono tabular-nums text-data">{f(r.laneData, 3)}</td>
                {WIDTHS.map((w) => (
                  <td key={w} className={`py-1.5 pr-3 font-mono tabular-nums ${r.common.includes(w) ? 'font-semibold text-fg' : 'text-muted'}`}>{f(linkData(r, w), 1)}</td>
                ))}
                <td className="py-1.5 pr-3 text-xs">{r.year}</td>
                <td className="py-1.5 text-xs">{r.connector}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted">Data rates in Gb/s. Bold widths are the ones commonly seen in products (4x ports, 12x on early generations, 2x split ports HDR100/NDR200); the others follow from the same formula. Click a generation to load it into the calculator.</p>

      <div className="rounded-lg border border-line p-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Seg label="Generation" value={gen} options={GENS.map((x) => x.name)} onChange={setGen} />
          <Seg label="Width" value={width} options={WIDTHS} onChange={setWidth} render={(v) => `${v}x`} />
          <Seg label="Active ports on the adapter" value={ports} options={[1, 2] as const} onChange={setPorts} />
          <div className="grid gap-2">
            <Seg label="PCIe generation" value={pg} options={[3, 4, 5, 6] as const} onChange={setPg} render={(v) => `Gen${v}`} />
            <Seg label="PCIe lanes" value={pl} options={[8, 16] as const} onChange={setPl} render={(v) => `x${v}`} />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
          {[['Link data rate', `${f(link, 2)} Gb/s`, 'text-accent'], ['Signalling', `${f(linkSignal(g, width), 3)} Gb/s`, 'text-fg'], [`Adapter total (${ports} port${ports > 1 ? 's' : ''})`, `${f(total, 1)} Gb/s ≈ ${f(total / 8, 1)} GB/s`, 'text-fg'], [`PCIe Gen${pg} x${pl}`, `${f(slot, 1)} Gb/s`, 'text-data']].map(([l, v, t]) => (
            <div key={l} className="rounded-lg border border-line bg-panel-2 px-3 py-2"><div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{l}</div><div className={`font-mono text-base font-semibold tabular-nums ${t}`}>{v}</div></div>
          ))}
        </div>

        <div className={`mt-2 rounded-lg border px-3 py-2 text-sm ${ratio > 1 ? 'border-danger/40 bg-danger/10 text-danger' : ratio > 0.8 ? 'border-warn/40 bg-warn/10 text-warn' : 'border-accent/40 bg-accent-soft text-accent'}`} role="status">
          {ratio > 1 ? `The slot is the bottleneck: the network wants ${f(total, 1)} Gb/s but PCIe Gen${pg} x${pl} moves at most ${f(slot, 1)} Gb/s per direction (${f(ratio * 100, 0)} %).`
            : ratio > 0.8 ? `Tight: the link uses ${f(ratio * 100, 0)} % of the slot before TLP header overhead, so line rate may not be reached in practice.`
              : `The slot has headroom: the link needs ${f(ratio * 100, 0)} % of PCIe Gen${pg} x${pl}.`}
        </div>

        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>lane data = <span className="font-mono text-fg">{g.encoding.startsWith('8b') ? `${g.signal} × 8/10` : g.encoding.startsWith('64b') ? `${g.signal} × 64/66` : `${g.signal} signalling incl. FEC and framing → ${g.laneData} nominal`}</span> = <span className="font-mono text-fg">{f(g.laneData, 3)} Gb/s</span> (efficiency {f(efficiency(g) * 100, 1)} %)</li>
          <li>link = {f(g.laneData, 3)} × {width} lanes = <span className="font-mono text-fg">{f(link, 2)} Gb/s</span>{ports > 1 ? <> ; × {ports} ports = <span className="font-mono text-fg">{f(total, 1)} Gb/s</span></> : null}</li>
          <li>PCIe = {p.gts} GT/s × {p.enc.startsWith('128') ? '128/130' : '236/256'} × {pl} = <span className="font-mono text-fg">{f(slot, 1)} Gb/s</span> per direction ({p.enc})</li>
        </ol>
        <div className="mt-2 flex flex-wrap gap-2"><Pill>HDR lane ≈ 26.6 GBd PAM4</Pill><Pill>NDR lane ≈ 53.1 GBd PAM4</Pill><Pill>FDR 4x ≈ 54.5 Gb/s</Pill><Pill>QDR 4x: 40 signalling, 32 data</Pill></div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Years are approximate first availability. Pre-FDR generations were marketed by signalling rate (QDR "40 Gb/s"), later ones by data rate (EDR 100, HDR 200, NDR 400).
        *XDR: 800 Gb/s 4x ports (Quantum-X800, ConnectX-8 generation); the exact lane signalling rate, FEC and reach are taken here as the ~200G-class PAM4 value and should be
        checked against current NVIDIA/IBTA documentation. EDR FEC use depends on cable and configuration. PCIe figures exclude TLP header overhead (and, for Gen3-5, DLLPs), which typically costs
        a further 5-20 % depending on payload size; dual-port adapters often cannot run both ports at line rate through one slot, so check the product brief.
      </p>
    </div>
  );
}
