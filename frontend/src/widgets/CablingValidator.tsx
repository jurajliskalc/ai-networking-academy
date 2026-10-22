import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '../components/ui';

// ---------- Pure model (unit-testable) ----------
//
// A small rail-optimized pod, as in lessons rail-optimized-topology, fabric-validation-burn-in and
// network-automation-for-ai: node n's NIC k (rail k) connects to leaf-r<k> port swp<n>; every leaf has
// one uplink to each spine (leaf-r<k> swp31 -> spine-1 swp<k+1>, swp32 -> spine-2 swp<k+1>).
// The source of truth (SoT) is that plan; the validator compares it with LLDP neighbors (IEEE 802.1AB:
// each port advertises Chassis ID, Port ID and optionally System Name), collected from the leaves,
// and classifies every difference. Port names and the neighbor table layout are illustrative.

export const NODES = 4;
export const RAILS = 4;
export const SPINES = 2;
export const HOST_PORTS = NODES;              // swp1..swp4
export const SPARE_PORTS = [5, 6, 7, 8];      // unplanned ports on every leaf
export const UPLINK_PORT = (s: number) => 31 + s; // spine s (0-based) on swp31, swp32

export interface End { dev: string; port: string }
export type Table = Record<string, End>; // key "leaf-r0:swp1" -> neighbor

export const leafName = (k: number) => `leaf-r${k}`;
export const nodeName = (n: number) => `node-${String(n + 1).padStart(2, '0')}`;
export const spineName = (s: number) => `spine-${s + 1}`;
export const key = (dev: string, port: string) => `${dev}:${port}`;
const endStr = (e: End | null | undefined) => (e ? `${e.dev}:${e.port}` : '(no neighbor)');
const sameEnd = (a?: End | null, b?: End | null) => !!a && !!b && a.dev === b.dev && a.port === b.port;

/** Rail of a host NIC end ("node-02", "nic3" -> 3), or null for anything else. */
export function hostRail(e: End): number | null {
  const m = /^nic(\d+)$/.exec(e.port);
  return e.dev.startsWith('node-') && m ? Number(m[1]) : null;
}
export function leafRail(dev: string): number | null {
  const m = /^leaf-r(\d+)$/.exec(dev);
  return m ? Number(m[1]) : null;
}

/** Physical state of the pod. */
export interface Physical {
  host: ({ leaf: number; port: number } | null)[][]; // [node][nic]
  nicUp: boolean[][];
  uplink: boolean[][]; // [leaf][spine]
  stray: { leaf: number; port: number; end: End }[];
}

export function cleanPhysical(): Physical {
  return {
    host: Array.from({ length: NODES }, (_, n) => Array.from({ length: RAILS }, (_, k) => ({ leaf: k, port: n + 1 }))),
    nicUp: Array.from({ length: NODES }, () => Array(RAILS).fill(true)),
    uplink: Array.from({ length: RAILS }, () => Array(SPINES).fill(true)),
    stray: [],
  };
}

/** What LLDP on the leaves reports: one neighbor per port whose link is up. */
export function lldpTable(ph: Physical): Table {
  const t: Table = {};
  ph.host.forEach((nics, n) => nics.forEach((c, k) => {
    if (c && ph.nicUp[n][k]) t[key(leafName(c.leaf), `swp${c.port}`)] = { dev: nodeName(n), port: `nic${k}` };
  }));
  ph.uplink.forEach((sp, l) => sp.forEach((up, s) => {
    if (up) t[key(leafName(l), `swp${UPLINK_PORT(s)}`)] = { dev: spineName(s), port: `swp${l + 1}` };
  }));
  for (const s of ph.stray) t[key(leafName(s.leaf), `swp${s.port}`)] = s.end;
  return t;
}

/** The SoT: the expected neighbor of every planned leaf port. */
export const planTable = (): Table => lldpTable(cleanPhysical());

export type Fault =
  | { kind: 'rail-swap'; node: number; a: number; b: number }
  | { kind: 'pair-swap'; rail: number; a: number; b: number }
  | { kind: 'wrong-leaf'; node: number; nic: number; leaf: number }
  | { kind: 'wrong-port'; node: number; nic: number }
  | { kind: 'missing'; node: number; nic: number }
  | { kind: 'nic-down'; node: number; nic: number }
  | { kind: 'missing-uplink'; leaf: number; spine: number }
  | { kind: 'stray'; leaf: number };

export type FaultKind = Fault['kind'];

