import { useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';
import NumInput from '../components/NumInput';

// ---------- Pure calculation (unit-testable). Decimal units for totals and rates: 1 GB = 1e9 B. ----------

export interface ModelShape {
  layers: number;   // num_hidden_layers
  heads: number;    // num_attention_heads (query heads)
  kvHeads: number;  // num_key_value_heads (= heads for MHA, fewer for GQA, 1 for MQA)
  headDim: number;  // head_dim, or hidden_size / num_attention_heads when the config has no head_dim
}

export interface ModelPreset extends ModelShape { id: string; name: string; note: string }

// Shapes from each model's published config.json on Hugging Face (checked 2026-10):
// Llama 3.1 8B: num_hidden_layers 32, hidden_size 4096, num_attention_heads 32, num_key_value_heads 8 -> head_dim 4096 / 32 = 128.
// Llama 3.1 70B: 80, 8192, 64, 8 -> head_dim 8192 / 64 = 128.
// Llama 3.1 405B: 126, 16384, 128, 8 -> head_dim 16384 / 128 = 128.
// Llama 2 7B: 32, 4096, 32, num_key_value_heads 32 (MHA) -> head_dim 128.
export const MODELS: readonly ModelPreset[] = [
  { id: 'l31-8b', name: 'Llama 3.1 8B', layers: 32, heads: 32, kvHeads: 8, headDim: 128, note: 'GQA, 4 query heads per KV head' },
  { id: 'l31-70b', name: 'Llama 3.1 70B', layers: 80, heads: 64, kvHeads: 8, headDim: 128, note: 'GQA, 8 query heads per KV head; the lessons\' 70B-class example' },
  { id: 'l31-405b', name: 'Llama 3.1 405B', layers: 126, heads: 128, kvHeads: 8, headDim: 128, note: 'GQA, 16 query heads per KV head' },
  { id: 'l2-7b', name: 'Llama 2 7B', layers: 32, heads: 32, kvHeads: 32, headDim: 128, note: 'MHA: one KV head per query head' },
] as const;

export const DTYPES = [
  { id: 'bf16', name: 'BF16 / FP16', bytes: 2 },
  { id: 'fp8', name: 'FP8', bytes: 1 },
] as const;

export interface LinkOption { id: string; name: string; GBps: number; note: string }

// Per-direction bandwidth, GB/s. NIC rates are line rate / 8 (400 Gb/s -> 50 GB/s), as in the lessons.
// NVLink: NVIDIA quotes 900 GB/s total (bidirectional) per H100/H200 GPU (NVLink 4) and 1.8 TB/s per B200 GPU
// (NVLink 5), i.e. about 450 and 900 GB/s each way (same convention as the nvlink-generations widget).
export const LINKS: readonly LinkOption[] = [
  { id: 'nvl5', name: 'NVLink 5 (B200)', GBps: 900, note: 'same NVLink domain; 1.8 TB/s bidirectional per GPU' },
  { id: 'nvl4', name: 'NVLink 4 (H100)', GBps: 450, note: 'same NVLink domain; 900 GB/s bidirectional per GPU' },
  { id: '8x400', name: '8 × 400G NICs', GBps: 400, note: 'a TP8 instance, each GPU sends its KV heads on its own rail' },
  { id: '1x800', name: '1 × 800G NIC', GBps: 100, note: 'one GPU, one NIC' },
  { id: '1x400', name: '1 × 400G NIC', GBps: 50, note: 'one GPU, one NIC (the lessons\' example)' },
  { id: '100g', name: '100G front-end', GBps: 12.5, note: 'a shared front-end Ethernet port; avoid for KV' },
] as const;

/** KV cache bytes per token: 2 (K and V) × layers × KV heads × head dim × bytes per element. */
export const kvBytesPerToken = (m: ModelShape, bytesPerElem: number) => 2 * m.layers * m.kvHeads * m.headDim * bytesPerElem;
/** The same model with multi-head attention (one KV head per query head). */
export const kvBytesPerTokenMHA = (m: ModelShape, bytesPerElem: number) => 2 * m.layers * m.heads * m.headDim * bytesPerElem;
/** Total KV bytes for `tokens` of context in each of `batch` sequences. */
export const kvBytes = (m: ModelShape, bytesPerElem: number, tokens: number, batch = 1) => kvBytesPerToken(m, bytesPerElem) * tokens * batch;
/** Transfer time in seconds over a link of `GBps` (decimal GB/s per direction) at `efficiency` (0..1] of that rate. */
export const transferS = (bytes: number, GBps: number, efficiency = 1) => bytes / (GBps * 1e9 * efficiency);
/** Exposed time if KV is streamed layer by layer and all but the last layer overlaps with prefill compute. */
export const streamedExposedS = (bytes: number, layers: number, GBps: number, efficiency = 1) => transferS(bytes / layers, GBps, efficiency);

// ---------- formatting ----------

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e11 ? 0 : b >= 1e10 ? 1 : 2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}
export function fmtTime(s: number): string {
  if (!isFinite(s)) return '∞';
  if (s < 1e-3) return `${(s * 1e6).toFixed(s < 1e-5 ? 2 : 1)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(s < 0.01 ? 2 : 1)} ms`;
  return `${s.toFixed(2)} s`;
}
const fmtInt = (n: number) => n.toLocaleString('en-US');

