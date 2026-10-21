import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

type ColorBy = 'tp' | 'pp' | 'dp' | 'ep';
const TOTALS = [64, 128, 256];
const DEGREES = [1, 2, 4, 8];
const PER_SERVER = 8;

interface Coord { r: number; tp: number; dp: number; pp: number; ep: number; epGroup: number; server: number }

// Megatron-style default rank order (tp fastest, then dp, then pp): r = tp + TP·(dp + DP·pp).
// Expert parallelism is carved out of the DP dimension: consecutive dp ranks form an EP group.
function coords(N: number, TP: number, PP: number, EP: number): Coord[] {
  const DP = N / (TP * PP);
  return Array.from({ length: N }, (_, r) => {
    const tp = r % TP, dp = Math.floor(r / TP) % DP, pp = Math.floor(r / (TP * DP));
    return { r, tp, dp, pp, ep: dp % EP, epGroup: Math.floor(dp / EP), server: Math.floor(r / PER_SERVER) };
  });
}

const hue = (i: number) => `hsl(${(i * 137.508) % 360} 58% 44%)`;

const SCALE = ['—', 'low', 'medium', 'high', 'very high'];
function Rating({ v }: { v: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={SCALE[v]}>
      <span className="flex gap-0.5">{[1, 2, 3, 4].map((i) => <span key={i} className={`h-2 w-2 rounded-sm ${i <= v ? 'bg-warn' : 'bg-panel-2 border border-line'}`} />)}</span>
      <span className="text-[11px] text-muted">{SCALE[v]}</span>
    </span>
  );
}

function Seg({ label, value, options, onChange, disabled }: { label: string; value: number; options: number[]; onChange: (v: number) => void; disabled?: (v: number) => boolean }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={o} type="button" disabled={disabled?.(o)} onClick={() => onChange(o)} aria-pressed={o === value}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition disabled:opacity-30 ${o === value ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-panel-2'}`}>{o}</button>
        ))}
      </div>
    </div>
  );
}

