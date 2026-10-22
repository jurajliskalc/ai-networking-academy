import { useMemo, useState, type ReactNode } from 'react';
import { Pill } from '../components/ui';

type Tiers = 'auto' | 2 | 3;
type Oversub = [number, number];

const GPU_OPTIONS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SPEEDS = [200, 400, 800];
const RADIXES = [32, 64, 128];
const OVERSUBS: Oversub[] = [[1, 1], [2, 1], [3, 1]];

const fmt = (n: number) => n.toLocaleString('en-US');

interface Design {
  servers: number; rails: number; kDown: number; kUp: number; leavesPerRail: number; leaves: number;
  usedDown: number; upPerLeaf: number; tiers: 1 | 2 | 3; spines: number; cores: number; pods: number;
  leavesPerPod: number; serverLinks: number; leafSpineLinks: number; spineCoreLinks: number; totalLinks: number;
  transceivers: number; switches: number; cap2: number; cap3: number; cap2NB: number; cap3NB: number;
  overflow: string | null; steps: ReactNode[];
}

function size(gpus: number, perServer: number, radix: number, tiersSel: Tiers, os: Oversub, rail: boolean, dac: boolean): Design {
  const [d, u] = os;
  const k = radix;
  const servers = Math.ceil(gpus / perServer);
  const endpoints = servers * perServer; // one scale-out NIC port per GPU
  const kDown = Math.floor((k * d) / (d + u));
  const kUp = k - kDown;
  const rails = rail ? perServer : 1;
  // Rail-optimized: NIC i of every server lands on a rail-i leaf, so each rail sees one port per server.
  const leavesPerRail = rail ? Math.ceil(servers / kDown) : Math.ceil(endpoints / kDown);
  const leaves = rails * leavesPerRail;
  const usedDown = rail ? Math.min(kDown, servers) : Math.min(kDown, endpoints);
  // Uplinks cabled in proportion to populated downlinks (keeps d:u on partially filled leaves).
  const upPerLeaf = Math.min(kUp, Math.ceil((usedDown * u) / d));

  const cap2 = k * kDown; // k leaves on a k-port spine, kDown endpoints each
  const cap3 = k * (k / 2) * kDown; // k pods of k/2 leaves (core radix k bounds pods)
  const cap2NB = (k * k) / 2;
  const cap3NB = (k * k * k) / 4;

  let tiers: 1 | 2 | 3;
  const singleSwitch = !rail && leaves === 1;
  if (tiersSel === 'auto') tiers = singleSwitch ? 1 : leaves <= k ? 2 : 3;
  else tiers = tiersSel;

  let spines = 0, cores = 0, pods = 0, leavesPerPod = 0, leafSpineLinks = 0, spineCoreLinks = 0;
  let overflow: string | null = null;
  const steps: ReactNode[] = [];
  const M = ({ children }: { children: ReactNode }) => <span className="font-mono text-fg">{children}</span>;

  steps.push(<>servers = ⌈{fmt(gpus)} / {perServer}⌉ = <M>{fmt(servers)}</M> (one NIC per GPU → {fmt(endpoints)} fabric ports)</>);
  steps.push(<>leaf ports {d}:{u} → down = ⌊{k}·{d}/{d + u}⌋ = <M>{kDown}</M>, up = {k} − {kDown} = <M>{kUp}</M></>);
  if (rail) {
    steps.push(<>rails = GPUs per server = <M>{rails}</M>; leaves per rail = ⌈{fmt(servers)} / {kDown}⌉ = <M>{fmt(leavesPerRail)}</M></>);
    steps.push(<>leaves = {rails} × {fmt(leavesPerRail)} = <M>{fmt(leaves)}</M></>);
  } else {
    steps.push(<>leaves = ⌈{fmt(endpoints)} / {kDown}⌉ = <M>{fmt(leaves)}</M> (no rails: a server's NICs share a leaf)</>);
  }

  if (tiers === 1) {
    if (leaves > 1) overflow = `A single switch has only ${k} ports; ${fmt(endpoints)} endpoints need ${fmt(leaves)} leaves.`;
    steps.push(<>{fmt(endpoints)} ports ≤ {kDown}: a single switch serves everyone, no spine tier</>);
  } else {
    steps.push(<>uplinks per leaf = min({kUp}, ⌈{usedDown}·{u}/{d}⌉) = <M>{upPerLeaf}</M> → leaf↔spine links = {fmt(leaves)} × {upPerLeaf} = <M>{fmt(leaves * upPerLeaf)}</M></>);
    leafSpineLinks = leaves * upPerLeaf;
    if (tiers === 2) {
      spines = Math.max(1, Math.ceil(leafSpineLinks / k));
      steps.push(<>spines = ⌈{fmt(leafSpineLinks)} / {k}⌉ = <M>{fmt(spines)}</M></>);
      if (leaves > k) overflow = `${fmt(leaves)} leaves exceed what a ${k}-port spine can reach (${k}). Two tiers top out at ${fmt(cap2)} GPUs at ${d}:${u}; use 3 tiers.`;
    } else {
      leavesPerPod = k / 2;
      if (rail) {
        const groupsPerPod = Math.max(1, Math.floor(leavesPerPod / perServer));
        pods = Math.ceil(leavesPerRail / groupsPerPod);
        steps.push(<>pod = {leavesPerPod} leaves = {groupsPerPod} rail group(s) of {perServer} → pods = ⌈{fmt(leavesPerRail)} / {groupsPerPod}⌉ = <M>{fmt(pods)}</M></>);
      } else {
        pods = Math.ceil(leaves / leavesPerPod);
        steps.push(<>pod = {leavesPerPod} leaves → pods = ⌈{fmt(leaves)} / {leavesPerPod}⌉ = <M>{fmt(pods)}</M></>);
      }
      spines = pods * upPerLeaf;
      steps.push(<>spines = pods × uplinks per leaf = {fmt(pods)} × {upPerLeaf} = <M>{fmt(spines)}</M> (each leaf has one link to each spine in its pod)</>);
      spineCoreLinks = leafSpineLinks; // spines are 1:1 (k/2 down, k/2 up)
      cores = Math.max(1, Math.ceil(spineCoreLinks / k));
      steps.push(<>spine↔core links = spine downlinks (spines run 1:1) = <M>{fmt(spineCoreLinks)}</M>; super-spines = ⌈{fmt(spineCoreLinks)} / {k}⌉ = <M>{fmt(cores)}</M></>);
      if (pods > k) overflow = `${fmt(pods)} pods exceed the ${k} a ${k}-port super-spine can reach. Three tiers top out at ${fmt(cap3)} GPUs at ${d}:${u}.`;
    }
  }

  const serverLinks = endpoints;
  const totalLinks = serverLinks + leafSpineLinks + spineCoreLinks;
  const optical = (dac ? 0 : serverLinks) + leafSpineLinks + spineCoreLinks;
  const transceivers = optical * 2;
  const switches = (tiers === 1 ? 1 : leaves) + spines + cores;
  steps.push(<>links = {fmt(serverLinks)} + {fmt(leafSpineLinks)}{tiers === 3 ? ` + ${fmt(spineCoreLinks)}` : ''} = <M>{fmt(totalLinks)}</M>; transceivers = 2 × {fmt(optical)} optical links = <M>{fmt(transceivers)}</M></>);

  return { servers, rails, kDown, kUp, leavesPerRail, leaves: tiers === 1 ? 1 : leaves, usedDown, upPerLeaf, tiers, spines, cores, pods, leavesPerPod,
    serverLinks, leafSpineLinks, spineCoreLinks, totalLinks, transceivers, switches, cap2, cap3, cap2NB, cap3NB, overflow, steps };
}

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

function TierRow({ y, count, label, color, w = 760 }: { y: number; count: number; label: string; color: string; w?: number }) {
  const shown = Math.min(count, 8);
  const boxW = 58, gap = 14;
  const total = shown * boxW + (shown - 1) * gap + (count > shown ? 80 : 0);
  const x0 = 120 + Math.max(0, (w - 140 - total) / 2);
  return (
    <g>
      <text x={8} y={y + 18} fontSize={12} fill="var(--muted)" fontFamily="var(--font-mono)">{label}</text>
      <text x={8} y={y + 32} fontSize={12} fill="var(--text)" fontFamily="var(--font-mono)" fontWeight={700}>×{fmt(count)}</text>
      {Array.from({ length: shown }, (_, i) => (
        <rect key={i} x={x0 + i * (boxW + gap)} y={y} width={boxW} height={30} rx={5} fill="var(--panel-2)" stroke={color} strokeWidth={1.5} />
      ))}
      {count > shown && <text x={x0 + shown * (boxW + gap) + 4} y={y + 20} fontSize={13} fill="var(--muted)" fontFamily="var(--font-mono)">…×{fmt(count)}</text>}
    </g>
  );
}

function rowCenters(count: number, w = 760) {
  const shown = Math.min(count, 8);
  const boxW = 58, gap = 14;
  const total = shown * boxW + (shown - 1) * gap + (count > shown ? 80 : 0);
  const x0 = 120 + Math.max(0, (w - 140 - total) / 2);
  return Array.from({ length: shown }, (_, i) => x0 + i * (boxW + gap) + boxW / 2);
}

function Diagram({ d }: { d: Design }) {
  const rows: { count: number; label: string; color: string }[] = [];
  if (d.tiers === 3) rows.push({ count: d.cores, label: 'super-spine', color: 'var(--warn)' });
  if (d.tiers >= 2) rows.push({ count: d.spines, label: 'spine', color: 'var(--data)' });
  rows.push({ count: d.leaves, label: d.tiers === 1 ? 'switch' : 'leaf', color: 'var(--accent)' });
  rows.push({ count: d.servers, label: 'servers', color: 'var(--border)' });
  const gapY = 70;
  const h = rows.length * gapY + 10;
  return (
    <svg viewBox={`0 0 760 ${h}`} className="w-full" role="img" aria-label={`Fabric tiers diagram: ${rows.map((r) => `${fmt(r.count)} ${r.label}`).join(', ')}`}>
      {rows.slice(0, -1).map((r, i) => {
        const a = rowCenters(r.count), b = rowCenters(rows[i + 1].count);
        return (
          <g key={`l${i}`} stroke="var(--border)" strokeWidth={1}>
            {a.flatMap((xa, ia) => b.map((xb, ib) => ((ia + ib) % (r.count > 8 || rows[i + 1].count > 8 ? 2 : 1) === 0 ?
              <line key={`${ia}-${ib}`} x1={xa} y1={10 + i * gapY + 30} x2={xb} y2={10 + (i + 1) * gapY} opacity={0.7} /> : null)))}
          </g>
        );
      })}
      {rows.map((r, i) => <TierRow key={r.label} y={10 + i * gapY} count={r.count} label={r.label} color={r.color} />)}
    </svg>
  );
}

function Out({ label, value, tone = 'text-fg' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export default function FabricSizer() {
  const [gpus, setGpus] = useState(1024);
  const [perServer, setPerServer] = useState(8);
  const [speed, setSpeed] = useState(400);
  const [radix, setRadix] = useState(64);
  const [tiers, setTiers] = useState<Tiers>('auto');
  const [osIdx, setOsIdx] = useState(0);
  const [rail, setRail] = useState(true);
  const [dac, setDac] = useState(false);
  const os = OVERSUBS[osIdx];
  const d = useMemo(() => size(gpus, perServer, radix, tiers, os, rail, dac), [gpus, perServer, radix, tiers, os, rail, dac]);
  const switchTbps = (radix * speed) / 1000;
  const gIdx = GPU_OPTIONS.indexOf(gpus);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2 lg:col-span-3">
          <div className="mb-1 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            <span>GPUs</span><span className="text-base font-semibold normal-case tracking-normal text-fg">{fmt(gpus)}</span>
          </div>
          <input type="range" min={0} max={GPU_OPTIONS.length - 1} step={1} value={gIdx} aria-label="Number of GPUs" aria-valuetext={`${fmt(gpus)} GPUs`}
            onChange={(e) => setGpus(GPU_OPTIONS[Number(e.target.value)])} className="w-full accent-[var(--accent)]" />
        </div>
        <Seg label="GPUs per server" value={perServer} options={[8, 4] as const} onChange={setPerServer} />
        <Seg label="NIC speed" value={speed} options={SPEEDS} onChange={setSpeed} render={(v) => `${v}G`} />
        <Seg label={`Switch radix (ports @ ${speed}G)`} value={radix} options={RADIXES} onChange={setRadix} />
        <Seg label="Tiers" value={tiers} options={['auto', 2, 3] as const} onChange={setTiers} render={(v) => (v === 'auto' ? 'auto' : `${v}-tier`)} />
        <Seg label="Leaf oversubscription (down:up)" value={osIdx} options={[0, 1, 2] as const} onChange={setOsIdx} render={(i) => `${OVERSUBS[i][0]}:${OVERSUBS[i][1]}`} />
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={rail} onChange={(e) => setRail(e.target.checked)} className="accent-[var(--accent)]" />Rail-optimized</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={dac} onChange={(e) => setDac(e.target.checked)} className="accent-[var(--accent)]" />Server links on copper DAC/ACC</label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>switch ≈ {switchTbps} Tb/s ({radix}×{speed}G)</Pill>
        <Pill>{d.tiers === 1 ? 'single switch' : `${d.tiers}-tier fat tree`}{tiers === 'auto' ? ' (auto)' : ''}</Pill>
        {rail && <Pill>{d.rails} rails</Pill>}
      </div>

      {d.overflow && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert"><span aria-hidden>⚠ </span>{d.overflow}</div>
      )}

      <p className="sr-only" aria-live="polite">{`${fmt(gpus)} GPUs: ${d.tiers === 1 ? 'single switch' : `${d.tiers}-tier fat tree`}, ${fmt(d.switches)} switches, ${fmt(d.totalLinks)} links, ${fmt(d.transceivers)} transceivers.`}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label="Servers" value={fmt(d.servers)} />
        <Out label={rail ? `Leaves (${fmt(d.leavesPerRail)}/rail)` : 'Leaves'} value={fmt(d.leaves)} tone="text-accent" />
        <Out label="Spines" value={fmt(d.spines)} tone="text-data" />
        <Out label="Super-spines" value={d.tiers === 3 ? fmt(d.cores) : '—'} tone="text-warn" />
        <Out label="Total switches" value={fmt(d.switches)} />
        <Out label="Server↔leaf links" value={fmt(d.serverLinks)} />
        <Out label="Leaf↔spine links" value={fmt(d.leafSpineLinks)} />
        <Out label="Spine↔core links" value={d.tiers === 3 ? fmt(d.spineCoreLinks) : '—'} />
        <Out label="Total links" value={fmt(d.totalLinks)} />
        <Out label="Transceivers" value={fmt(d.transceivers)} />
        <Out label={`2-tier max (k²/2, ${os[0]}:${os[1]})`} value={<>{fmt(d.cap2NB)}<span className="text-xs text-muted"> / {fmt(d.cap2)}</span></>} />
        <Out label={`3-tier max (k³/4, ${os[0]}:${os[1]})`} value={<>{fmt(d.cap3NB)}<span className="text-xs text-muted"> / {fmt(d.cap3)}</span></>} />
      </div>

      <div className="rounded-lg border border-line bg-panel p-2"><Diagram d={d} /></div>

      <div>
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Derivation (k = {radix})</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          {d.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Model: one scale-out NIC port per GPU, every leaf uplink to a spine, spines and super-spines non-blocking (k/2 down, k/2 up). Max-GPU figures are
        non-blocking fat-tree limits k²/2 and k³/4, then the same limit at your leaf ratio. Real designs round spine counts so uplinks divide evenly,
        add front-end/storage networks separately and may use multi-plane NICs. Radix depends on the switch generation: e.g. a 51.2 Tb/s ASIC is 64×800G
        or 128×400G using 2×400G breakout per 800G OSFP cage; check vendor datasheets. Transceiver counts assume 2 per optical link and ignore breakout
        (one 2×400G module can terminate two links).
      </p>
    </div>
  );
}