/** Cable ends a fault touches; two faults may not touch the same one. */
export function faultTouches(f: Fault): string[] {
  switch (f.kind) {
    case 'rail-swap': return [`h${f.node}.${f.a}`, `h${f.node}.${f.b}`];
    case 'pair-swap': return [`h${f.a}.${f.rail}`, `h${f.b}.${f.rail}`];
    case 'wrong-leaf': case 'wrong-port': case 'missing': case 'nic-down': return [`h${f.node}.${f.nic}`];
    case 'missing-uplink': return [`u${f.leaf}.${f.spine}`];
    case 'stray': return [];
  }
}

function freeSpare(ph: Physical, leaf: number): number | null {
  const used = new Set<number>();
  ph.host.forEach((nics) => nics.forEach((c) => { if (c && c.leaf === leaf) used.add(c.port); }));
  ph.stray.forEach((s) => { if (s.leaf === leaf) used.add(s.port); });
  return SPARE_PORTS.find((p) => !used.has(p)) ?? null;
}

/** Validate a fault on its own (a swap needs two different ends; a wrong leaf must be another rail's leaf). */
export function faultValid(f: Fault): boolean {
  if (f.kind === 'rail-swap' || f.kind === 'pair-swap') return f.a !== f.b;
  if (f.kind === 'wrong-leaf') return f.leaf !== f.nic;
  return true;
}

/** Apply faults in order; returns the physical state and any fault that could not be applied. */
export function applyFaults(faults: Fault[]): { ph: Physical; rejected: number[] } {
  const ph = cleanPhysical();
  const touched = new Set<string>();
  const rejected: number[] = [];
  faults.forEach((f, i) => {
    const t = faultTouches(f);
    if (!faultValid(f) || t.some((x) => touched.has(x))) { rejected.push(i); return; }
    switch (f.kind) {
      case 'rail-swap': { const h = ph.host[f.node]; [h[f.a], h[f.b]] = [h[f.b], h[f.a]]; break; }
      case 'pair-swap': { const x = ph.host[f.a][f.rail]; ph.host[f.a][f.rail] = ph.host[f.b][f.rail]; ph.host[f.b][f.rail] = x; break; }
      case 'wrong-leaf': case 'wrong-port': {
        const leaf = f.kind === 'wrong-leaf' ? f.leaf : f.nic;
        const port = freeSpare(ph, leaf);
        if (port === null) { rejected.push(i); return; }
        ph.host[f.node][f.nic] = { leaf, port }; break;
      }
      case 'missing': ph.host[f.node][f.nic] = null; break;
      case 'nic-down': ph.nicUp[f.node][f.nic] = false; break;
      case 'missing-uplink': ph.uplink[f.leaf][f.spine] = false; break;
      case 'stray': {
        const port = freeSpare(ph, f.leaf);
        if (port === null) { rejected.push(i); return; }
        ph.stray.push({ leaf: f.leaf, port, end: { dev: 'unknown-host', port: 'eth0' } }); break;
      }
    }
    t.forEach((x) => touched.add(x));
  });
  return { ph, rejected };
}

export type FindingClass = 'missing' | 'rail-crossing' | 'port-mismatch' | 'unexpected';
export interface Finding { port: string; cls: FindingClass; expected: End | null; observed: End | null; hint: string }

/** Diff the plan against observed LLDP neighbors and classify each difference. */
export function validate(plan: Table, observed: Table): Finding[] {
  const where: Record<string, string> = {};
  for (const [p, e] of Object.entries(plan)) where[key(e.dev, e.port)] = p;
  const ports = [...new Set([...Object.keys(plan), ...Object.keys(observed)])].sort(portOrder);
  const out: Finding[] = [];
  for (const p of ports) {
    const exp = plan[p] ?? null, obs = observed[p] ?? null;
    if (sameEnd(exp, obs)) continue;
    if (exp && !obs) {
      out.push({ port: p, cls: 'missing', expected: exp, observed: null, hint: 'no LLDP neighbor: link down (cable, optic or far-end port; LLDP alone cannot tell which) or, if the port is up, no LLDP agent running at the far end' });
      continue;
    }
    const o = obs!;
    const dev = p.split(':')[0];
    const lr = leafRail(dev), hr = hostRail(o);
    const plannedAt = where[key(o.dev, o.port)];
    if (hr !== null && lr !== null && hr !== lr) {
      out.push({ port: p, cls: 'rail-crossing', expected: exp, observed: o, hint: `rail-${hr} NIC on the rail-${lr} leaf${plannedAt ? `; planned at ${plannedAt}` : ''}` });
    } else if (plannedAt && plannedAt.split(':')[0] === dev) {
      out.push({ port: p, cls: 'port-mismatch', expected: exp, observed: o, hint: `right leaf, wrong port: planned at ${plannedAt}` });
    } else {
      out.push({ port: p, cls: 'unexpected', expected: exp, observed: o, hint: plannedAt ? `neighbor is planned at ${plannedAt}` : 'neighbor is not in the source of truth' });
    }
  }
  return out;
}

