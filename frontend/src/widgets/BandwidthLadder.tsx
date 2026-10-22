import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import { NV_GENS, perDir, nicGBs } from './NvlinkGenerations';
import { GENS, linkGbps } from './PcieBandwidth';

// ---------- Data (approximate datasheet figures, per GPU) and pure helpers ----------
// Units: GB/s = gigabytes per second (decimal, 1 GB = 1e9 B); Gb/s = gigabits per second. 1 GB/s = 8 Gb/s.
// NVLink comes from NV_GENS (NvlinkGenerations widget, NVIDIA's total bidirectional figure per GPU) and PCIe
// from the PcieBandwidth widget (per direction, 128b/130b removed), so the three widgets agree.

export type Host = { kind: 'pcie'; gen: number; width: number } | { kind: 'c2c'; bidiGBs: number };

export interface Platform {
  id: string; name: string; gpu: string;
  /** HBM bandwidth per GPU, GB/s (memory bandwidth is one shared figure for reads and writes). */
  hbmGBs: number;
  /** Key into NV_GENS. */
  nv: string;
  host: Host;
  /** Scale-out NIC per GPU in the matching DGX system, Gb/s per direction. */
  nicGbps: number;
  /** GPUs per node (server or compute tray), used to share the front-end/storage NICs. */
  gpusPerNode: number;
}

export const PLATFORMS: Platform[] = [
  // HBM 2,039 GB/s and "PCIe Gen4: 64 GB/s" (A100 80GB SXM): nvidia.com/en-us/data-center/a100.
  // NIC: DGX A100 user guide, compute network = 8 single-port ConnectX-6 VPI, 200 Gb/s HDR, one per GPU.
  { id: 'a100', name: 'HGX / DGX A100', gpu: 'A100 SXM 80 GB', hbmGBs: 2039, nv: 'a100', host: { kind: 'pcie', gen: 4, width: 16 }, nicGbps: 200, gpusPerNode: 8 },
  // HBM 3.35 TB/s, "PCIe Gen5: 128GB/s" (H100 SXM): nvidia.com/en-us/data-center/h100.
  // NIC: DGX H100, 4 OSFP ports serving 8 single-port ConnectX-7 at 400 Gb/s (DGX BasePOD deployment guide).
  { id: 'h100', name: 'HGX / DGX H100', gpu: 'H100 SXM 80 GB', hbmGBs: 3350, nv: 'h100', host: { kind: 'pcie', gen: 5, width: 16 }, nicGbps: 400, gpusPerNode: 8 },
  // HBM 4.8 TB/s, NVLink 900 GB/s, PCIe Gen5 128 GB/s (H200 SXM): nvidia.com/en-us/data-center/h200. Same DGX networking as H100.
  { id: 'h200', name: 'HGX / DGX H200', gpu: 'H200 SXM 141 GB', hbmGBs: 4800, nv: 'h100', host: { kind: 'pcie', gen: 5, width: 16 }, nicGbps: 400, gpusPerNode: 8 },
  // HBM: DGX B200 lists 64 TB/s HBM3e for 8 GPUs = 8 TB/s each (some OEM sheets list 7.7 TB/s for the 180 GB SKU).
  // PCIe Gen5 x16 host link: Lenovo Press LP2226 (HGX B200). NIC: DGX B200, 8 single-port ConnectX-7 at 400 Gb/s.
  { id: 'b200', name: 'HGX / DGX B200', gpu: 'B200 (HGX)', hbmGBs: 8000, nv: 'b200', host: { kind: 'pcie', gen: 5, width: 16 }, nicGbps: 400, gpusPerNode: 8 },
  // HBM: GB200 NVL72 lists 576 TB/s for 72 GPUs = 8 TB/s each (nvidia.com/en-us/data-center/gb200-nvl72).
  // Host link: NVLink-C2C between Grace and the B200 GPUs, NVIDIA headline 900 GB/s (bidirectional) per superchip.
  // Whether each of the two GPUs gets all of it or they share it (~450 GB/s each) is not stated clearly; 900 is an upper bound.
  // NIC: DGX GB200 lists 72 single-port ConnectX-7 at 400 Gb/s per rack = one per GPU. 4 GPUs per compute tray.
  { id: 'gb200', name: 'GB200 NVL72', gpu: 'B200 in GB200 superchip', hbmGBs: 8000, nv: 'gb200', host: { kind: 'c2c', bidiGBs: 900 }, nicGbps: 400, gpusPerNode: 4 },
];

