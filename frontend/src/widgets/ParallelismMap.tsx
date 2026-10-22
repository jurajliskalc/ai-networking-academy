import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

type ColorBy = 'tp' | 'pp' | 'dp' | 'ep';
const TOTALS = [64, 128, 256];
const TP_DEGREES = [1, 2, 4, 8, 16];
const PP_DEGREES = [1, 2, 4, 8];
const PER_SERVER = 8;

export interface Coord { r: number; tp: number; dp: number; pp: number; ep: number; epGroup: number; server: number }

/**
 * Megatron-Core default rank order "tp-cp-ep-dp-pp" with cp = 1: TP varies fastest, then the
 * expert-parallel slice of DP, then the rest of DP, then PP. So r = tp + TP·(dp + DP·pp), and EP groups
 * are consecutive dp indices (ep = dp mod EP).
 */
export function coords(N: number, TP: number, PP: number, EP: number): Coord[] {
  const DP = N / (TP * PP);
  return Array.from({ length: N }, (_, r) => {
    const tp = r % TP, dp = Math.floor(r / TP) % DP, pp = Math.floor(r / (TP * DP));
    return { r, tp, dp, pp, ep: dp % EP, epGroup: Math.floor(dp / EP), server: Math.floor(r / PER_SERVER) };
  });
}

export type Kind = 'tp' | 'dp' | 'ep';
/** Communication-group key: TP = same (dp, pp); DP = same (tp, pp); EP = same (tp, pp, dp div EP). */
export function commKey(c: Coord, kind: Kind, TP: number, DP: number, EP: number): number {
  if (kind === 'tp') return c.dp + DP * c.pp;
  if (kind === 'dp') return c.tp + TP * c.pp;
  return c.epGroup + (DP / EP) * (c.tp + TP * c.pp);
}

export type Placement = 'none' | 'nvlink' | 'rdma' | 'hier';
/** Where a kind of collective runs: inside servers only, across servers only, or both (hierarchical). */
export function placement(cs: Coord[], keyOf: (c: Coord) => number): Placement {
  const groups = new Map<number, Coord[]>();
  for (const c of cs) {
    const k = keyOf(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  let cross = false, intra = false;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const perServer = new Map<number, number>();
    for (const c of g) perServer.set(c.server, (perServer.get(c.server) ?? 0) + 1);
    if (perServer.size > 1) cross = true;
    if ([...perServer.values()].some((n) => n > 1)) intra = true;
  }
  return cross && intra ? 'hier' : cross ? 'rdma' : intra ? 'nvlink' : 'none';
}

export interface Model { name: string; params: number; expertFrac: number; layers: number; hidden: number; topk: number; experts: number }
export const MODELS: Model[] = [
  { name: '8B-class dense (L=32, h=4096)', params: 8e9, expertFrac: 0, layers: 32, hidden: 4096, topk: 0, experts: 0 },
  { name: '70B-class dense (L=80, h=8192)', params: 70e9, expertFrac: 0, layers: 80, hidden: 8192, topk: 0, experts: 0 },
  { name: 'MoE, 47B total, 8 experts, top-2 (L=32, h=4096)', params: 47e9, expertFrac: 0.96, layers: 32, hidden: 4096, topk: 2, experts: 8 },
];

export interface TrafficIn { TP: number; PP: number; DP: number; EP: number; model: Model; seq: number; micro: number; mb: number }
/**
 * Bytes sent per GPU per training step, first-order, bf16 (2 bytes per element).
 *  TP: 2 all-reduces forward + 2 backward per layer per micro-batch (Megatron), message b·s·h; a ring
 *      all-reduce sends 2(TP-1)/TP of the message. Sequence parallelism (reduce-scatter + all-gather)
 *      moves the same volume. Activation recomputation would add 2 more per layer (ignored).
 *  PP: per micro-batch, a middle stage sends one activation forward and one gradient backward; with
 *      sequence parallelism each TP rank holds b·(s/TP)·h of it.
 *  DP: ring all-reduce (or reduce-scatter + all-gather, same volume) of this GPU's gradient shard:
 *      dense params / (TP·PP) over all DP ranks, expert params / (TP·PP·EP) over DP/EP ranks.
 *  EP: 4 all-to-alls per MoE layer per micro-batch (dispatch + combine, forward and backward); each GPU
 *      routes b·s/TP tokens to topk experts each, and with uniform routing (EP-1)/EP of them leave the GPU.
 */
export function trafficPerGpu(i: TrafficIn) {
  const B = 2;
  const { TP, PP, DP, EP, model: m, seq: s, micro: b, mb } = i;
  const layersPerStage = m.layers / PP;
  const act = b * s * m.hidden * B;
  const tp = TP > 1 ? mb * layersPerStage * 4 * ((2 * (TP - 1)) / TP) * act : 0;
  const pp = PP > 1 ? 2 * mb * (act / TP) : 0;
  const dense = (m.params * (1 - m.expertFrac)) / (TP * PP);
  const expert = (m.params * m.expertFrac) / (TP * PP * Math.max(1, EP));
  const ring = (n: number) => (n > 1 ? (2 * (n - 1)) / n : 0);
  const dp = (ring(DP) * dense + ring(DP / Math.max(1, EP)) * expert) * B;
  const ep = EP > 1 && m.topk > 0 ? mb * layersPerStage * 4 * ((b * s) / TP) * m.topk * m.hidden * B * ((EP - 1) / EP) : 0;
  return { tp, pp, dp, ep };
}

// Fills are dark enough (30% lightness) that the white rank numbers keep 4.5:1 on every hue, yellow included.
const hue = (i: number) => `hsl(${(i * 137.508) % 360} 58% 30%)`;
// Ranks outside the focused GPU's groups are dimmed by desaturating the fill, not by opacity, so their numbers stay readable.
const dimHue = (i: number) => `hsl(${(i * 137.508) % 360} 14% 34%)`;
const SCALE = ['—', 'low', 'medium', 'high', 'very high'];
function Rating({ v }: { v: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={SCALE[v]}>
      <span className="flex gap-0.5" aria-hidden>{[1, 2, 3, 4].map((i) => <span key={i} className={`h-2 w-2 rounded-sm ${i <= v ? 'bg-warn' : 'border border-line bg-panel-2'}`} />)}</span>
      <span className="text-[11px] text-muted">{SCALE[v]}</span>
    </span>
  );
}

function Seg({ label, value, options, onChange, disabled }: { label: string; value: number; options: number[]; onChange: (v: number) => void; disabled?: (v: number) => boolean }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" disabled={disabled?.(o)} onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition disabled:opacity-30 ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{o}</button>
        ))}
      </div>
    </div>
  );
}

