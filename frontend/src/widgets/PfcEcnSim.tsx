import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui';

/* Model constants (1 step = 1 µs) */
const LINE = 400; // Gb/s, both sender NICs and the egress port
const BPUS = (LINE * 1e9) / 8 / 1e6; // bytes per µs at line rate = 50 000
const PKT = 4096 + 78; // RoCE MTU payload + headers (approx.)
const STEPS = 1500;
const PFC_DELAY = 1; // µs between crossing XOFF and senders actually stopping (cable RTT + response)
const CNP_DELAY = 3; // µs receiver → sender feedback
const CNP_GAP = 50; // µs minimum between CNPs per flow (NIC default class)
const ALPHA_T = 55; // µs alpha decay timer
const INC_T = 55; // µs rate-increase timer
const G = 1 / 256;
const R_AI = 4; // Gb/s additive increase
const F_FAST = 5; // fast-recovery stages
const R_MIN = 1;
const PAUSE_REFRESH = 10; // µs between repeated XOFF frames while paused

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Params { k: number; kmin: number; kmax: number; pmax: number; xoff: number; xon: number; head: number; pfc: boolean; ecn: boolean }
interface Sample { q: number; p: number; paused: boolean; rate: number; r0: number; drop: number }
interface Counters { marked: number; cnps: number; pauses: number; drops: number; sent: number }

function markProb(qKB: number, P: Params) {
  if (!P.ecn || qKB <= P.kmin) return 0;
  if (qKB >= P.kmax) return 1;
  return (P.pmax / 100) * ((qKB - P.kmin) / (P.kmax - P.kmin));
}

const SUB = 10; // sub-steps per µs (0.1 µs resolution inside the model)

function simulate(P: Params): { s: Sample[]; c: Counters[] } {
  const rnd = mulberry32(0x5eed + P.k * 977);
  const limit = (P.xoff + (P.pfc ? P.head * P.k : P.head)) * 1024; // bytes
  const rc = Array(P.k).fill(LINE), rt = Array(P.k).fill(LINE), alpha = Array(P.k).fill(1);
  const lastCnp = Array(P.k).fill(-1e9), sinceCnp = Array(P.k).fill(0), incStage = Array(P.k).fill(0), sinceInc = Array(P.k).fill(0);
  const pktAcc = Array(P.k).fill(0);
  const pendingCnp: { t: number; f: number }[] = [];
  let q = 0, pauseReq = false, pausedAt = -1e9, lastPauseFrame = -1e9;
  const c: Counters = { marked: 0, cnps: 0, pauses: 0, drops: 0, sent: 0 };
  const s: Sample[] = [], cs: Counters[] = [];
  let stepDrops = 0, stepPaused = false;
  for (let u = 0; u < STEPS * SUB; u++) {
    const t = u / SUB; // µs
    const senderStopped = pauseReq && t - pausedAt >= PFC_DELAY;
    // CNP arrivals -> DCQCN multiplicative decrease
    for (let i = pendingCnp.length - 1; i >= 0; i--) if (pendingCnp[i].t <= t) {
      const f = pendingCnp[i].f; pendingCnp.splice(i, 1);
      rt[f] = rc[f]; rc[f] = Math.max(R_MIN, rc[f] * (1 - alpha[f] / 2)); alpha[f] = (1 - G) * alpha[f] + G;
      sinceCnp[f] = 0; incStage[f] = 0; sinceInc[f] = 0;
    }
    // timers: alpha decay and rate increase
    for (let f = 0; f < P.k; f++) {
      sinceCnp[f] += 1 / SUB;
      if (sinceCnp[f] >= ALPHA_T) { alpha[f] *= 1 - G; sinceCnp[f] = 0; }
      if (rc[f] < LINE) {
        sinceInc[f] += 1 / SUB;
        if (sinceInc[f] >= INC_T) {
          sinceInc[f] = 0; incStage[f]++;
          if (incStage[f] > F_FAST) rt[f] = Math.min(LINE, rt[f] + R_AI);
          rc[f] = Math.min(LINE, (rt[f] + rc[f]) / 2);
        }
      }
    }
    // arrivals + ECN marking (per packet, at enqueue)
    const p = markProb(q / 1024, P);
    let arrived = 0, dropped = 0;
    if (!senderStopped) for (let f = 0; f < P.k; f++) {
      pktAcc[f] += (rc[f] * 1e9) / 8 / 1e6 / SUB / PKT;
      while (pktAcc[f] >= 1) {
        pktAcc[f] -= 1;
        if (q + arrived + PKT > limit) { dropped++; continue; }
        arrived += PKT;
        if (p > 0 && rnd() < p) {
          c.marked++;
          if (t - lastCnp[f] >= CNP_GAP) { lastCnp[f] = t; c.cnps++; pendingCnp.push({ t: t + CNP_DELAY, f }); }
        }
      }
    }
    c.drops += dropped; stepDrops += dropped;
    q += arrived;
    const out = Math.min(q, BPUS / SUB);
    q -= out; c.sent += out;
    // PFC: switch compares queue to XOFF/XON; senders stop PFC_DELAY later
    if (P.pfc) {
      if (!pauseReq && q > P.xoff * 1024) { pauseReq = true; pausedAt = t; }
      else if (pauseReq && q < P.xon * 1024) { pauseReq = false; lastPauseFrame = -1e9; }
      if (pauseReq && t - lastPauseFrame >= PAUSE_REFRESH) { c.pauses += P.k; lastPauseFrame = t; }
    }
    stepPaused = stepPaused || pauseReq;
    if ((u + 1) % SUB === 0) {
      s.push({ q: q / 1024, p, paused: stepPaused, rate: rc.reduce((a2, b2) => a2 + b2, 0), r0: rc[0], drop: stepDrops });
      cs.push({ ...c });
      stepDrops = 0; stepPaused = false;
    }
  }
  return { s, c: cs };
}

