import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui';

/* Fluid model of one link direction at 400 Gb/s (50 bytes/ns), stepped every DT ns.
   Left: InfiniBand credit-based link-level flow control. Right: Ethernet PFC with XOFF/XON. */
const RATE = 50; // bytes per ns at 400 Gb/s
const DT = 5; // ns per step
const PER_STEP = RATE * DT; // 250 B
const XOFF = 64 * 1024; // PFC XOFF threshold (bytes)
const XON_GAP = 16 * 1024; // XON fires this far below XOFF
const RESPONSE_NS = 300; // sender reaction to a PAUSE (finish current frame, MAC/PHY): illustrative
const MTU = 4096;
const BLOCK = 64; // IB credits are counted in units of 64-byte blocks

class Ring {
  a: Float64Array; i = 0;
  constructor(n: number) { this.a = new Float64Array(Math.max(1, n)); }
  /** push value in, get the value that has spent n steps in the pipe */
  shift(v: number) { const out = this.a[this.i]; this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; return out; }
  /** contents ordered oldest (about to arrive) → newest (just sent) */
  ordered() { const n = this.a.length; return Array.from({ length: n }, (_, k) => this.a[(this.i + k) % n]); }
  sum() { let s = 0; for (const v of this.a) s += v; return s; }
}

interface Sim {
  t: number; D: number; buf: number;
  ib: { credits: number; fwd: Ring; back: Ring; occ: number; sent: number; drained: number; stalled: number };
  pfc: { fwd: Ring; occ: number; sent: number; drained: number; drops: number; pauses: number; paused: boolean; xoffSent: boolean;
    ctrl: { sent: number; arrive: number; type: 'PAUSE' | 'XON' }[]; maxOcc: number };
}

function makeSim(cableM: number, headroom: number): Sim {
  const D = Math.max(1, Math.round((cableM * 5) / DT));
  const buf = XOFF + headroom;
  return {
    t: 0, D, buf,
    ib: { credits: buf, fwd: new Ring(D), back: new Ring(D), occ: 0, sent: 0, drained: 0, stalled: 0 },
    pfc: { fwd: new Ring(D), occ: 0, sent: 0, drained: 0, drops: 0, pauses: 0, paused: false, xoffSent: false, ctrl: [], maxOcc: 0 },
  };
}

function step(s: Sim, drainFrac: number) {
  const drainCap = PER_STEP * drainFrac;
  // ---- InfiniBand: send only what the receiver has promised to buffer.
  const ib = s.ib;
  const tx = Math.min(PER_STEP, ib.credits);
  if (tx < PER_STEP) ib.stalled++;
  ib.credits -= tx; ib.sent += tx;
  ib.occ += ib.fwd.shift(tx);
  const d1 = Math.min(ib.occ, drainCap);
  ib.occ -= d1; ib.drained += d1;
  ib.credits += ib.back.shift(d1); // freed buffer returns as credits one cable delay later

  // ---- PFC: send at line rate until a PAUSE has arrived and taken effect.
  const p = s.pfc;
  p.ctrl = p.ctrl.filter((c) => { if (c.arrive <= s.t) { p.paused = c.type === 'PAUSE'; return false; } return true; });
  const tx2 = p.paused ? 0 : PER_STEP;
  p.sent += tx2;
  const arr = p.fwd.shift(tx2);
  const space = s.buf - p.occ;
  const acc = Math.min(arr, space);
  p.drops += arr - acc; p.occ += acc;
  const d2 = Math.min(p.occ, drainCap);
  p.occ -= d2; p.drained += d2;
  p.maxOcc = Math.max(p.maxOcc, p.occ);
  if (!p.xoffSent && p.occ >= XOFF) { p.xoffSent = true; p.pauses++; p.ctrl.push({ sent: s.t, arrive: s.t + s.D + Math.round(RESPONSE_NS / DT), type: 'PAUSE' }); }
  else if (p.xoffSent && p.occ <= XOFF - XON_GAP) { p.xoffSent = false; p.ctrl.push({ sent: s.t, arrive: s.t + s.D, type: 'XON' }); }
  s.t++;
}

