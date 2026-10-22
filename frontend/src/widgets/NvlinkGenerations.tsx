import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Data (NVIDIA headline figures) and pure helpers ----------

export interface NvGen { id: string; gen: string; gpu: string; links: number | null; bidiGBs: number; domain: string; domainGpus: number; switches: string; announced?: boolean }

// Bandwidth = NVIDIA's total bidirectional NVLink bandwidth per GPU, summed over all links.
export const NV_GENS: NvGen[] = [
  { id: 'p100', gen: 'NVLink 1', gpu: 'P100', links: 4, bidiGBs: 160, domain: 'DGX-1 (P100), hybrid cube-mesh', domainGpus: 8, switches: 'none (direct GPU-GPU links)' },
  { id: 'v100', gen: 'NVLink 2', gpu: 'V100', links: 6, bidiGBs: 300, domain: 'DGX-1 cube-mesh, or DGX-2 / HGX-2 with NVSwitch', domainGpus: 16, switches: '12 first-gen NVSwitch (DGX-2)' },
  { id: 'a100', gen: 'NVLink 3', gpu: 'A100', links: 12, bidiGBs: 600, domain: 'HGX A100 8-GPU', domainGpus: 8, switches: '6 NVSwitch' },
  { id: 'h100', gen: 'NVLink 4', gpu: 'H100 / H200', links: 18, bidiGBs: 900, domain: 'HGX H100 8-GPU', domainGpus: 8, switches: '4 NVSwitch' },
  { id: 'b200', gen: 'NVLink 5', gpu: 'B200 (HGX)', links: 18, bidiGBs: 1800, domain: 'HGX B200 8-GPU', domainGpus: 8, switches: '2 NVLink 5 switch chips' },
  { id: 'gb200', gen: 'NVLink 5', gpu: 'GB200 NVL72', links: 18, bidiGBs: 1800, domain: 'GB200 NVL72 rack', domainGpus: 72, switches: '18 NVSwitch chips in 9 switch trays' },
  { id: 'rubin', gen: 'NVLink 6', gpu: 'Rubin (announced)', links: null, bidiGBs: 3600, domain: 'announced; see NVIDIA roadmap', domainGpus: 72, switches: 'announced', announced: true },
];

/** NVIDIA quotes both directions summed: per-direction = bidirectional / 2. */
export const perDir = (bidiGBs: number) => bidiGBs / 2;
/** NIC line rate in Gb/s to GB/s per direction. */
export const nicGBs = (gbps: number) => gbps / 8;
/** Bytes each GPU sends in a ring all-reduce of S over n ranks: 2(n-1)/n * S. */
export const ringBytes = (S: number, n: number) => (2 * (n - 1) / n) * S;
/** Transfer time in ms for GB at GB/s (bandwidth term only). */
export const xferMs = (GB: number, GBs: number) => (GB / GBs) * 1e3;

// ---------- UI ----------

const NIC_SPEEDS = [200, 400, 800];
const fmtBW = (GBs: number) => (GBs >= 1000 ? `${+(GBs / 1000).toFixed(2)} TB/s` : `${GBs} GB/s`);
const fmtMs = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