export default function ParallelismMap() {
  const [N, setN] = useState(128);
  const [TP, setTP] = useState(8);
  const [PP, setPP] = useState(4);
  const [moe, setMoe] = useState(false);
  const [EPsel, setEP] = useState(4);
  const [colorBy, setColorBy] = useState<ColorBy>('tp');
  const [focus, setFocus] = useState<number | null>(0);

  const valid = N % (TP * PP) === 0 && TP * PP <= N;
  const DP = valid ? N / (TP * PP) : 1;
  const epOptions = [2, 4, 8, 16, 32].filter((e) => e <= DP && DP % e === 0);
  const EP = moe && epOptions.length ? (epOptions.includes(EPsel) ? EPsel : epOptions[epOptions.length - 1]) : 1;
  const cs = useMemo(() => (valid ? coords(N, TP, PP, EP) : []), [N, TP, PP, EP, valid]);
  const f = focus !== null && focus < cs.length ? cs[focus] : null;

  const groupKey = (c: Coord, by: ColorBy) =>
    by === 'tp' ? c.dp + DP * c.pp : by === 'pp' ? c.pp : by === 'dp' ? c.dp : c.epGroup + (DP / EP) * (c.tp + TP * c.pp);
  const colorIdx = (c: Coord) => groupKey(c, colorBy);

  // Do the members of each group of a kind sit within one server?
  const spans = (by: 'tp' | 'dp' | 'ep') => {
    const m = new Map<number, Set<number>>();
    const key = (c: Coord) => (by === 'tp' ? c.dp + DP * c.pp : by === 'dp' ? c.tp + TP * c.pp : groupKey(c, 'ep'));
    cs.forEach((c) => { const k = key(c); if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(c.server); });
    return [...m.values()].some((s) => s.size > 1);
  };
  const tpCross = valid && TP > 1 && spans('tp');
  const dpCross = valid && DP > 1 && spans('dp');
  const epCross = valid && EP > 1 && spans('ep');
  const ppCross = valid && PP > 1 && TP * DP >= PER_SERVER;

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
  const net = (cross: boolean, used: boolean) => (!used ? <span className="text-muted">not used</span> : cross ? <span className="text-data">RDMA scale-out</span> : <span className="text-accent">NVLink scale-up</span>);

  const rows = [
    { name: 'Tensor (TP)', deg: TP, coll: 'all-reduce (or reduce-scatter + all-gather with sequence parallel), ~2 per layer fwd and 2 bwd', net: net(tpCross, TP > 1), vol: 4, lat: 4 },
    { name: 'Pipeline (PP)', deg: PP, coll: 'send/recv of activations (fwd) and their gradients (bwd) between adjacent stages, per micro-batch', net: net(ppCross, PP > 1), vol: 1, lat: 3 },
    { name: 'Data (DP)', deg: DP, coll: 'gradient all-reduce, or reduce-scatter + all-gather with ZeRO/FSDP; overlappable with backward', net: net(dpCross, DP > 1), vol: 3, lat: 2 },
    ...(moe ? [{ name: 'Expert (EP)', deg: EP, coll: 'all-to-all dispatch + combine, 2 per MoE layer fwd and 2 bwd; skewed by router load, incast-prone', net: net(epCross, EP > 1), vol: 3, lat: 4 }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Seg label="Total GPUs" value={N} options={TOTALS} onChange={setN} />
        <Seg label="TP degree" value={TP} options={DEGREES} onChange={setTP} />
        <Seg label="PP degree" value={PP} options={DEGREES} onChange={setPP} />
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
        <Pill>{servers} servers × {PER_SERVER} GPUs</Pill>
        {moe && <Pill>EP {EP} carved from DP</Pill>}
        <div className="ml-auto flex gap-1">
          {(['tp', 'pp', 'dp', ...(moe ? ['ep'] : [])] as ColorBy[]).map((k) => (
            <button key={k} type="button" onClick={() => setColorBy(k)} aria-pressed={colorBy === k}
              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase ${colorBy === k ? 'border-fg text-fg' : 'border-line text-muted'}`}>color: {k}</button>
          ))}
        </div>
      </div>

      {!valid ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">TP × PP = {TP * PP} does not divide {N} GPUs.</div>
      ) : (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${N > 128 ? 92 : 120}px, 1fr))` }}>
          {Array.from({ length: servers }, (_, s) => (
            <div key={s} className="rounded-md border border-line bg-panel-2 p-1">
              <div className="mb-0.5 font-mono text-[9px] text-muted">srv {s}</div>
              <div className="grid grid-cols-4 gap-0.5">
                {cs.slice(s * PER_SERVER, (s + 1) * PER_SERVER).map((c) => {
                  const p = peer(c);
                  const me = f?.r === c.r;
                  return (
                    <button key={c.r} type="button" onClick={() => setFocus(c.r)} onMouseEnter={() => setFocus(c.r)}
                      aria-label={`GPU ${c.r}: tp ${c.tp}, pp ${c.pp}, dp ${c.dp}`}
                      className="aspect-square rounded-sm font-mono text-[8px] leading-none text-white"
                      style={{ background: hue(colorIdx(c)), outline: me ? '2px solid var(--text)' : p ? `2px solid ${PEER_RING[p]}` : undefined, outlineOffset: 1, opacity: f && !me && !p ? 0.55 : 1 }}>
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
          <span className="font-mono">GPU {f.r}: tp={f.tp} pp={f.pp} dp={f.dp}{moe ? ` ep=${f.ep}` : ''} (server {f.server})</span>
          {Object.entries(PEER_RING).filter(([k]) => k !== 'ep' || moe).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ outline: `2px solid ${v}` }} />{k.toUpperCase()} peers</span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-sm">
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
                <td className="pr-2 font-mono text-xs">{r.net}</td>
                <td className="pr-2"><Rating v={r.deg > 1 ? r.vol : 0} /></td>
                <td><Rating v={r.deg > 1 ? r.lat : 0} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 text-sm text-muted">
        {tpCross && <p className="text-danger">TP spans servers here: its per-layer collectives would run over the scale-out NICs, often several times slower than NVLink, and sit on the critical path of every layer.</p>}
        <p><span className="font-semibold text-fg">Why TP stays inside the NVLink domain:</span> tensor parallelism splits every matrix multiply, so each layer
          blocks on an all-reduce of activation-sized tensors, several times per layer, forward and backward. Nothing can overlap it, so it needs the
          highest bandwidth and lowest latency available: NVLink at roughly an order of magnitude more bandwidth per GPU than a scale-out NIC. DP and PP
          communicate less often or can be overlapped with compute, so they tolerate the scale-out network. EP all-to-all is the hardest scale-out
          pattern: every GPU sends to every other in its group, sizes are uneven, and the result sits on the critical path.</p>
      </div>
      <p className="text-[11px] text-muted">
        Ratings are qualitative and depend on model size, sequence length, micro-batch count, overlap and framework (Megatron-LM, DeepSpeed, FSDP).
        Rank order follows Megatron's default tp→dp→pp layout; other orders (and context parallelism, not shown) change which groups cross servers.
        Rack-scale NVLink domains (e.g. 72 GPUs) extend what counts as scale-up.
      </p>
    </div>
  );
}