const fmtBytes = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(x >= 1e10 ? 1 : 2)} GB` : x >= 1e6 ? `${(x / 1e6).toFixed(0)} MB` : x > 0 ? `${(x / 1e3).toFixed(0)} KB` : '—');
const fmtTime = (s: number) => (s <= 0 ? '—' : s >= 1 ? `${s.toFixed(2)} s` : `${(s * 1e3).toFixed(s >= 0.01 ? 0 : 1)} ms`);
const COLOR_LABEL: Record<ColorBy, string> = { tp: 'TP group', pp: 'PP stage', dp: 'DP replica', ep: 'EP group' };

export default function ParallelismMap() {
  const [N, setN] = useState(128);
  const [TP, setTP] = useState(8);
  const [PP, setPP] = useState(4);
  const [moe, setMoe] = useState(false);
  const [EPsel, setEP] = useState(4);
  const [colorBy, setColorBy] = useState<ColorBy>('tp');
  const [focus, setFocus] = useState<number | null>(0);
  const [modelIdx, setModelIdx] = useState(1);
  const [seq, setSeq] = useState(4096);
  const [mb, setMb] = useState(8);
  const [nvl, setNvl] = useState(450);
  const [nic, setNic] = useState(50);

  const valid = N % (TP * PP) === 0 && TP * PP <= N;
  const DP = valid ? N / (TP * PP) : 1;
  const epOptions = [2, 4, 8, 16, 32].filter((e) => e <= DP && DP % e === 0);
  const EP = moe && epOptions.length ? (epOptions.includes(EPsel) ? EPsel : epOptions[epOptions.length - 1]) : 1;
  const cs = useMemo(() => (valid ? coords(N, TP, PP, EP) : []), [N, TP, PP, EP, valid]);
  const f = focus !== null && focus < cs.length ? cs[focus] : null;

  const colorKey = (c: Coord) => (colorBy === 'tp' ? commKey(c, 'tp', TP, DP, EP) : colorBy === 'pp' ? c.pp : colorBy === 'dp' ? c.dp : commKey(c, 'ep', TP, DP, EP));
  const place = useMemo(() => ({
    tp: valid ? placement(cs, (c) => commKey(c, 'tp', TP, DP, EP)) : 'none',
    dp: valid ? placement(cs, (c) => commKey(c, 'dp', TP, DP, EP)) : 'none',
    ep: valid && EP > 1 ? placement(cs, (c) => commKey(c, 'ep', TP, DP, EP)) : 'none',
    // Adjacent stages are N/PP ranks apart, which is at least one full server here: always cross-server.
    pp: valid && PP > 1 ? 'rdma' : 'none',
  } as Record<'tp' | 'dp' | 'ep' | 'pp', Placement>), [cs, valid, TP, DP, EP, PP]);

  const model = MODELS[modelIdx];
  const effMoe = moe && model.topk > 0;
  const epTooBig = effMoe && EP > model.experts; // each EP rank must own at least one whole expert
  const traffic = valid && !epTooBig ? trafficPerGpu({ TP, PP, DP, EP: effMoe ? EP : 1, model: effMoe ? model : { ...model, expertFrac: 0, topk: 0 }, seq, micro: 1, mb }) : { tp: 0, pp: 0, dp: 0, ep: 0 };
  const bwFor = (p: Placement) => (p === 'nvlink' ? nvl : nic) * 1e9;
  const layersOk = model.layers % PP === 0;

  const peer = (c: Coord) => {
    if (!f || c.r === f.r) return '';
    if (c.dp === f.dp && c.pp === f.pp) return 'tp';
    if (c.tp === f.tp && c.dp === f.dp && Math.abs(c.pp - f.pp) === 1) return 'pp';
    if (moe && EP > 1 && c.tp === f.tp && c.pp === f.pp && c.epGroup === f.epGroup) return 'ep';
    if (c.tp === f.tp && c.pp === f.pp) return 'dp';
    return '';
  };
  const PEER_RING: Record<string, string> = { tp: 'var(--accent)', pp: 'var(--warn)', dp: 'var(--data)', ep: 'var(--danger)' };
  const servers = valid ? N / PER_SERVER : 0;
  const netLabel = (p: Placement) =>
    p === 'none' ? <span className="text-muted">not used</span>
      : p === 'nvlink' ? <span className="text-accent">NVLink scale-up</span>
        : p === 'rdma' ? <span className="text-data">RDMA scale-out</span>
          : <span className="text-warn">NVLink inside + RDMA across</span>;

  const rows = [
    { key: 'tp' as const, name: 'Tensor (TP)', deg: TP, coll: 'all-reduce (or reduce-scatter + all-gather with sequence parallel): 2 per layer forward, 2 backward', vol: 4, lat: 4 },
    { key: 'pp' as const, name: 'Pipeline (PP)', deg: PP, coll: 'send/recv of activations (forward) and their gradients (backward) between adjacent stages, per micro-batch', vol: 1, lat: 3 },
    { key: 'dp' as const, name: 'Data (DP)', deg: DP, coll: 'gradient all-reduce, or reduce-scatter + all-gather with ZeRO/FSDP; overlappable with backward', vol: 3, lat: 2 },
    ...(moe ? [{ key: 'ep' as const, name: 'Expert (EP)', deg: EP, coll: 'all-to-all dispatch + combine: 2 per MoE layer forward, 2 backward; skewed by router load, incast-prone', vol: 3, lat: 4 }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Seg label="Total GPUs" value={N} options={TOTALS} onChange={setN} />
        <Seg label="TP degree" value={TP} options={TP_DEGREES} onChange={setTP} />
        <Seg label="PP degree" value={PP} options={PP_DEGREES} onChange={setPP} />
        <div>
          <label className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <input type="checkbox" checked={moe} onChange={(e) => setMoe(e.target.checked)} className="accent-[var(--accent)]" /> MoE · EP degree
          </label>
          <div className="flex flex-wrap gap-1">
            {[2, 4, 8, 16, 32].map((o) => (
              <button key={o} type="button" disabled={!moe || !epOptions.includes(o)} onClick={() => setEP(o)} aria-pressed={o === EP}
                className={`rounded-md border px-2 py-1 font-mono text-xs disabled:opacity-30 ${moe && o === EP ? 'border-danger bg-danger/10 text-danger' : 'border-line hover:bg-panel-2'}`}>{o}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Pill>DP = {N} / ({TP}·{PP}) = <span className="font-mono text-fg">{valid ? DP : '—'}</span></Pill>
        <Pill>{N / PER_SERVER} servers × {PER_SERVER} GPUs</Pill>
        {moe && <Pill>EP {EP} carved from DP</Pill>}
        <div className="ml-auto flex flex-wrap gap-1">
          {(['tp', 'pp', 'dp', ...(moe ? ['ep'] : [])] as ColorBy[]).map((k) => (
            <button key={k} type="button" onClick={() => setColorBy(k)} aria-pressed={colorBy === k}
              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${colorBy === k ? 'border-fg text-fg' : 'border-line text-muted'}`}>colour by {COLOR_LABEL[k]}</button>
          ))}
        </div>
      </div>

      {!valid ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">TP × PP = {TP * PP} does not divide {N} GPUs.</div>
      ) : (
        <div className="grid gap-1.5" role="group" aria-label={`${N} GPUs in ${servers} servers, coloured by ${COLOR_LABEL[colorBy]}. Select a GPU to outline its TP, PP, DP${moe ? ' and EP' : ''} peers.`}
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${N > 128 ? 92 : 120}px, 1fr))` }}>
          {Array.from({ length: servers }, (_, s) => (
            <div key={s} className="rounded-md border border-line bg-panel-2 p-1">
              <div className="mb-0.5 font-mono text-[9px] text-muted">srv {s}</div>
              <div className="grid grid-cols-4 gap-0.5">
                {cs.slice(s * PER_SERVER, (s + 1) * PER_SERVER).map((c) => {
                  const p = peer(c);
                  const me = f?.r === c.r;
                  return (
                    <button key={c.r} type="button" onClick={() => setFocus(c.r)} onMouseEnter={() => setFocus(c.r)}
                      aria-label={`GPU ${c.r}: tp ${c.tp}, pp ${c.pp}, dp ${c.dp}${moe ? `, ep ${c.ep}` : ''}${p ? `, ${p.toUpperCase()} peer of GPU ${f!.r}` : ''}`} aria-pressed={me}
                      className="aspect-square rounded-sm font-mono text-[8px] leading-none text-white"
                      style={{ background: f && !me && !p ? dimHue(colorKey(c)) : hue(colorKey(c)), outline: me ? '2px solid var(--text)' : p ? `2px solid ${PEER_RING[p]}` : undefined, outlineOffset: 1 }}>
                      {c.r}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {f && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-mono" aria-live="polite">GPU {f.r}: tp={f.tp} pp={f.pp} dp={f.dp}{moe ? ` ep=${f.ep}` : ''} (server {f.server})</span>
          {Object.entries(PEER_RING).filter(([k]) => k !== 'ep' || moe).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ outline: `2px solid ${v}` }} aria-hidden />{k.toUpperCase()} peers</span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Traffic by parallelism type">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              <th className="py-1.5 pr-2">Traffic</th><th className="pr-2">Deg.</th><th className="pr-2">Pattern per iteration</th><th className="pr-2">Network here</th><th className="pr-2">Volume</th><th>Latency sens.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-line align-top">
                <td className="py-1.5 pr-2 font-semibold">{r.name}</td>
                <td className="pr-2 font-mono">{r.deg}</td>
                <td className="pr-2 text-muted">{r.coll}</td>
                <td className="pr-2 font-mono text-xs">{netLabel(place[r.key])}</td>
                <td className="pr-2"><Rating v={r.deg > 1 ? r.vol : 0} /></td>
                <td><Rating v={r.deg > 1 ? r.lat : 0} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {place.tp !== 'nvlink' && place.tp !== 'none' && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          TP {TP} is larger than one {PER_SERVER}-GPU NVLink domain, so every layer's TP collectives now cross the scale-out NICs, roughly an order of magnitude
          slower than NVLink, on the critical path of every layer. This is why TP is normally capped at the NVLink domain size.
        </p>
      )}

      <details className="rounded-xl border border-line bg-panel-2/40 p-3" open>
        <summary className="cursor-pointer text-sm font-semibold">Traffic estimator: bytes per GPU per step</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Model</span>
            <select value={modelIdx} onChange={(e) => setModelIdx(Number(e.target.value))} className="w-full rounded-md border border-line bg-panel px-2 py-1 text-xs">
              {MODELS.map((m, i) => <option key={m.name} value={i}>{m.name}</option>)}
            </select>
          </label>
          <Seg label="Sequence length" value={seq} options={[2048, 4096, 8192]} onChange={setSeq} />
          <Seg label="Micro-batches / step" value={mb} options={[1, 4, 8, 16, 32]} onChange={setMb} />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs"><span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-muted">NVLink GB/s/dir</span>
              <NumInput min={1} max={2000} value={nvl} onValue={setNvl} className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs" /></label>
            <label className="text-xs"><span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-muted">NIC GB/s/dir</span>
              <NumInput min={1} max={400} value={nic} onValue={setNic} className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs" /></label>
          </div>
        </div>
        {moe && model.topk === 0 && <p className="mt-2 text-xs text-warn">The selected model is dense; pick the MoE model to see expert-parallel traffic.</p>}
        {epTooBig && <p className="mt-2 text-xs text-danger">EP {EP} exceeds this model's {model.experts} experts: each EP rank must hold at least one whole expert, so pick EP ≤ {model.experts} for the estimate.</p>}
        {!layersOk && <p className="mt-2 text-xs text-warn">{model.layers} layers do not split evenly over {PP} stages; the estimate uses {(model.layers / PP).toFixed(1)} layers per stage.</p>}
        <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Traffic estimate per GPU per step" aria-live="polite">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                <th className="py-1.5 pr-2">Traffic</th><th className="pr-2">Sent per GPU per step</th><th className="pr-2">Runs on</th><th>Time if not overlapped</th>
              </tr>
            </thead>
            <tbody>
              {(['tp', 'pp', 'dp', 'ep'] as const).filter((k) => k !== 'ep' || effMoe).map((k) => (
                <tr key={k} className="border-b border-line">
                  <td className="py-1.5 pr-2 font-semibold uppercase">{k}</td>
                  <td className="pr-2 font-mono">{fmtBytes(traffic[k])}</td>
                  <td className="pr-2 font-mono text-xs">{netLabel(traffic[k] > 0 ? place[k] : 'none')}</td>
                  <td className="font-mono">{fmtTime(traffic[k] > 0 ? traffic[k] / bwFor(place[k]) : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] text-muted">
          <li>TP: micro-batches × layers per stage × 4 all-reduces × 2(TP−1)/TP × (b·s·h·2 B). Activation recomputation adds 2 more per layer.</li>
          <li>PP (middle stage): 2 × micro-batches × b·s·h·2 B / TP (sequence parallelism splits the activation across TP ranks).</li>
          <li>DP: 2(DP−1)/DP × dense parameters/(TP·PP) × 2 B, plus expert parameters/(TP·PP·EP) reduced over DP/EP ranks. Reducing gradients in fp32 doubles it. FSDP/ZeRO-3 adds parameter all-gathers in forward and backward (total about 1.5× this all-reduce volume).</li>
          <li>EP: micro-batches × MoE layers per stage × 4 all-to-alls × (b·s/TP tokens) × top-k × h × 2 B × (EP−1)/EP, assuming uniform routing.</li>
          <li>b = 1, bf16 (2 bytes), one NIC per GPU. Hierarchical collectives are timed at the NIC rate (their bottleneck; for all-to-all this overstates the time, since the intra-server share rides NVLink). Real frameworks overlap much of DP and some TP with compute, so these are upper bounds on exposed time, not predictions.</li>
        </ul>
      </details>

      <div className="space-y-2 text-sm text-muted">
        <p><span className="font-semibold text-fg">Why TP stays inside the NVLink domain:</span> tensor parallelism splits every matrix multiply, so each layer
          blocks on an all-reduce of activation-sized tensors, several times per layer, forward and backward. It is hard to hide behind compute (overlap schemes exist but are partial), so it needs the
          highest bandwidth and lowest latency available: NVLink at roughly an order of magnitude more bandwidth per GPU than a scale-out NIC. DP and PP
          communicate less often or can be overlapped with compute, so they tolerate the scale-out network. EP all-to-all is the hardest scale-out
          pattern: every GPU sends to every other in its group, sizes are uneven, and the result sits on the critical path.</p>
      </div>
      <p className="text-[11px] text-muted">
        Ratings are qualitative and depend on model size, sequence length, micro-batch count, overlap and framework (Megatron-LM, DeepSpeed, FSDP).
        Rank order follows Megatron-Core's default tp-cp-ep-dp-pp layout with no context parallelism and expert TP equal to TP (its default); other orders change which groups cross servers.
        Model shapes are illustrative, not exact published configurations. Default NVLink 450 GB/s per direction is Hopper-class; NIC 50 GB/s is one 400G port.
        Rack-scale NVLink domains (for example 72 GPUs) extend what counts as scale-up.
      </p>
    </div>
  );
}