// ---------- UI ----------

const lbl = 'mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted';
const btn = (on: boolean) => `min-h-[24px] rounded-md border px-2 py-1 font-mono text-xs transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;

function Seg<T extends string | number>({ label, value, options, onChange, render }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string;
}) {
  return (
    <div>
      <div className={lbl}>{label}</div>
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

const TOKEN_STEPS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 128000] as const;
const BUDGETS = [0.2, 0.5, 1, 2] as const;
const EFFS = [1, 0.9, 0.8, 0.7] as const;

/** Horizontal bars: transfer time over every link option, log time axis, with the TTFT budget marked. */
function LinkChart({ bytes, eff, budget, selected }: { bytes: number; eff: number; budget: number; selected: string }) {
  const W = 640, rowH = 26, T = 8, L = 128, R = 70, B = 26;
  const H = T + LINKS.length * rowH + B;
  const times = LINKS.map((l) => transferS(bytes, l.GBps, eff));
  const lo = Math.floor(Math.log10(Math.min(...times, budget))) , hi = Math.ceil(Math.log10(Math.max(...times, budget)));
  const span = Math.max(1, hi - lo);
  const x = (s: number) => L + ((Math.log10(s) - lo) / span) * (W - L - R);
  const decades = Array.from({ length: span + 1 }, (_, i) => lo + i);
  const summary = LINKS.map((l, i) => `${l.name} ${fmtTime(times[i])}`).join('; ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]" role="img"
      aria-label={`Transfer time of ${fmtBytes(bytes)} at ${Math.round(eff * 100)}% efficiency, log scale, against a ${fmtTime(budget)} time-to-first-token budget: ${summary}.`}>
      {decades.map((d) => (
        <g key={d}>
          <line x1={x(10 ** d)} y1={T} x2={x(10 ** d)} y2={H - B} stroke="var(--border)" strokeWidth={0.75} />
          <text x={x(10 ** d)} y={H - 8} fontSize={10} textAnchor="middle" fill="var(--muted)" fontFamily="var(--font-mono)">{fmtTime(10 ** d)}</text>
        </g>
      ))}
      {LINKS.map((l, i) => {
        const y = T + i * rowH, t = times[i], over = t > budget, sel = l.id === selected;
        return (
          <g key={l.id}>
            <text x={L - 8} y={y + rowH / 2 + 4} fontSize={11} textAnchor="end" fill={sel ? 'var(--text)' : 'var(--muted)'} fontWeight={sel ? 700 : 400} fontFamily="var(--font-mono)">{l.name}</text>
            <rect x={L} y={y + 5} width={Math.max(2, x(t) - L)} height={rowH - 10} rx={3}
              fill={over ? 'var(--danger)' : 'var(--data)'} opacity={sel ? 0.9 : 0.4} stroke={sel ? 'var(--text)' : 'none'} strokeWidth={sel ? 1.25 : 0} />
            <text x={Math.max(2, x(t) - L) + L + 4} y={y + rowH / 2 + 4} fontSize={10.5} fill="var(--text)" fontFamily="var(--font-mono)">{fmtTime(t)}{over ? ' !' : ''}</text>
          </g>
        );
      })}
      <line x1={x(budget)} y1={T - 4} x2={x(budget)} y2={H - B} stroke="var(--warn)" strokeWidth={1.5} strokeDasharray="5 3" />
      <text x={x(budget) + 3} y={T + 4} fontSize={10} fill="var(--warn)" fontFamily="var(--font-mono)">TTFT {fmtTime(budget)}</text>
    </svg>
  );
}


export default function KvCacheTransfer() {
  const [presetId, setPresetId] = useState<string>('l31-70b');
  const [shape, setShape] = useState<ModelShape>({ layers: 80, heads: 64, kvHeads: 8, headDim: 128 });
  const [dtype, setDtype] = useState<'bf16' | 'fp8'>('bf16');
  const [tokIdx, setTokIdx] = useState(6); // 8192
  const [batch, setBatch] = useState(1);
  const [linkId, setLinkId] = useState('1x400');
  const [eff, setEff] = useState<number>(1);
  const [budget, setBudget] = useState<number>(0.5);

  const pickPreset = (p: ModelPreset) => { setPresetId(p.id); setShape({ layers: p.layers, heads: p.heads, kvHeads: p.kvHeads, headDim: p.headDim }); };
  const edit = (k: keyof ModelShape, v: number) => { setPresetId('custom'); setShape((s) => ({ ...s, [k]: v })); };

  const bpe = DTYPES.find((d) => d.id === dtype)!.bytes;
  const tokens = TOKEN_STEPS[tokIdx];
  const link = LINKS.find((l) => l.id === linkId)!;
  const perTok = kvBytesPerToken(shape, bpe);
  const perTokMha = kvBytesPerTokenMHA(shape, bpe);
  const total = kvBytes(shape, bpe, tokens, batch);
  const totalMha = perTokMha * tokens * batch;
  const t = transferS(total, link.GBps, eff);
  const tMha = transferS(totalMha, link.GBps, eff);
  const tStream = streamedExposedS(total, shape.layers, link.GBps, eff);
  const share = t / budget;
  const gqaRatio = shape.heads / shape.kvHeads;
  const preset = MODELS.find((m) => m.id === presetId);
  const shapeWarn = shape.kvHeads > shape.heads ? 'KV heads cannot exceed attention heads.' : shape.heads % shape.kvHeads !== 0 ? 'In GQA the attention heads are a multiple of the KV heads; check the config.' : null;
  const effPct = Math.round(eff * 100);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div>
          <div className={lbl}>Model (shape from its config.json)</div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Model preset">
            {MODELS.map((m) => <button key={m.id} type="button" aria-pressed={presetId === m.id} onClick={() => pickPreset(m)} className={btn(presetId === m.id)}>{m.name}</button>)}
            <button type="button" aria-pressed={presetId === 'custom'} onClick={() => setPresetId('custom')} className={btn(presetId === 'custom')}>Custom</button>
          </div>
          <p className="mt-1 text-[11px] text-muted">{preset ? preset.note : 'Edit the fields below; take the numbers from the model\'s config.json.'}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ['layers', 'Layers', 'num_hidden_layers', 1, 512],
            ['heads', 'Attention heads', 'num_attention_heads', 1, 512],
            ['kvHeads', 'KV heads', 'num_key_value_heads', 1, 512],
            ['headDim', 'Head dim', 'head_dim', 1, 1024],
          ] as const).map(([k, name, key, lo, hi]) => (
            <div key={k}>
              <label htmlFor={`kv-${k}`} className={lbl}>{name}</label>
              <NumInput id={`kv-${k}`} integer min={lo} max={hi} value={shape[k]} aria-describedby={`kv-${k}-key`}
                onValue={(v) => edit(k, v)}
                className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
              <div id={`kv-${k}-key`} className="mt-0.5 font-mono text-[10px] text-muted">{key}</div>
            </div>
          ))}
        </div>
        {shapeWarn && <p className="text-xs text-warn" role="note">{shapeWarn}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Seg label="KV cache data type" value={dtype} options={['bf16', 'fp8'] as const} onChange={setDtype} render={(v) => DTYPES.find((d) => d.id === v)!.name} />
          <div>
            <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              <label htmlFor="kv-tok">Prompt length</label><span className="text-base font-semibold normal-case tracking-normal text-fg">{fmtInt(tokens)} tokens</span>
            </div>
            <input id="kv-tok" type="range" min={0} max={TOKEN_STEPS.length - 1} value={tokIdx} aria-valuetext={`${fmtInt(tokens)} tokens`}
              onChange={(e) => setTokIdx(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
            <div className="flex justify-between font-mono text-[10px] text-muted" aria-hidden><span>128</span><span>4k</span><span>128k</span></div>
          </div>
          <div>
            <label htmlFor="kv-batch" className={lbl}>Requests in this transfer (batch)</label>
            <NumInput id="kv-batch" integer min={1} max={256} value={batch} onValue={setBatch}
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
          </div>
          <Seg label="Example TTFT budget" value={budget} options={BUDGETS} onChange={setBudget} render={(v) => (v < 1 ? `${v * 1000} ms` : `${v} s`)} />
        </div>
        <Seg label="Link from prefill to decode (per direction)" value={linkId} options={LINKS.map((l) => l.id)} onChange={setLinkId}
          render={(id) => { const l = LINKS.find((x) => x.id === id)!; return `${l.name} · ${l.GBps} GB/s`; }} />
        <p className="-mt-2 text-[11px] text-muted">{link.note}</p>
        <Seg label="Achieved share of line rate" value={eff} options={EFFS} onChange={setEff} render={(v) => (v === 1 ? '100% (lesson math)' : `${Math.round(v * 100)}%`)} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="KV per token" value={`${fmtInt(perTok)} B`} sub={`${(perTok / 1024).toFixed(perTok % 1024 ? 1 : 0)} KiB`} tone="text-data" />
        <Out label="KV to transfer" value={fmtBytes(total)} sub={`${fmtInt(tokens)} tokens${batch > 1 ? ` × ${batch} requests` : ''}`} tone="text-data" />
        <Out label={`Transfer on ${link.name}`} value={fmtTime(t)} tone={share > 1 ? 'text-danger' : share > 0.25 ? 'text-warn' : 'text-accent'}
          sub={`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% of a ${fmtTime(budget)} TTFT budget${share > 1 ? ' (over budget)' : ''}`} />
        <Out label="Streamed layer by layer" value={fmtTime(tStream)} sub={`exposed ≈ last layer's share (1/${shape.layers}), if the link keeps up with prefill`} />
      </div>

      <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm" aria-live="polite">
        <span className="font-semibold text-fg">Why GQA matters:</span>{' '}
        <span className="text-muted">
          {gqaRatio < 1 ? (
            <>Not a valid shape: a model cannot have more KV heads than attention heads. Take both numbers from the config.</>
          ) : gqaRatio > 1 ? (
            <>With multi-head attention ({shape.heads} KV heads instead of {shape.kvHeads}) this model would need <span className="font-mono text-fg">{fmtInt(perTokMha)} B</span> per
              token, <span className="font-mono text-fg">{fmtBytes(totalMha)}</span> for this prompt and <span className="font-mono text-fg">{fmtTime(tMha)}</span> on the same link: {Number.isInteger(gqaRatio) ? gqaRatio : gqaRatio.toFixed(2)}× more.
              Use the KV heads from the config, not the attention heads.</>
          ) : (
            <>This model uses multi-head attention (KV heads = attention heads), so nothing is saved. For comparison, Llama 3.1 8B has the same depth and width as Llama 2 7B (32 layers, hidden size 4,096) but 8 KV heads instead of 32: a quarter of the KV bytes.</>
          )}
        </span>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Transfer time on each link (log scale; ! = over budget)</div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Transfer time per link chart, scrollable">
          <LinkChart bytes={total} eff={eff} budget={budget} selected={linkId} />
        </div>
      </div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>KV per token = 2 (K and V) × layers × KV heads × head dim × bytes = 2 × {shape.layers} × {shape.kvHeads} × {shape.headDim} × {bpe} = <span className="font-mono text-fg">{fmtInt(perTok)} B</span></li>
          <li>KV per request = per token × tokens{batch > 1 ? ' × requests' : ''} = {fmtInt(perTok)} × {fmtInt(tokens)}{batch > 1 ? ` × ${batch}` : ''} = <span className="font-mono text-fg">{fmtInt(total)} B ≈ {fmtBytes(total)}</span></li>
          <li>transfer = bytes / (rate × efficiency) = {fmtBytes(total)} / ({link.GBps} GB/s × {effPct}%) = <span className="font-mono text-fg">{fmtTime(t)}</span></li>
          <li>streamed per layer: one layer holds 1/{shape.layers} of it, {fmtBytes(total / shape.layers)} → <span className="font-mono text-fg">{fmtTime(tStream)}</span> exposed, if each layer's transfer finishes while the next layers are still computing</li>
          <li>MHA comparison: replace KV heads by attention heads ({shape.heads}) → {fmtInt(perTokMha)} B per token</li>
        </ol>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>{fmtBytes(perTok * 1000)} per 1k tokens</Pill>
        <Pill>{link.name}: {fmtBytes(link.GBps * 1e9 * eff * 1e-3)} per ms</Pill>
        {dtype === 'bf16' && <Pill>FP8 KV would halve this: {fmtBytes(total / 2)}</Pill>}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Bandwidth-only model: no per-transfer setup latency, no protocol overhead beyond the efficiency factor, and the whole prompt's KV moves
        (no prefix already cached on the decode side). The formula holds for standard multi-head, grouped-query and multi-query attention; models
        with compressed KV (for example multi-head latent attention), sliding-window layers or quantised KV with scale factors need their own
        formula, so compute from the real config. "8 × 400G" assumes the KV is split evenly across the 8 GPUs of a TP8 instance and each sends on
        its own rail; if decode receives on one GPU (for example DP attention), the receiver's single NIC is the limit. NVLink figures are NVIDIA's
        per-GPU peak; a single GPU-to-GPU copy reaches less. The TTFT budget is an example, not a standard; real budgets come from your SLOs and
        also have to cover queueing and prefill compute. Decimal units (1 GB = 10^9 B); KiB = 1024 B.
      </p>
    </div>
  );
}