export type RungId = 'hbm' | 'nvlink' | 'host' | 'nic' | 'frontend';
export interface Rung {
  id: RungId; name: string;
  /** GB/s in one direction (HBM: the quoted total, it is not split by direction). */
  dirGBs: number;
  /** GB/s counting both directions, as vendors often quote; null where direction does not apply (HBM). */
  bidiGBs: number | null;
  detail: string;
}

/** Per-direction GB/s of a host link: PCIe from the kernel-style link rate, NVLink-C2C as half its bidirectional figure. */
export function hostDirGBs(h: Host): number {
  if (h.kind === 'c2c') return h.bidiGBs / 2;
  return linkGbps(GENS.find((g) => g.gen === h.gen)!, h.width) / 8;
}

/** The ladder for one platform. nicGbps: scale-out NIC per GPU; frontendNodeGbps: front-end + storage NICs per node. */
export function ladder(p: Platform, nicGbps = p.nicGbps, frontendNodeGbps = 400): Rung[] {
  const nv = NV_GENS.find((g) => g.id === p.nv)!;
  const host = hostDirGBs(p.host);
  const fe = nicGBs(frontendNodeGbps) / p.gpusPerNode;
  return [
    { id: 'hbm', name: 'HBM (GPU memory)', dirGBs: p.hbmGBs, bidiGBs: null, detail: `${p.gpu} datasheet` },
    { id: 'nvlink', name: `NVLink (${nv.gen})`, dirGBs: perDir(nv.bidiGBs), bidiGBs: nv.bidiGBs, detail: `${nv.bidiGBs} GB/s total bidirectional, all links` },
    {
      id: 'host', name: p.host.kind === 'pcie' ? `PCIe Gen${p.host.gen} x${p.host.width} host link` : 'NVLink-C2C to Grace CPU',
      dirGBs: host, bidiGBs: 2 * host,
      detail: p.host.kind === 'pcie' ? `usually quoted as ${p.host.gen === 4 ? 64 : 128} GB/s (both directions, before encoding)` : 'NVIDIA quotes 900 GB/s per superchip (2 GPUs); upper bound per GPU',
    },
    { id: 'nic', name: `Scale-out NIC (${nicGbps}G)`, dirGBs: nicGBs(nicGbps), bidiGBs: 2 * nicGBs(nicGbps), detail: `one ${nicGbps} Gb/s NIC per GPU` },
    { id: 'frontend', name: 'Front-end / storage share', dirGBs: fe, bidiGBs: 2 * fe, detail: `${frontendNodeGbps} Gb/s per node ÷ ${p.gpusPerNode} GPUs (assumed)` },
  ];
}

/** Seconds to move `GB` gigabytes at `GBs` gigabytes per second (bandwidth term only). */
export const moveSeconds = (GB: number, GBs: number) => GB / GBs;
/** Position of a value on a log axis from lo to hi, 0..1. */
export const logPos = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, Math.log10(v / lo) / Math.log10(hi / lo)));

// ---------- formatting ----------

export function fmtSec(s: number): string {
  if (s < 1e-3) return `${(s * 1e6).toFixed(s < 1e-5 ? 2 : 0)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(s < 0.01 ? 2 : s < 0.1 ? 1 : 0)} ms`;
  return `${s.toFixed(s < 10 ? 2 : 1)} s`;
}
export function fmtRate(GBs: number, unit: 'GB' | 'Gb'): string {
  const v = unit === 'GB' ? GBs : GBs * 8;
  const u = unit === 'GB' ? 'B' : 'b';
  if (v >= 1000) return `${+(v / 1000).toFixed(2)} T${u}/s`;
  return `${+v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} G${u}/s`;
}