function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="block text-xs">
      <div className="flex justify-between gap-2"><span className="text-muted">{label}</span><span className="font-mono">{value} {unit}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className="w-full accent-[var(--accent)]" />
    </label>
  );
}

export default function PfcEcnSim() {
  const [k, setK] = useState(8);
  const [kmin, setKmin] = useState(100);
  const [kmax, setKmax] = useState(400);
  const [pmax, setPmax] = useState(20);
  const [xoff, setXoff] = useState(600);
  const [xon, setXon] = useState(450);
  const [head, setHead] = useState(64);
  const [pfc, setPfc] = useState(true);
  const [ecn, setEcn] = useState(true);
  const [t, setT] = useState(STEPS);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);

  const P = useMemo<Params>(() => ({ k, kmin, kmax: Math.max(kmax, kmin + 10), pmax, xoff, xon: Math.min(xon, xoff - 10), head, pfc, ecn }), [k, kmin, kmax, pmax, xoff, xon, head, pfc, ecn]);
  const sim = useMemo(() => simulate(P), [P]);

  useEffect(() => {
    if (!playing) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setT(STEPS); setPlaying(false); return; }
    let last = performance.now();
    const tick = (now: number) => {
      const adv = Math.max(1, Math.round((now - last) / 4)); last = now;
      setT((x) => { const n = Math.min(STEPS, x + adv); if (n >= STEPS) setPlaying(false); return n; });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const shown = sim.s.slice(0, t);
  const c = sim.c[Math.max(0, t - 1)];
  const cur = sim.s[Math.max(0, t - 1)];
  const limitKB = xoff + (pfc ? head * k : head);
  const thr = t > 0 ? (c.sent / (t * BPUS)) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button className="!px-3 !py-1 text-xs" onClick={() => { if (t >= STEPS) setT(0); setPlaying((p) => !p); }}>{playing ? 'Pause' : 'Play'}</Button>
        <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => { setPlaying(false); setT(0); }}>Reset</Button>
        <span className="font-mono text-xs text-muted">t = {t} µs / {STEPS} µs</span>
        <div className="ml-auto flex flex-wrap gap-4 text-xs">
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={pfc} onChange={(e) => setPfc(e.target.checked)} className="accent-[var(--accent)]" />PFC</label>
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={ecn} onChange={(e) => setEcn(e.target.checked)} className="accent-[var(--accent)]" />ECN / DCQCN</label>
        </div>
      </div>

      <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <Slider label="Incast degree K" value={k} min={2} max={16} unit="× 400G" onChange={setK} />
        <Slider label="ECN Kmin" value={kmin} min={20} max={1000} step={10} unit="KB" onChange={setKmin} />
        <Slider label="ECN Kmax" value={kmax} min={50} max={2000} step={10} unit="KB" onChange={setKmax} />
        <Slider label="ECN Pmax" value={pmax} min={1} max={100} unit="%" onChange={setPmax} />
        <Slider label="PFC XOFF" value={xoff} min={100} max={3000} step={10} unit="KB" onChange={setXoff} />
        <Slider label="PFC XON" value={xon} min={50} max={2900} step={10} unit="KB" onChange={setXon} />
        <Slider label="Headroom per ingress port" value={head} min={0} max={256} step={4} unit="KB" onChange={setHead} />
        <div className="text-xs text-muted">Buffer before drop: <span className="font-mono text-fg">{limitKB} KB</span><br />{pfc ? `XOFF + ${k} × headroom` : 'XOFF + headroom (no pause)'}</div>
      </div>

      <QueueChart s={shown} P={P} limitKB={limitKB} />
      <RateChart s={shown} k={k} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['ECN-marked pkts', c.marked, 'text-data'], ['CNPs', c.cnps, 'text-data'], ['Pause frames', c.pauses, 'text-warn'],
          ['Drops', c.drops, c.drops ? 'text-danger' : ''], ['Avg egress util.', `${thr.toFixed(1)} %`, 'text-accent'], ['Mark prob. now', `${((cur?.p ?? 0) * 100).toFixed(1)} %`, ''],
        ].map(([l, v, cls]) => (
          <div key={l as string} className="rounded-lg border border-line bg-panel-2 p-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">{l}</div>
            <div className={`text-lg font-bold tabular-nums ${cls}`}>{v}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        {K_TEXT(k)} Pause frames are counted per ingress port (XOFF refreshed every {PAUSE_REFRESH} µs). Senders stop {PFC_DELAY} µs after XOFF, so every port needs headroom ≥ 400 Gb/s × that delay ≈ {(BPUS * PFC_DELAY / 1024).toFixed(0)} KB plus a maximum frame: set headroom below that and lossless Ethernet drops, which RoCE punishes with go-back-N. With ECN off, PFC alone keeps it lossless but the queue sits at XOFF and pauses spread upstream. Simplified DCQCN model after Zhu et al., SIGCOMM 2015 (g = 1/256, CNP every ≥ {CNP_GAP} µs per flow, {INC_T} µs increase timer, {F_FAST} fast-recovery steps then +{R_AI} Gb/s additive increase); one flow per sender, deterministic seeded marking.
      </p>
    </div>
  );
}