function portOrder(a: string, b: string) {
  const pa = /^(.*):swp(\d+)$/.exec(a), pb = /^(.*):swp(\d+)$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  return pa[1].localeCompare(pb[1]) || Number(pa[2]) - Number(pb[2]);
}

export interface Summary { planned: number; ok: number; counts: Record<FindingClass, number>; pass: boolean }
export function summarize(plan: Table, observed: Table, findings: Finding[]): Summary {
  const counts: Record<FindingClass, number> = { missing: 0, 'rail-crossing': 0, 'port-mismatch': 0, unexpected: 0 };
  findings.forEach((f) => counts[f.cls]++);
  const ok = Object.entries(plan).filter(([p, e]) => sameEnd(e, observed[p])).length;
  return { planned: Object.keys(plan).length, ok, counts, pass: findings.length === 0 };
}

export const CLASS_LABEL: Record<FindingClass, string> = {
  missing: 'MISSING', 'rail-crossing': 'RAIL-CROSSING', 'port-mismatch': 'PORT-MISMATCH', unexpected: 'UNEXPECTED',
};

export const FAULT_INFO: Record<FaultKind, { label: string; expect: string; symptom: string }> = {
  'rail-swap': {
    label: 'Two NICs of one node swapped (rail swap)',
    expect: '2 × rail crossing',
    symptom: 'Both links are up, so "link up" checks pass. If NICs are addressed per port (/31s) or per rail subnet, the addresses no longer match the leaf ports and RDMA on these two NICs fails (NCCL connection errors or timeouts). If traffic still forwards, a GPU\'s same-rail traffic now enters another rail\'s leaf and crosses the spines: extra hops and spine load, and NCCL\'s rail-aligned (GPU-NIC affinity) assumptions no longer hold, so busbw drops and varies.',
  },
  'pair-swap': {
    label: 'Two nodes\' cables swapped on one leaf',
    expect: '2 × port mismatch',
    symptom: 'The swapped pair stays in the right rail and may still forward if both nodes sit in one shared rail subnet, but per-port configuration (/31 addresses, port descriptions) now belongs to the wrong node, and telemetry joins (port to node) are wrong: you will chase counters on the wrong server.',
  },
  'wrong-leaf': {
    label: 'Cable to the wrong leaf',
    expect: '1 × missing + 1 × rail crossing',
    symptom: 'The planned port is dark and the NIC landed on another rail\'s leaf, on a port the plan does not use (probably unconfigured). Rail alignment is broken for that GPU: it typically shows up later as poor all-reduce bandwidth, or that NIC has no working path at all.',
  },
  'wrong-port': {
    label: 'Right leaf, wrong port',
    expect: '1 × missing + 1 × port mismatch',
    symptom: 'The rail is right, but the cable sits on a spare port that has none of the planned configuration (address, MTU, QoS may be defaults or the port admin-down). Expect the NIC to be unreachable or misconfigured until it is moved.',
  },
  missing: {
    label: 'Missing cable',
    expect: '1 × missing',
    symptom: 'That GPU\'s NIC has no link. NCCL typically uses only active ports, so the GPU\'s traffic goes through another NIC (over PCIe, or NVLink with PXN) at lower bandwidth and the node becomes the slow rank; some setups fail at connection setup instead.',
  },
  'nic-down': {
    label: 'NIC down on the host',
    expect: '1 × missing',
    symptom: 'From the leaf it looks exactly like a missing cable: port down, no neighbor. Check the host side (ip link, ethtool <netdev>, ibv_devinfo port state) and the optic before sending someone to recable. Job impact as for a missing cable.',
  },
  'missing-uplink': {
    label: 'Missing leaf-to-spine uplink',
    expect: '1 × missing',
    symptom: 'Same-rail traffic is unaffected, so per-rail and intra-leaf tests pass. Traffic that crosses the spines from this leaf has half the uplinks (1 of 2 here), so ECMP squeezes it onto the rest: it shows up in bisection and cross-rail tests, and as a slower all-to-all wherever cross-rail traffic is not first moved onto the right rail over NVLink (PXN).',
  },
  stray: {
    label: 'Unplanned device on a spare port',
    expect: '1 × unexpected neighbor',
    symptom: 'Something not in the source of truth is patched into the compute fabric (a test host, a leftover burn-in cable). No job symptom yet, but acceptance requires zero unplanned links: an unknown endpoint on an RDMA fabric is an operational and security problem. Remove it or add it to the SoT.',
  },
};