const kb = (b: number) => `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function Lane({ title, fwd, back, occ, buf, marks, color, ctrl, D, t }: {
  title: string; fwd: number[]; back?: number[]; occ: number; buf: number; marks: { y: number; label: string; color: string }[]; color: string;
  ctrl?: { sent: number; type: string }[]; D: number; t: number;
}) {
  const BINS = 28, x0 = 74, x1 = 280, bw = (x1 - x0) / BINS;
  const bin = (arr: number[]) => Array.from({ length: BINS }, (_, b) => {
    const lo = Math.floor((b * arr.length) / BINS), hi = Math.max(lo + 1, Math.floor(((b + 1) * arr.length) / BINS));
    let s = 0; for (let k = lo; k < hi; k++) s += arr[k]; return s / ((hi - lo) * PER_STEP);
  });
  // fwd ordered oldest→newest: oldest is nearest the receiver (right). Reverse so index 0 = sender side.
  const f = bin([...fwd].reverse());
  const bk = back ? bin(back) : null; // back ordered oldest→newest: oldest nearest the sender (left)
  const H = 120, by = 30;
  const fill = Math.min(1, occ / buf);
  return (
    <svg viewBox="0 0 360 170" className="w-full" role="img" aria-label={`${title} link`}>
      <text x={8} y={16} fontSize={12} fontWeight={700} fill="var(--text)">{title}</text>
      <rect x={8} y={48} width={60} height={56} rx={6} fill="var(--panel-2)" stroke="var(--border)" />
      <text x={38} y={80} textAnchor="middle" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">TX</text>
      <line x1={x0} y1={62} x2={x1} y2={62} stroke="var(--border)" strokeWidth={10} strokeLinecap="round" />
      {f.map((v, i) => v > 0.01 && <rect key={i} x={x0 + i * bw + 0.5} y={57} width={bw - 1} height={10} rx={2} fill={color} opacity={Math.min(1, 0.25 + v * 0.75)} />)}
      <line x1={x0} y1={92} x2={x1} y2={92} stroke="var(--border)" strokeWidth={4} strokeLinecap="round" />
      {bk && bk.map((v, i) => v > 0.01 && <rect key={i} x={x0 + i * bw + 0.5} y={89} width={bw - 1} height={6} rx={2} fill="var(--accent)" opacity={Math.min(1, 0.3 + v)} />)}
      {ctrl && ctrl.map((c, i) => {
        const prog = Math.min(1, (t - c.sent) / D);
        const x = x1 - prog * (x1 - x0);
        return <g key={i}><rect x={x - 18} y={84} width={36} height={16} rx={3} fill={c.type === 'PAUSE' ? 'var(--warn)' : 'var(--accent)'} /><text x={x} y={95.5} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="var(--panel)" fontFamily="var(--font-mono)">{c.type}</text></g>;
      })}
      <text x={(x0 + x1) / 2} y={48} textAnchor="middle" fontSize={9.5} fill="var(--muted)" fontFamily="var(--font-mono)">data →</text>
      <text x={(x0 + x1) / 2} y={114} textAnchor="middle" fontSize={9.5} fill="var(--muted)" fontFamily="var(--font-mono)">← {back ? 'credit updates' : 'PFC frames'}</text>
      <rect x={292} y={by} width={44} height={H} rx={4} fill="var(--panel-2)" stroke="var(--border)" />
      <rect x={292} y={by + H * (1 - fill)} width={44} height={H * fill} rx={4} fill={fill >= 0.999 && !back ? 'var(--danger)' : color} opacity={0.75} />
      {marks.map((m) => <g key={m.label}><line x1={288} x2={340} y1={by + H * (1 - m.y)} y2={by + H * (1 - m.y)} stroke={m.color} strokeDasharray="3 2" /><text x={342} y={by + H * (1 - m.y) + 3} fontSize={8} fill={m.color} fontFamily="var(--font-mono)">{m.label}</text></g>)}
      <text x={314} y={by + H + 14} textAnchor="middle" fontSize={9.5} fill="var(--muted)" fontFamily="var(--font-mono)">RX buf</text>
    </svg>
  );
}

function Ctr({ k, v, tone = 'text-fg' }: { k: string; v: string; tone?: string }) {
  return <div className="flex justify-between gap-2 font-mono text-xs"><span className="text-muted">{k}</span><span className={`tabular-nums ${tone}`}>{v}</span></div>;
}

export default function IbCreditFlow() {
  const [drain, setDrain] = useState(50);
  const [cable, setCable] = useState(100);
  const [headroom, setHeadroom] = useState(96);
  const [running, setRunning] = useState(() => !reduced());
  const [, setTick] = useState(0);
  const sim = useRef<Sim>(makeSim(100, 96 * 1024));
  const drainRef = useRef(drain);
  drainRef.current = drain;

  const reset = useCallback(() => { sim.current = makeSim(cable, headroom * 1024); setTick((x) => x + 1); }, [cable, headroom]);
  useEffect(() => { reset(); }, [reset]);

  const advance = useCallback((n: number) => { for (let i = 0; i < n; i++) step(sim.current, drainRef.current / 100); setTick((x) => x + 1); }, []);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = () => { advance(Math.max(4, Math.ceil(sim.current.D / 30))); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, advance]);

  const s = sim.current;
  const oneWayNs = cable * 5;
  const rttNs = 2 * oneWayNs;
  const inflight = RATE * rttNs;
  const needHead = RATE * (rttNs + RESPONSE_NS) + 2 * MTU;
  const elapsed = Math.max(1, s.t) * DT;
  const ibTput = (s.ib.drained / elapsed / RATE) * 100;
  const pfcTput = (s.pfc.drained / elapsed / RATE) * 100;
  const ibFullRate = s.buf >= inflight;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Receiver drain rate', val: `${drain}% of 400G`, min: 0, max: 100, step: 5, v: drain, set: setDrain },
          { label: 'Cable length', val: `${cable} m`, min: 1, max: 2000, step: 1, v: cable, set: setCable },
          { label: 'PFC headroom', val: `${headroom} KB`, min: 8, max: 512, step: 8, v: headroom, set: setHeadroom },
        ].map((c) => (
          <label key={c.label} className="block">
            <div className="mb-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted"><span>{c.label}</span><span className="normal-case tracking-normal text-fg">{c.val}</span></div>
            <input type="range" min={c.min} max={c.max} step={c.step} value={c.v} onChange={(e) => c.set(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => setRunning((r) => !r)} className="!py-1">{running ? 'Pause' : 'Run'}</Button>
        <Button variant="ghost" onClick={() => advance(Math.round(1000 / DT))} className="!py-1">+1 µs</Button>
        <Button variant="ghost" onClick={reset} className="!py-1">Reset</Button>
        <span className="ml-auto font-mono text-xs text-muted">t = {(elapsed / 1000).toFixed(1)} µs</span>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-3 font-mono text-xs leading-relaxed">
        <div>one-way delay = {cable} m × 5 ns/m = <span className="text-fg">{oneWayNs.toLocaleString()} ns</span>; RTT = {rttNs.toLocaleString()} ns</div>
        <div>bytes in flight per RTT = 50 B/ns × {rttNs.toLocaleString()} ns = <span className="text-data">{kb(inflight)}</span></div>
        <div>PFC headroom needed ≈ rate × (RTT + {RESPONSE_NS} ns response) + 2 × MTU = <span className={headroom * 1024 >= needHead ? 'text-accent' : 'text-danger'}>{kb(needHead)}</span> (set: {headroom} KB)</div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line p-2">
          <Lane title="InfiniBand: credit-based" fwd={s.ib.fwd.ordered()} back={s.ib.back.ordered()} occ={s.ib.occ} buf={s.buf} color="var(--data)" D={s.D} t={s.t}
            marks={[{ y: 1, label: 'full', color: 'var(--muted)' }]} />
          <div className="space-y-0.5 px-1">
            <Ctr k="credits at sender" v={`${Math.floor(s.ib.credits / BLOCK).toLocaleString()} blocks`} tone={s.ib.credits < PER_STEP ? 'text-warn' : 'text-accent'} />
            <Ctr k="buffer occupancy" v={`${kb(s.ib.occ)} / ${kb(s.buf)}`} />
            <Ctr k="sender stalled (no credits)" v={`${((s.ib.stalled / Math.max(1, s.t)) * 100).toFixed(0)}%`} />
            <Ctr k="delivered throughput" v={`${ibTput.toFixed(0)}%`} />
            <Ctr k="drops" v="0 (by construction)" tone="text-accent" />
          </div>
        </div>
        <div className="rounded-lg border border-line p-2">
          <Lane title="Ethernet: PFC pause" fwd={s.pfc.fwd.ordered()} occ={s.pfc.occ} buf={s.buf} color="var(--data)" D={s.D} t={s.t} ctrl={s.pfc.ctrl}
            marks={[{ y: XOFF / s.buf, label: 'XOFF', color: 'var(--warn)' }, { y: (XOFF - XON_GAP) / s.buf, label: 'XON', color: 'var(--accent)' }]} />
          <div className="space-y-0.5 px-1">
            <Ctr k="sender state" v={s.pfc.paused ? 'PAUSED' : 'sending'} tone={s.pfc.paused ? 'text-warn' : 'text-accent'} />
            <Ctr k="buffer occupancy (peak)" v={`${kb(s.pfc.occ)} (${kb(s.pfc.maxOcc)})`} />
            <Ctr k="PAUSE frames sent" v={s.pfc.pauses.toLocaleString()} tone="text-warn" />
            <Ctr k="delivered throughput" v={`${pfcTput.toFixed(0)}%`} />
            <Ctr k="drops" v={kb(s.pfc.drops)} tone={s.pfc.drops > 0 ? 'text-danger' : 'text-accent'} />
          </div>
        </div>
      </div>

      <div className="space-y-2 text-sm text-muted">
        <p><span className="font-semibold text-fg">Credits</span>: the receiver advertises free buffer per virtual lane, in units of 64-byte blocks, and the sender
          may only transmit what has been promised. Overflow is impossible. The cost of a long cable is bandwidth, not loss: if the buffer
          ({kb(s.buf)}) is smaller than the bytes in flight per RTT ({kb(inflight)}), the sender waits for credits even with an idle receiver.
          {ibFullRate ? ' Here the buffer covers the RTT.' : ' Here it does not, so even at 100% drain the IB link cannot run at line rate.'}</p>
        <p><span className="font-semibold text-fg">PFC</span>: the sender transmits freely until a PAUSE reaches it. Everything already on the wire, plus what is sent
          while the PAUSE travels back and the sender reacts, lands above XOFF. That headroom must be reserved per lossless priority, per port, which is why long
          lossless Ethernet links are expensive in switch buffer.</p>
      </div>
      <p className="text-[11px] text-muted">
        Fluid model of one priority/VL at 400 Gb/s; ~5 ns/m propagation in fibre or copper. Real credit updates (FCCL) are sent periodically, not every few ns,
        and PFC uses pause quanta with refresh rather than a pure XOFF/XON pair. The 300 ns response time and the 64 KB XOFF threshold are illustrative;
        vendor headroom calculators include MTU, PHY/FEC latency and cable type.
      </p>
    </div>
  );
}