// ---------- UI ----------

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o)} type="button" onClick={() => onChange(o)} aria-pressed={o === value}
            className={`min-h-6 rounded-md border px-2 py-1 font-mono text-xs transition ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>
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

const COLOR: Record<RungId, string> = { hbm: 'var(--accent)', nvlink: 'var(--data)', host: 'var(--muted)', nic: 'var(--warn)', frontend: 'var(--analogy)' };
const LO = 1, HI = 20000; // GB/s axis: 1 GB/s .. 20 TB/s
const DECADES = [1, 10, 100, 1000, 10000];

export default function BandwidthLadder() {
  const [pid, setPid] = useState('h100');
  const [unit, setUnit] = useState<'GB' | 'Gb'>('GB');
  const [basis, setBasis] = useState<'dir' | 'bidi'>('dir');
  const [nicOverride, setNicOverride] = useState<number | null>(null);
  const [fe, setFe] = useState(400);
  const [gb, setGbNum] = useState(10);
  const [gbText, setGbText] = useState('10');
  const setGb = (v: number) => { setGbNum(v); setGbText(String(v)); };

  const p = PLATFORMS.find((x) => x.id === pid)!;
  const nic = nicOverride ?? p.nicGbps;
  const rungs = ladder(p, nic, fe);
  const shown = (r: Rung) => (basis === 'bidi' && r.bidiGBs !== null ? r.bidiGBs : r.dirGBs);
  const by = (id: RungId) => rungs.find((r) => r.id === id)!;
  const nicR = by('nic');
  const ratio = (id: RungId) => by(id).dirGBs / nicR.dirGBs;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Seg label="Platform (per GPU)" value={pid} options={PLATFORMS.map((x) => x.id)} onChange={(v) => { setPid(v); setNicOverride(null); }}
          render={(v) => PLATFORMS.find((x) => x.id === v)!.name} />
        <div className="grid grid-cols-2 gap-3">
          <Seg label="Units" value={unit} options={['GB', 'Gb'] as const} onChange={setUnit} render={(v) => (v === 'GB' ? 'GB/s (bytes)' : 'Gb/s (bits)')} />
          <Seg label="Count" value={basis} options={['dir', 'bidi'] as const} onChange={setBasis} render={(v) => (v === 'dir' ? 'per direction' : 'both directions')} />
        </div>
        <Seg label="Scale-out NIC per GPU" value={nic} options={[200, 400, 800] as const} onChange={setNicOverride} render={(v) => `${v}G${v === p.nicGbps ? ' (DGX)' : ''}`} />
        <Seg label="Front-end + storage per node (assumed)" value={fe} options={[100, 200, 400, 800] as const} onChange={setFe} render={(v) => `${v}G`} />
      </div>

      <div className="rounded-lg border border-line bg-panel p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">One {p.gpu}: bandwidth, log scale</div>
          <div className="font-mono text-[10px] text-muted">{basis === 'dir' ? 'per direction' : 'both directions summed (HBM unchanged)'}</div>
        </div>
        <ul className="space-y-3" aria-label={`Bandwidth ladder for ${p.name}`}>
          {rungs.map((r) => {
            const v = shown(r);
            const pos = logPos(v, LO, HI);
            return (
              <li key={r.id} className="grid gap-x-3 gap-y-1 sm:grid-cols-[11rem_1fr_7rem] sm:items-center">
                <div className="text-sm">
                  <div className="font-semibold text-fg">{r.name}</div>
                  <div className="text-[11px] leading-tight text-muted">{r.detail}</div>
                </div>
                <div className="relative h-5 rounded bg-panel-2" aria-hidden="true">
                  {DECADES.map((d) => <div key={d} className="absolute inset-y-0 border-l border-line" style={{ left: `${logPos(d, LO, HI) * 100}%` }} />)}
                  <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${Math.max(pos * 100, 1)}%`, background: COLOR[r.id], opacity: 0.85 }} />
                </div>
                <div className="flex items-baseline justify-between gap-2 font-mono text-sm sm:block sm:text-right">
                  <span className="font-semibold tabular-nums text-fg">{fmtRate(v, unit)}{r.bidiGBs === null && basis === 'bidi' ? '*' : ''}</span>
                  <span className="text-[11px] text-muted sm:block">{gb} GB in {fmtSec(moveSeconds(gb, r.dirGBs))}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 grid sm:grid-cols-[11rem_1fr_7rem] sm:gap-x-3" aria-hidden="true">
          <div />
          <div className="relative h-4 font-mono text-[10px] text-muted">
            {DECADES.map((d, i) => (
              <span key={d} className={`absolute whitespace-nowrap ${i === DECADES.length - 1 ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: `${logPos(d, LO, HI) * 100}%`, display: i === 0 ? 'none' : undefined }}>
                {fmtRate(d, unit)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="bl-gb" className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Data to move (GB, decimal)</label>
        <div className="flex flex-wrap items-center gap-1">
          <input id="bl-gb" type="number" min={0.001} max={100000} step="any" value={gbText}
            onChange={(e) => {
              setGbText(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(n) && n > 0) setGbNum(Math.min(100000, n));
            }}
            onBlur={() => setGbText(String(gb))}
            className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
          {[0.1, 1, 10, 80].map((v) => (
            <button key={v} type="button" aria-pressed={v === gb} onClick={() => setGb(v)} aria-label={`${v} GB`}
              className={`min-h-6 rounded-md border px-2 py-1 font-mono text-xs ${v === gb ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{v} GB</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="HBM vs NIC" value={`${ratio('hbm').toFixed(0)}×`} sub={`${fmtRate(by('hbm').dirGBs, 'GB')} vs ${fmtRate(nicR.dirGBs, 'GB')}`} tone="text-accent" />
        <Out label="NVLink vs NIC" value={`${ratio('nvlink').toFixed(1)}×`} sub="per direction, like for like" tone="text-data" />
        <Out label="Host link vs NIC" value={`${ratio('host').toFixed(2)}×`} tone={ratio('host') < 1 ? 'text-danger' : 'text-fg'}
          sub={p.host.kind === 'pcie'
            ? (ratio('host') < 1 ? 'NIC is faster than this PCIe link: it cannot reach line rate here' : 'GPUDirect RDMA to the NIC crosses this link')
            : 'Grace link (see note)'} />
        <Out label={`${gb} GB over the NIC`} value={fmtSec(moveSeconds(gb, nicR.dirGBs))} sub={`vs ${fmtSec(moveSeconds(gb, by('nvlink').dirGBs))} on NVLink`} tone="text-warn" />
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>NIC: {nic} Gb/s ÷ 8 = <span className="font-mono text-fg">{fmtRate(nicR.dirGBs, 'GB')}</span> per direction; vendors quote NIC speeds per direction.</li>
          <li>NVLink: NVIDIA's {by('nvlink').bidiGBs} GB/s is both directions summed over all links, so ÷ 2 = <span className="font-mono text-fg">{fmtRate(by('nvlink').dirGBs, 'GB')}</span> per direction. Comparing {by('nvlink').bidiGBs} GB/s with a {nic}G NIC's {fmtRate(nicR.dirGBs, 'GB')} overstates the gap by 2×.</li>
          <li>{p.host.kind === 'pcie'
            ? <>PCIe Gen{p.host.gen} x16: {p.host.gen === 4 ? 16 : 32} GT/s × 16 lanes × 128/130 ÷ 8 ≈ <span className="font-mono text-fg">{fmtRate(by('host').dirGBs, 'GB')}</span> per direction (the pcie-bandwidth widget's figure); the usual {p.host.gen === 4 ? 64 : 128} GB/s headline counts both directions before encoding.</>
            : <>NVLink-C2C: 900 GB/s ÷ 2 = <span className="font-mono text-fg">{fmtRate(by('host').dirGBs, 'GB')}</span> per direction if one GPU had the whole link; if the superchip's two GPUs share it, about half that each (see the note below).</>}</li>
          <li>Time to move {gb} GB = {gb} GB ÷ rate, always at the one-direction rate: one copy goes one way. Over the NIC: {gb} ÷ {+nicR.dirGBs.toFixed(2)} = <span className="font-mono text-fg">{fmtSec(moveSeconds(gb, nicR.dirGBs))}</span>.</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>1 GB/s = 8 Gb/s</Pill>
        <Pill>400 Gb/s NIC = 50 GB/s each way</Pill>
        <Pill>NVLink figures are bidirectional totals</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Approximate per-GPU headline figures from NVIDIA product pages and DGX documentation (A100 80 GB SXM, H100 SXM, H200 SXM, DGX B200, GB200 NVL72
        and DGX GB200); other SKUs and OEM systems differ (for example some B200 sheets list 7.7 TB/s HBM, and B300/GB300 systems move to 800G NICs).
        These are peak rates: real copies reach a fraction of them (protocol overhead, DMA efficiency, contention). HBM bandwidth is one figure shared by
        reads and writes, so it is not doubled in the both-directions view{basis === 'bidi' ? ' (marked *)' : ''}. For GB200 the 900 GB/s NVLink-C2C
        figure connects one Grace CPU to its two GPUs; NVIDIA material does not state a per-GPU split clearly (some analyses read it as shared,
        about 450 GB/s, i.e. 225 GB/s per direction, per GPU), so treat that row as an upper bound. The HBM time is reading (or writing) the data
        once; a copy within one GPU's memory both reads and writes it, so takes about twice as long.
        The front-end/storage row is an assumption you set: how many ports a node really cables and at what speed is a design choice. Times are the
        bandwidth term only, with no latency or setup cost.
      </p>
    </div>
  );
}