export const PRESETS: { id: string; label: string; faults: Fault[] }[] = [
  { id: 'clean', label: 'Clean build', faults: [] },
  { id: 'lesson', label: 'The lesson\'s report', faults: [{ kind: 'pair-swap', rail: 3, a: 0, b: 1 }, { kind: 'rail-swap', node: 2, a: 2, b: 3 }, { kind: 'missing', node: 3, nic: 3 }] },
  { id: 'mixed', label: 'A bad day', faults: [{ kind: 'wrong-leaf', node: 1, nic: 0, leaf: 2 }, { kind: 'nic-down', node: 3, nic: 1 }, { kind: 'missing-uplink', leaf: 2, spine: 1 }, { kind: 'stray', leaf: 3 }] },
];

export function describeFault(f: Fault): string {
  switch (f.kind) {
    case 'rail-swap': return `${nodeName(f.node)} nic${f.a} ↔ nic${f.b}`;
    case 'pair-swap': return `rail ${f.rail}: ${nodeName(f.a)} ↔ ${nodeName(f.b)}`;
    case 'wrong-leaf': return `${nodeName(f.node)} nic${f.nic} → ${leafName(f.leaf)}`;
    case 'wrong-port': return `${nodeName(f.node)} nic${f.nic} → spare port`;
    case 'missing': return `${nodeName(f.node)} nic${f.nic} unplugged`;
    case 'nic-down': return `${nodeName(f.node)} nic${f.nic} down`;
    case 'missing-uplink': return `${leafName(f.leaf)} → ${spineName(f.spine)}`;
    case 'stray': return `stray host on ${leafName(f.leaf)}`;
  }
}