const K_TEXT = (k: number) => `${k} senders × 400 Gb/s offer ${k}× the egress rate; the fair share is ${(LINE / k).toFixed(1)} Gb/s each.`;

const W = 860, PADL = 44, PADR = 8, PADT = 8, PADB = 22;
const X = (i: number) => PADL + (i / STEPS) * (W - PADL - PADR);
function linePath(s: Sample[], f: (d: Sample) => number, Y: (v: number) => number) {
  let out = '';
  for (let i = 0; i < s.length; i += 2) out += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(f(s[i])).toFixed(1)}`;
  return out;
}

function QueueChart({ s, P, limitKB }: { s: Sample[]; P: Params; limitKB: number }) {
  const H = 190;
  const ymax = Math.max(limitKB * 1.08, P.kmax * 1.1);
  const Y = (v: number) => PADT + (1 - v / ymax) * (H - PADT - PADB);
  const bands: [number, number][] = [];
  let st = -1;
  s.forEach((d, i) => { if (d.paused && st < 0) st = i; if (!d.paused && st >= 0) { bands.push([st, i]); st = -1; } });
  if (st >= 0) bands.push([st, s.length]);
  const path = linePath(s, (d) => d.q, Y);
  const hl = (v: number, label: string, color: string, dash = '4 3') => (
    <g key={label}><line x1={PADL} x2={W - PADR} y1={Y(v)} y2={Y(v)} stroke={color} strokeDasharray={dash} strokeWidth={1} />
      <text x={W - PADR - 2} y={Y(v) - 2} textAnchor="end" fontSize={9} fill={color} fontFamily="var(--font-mono)">{label}</text></g>
  );
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-x-4 font-mono text-[10px] text-muted"><span>egress queue depth (KB)</span><span className="text-warn">■ PFC pause asserted</span><span className="text-danger">| drops</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Queue depth over time">
        {bands.map(([a, b]) => <rect key={a} x={X(a)} y={PADT} width={Math.max(0.8, X(b) - X(a))} height={H - PADT - PADB} fill="var(--warn)" opacity={0.15} />)}
        <line x1={PADL} x2={PADL} y1={PADT} y2={H - PADB} stroke="var(--border)" />
        <line x1={PADL} x2={W - PADR} y1={H - PADB} y2={H - PADB} stroke="var(--border)" />
        {[0, 0.5, 1].map((f) => <text key={f} x={PADL - 4} y={Y(ymax * f * 0.92) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{Math.round(ymax * f * 0.92)}</text>)}
        {[0, 500, 1000, 1500].map((v) => <text key={v} x={X(v)} y={H - 8} textAnchor="middle" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{v} µs</text>)}
        {P.ecn && hl(P.kmin, 'Kmin', 'var(--data)')}
        {P.ecn && hl(P.kmax, 'Kmax', 'var(--data)')}
        {P.pfc && hl(P.xoff, 'XOFF', 'var(--warn)')}
        {P.pfc && hl(P.xon, 'XON', 'var(--warn)', '1 3')}
        {hl(limitKB, 'buffer limit', 'var(--danger)', '6 2')}
        {s.map((d, i) => d.drop > 0 ? <line key={`d${i}`} x1={X(i)} x2={X(i)} y1={H - PADB} y2={H - PADB - 8} stroke="var(--danger)" strokeWidth={1.2} /> : null)}
        <path d={path} fill="none" stroke="var(--text)" strokeWidth={1.6} />
      </svg>
    </div>
  );
}

function RateChart({ s, k }: { s: Sample[]; k: number }) {
  const H = 130;
  const ymax = LINE * k;
  const Y = (v: number) => PADT + (1 - v / ymax) * (H - PADT - PADB);
  const mk = (f: (d: Sample) => number) => linePath(s, f, Y);
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-x-4 font-mono text-[10px] text-muted"><span className="text-accent">— aggregate sender rate (Gb/s)</span><span className="text-data">— sender 0</span><span>- - egress capacity 400 Gb/s</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sender rates over time">
        <line x1={PADL} x2={PADL} y1={PADT} y2={H - PADB} stroke="var(--border)" />
        <line x1={PADL} x2={W - PADR} y1={H - PADB} y2={H - PADB} stroke="var(--border)" />
        <line x1={PADL} x2={W - PADR} y1={Y(LINE)} y2={Y(LINE)} stroke="var(--muted)" strokeDasharray="4 3" />
        {[0, ymax / 2, ymax].map((v) => <text key={v} x={PADL - 4} y={Y(v) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--font-mono)">{v}</text>)}
        <path d={mk((d) => d.rate)} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
        <path d={mk((d) => d.r0)} fill="none" stroke="var(--data)" strokeWidth={1.4} />
      </svg>
    </div>
  );
}
