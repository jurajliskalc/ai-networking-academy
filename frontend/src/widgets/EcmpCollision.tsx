import { useMemo, useState } from 'react';
import { Button } from '../components/ui';

type Mode = 'ecmp' | 'ar' | 'spray';
const FLOWLETS = 8; // flowlets per flow for the adaptive-routing model

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* FNV-1a over the 5-tuple bytes: a stand-in for the switch's CRC-based ECMP hash. */
function hash5(srcIp: number, dstIp: number, proto: number, sport: number, dport: number) {
  let h = 0x811c9dc5;
  const bytes = [srcIp >>> 24, (srcIp >>> 16) & 255, (srcIp >>> 8) & 255, srcIp & 255, dstIp >>> 24, (dstIp >>> 16) & 255, (dstIp >>> 8) & 255, dstIp & 255, proto, sport >>> 8, sport & 255, dport >>> 8, dport & 255];
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const ip = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const ipStr = (x: number) => `${x >>> 24}.${(x >>> 16) & 255}.${(x >>> 8) & 255}.${x & 255}`;

function collisionProb(f: number, s: number) {
  if (f > s) return 1;
  let p = 1;
  for (let i = 0; i < f; i++) p *= 1 - i / s;
  return 1 - p;
}

export default function EcmpCollision() {
  const [S, setS] = useState(4);
  const [F, setF] = useState(4);
  const [mode, setMode] = useState<Mode>('ecmp');
  const [seed, setSeed] = useState(7);
  const [degrade, setDegrade] = useState(false);

  const flows = useMemo(() => {
    const rnd = mulberry32(seed * 7919 + 13);
    return Array.from({ length: 16 }, (_, i) => {
      const src = ip(10, 0, 1, 10 + (i % 8)), dst = ip(10, 0, 2, 10 + (i % 8));
      const sport = 49152 + Math.floor(rnd() * 16384);
      return { i, src, dst, sport };
    });
  }, [seed]);

  const cap = useMemo(() => Array.from({ length: S }, (_, j) => (degrade && j === 0 ? 0.5 : 1)), [S, degrade]);

  const { load, assign } = useMemo(() => {
    const load = Array(S).fill(0) as number[];
    const assign: (number | null)[] = [];
    const active = flows.slice(0, F);
    if (mode === 'ecmp') {
      for (const f of active) { const j = hash5(f.src, f.dst, 17, f.sport, 4791) % S; load[j] += 1; assign.push(j); }
    } else if (mode === 'spray') {
      for (let j = 0; j < S; j++) load[j] = F / S;
      active.forEach(() => assign.push(null));
    } else {
      // flowlets placed one at a time on the link with the least normalised load after placement
      for (let r = 0; r < FLOWLETS; r++) for (let fi = 0; fi < F; fi++) {
        let best = 0, bv = Infinity;
        for (let j = 0; j < S; j++) { const v = (load[j] + 1 / FLOWLETS) / cap[j]; if (v < bv - 1e-9) { bv = v; best = j; } }
        load[best] += 1 / FLOWLETS;
      }
      active.forEach(() => assign.push(null));
    }
    return { load, assign };
  }, [flows, F, S, mode, cap]);

  const util = load.map((l, j) => l / cap[j]); // 1.0 = one full-rate flow's worth on a full-rate link
  const maxU = Math.max(...util);
  const totalCap = cap.reduce((a, b) => a + b, 0);
  const ideal = Math.max(1, F / totalCap);
  const time = Math.max(1, maxU); // a flow alone is limited by its 400G NIC
  const slow = time / ideal;
  const pColl = collisionProb(F, S);

  // geometry
  const W = 640, H = 300;
  const spineX = (j: number) => 60 + ((j + 0.5) * (W - 120)) / S;
  const leafX = (l: number) => 80 + (l * (W - 160)) / 3;
  const spY = 50, lfY = 200, hostY = 270;
  const loadColor = (u: number) => (u > 1.001 ? 'var(--danger)' : u > 0.999 ? 'var(--warn)' : u > 0 ? 'var(--accent)' : 'var(--border)');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <label className="flex items-center gap-2 text-xs"><span className="text-muted">Spines S</span>
          <input type="range" min={2} max={8} value={S} onChange={(e) => setS(+e.target.value)} aria-valuetext={`${S} spines`} className="w-24 accent-[var(--accent)]" /><span className="w-4 font-mono">{S}</span></label>
        <label className="flex items-center gap-2 text-xs"><span className="text-muted">Elephant flows F</span>
          <input type="range" min={1} max={16} value={F} onChange={(e) => setF(+e.target.value)} aria-valuetext={`${F} flows`} className="w-24 accent-[var(--accent)]" /><span className="w-5 font-mono">{F}</span></label>
        <div className="inline-flex flex-wrap overflow-hidden rounded-lg border border-line" role="group" aria-label="Load-balancing mode">
          {([['ecmp', 'Static ECMP'], ['ar', 'Adaptive routing'], ['spray', 'Packet spraying']] as [Mode, string][]).map(([m, l]) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={`px-2.5 py-1 text-xs ${mode === m ? 'bg-accent-soft text-accent' : 'bg-panel text-muted hover:text-fg'}`}>{l}</button>
          ))}
        </div>
        <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => setSeed((x) => x + 1)} disabled={mode !== 'ecmp'}>Reshuffle ports</Button>
        <label className="inline-flex items-center gap-1.5 text-xs"><input type="checkbox" checked={degrade} onChange={(e) => setDegrade(e.target.checked)} className="accent-[var(--accent)]" />Spine 0 uplink degraded to 50%</label>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Leaf-spine fabric, ${S} spines, ${F} elephant flows from leaf A to leaf B, ${mode === 'ecmp' ? 'static ECMP' : mode === 'ar' ? 'adaptive routing' : 'packet spraying'}. Uplink load: ${util.map((u, j) => `S${j} ${(u * 100).toFixed(0)}%${u > 1.001 ? ' overloaded' : ''}`).join(', ')}.`}>
        {/* faint links for leaves C, D */}
        {[2, 3].map((l) => Array.from({ length: S }, (_, j) => <line key={`${l}-${j}`} x1={leafX(l)} y1={lfY} x2={spineX(j)} y2={spY} stroke="var(--border)" strokeWidth={1} />))}
        {[0, 1].map((l) => Array.from({ length: S }, (_, j) => {
          const u = util[j];
          return <line key={`${l}-${j}`} x1={leafX(l)} y1={lfY} x2={spineX(j)} y2={spY} stroke={loadColor(u)} strokeWidth={1.5 + Math.min(load[j], 6) * 1.6}
            strokeOpacity={u > 0 ? 0.9 : 1} className={u > 0 ? 'flow-dash' : ''} style={l === 1 ? { animationDirection: 'reverse' } : undefined} />;
        }))}
        {Array.from({ length: S }, (_, j) => (
          <g key={j}>
            <rect x={spineX(j) - 24} y={spY - 18} width={48} height={26} rx={6} fill="var(--panel-2)" stroke={util[j] > 1.001 ? 'var(--danger)' : 'var(--border)'} strokeWidth={1.5} />
            <text x={spineX(j)} y={spY - 1} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill="var(--text)">S{j}</text>
            <text x={spineX(j)} y={spY - 24} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)" fill={util[j] > 0 ? loadColor(util[j]) : 'var(--muted)'}>{load[j] % 1 === 0 ? load[j] : load[j].toFixed(2)}{degrade && j === 0 ? ' @½' : ''}</text>
          </g>
        ))}
        {['A', 'B', 'C', 'D'].map((n, l) => (
          <g key={n}>
            <rect x={leafX(l) - 30} y={lfY - 4} width={60} height={26} rx={6} fill={l < 2 ? 'var(--accent-soft)' : 'var(--panel-2)'} stroke={l < 2 ? 'var(--accent)' : 'var(--border)'} strokeWidth={1.5} />
            <text x={leafX(l)} y={lfY + 13} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill="var(--text)">Leaf {n}</text>
            {l < 2 && Array.from({ length: 4 }, (_, h) => <rect key={h} x={leafX(l) - 26 + h * 14} y={hostY - 10} width={10} height={14} rx={2} fill="var(--panel)" stroke="var(--muted)" />)}
            {l < 2 && <line x1={leafX(l)} y1={lfY + 22} x2={leafX(l)} y2={hostY - 10} stroke="var(--muted)" />}
          </g>
        ))}
        <text x={leafX(0)} y={hostY + 18} textAnchor="middle" fontSize={10} fill="var(--muted)">senders</text>
        <text x={leafX(1)} y={hostY + 18} textAnchor="middle" fontSize={10} fill="var(--muted)">receivers</text>
      </svg>

      <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Leaf A uplink load (1.0 = one 400G flow on a 400G link)</div>
          {util.map((u, j) => (
            <div key={j} className="flex items-center gap-2 text-xs">
              <span className="w-6 font-mono text-muted">S{j}</span>
              <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-panel-2" aria-hidden>
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (u / Math.max(2, maxU)) * 100)}%`, background: loadColor(u) }} />
                <div className="absolute inset-y-0 w-px bg-[var(--muted)]" style={{ left: `${(1 / Math.max(2, maxU)) * 100}%` }} />
              </div>
              <span className="w-12 text-right font-mono">{(u * 100).toFixed(0)}%{u > 1.001 && <span className="sr-only"> overloaded</span>}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2" aria-live="polite">
          <Stat label="Max link load" value={`${(maxU * 100).toFixed(0)}%`} tone={maxU > 1.001 ? 'text-danger' : 'text-accent'} />
          <Stat label="Collective step time" value={`${slow.toFixed(2)}×`} sub="vs ideal; slowest flow decides" tone={slow > 1.01 ? 'text-warn' : 'text-accent'} />
          <Stat label="P(≥1 collision)" value={`${(pColl * 100).toFixed(1)}%`} sub={`static ECMP, ${F} flows on ${S} links`} />
          <Stat label="Effective fabric use" value={`${((F / time / totalCap) * 100).toFixed(0)}%`} sub="of leaf A uplink capacity" />
        </div>
      </div>

      {mode === 'ecmp' && (
        <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="ECMP hash of each flow">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-panel-2 text-muted"><tr><th className="px-2 py-1">flow</th><th className="px-2 py-1">5-tuple (src, dst, 17, sport, 4791)</th><th className="px-2 py-1">hash</th><th className="px-2 py-1">mod {S}</th></tr></thead>
            <tbody>
              {flows.slice(0, F).map((f, i) => {
                const j = assign[i] ?? 0;
                return <tr key={i} className="border-t border-line"><td className="px-2 py-0.5">f{i}</td><td className="px-2 py-0.5 text-muted">{ipStr(f.src)} → {ipStr(f.dst)} udp <span className="text-data">{f.sport}</span>→4791</td>
                  <td className="px-2 py-0.5">0x{hash5(f.src, f.dst, 17, f.sport, 4791).toString(16).padStart(8, '0')}</td><td className="px-2 py-0.5" style={{ color: loadColor(util[j]) }}>S{j}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2 text-sm text-muted">
        <p><span className="font-semibold text-fg">Entropy.</span> A switch can only spread traffic it can tell apart. ECMP hashes the 5-tuple, so all packets of a flow take one path (no reordering) but a handful of 400G elephants hash like a few balls into S bins: collisions are the rule, not the exception, and in a synchronised collective the one doubled-up link sets the pace for every GPU.</p>
        <p><span className="font-semibold text-fg">Why RoCE cares.</span> Between two hosts every RoCEv2 packet has the same IPs, protocol and destination port 4791, so the UDP source port is the only entropy. NICs derive it per QP, which is why NCCL opens several QPs per connection (NCCL_IB_QPS_PER_CONNECTION) and why fabrics add adaptive routing or spraying. Those need receivers that tolerate out-of-order arrival (RDMA write placement by address, NIC reordering), otherwise go-back-N treats reordering as loss.</p>
        <p className="text-xs">Model: every flow wants 400G, links are 400G, max-min sharing, spine→leaf B link carries the same flows. Adaptive routing places {FLOWLETS} flowlets per flow on the least-loaded uplink (and steers around a degraded link); spraying splits each flow evenly regardless of link health.</p>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}