/** The text report an automated check might print (format illustrative, as in network-automation-for-ai). */
export function report(s: Summary, findings: Finding[]): string {
  const lines = [`CHECK lldp-vs-sot  leaves=${RAILS}  planned-ports=${s.planned}`, `  OK             ${s.ok}`];
  (Object.keys(CLASS_LABEL) as FindingClass[]).forEach((c) => {
    const fs = findings.filter((f) => f.cls === c);
    if (!fs.length) return;
    lines.push(`  ${CLASS_LABEL[c].padEnd(14)} ${fs.length}`);
    fs.forEach((f) => lines.push(`    ${f.port.replace(':', ' ').padEnd(16)} expected ${endStr(f.expected).padEnd(16)} observed ${endStr(f.observed)}`));
  });
  lines.push(`RESULT ${s.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

// ---------- UI ----------

const cap = 'font-mono text-[10px] uppercase tracking-[0.14em] text-muted';
const btn = (on: boolean) => `min-h-6 rounded-md border px-2 py-1 font-mono text-xs transition ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;
const sel = 'min-h-6 rounded-md border border-line bg-panel px-1.5 py-0.5 font-mono text-xs text-fg';
const CLS_TONE: Record<FindingClass, string> = { missing: 'text-danger', 'rail-crossing': 'text-warn', 'port-mismatch': 'text-data', unexpected: 'text-danger' };

function Out({ label, value, sub, tone = 'text-fg' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function Topology({ ph, findings }: { ph: Physical; findings: Finding[] }) {
  const W = 640, H = 290;
  const spineX = (s: number) => 200 + s * 240, spineY = 28;
  const leafX = (l: number) => 80 + l * 160, leafY = 120, leafW = 136;
  const portX = (l: number, port: number) => {
    if (port >= 31) return leafX(l) + (port === 31 ? -20 : 20);
    return leafX(l) - leafW / 2 + 10 + (port - 1) * ((leafW - 20) / 7);
  };
  const nodeX = (n: number) => 80 + n * 160, nodeY = 250;
  const nicX = (n: number, k: number) => nodeX(n) - 45 + k * 30;
  const bad = new Set(findings.map((f) => f.port));
  const plan = cleanPhysical();
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
      aria-label={`Rail-optimized pod: ${NODES} nodes with ${RAILS} NICs each, ${RAILS} rail leaves, ${SPINES} spines. ${findings.length ? `${findings.length} cabling findings: ${findings.map((f) => `${f.port} ${CLASS_LABEL[f.cls].toLowerCase()}`).join(', ')}.` : 'All links match the plan.'}`}>
      {/* uplinks */}
      {ph.uplink.map((sp, l) => sp.map((up, s) => {
        const x1 = portX(l, UPLINK_PORT(s)), x2 = spineX(s) - 30 + l * 20;
        return up
          ? <line key={`u${l}${s}`} x1={x1} y1={leafY - 14} x2={x2} y2={spineY + 12} stroke="var(--muted)" strokeWidth={1} />
          : <g key={`u${l}${s}`}><line x1={x1} y1={leafY - 14} x2={x2} y2={spineY + 12} stroke="var(--danger)" strokeWidth={1.5} strokeDasharray="4 4" />
            <text x={(x1 + x2) / 2} y={(leafY + spineY) / 2} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--danger)">×</text></g>;
      }))}
      {/* planned host links that are now missing */}
      {plan.host.map((nics, n) => nics.map((c, k) => {
        const p = c!;
        const k2 = key(leafName(p.leaf), `swp${p.port}`);
        const f = findings.find((x) => x.port === k2 && x.cls === 'missing');
        if (!f) return null;
        const x1 = nicX(n, k), x2 = portX(p.leaf, p.port);
        return <g key={`m${n}${k}`}><line x1={x1} y1={nodeY - 12} x2={x2} y2={leafY + 14} stroke="var(--danger)" strokeWidth={1.5} strokeDasharray="4 4" opacity={0.8} />
          <text x={x1 + (x2 - x1) * 0.35} y={nodeY - 12 + (leafY + 14 - nodeY + 12) * 0.35 + 4} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--danger)">×</text></g>;
      }))}
      {/* actual host links */}
      {ph.host.map((nics, n) => nics.map((c, k) => {
        if (!c || !ph.nicUp[n][k]) return null;
        const k2 = key(leafName(c.leaf), `swp${c.port}`);
        const f = findings.find((x) => x.port === k2);
        const stroke = !bad.has(k2) ? 'var(--muted)' : f?.cls === 'rail-crossing' ? 'var(--warn)' : f?.cls === 'port-mismatch' ? 'var(--data)' : 'var(--danger)';
        return <line key={`h${n}${k}`} x1={nicX(n, k)} y1={nodeY - 12} x2={portX(c.leaf, c.port)} y2={leafY + 14} stroke={stroke} strokeWidth={bad.has(k2) ? 2.2 : 1} />;
      }))}
      {ph.stray.map((s) => (
        <g key={`s${s.leaf}${s.port}`}>
          <line x1={portX(s.leaf, s.port)} y1={leafY + 14} x2={portX(s.leaf, s.port) + 10} y2={leafY + 52} stroke="var(--danger)" strokeWidth={2} />
          <rect x={portX(s.leaf, s.port) - 8} y={leafY + 52} width={40} height={16} rx={3} fill="var(--panel)" stroke="var(--danger)" />
          <text x={portX(s.leaf, s.port) + 12} y={leafY + 64} textAnchor="middle" fontSize={9} fill="var(--danger)" fontFamily="var(--font-mono)">???</text>
        </g>
      ))}
      {Array.from({ length: SPINES }, (_, s) => (
        <g key={`sp${s}`}>
          <rect x={spineX(s) - 50} y={spineY - 14} width={100} height={26} rx={6} fill="var(--panel-2)" stroke="var(--border)" strokeWidth={1.5} />
          <text x={spineX(s)} y={spineY + 4} textAnchor="middle" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">{spineName(s)}</text>
        </g>
      ))}
      {Array.from({ length: RAILS }, (_, l) => (
        <g key={`l${l}`}>
          <rect x={leafX(l) - leafW / 2} y={leafY - 14} width={leafW} height={28} rx={6} fill="var(--panel-2)" stroke={findings.some((f) => f.port.startsWith(`${leafName(l)}:`)) ? 'var(--danger)' : 'var(--border)'} strokeWidth={1.5} />
          <text x={leafX(l)} y={leafY + 4} textAnchor="middle" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">{leafName(l)} (rail {l})</text>
        </g>
      ))}
      {Array.from({ length: NODES }, (_, n) => (
        <g key={`n${n}`}>
          <rect x={nodeX(n) - 62} y={nodeY - 14} width={124} height={34} rx={6} fill="var(--panel)" stroke="var(--border)" />
          <text x={nodeX(n)} y={nodeY + 32} textAnchor="middle" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">{nodeName(n)}</text>
          {Array.from({ length: RAILS }, (_, k) => (
            <g key={k}>
              <rect x={nicX(n, k) - 12} y={nodeY - 10} width={24} height={16} rx={3} fill={ph.nicUp[n][k] ? 'var(--panel-2)' : 'var(--panel)'} stroke={ph.nicUp[n][k] ? 'var(--muted)' : 'var(--danger)'} strokeDasharray={ph.nicUp[n][k] ? '' : '2 2'} />
              <text x={nicX(n, k)} y={nodeY + 2} textAnchor="middle" fontSize={9} fill={ph.nicUp[n][k] ? 'var(--muted)' : 'var(--danger)'} fontFamily="var(--font-mono)">{ph.nicUp[n][k] ? `n${k}` : '×'}</text>
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}

type Draft = { kind: FaultKind; node: number; nic: number; b: number; leaf: number; spine: number };

function draftToFault(d: Draft): Fault {
  switch (d.kind) {
    case 'rail-swap': return { kind: 'rail-swap', node: d.node, a: d.nic, b: d.b };
    case 'pair-swap': return { kind: 'pair-swap', rail: d.nic, a: d.node, b: d.b };
    case 'wrong-leaf': return { kind: 'wrong-leaf', node: d.node, nic: d.nic, leaf: d.leaf };
    case 'wrong-port': return { kind: 'wrong-port', node: d.node, nic: d.nic };
    case 'missing': return { kind: 'missing', node: d.node, nic: d.nic };
    case 'nic-down': return { kind: 'nic-down', node: d.node, nic: d.nic };
    case 'missing-uplink': return { kind: 'missing-uplink', leaf: d.leaf, spine: d.spine };
    case 'stray': return { kind: 'stray', leaf: d.leaf };
  }
}

export default function CablingValidator() {
  const [faults, setFaults] = useState<Fault[]>(PRESETS[1].faults);
  const [preset, setPreset] = useState<string>('lesson');
  const [d, setD] = useState<Draft>({ kind: 'rail-swap', node: 0, nic: 0, b: 1, leaf: 1, spine: 0 });
  const [msg, setMsg] = useState('');
  const [showLldp, setShowLldp] = useState(false);

  const plan = useMemo(planTable, []);
  const { ph } = useMemo(() => applyFaults(faults), [faults]);
  const observed = useMemo(() => lldpTable(ph), [ph]);
  const findings = useMemo(() => validate(plan, observed), [plan, observed]);
  const s = summarize(plan, observed, findings);

  const inject = () => {
    const f = draftToFault(d);
    if (!faultValid(f)) { setMsg('Pick two different ends (or another rail\'s leaf) for this fault.'); return; }
    const res = applyFaults([...faults, f]);
    if (res.rejected.includes(faults.length)) { setMsg('That cable is already part of another injected fault (or no spare port is left). Remove that fault first.'); return; }
    setFaults([...faults, f]); setPreset('custom'); setMsg(`Injected: ${describeFault(f)}.`);
  };
  const remove = (i: number) => { setFaults(faults.filter((_, j) => j !== i)); setPreset('custom'); setMsg(`Removed: ${describeFault(faults[i])}.`); };
  const upd = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const needsNode = !['missing-uplink', 'stray'].includes(d.kind);
  const kindsUsed = [...new Set(faults.map((f) => f.kind))];

  return (
    <div className="space-y-4">
      <div>
        <div className={`${cap} mb-1`}>Start from</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Preset cabling scenarios">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => { setFaults(p.faults); setPreset(p.id); setMsg(''); }} className={btn(preset === p.id)}>{p.label}</button>
          ))}
        </div>
      </div>

      <fieldset className="rounded-lg border border-line p-3">
        <legend className={`${cap} px-1`}>Inject a fault</legend>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2 text-xs">
          <label className="flex flex-col gap-1 text-muted">Fault
            <select className={sel} value={d.kind} onChange={(e) => upd({ kind: e.target.value as FaultKind })}>
              {(Object.keys(FAULT_INFO) as FaultKind[]).map((k) => <option key={k} value={k}>{FAULT_INFO[k].label}</option>)}
            </select>
          </label>
          {needsNode && (
            <label className="flex flex-col gap-1 text-muted">{d.kind === 'pair-swap' ? 'Node A' : 'Node'}
              <select className={sel} value={d.node} onChange={(e) => upd({ node: +e.target.value })}>
                {Array.from({ length: NODES }, (_, n) => <option key={n} value={n}>{nodeName(n)}</option>)}
              </select>
            </label>
          )}
          {needsNode && (
            <label className="flex flex-col gap-1 text-muted">{d.kind === 'rail-swap' ? 'NIC A' : d.kind === 'pair-swap' ? 'Rail (NIC)' : 'NIC'}
              <select className={sel} value={d.nic} onChange={(e) => upd({ nic: +e.target.value })}>
                {Array.from({ length: RAILS }, (_, k) => <option key={k} value={k}>nic{k} (rail {k})</option>)}
              </select>
            </label>
          )}
          {d.kind === 'rail-swap' && (
            <label className="flex flex-col gap-1 text-muted">NIC B
              <select className={sel} value={d.b} onChange={(e) => upd({ b: +e.target.value })}>
                {Array.from({ length: RAILS }, (_, k) => <option key={k} value={k}>nic{k} (rail {k})</option>)}
              </select>
            </label>
          )}
          {d.kind === 'pair-swap' && (
            <label className="flex flex-col gap-1 text-muted">Node B
              <select className={sel} value={d.b} onChange={(e) => upd({ b: +e.target.value })}>
                {Array.from({ length: NODES }, (_, n) => <option key={n} value={n}>{nodeName(n)}</option>)}
              </select>
            </label>
          )}
          {['wrong-leaf', 'missing-uplink', 'stray'].includes(d.kind) && (
            <label className="flex flex-col gap-1 text-muted">{d.kind === 'wrong-leaf' ? 'Lands on' : 'Leaf'}
              <select className={sel} value={d.leaf} onChange={(e) => upd({ leaf: +e.target.value })}>
                {Array.from({ length: RAILS }, (_, l) => <option key={l} value={l}>{leafName(l)}</option>)}
              </select>
            </label>
          )}
          {d.kind === 'missing-uplink' && (
            <label className="flex flex-col gap-1 text-muted">Spine
              <select className={sel} value={d.spine} onChange={(e) => upd({ spine: +e.target.value })}>
                {Array.from({ length: SPINES }, (_, sp) => <option key={sp} value={sp}>{spineName(sp)}</option>)}
              </select>
            </label>
          )}
          <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={inject}>Inject</Button>
          <Button variant="ghost" className="!px-3 !py-1 text-xs" onClick={() => { setFaults([]); setPreset('clean'); setMsg('All faults cleared.'); }} disabled={!faults.length}>Clear all</Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted">Expected finding: {FAULT_INFO[d.kind].expect}</p>
        <p className="mt-1 text-xs text-muted" role="status">{msg}</p>
        {faults.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Injected faults">
            {faults.map((f, i) => (
              <li key={i} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 py-0.5 pl-2 pr-0.5 font-mono text-[11px]">
                {describeFault(f)}
                <button type="button" onClick={() => remove(i)} aria-label={`Remove fault ${describeFault(f)}`} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-panel hover:text-fg">×</button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className={`${cap} px-1 pb-1`}>Physical cabling (amber: rail crossing, blue: port mismatch, red dashed ×: missing, red ???: unexpected)</div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Cabling diagram, scrollable">
          <div className="min-w-[560px]"><Topology ph={ph} findings={findings} /></div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <Out label="Result" value={s.pass ? 'PASS' : 'FAIL'} tone={s.pass ? 'text-accent' : 'text-danger'} sub={`${s.ok} / ${s.planned} planned ports OK`} />
        <Out label="Missing" value={s.counts.missing} tone={s.counts.missing ? 'text-danger' : 'text-fg'} sub="planned, no neighbor" />
        <Out label="Rail crossing" value={s.counts['rail-crossing']} tone={s.counts['rail-crossing'] ? 'text-warn' : 'text-fg'} sub="NIC on another rail's leaf" />
        <Out label="Port mismatch / unexpected" value={`${s.counts['port-mismatch']} / ${s.counts.unexpected}`} tone={s.counts['port-mismatch'] + s.counts.unexpected ? 'text-warn' : 'text-fg'} sub="wrong port / not in the plan" />
      </div>

      <div>
        <div className={`${cap} mb-1`}>Findings</div>
        {findings.length === 0
          ? <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-accent">Every planned port sees exactly its planned neighbor, and no unplanned port has a neighbor.</p>
          : (
            <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Cabling findings">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead className="bg-panel-2 text-muted"><tr>
                  <th scope="col" className="px-2 py-1">Leaf port</th><th scope="col" className="px-2 py-1">Class</th>
                  <th scope="col" className="px-2 py-1">Expected (SoT)</th><th scope="col" className="px-2 py-1">Observed (LLDP)</th><th scope="col" className="px-2 py-1">Hint</th>
                </tr></thead>
                <tbody>
                  {findings.map((f) => (
                    <tr key={f.port} className="border-t border-line align-top">
                      <td className="px-2 py-1 font-mono">{f.port.replace(':', ' ')}</td>
                      <td className={`px-2 py-1 font-mono font-semibold ${CLS_TONE[f.cls]}`}>{CLASS_LABEL[f.cls]}</td>
                      <td className="px-2 py-1 font-mono">{endStr(f.expected)}</td>
                      <td className="px-2 py-1 font-mono">{endStr(f.observed)}</td>
                      <td className="px-2 py-1 text-muted">{f.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div>
        <div className={`${cap} mb-1`}>What the check prints (illustrative format)</div>
        <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-2 font-mono text-[11px] leading-relaxed text-fg" tabIndex={0} aria-label="Validation report">{report(s, findings)}</pre>
      </div>

      {kindsUsed.length > 0 && (
        <div>
          <div className={`${cap} mb-1`}>What each injected fault does to an AI job</div>
          <ul className="space-y-1.5 text-sm">
            {kindsUsed.map((k) => (
              <li key={k} className="rounded-lg border border-line bg-panel-2 px-3 py-2">
                <span className="font-semibold text-fg">{FAULT_INFO[k].label}</span> <span className="font-mono text-[11px] text-muted">({FAULT_INFO[k].expect})</span>
                <p className="mt-0.5 text-muted">{FAULT_INFO[k].symptom}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <button type="button" aria-expanded={showLldp} aria-controls="cv-lldp" onClick={() => setShowLldp((v) => !v)} className={btn(showLldp)}>
          {showLldp ? 'Hide' : 'Show'} observed LLDP neighbors ({Object.keys(observed).length} ports)
        </button>
        {showLldp && (
          <div id="cv-lldp" className="mt-2 overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Observed LLDP neighbor table">
            <table className="w-full min-w-[480px] text-left font-mono text-[11px]">
              <caption className="px-2 py-1 text-left font-sans text-[11px] text-muted">Illustrative, normalised by the collector. LLDP carries the neighbor's System Name and Port ID; whether the Port ID is an interface name or a MAC depends on the agent's configuration, and lldpctl or NVUE print it in their own layout.</caption>
              <thead className="bg-panel-2 text-muted"><tr>
                <th scope="col" className="px-2 py-1">Device</th><th scope="col" className="px-2 py-1">Port</th><th scope="col" className="px-2 py-1">Neighbor system</th><th scope="col" className="px-2 py-1">Neighbor port</th>
              </tr></thead>
              <tbody>
                {Object.keys(observed).sort(portOrder).map((p) => {
                  const [dev, port] = p.split(':');
                  const bad = findings.some((f) => f.port === p);
                  return (
                    <tr key={p} className="border-t border-line">
                      <td className="px-2 py-0.5">{dev}</td><td className="px-2 py-0.5">{port}</td>
                      <td className={`px-2 py-0.5 ${bad ? 'font-semibold text-warn' : ''}`}>{observed[p].dev}{bad && <span className="sr-only"> (mismatch)</span>}</td>
                      <td className={`px-2 py-0.5 ${bad ? 'font-semibold text-warn' : ''}`}>{observed[p].port}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model: one pod of {NODES} nodes × {RAILS} rails, one leaf per rail, {SPINES} spines, every host running an LLDP agent, neighbors collected
        from the leaves only (a real check also reads the spines and the hosts, which catches unplanned devices on spine ports and confirms each
        link from both ends). LLDP proves which device and port sit at the other end; it does not prove the link runs at its designed speed and FEC
        with a healthy BER, which need their own checks (ethtool, mlxlink). On InfiniBand the same diff is done against discovered
        topology (ibnetdiscover, ibdiagnet with a reference topology, or UFM). Job symptoms depend on addressing, NCCL version and settings.
      </p>
    </div>
  );
}