export default function NvlinkGenerations() {
  const [sel, setSel] = useState('gb200');
  const [nic, setNic] = useState(400);
  const [basis, setBasis] = useState<'dir' | 'bidi'>('dir');
  const [mode, setMode] = useState<'p2p' | 'ar'>('p2p');
  const [gb, setGb] = useState(1);

  const g = NV_GENS.find((x) => x.id === sel)!;
  const nvDir = perDir(g.bidiGBs);
  const nicDir = nicGBs(nic);
  const ratio = nvDir / nicDir;
  const wrong = g.bidiGBs / nicDir;
  const n = g.domainGpus;
  const bytes = mode === 'p2p' ? gb : ringBytes(gb, n);
  const tNv = xferMs(bytes, nvDir), tNic = xferMs(bytes, nicDir);
  const val = (x: NvGen) => (basis === 'dir' ? perDir(x.bidiGBs) : x.bidiGBs);
  const nicVal = basis === 'dir' ? nicDir : nicDir * 2;
  const max = Math.max(...NV_GENS.map(val));
  const rows = [...NV_GENS.map((x) => ({ key: x.id, label: `${x.gen} · ${x.gpu}`, v: val(x), color: x.announced ? 'var(--muted)' : x.id === sel ? 'var(--accent)' : 'var(--data)', dashed: !!x.announced })),
    { key: 'nic', label: `${nic}G scale-out NIC`, v: nicVal, color: 'var(--warn)', dashed: false }];
  const BAR_X = 190, BAR_W = 380;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="NVLink generations table">
        <table className="w-full min-w-[700px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              <th className="py-1.5 pr-2">Generation</th><th className="pr-2">GPU / system</th><th className="pr-2 text-right">Links</th>
              <th className="pr-2 text-right">Bidirectional</th><th className="pr-2 text-right">Per direction</th><th className="pr-2">NVLink domain</th><th>Switching</th>
            </tr>
          </thead>
          <tbody>
            {NV_GENS.map((x) => (
              <tr key={x.id} className={`border-b border-line ${x.id === sel ? 'bg-accent-soft' : ''} ${x.announced ? 'text-muted' : ''}`}>
                <td className="py-1.5 pr-2">
                  <button type="button" onClick={() => setSel(x.id)} aria-pressed={x.id === sel} className={`font-semibold ${x.id === sel ? 'text-accent' : 'hover:underline'}`}>{x.gen}</button>
                </td>
                <td className="pr-2">{x.gpu}</td>
                <td className="pr-2 text-right font-mono">{x.links ?? '—'}</td>
                <td className="pr-2 text-right font-mono">{x.announced ? '~' : ''}{fmtBW(x.bidiGBs)}</td>
                <td className="pr-2 text-right font-mono">{x.announced ? '~' : ''}{fmtBW(perDir(x.bidiGBs))}</td>
                <td className="pr-2 text-xs">{x.domain}{x.announced ? '' : ` (${x.domainGpus} GPUs)`}</td>
                <td className="text-xs">{x.switches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Chart basis</div>
          <div className="flex gap-1">
            {([['dir', 'per direction'], ['bidi', 'bidirectional (NVIDIA headline)']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setBasis(k)} aria-pressed={basis === k}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${basis === k ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Scale-out NIC per GPU</div>
          <div className="flex gap-1">
            {NIC_SPEEDS.map((s) => (
              <button key={s} type="button" onClick={() => setNic(s)} aria-pressed={nic === s}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${nic === s ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{s}G</button>
            ))}
          </div>
        </div>
      </div>

      <svg viewBox={`0 0 640 ${rows.length * 26 + 8}`} className="w-full" role="img" aria-label={`Per-GPU NVLink bandwidth by generation, ${basis === 'dir' ? 'per direction' : 'bidirectional'}, compared with a ${nic}G NIC: ${rows.map((r) => `${r.label} ${fmtBW(r.v)}${r.dashed ? ' (announced)' : ''}`).join('; ')}`}>
        {rows.map((r, i) => (
          <g key={r.key}>
            <text x={0} y={i * 26 + 18} fontSize={11} fill="var(--text)">{r.label}</text>
            <rect x={BAR_X} y={i * 26 + 6} width={Math.max(1.5, (r.v / max) * BAR_W)} height={16} rx={3} fill={r.color} opacity={r.dashed ? 0.35 : 0.85} stroke={r.dashed ? 'var(--muted)' : 'none'} strokeDasharray={r.dashed ? '3 3' : undefined} />
            <text x={BAR_X + (r.v / max) * BAR_W + 6} y={i * 26 + 18} fontSize={10} fill="var(--muted)">{fmtBW(r.v)}{r.dashed ? ' (announced)' : ''}</text>
          </g>
        ))}
      </svg>

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Calculator: {g.gen} ({g.gpu}) vs {nic}G NIC</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted" aria-live="polite">
          <li>NVLink per direction = {fmtBW(g.bidiGBs)} bidirectional / 2 = <b className="font-mono text-fg">{fmtBW(nvDir)}</b></li>
          <li>NIC per direction = {nic} Gb/s / 8 = <b className="font-mono text-fg">{nicDir} GB/s</b></li>
          <li>ratio = {nvDir} / {nicDir} = <b className="font-mono text-accent">{ratio.toFixed(1)}×</b> <span className="text-danger">(not {wrong.toFixed(0)}×: that mixes bidirectional NVLink with per-direction NIC)</span></li>
        </ol>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Transfer</div>
            <div className="flex gap-1">
              {([['p2p', 'move X GB'], ['ar', `ring all-reduce of X GB over ${n} GPUs`]] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setMode(k)} aria-pressed={mode === k}
                  className={`rounded-md border px-2 py-1 font-mono text-xs ${mode === k ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{l}</button>
              ))}
            </div>
          </div>
          <label className="text-xs text-muted">X (GB)
            <input type="number" min={0.001} max={10000} step={0.1} value={gb} onChange={(e) => setGb(Math.max(0.001, Number(e.target.value) || 0.001))}
              className="ml-2 w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm text-fg" />
          </label>
        </div>
        {mode === 'ar' && <p className="mt-2 text-sm text-muted">bytes sent per GPU = 2({n}−1)/{n} × {gb} GB = <span className="font-mono text-fg">{bytes.toFixed(3)} GB</span></p>}
        <div className="mt-2 flex flex-wrap gap-2" aria-live="polite">
          <Pill>NVLink: {bytes.toFixed(3)} GB / {nvDir} GB/s = <span className="font-mono text-accent">{fmtMs(tNv)} ms</span></Pill>
          <Pill>{nic}G NIC: {bytes.toFixed(3)} GB / {nicDir} GB/s = <span className="font-mono text-warn">{fmtMs(tNic)} ms</span></Pill>
        </div>
        {g.announced && <p className="mt-2 text-xs text-warn">Announced figure only: treat as a roadmap plan until NVIDIA's shipping documentation confirms it. The all-reduce example assumes a 72-GPU domain as a placeholder.</p>}
      </div>

      <p className="text-[11px] text-muted">
        Bandwidths are NVIDIA's published headline figures: total bidirectional NVLink bandwidth per GPU, summed over all links (e.g. H100: 18 links,
        900 GB/s, about 450 GB/s each way). NIC speeds are quoted per direction in bits. Some SKUs ship with fewer active links (for example PCIe-form-factor
        cards with NVLink bridges), so check the datasheet of your exact product. Times are the bandwidth term only: no latency, protocol overhead or in-network
        reduction (NVLink SHARP would help NVLink further), and the all-reduce example assumes the whole collective stays inside one NVLink domain.
        Domain sizes are the common configurations; NVIDIA has also announced larger multi-rack NVLink domains.
      </p>
    </div>
  );
}
