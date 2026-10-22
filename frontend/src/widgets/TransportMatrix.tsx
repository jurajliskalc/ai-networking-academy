import { useMemo, useState } from 'react';
import { Pill } from '../components/ui';

export type Transport = 'RC' | 'UC' | 'UD' | 'XRC' | 'DC';
export const TRANSPORTS: Transport[] = ['RC', 'UC', 'UD', 'XRC', 'DC'];

export interface QpCounts { perProcess: number; perNode: number; cluster: number; note: string }

/** Remote peer processes each process talks to in an all-to-all pattern. */
export function remotePeers(nodes: number, ppn: number, intraNode: boolean): number {
  return (nodes - 1) * ppn + (intraNode ? ppn - 1 : 0);
}

/**
 * QPs needed for full all-to-all connectivity.
 * RC/UC: one QP per (process, peer process) pair, per extra QP per connection.
 * XRC: one INI QP per (process, remote node); each node hosts one TGT QP per incoming INI QP (shared by its XRC domain).
 * DC: a pool of DCIs plus one DCT per process, independent of the job size.
 * UD: one QP per process (plus one address handle per destination).
 */
export function qpCounts(t: Transport, nodes: number, ppn: number, intraNode: boolean, qpsPerConn: number, dcis: number): QpCounts {
  const peers = remotePeers(nodes, ppn, intraNode);
  const procs = nodes * ppn;
  if (t === 'RC' || t === 'UC') {
    const pp = peers * qpsPerConn;
    return { perProcess: pp, perNode: pp * ppn, cluster: pp * procs, note: `${peers.toLocaleString('en-US')} peers × ${qpsPerConn} QP(s)` };
  }
  if (t === 'XRC') {
    const targetNodes = nodes - 1 + (intraNode && ppn > 1 ? 1 : 0);
    const ini = targetNodes; // per process
    const tgtPerNode = ppn * targetNodes; // every process on every other node opens one INI towards this node
    const perNode = ini * ppn + tgtPerNode;
    return { perProcess: ini, perNode, cluster: perNode * nodes, note: `${ini} INI per process; ${tgtPerNode.toLocaleString('en-US')} TGT per node` };
  }
  if (t === 'DC') {
    const pp = dcis + 1;
    return { perProcess: pp, perNode: pp * ppn, cluster: pp * procs, note: `${dcis} DCI + 1 DCT per process` };
  }
  return { perProcess: 1, perNode: ppn, cluster: procs, note: `1 QP + ${peers.toLocaleString('en-US')} address handles per process` };
}

type V = 'yes' | 'no' | 'partial';
interface Row { key: string; label: string; group: 'ops' | 'semantics' | 'scaling'; cells: Record<Transport, [V, string]> }

const Y = (s = 'Yes'): [V, string] => ['yes', s];
const N = (s = 'No'): [V, string] => ['no', s];
const P = (s: string): [V, string] => ['partial', s];

const ROWS: Row[] = [
  { key: 'rel', label: 'Reliable (ACK, retransmit)', group: 'semantics', cells: { RC: Y(), UC: N('No: lost packet = lost message'), UD: N(), XRC: Y(), DC: Y() } },
  { key: 'conn', label: 'Connected', group: 'semantics', cells: { RC: Y('Yes, 1 QP ↔ 1 QP'), UC: Y('Yes, 1 QP ↔ 1 QP'), UD: N('No: AH + QPN + Q_Key per WR'), XRC: Y('INI QP ↔ TGT QP per remote node'), DC: P('Dynamically, per DCT, by hardware') } },
  { key: 'send', label: 'SEND / RECV (with IMM)', group: 'ops', cells: { RC: Y(), UC: Y(), UD: Y(), XRC: Y('Yes, into XRC SRQs'), DC: Y('Yes, DCT receives into an SRQ') } },
  { key: 'write', label: 'RDMA WRITE (with IMM)', group: 'ops', cells: { RC: Y(), UC: Y(), UD: N(), XRC: Y(), DC: Y() } },
  { key: 'read', label: 'RDMA READ', group: 'ops', cells: { RC: Y(), UC: N(), UD: N(), XRC: Y(), DC: Y() } },
  { key: 'atomic', label: 'Atomics (CAS, FAA)', group: 'ops', cells: { RC: Y('Yes (atomic_cap)'), UC: N(), UD: N(), XRC: Y('Yes (atomic_cap)'), DC: Y('Yes (device-dependent)') } },
  { key: 'mcast', label: 'Multicast', group: 'ops', cells: { RC: N(), UC: N(), UD: Y(), XRC: N(), DC: N() } },
  { key: 'size', label: 'Max message size', group: 'semantics', cells: { RC: P('≤ 2³¹ B (2 GiB); max_msg_sz'), UC: P('≤ 2³¹ B (2 GiB); max_msg_sz'), UD: P('One path MTU (≤ 4096 B)'), XRC: P('≤ 2³¹ B (2 GiB); max_msg_sz'), DC: P('Device-dependent (like RC)') } },
  { key: 'order', label: 'Ordering', group: 'semantics', cells: { RC: Y('In order; completions in post order'), UC: P('In order; damaged messages silently dropped'), UD: N('No guarantee'), XRC: Y('In order per INI→TGT'), DC: Y('In order per DCI stream') } },
  { key: 'scale', label: 'QPs per process (all-to-all)', group: 'scaling', cells: { RC: N('(N−1)·P'), UC: N('(N−1)·P'), UD: Y('1'), XRC: P('N−1 (per remote node)'), DC: Y('a few DCIs + 1 DCT') } },
  { key: 'std', label: 'Defined by', group: 'scaling', cells: { RC: Y('IBTA'), UC: Y('IBTA'), UD: Y('IBTA'), XRC: Y('IBTA (annex), rdma-core'), DC: P('NVIDIA mlx5dv only') } },
  { key: 'use', label: 'Typical use', group: 'scaling', cells: { RC: Y('NCCL, storage, most RDMA apps'), UC: P('Rare'), UD: Y('Management MADs (SM/SA on QP0/QP1), CM / rdma_cm, IPoIB, UCX ud_mlx5'), XRC: P('MPI (historically)'), DC: P('UCX dc_mlx5, large MPI/SHMEM jobs') } },
];

const OPS = [
  { key: 'write', label: 'needs RDMA WRITE' }, { key: 'read', label: 'needs RDMA READ' }, { key: 'atomic', label: 'needs atomics' },
  { key: 'rel', label: 'needs reliability' }, { key: 'big', label: 'messages > MTU' }, { key: 'portable', label: 'vendor-neutral' },
] as const;
export type Req = (typeof OPS)[number]['key'];

export function meets(t: Transport, r: Req): boolean {
  if (r === 'big') return t !== 'UD';
  if (r === 'portable') return t !== 'DC';
  return ROWS.find((x) => x.key === r)!.cells[t][0] === 'yes';
}

const tone: Record<V, string> = { yes: 'text-accent', no: 'text-danger', partial: 'text-warn' };
const fmt = (n: number) => n.toLocaleString('en-US');

function NumIn({ label, value, set, min, max }: { label: string; value: number; set: (v: number) => void; min: number; max: number }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(e) => set(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))}
        className="w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-sm" />
    </label>
  );
}

export default function TransportMatrix() {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [group, setGroup] = useState<'all' | Row['group']>('all');
  const [nodes, setNodes] = useState(128);
  const [ppn, setPpn] = useState(8);
  const [intra, setIntra] = useState(false);
  const [qpc, setQpc] = useState(1);
  const [dcis, setDcis] = useState(4);

  const ok = (t: Transport) => reqs.every((r) => meets(t, r));
  const rows = ROWS.filter((r) => group === 'all' || r.group === group);
  const counts = useMemo(() => TRANSPORTS.map((t) => ({ t, c: qpCounts(t, nodes, ppn, intra, qpc, dcis) })), [nodes, ppn, intra, qpc, dcis]);
  const peers = remotePeers(nodes, ppn, intra);
  const maxCluster = Math.max(...counts.map((x) => x.c.cluster));

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">My workload… (dims transports that cannot do it)</div>
        <div className="flex flex-wrap gap-1">
          {OPS.map((o) => {
            const on = reqs.includes(o.key);
            return (
              <button key={o.key} type="button" aria-pressed={on} onClick={() => setReqs(on ? reqs.filter((r) => r !== o.key) : [...reqs, o.key])}
                className={`rounded-md border px-2 py-1 font-mono text-xs ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`}>{o.label}</button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['all', 'ops', 'semantics', 'scaling'] as const).map((g) => (
            <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}
              className={`rounded-md border px-2 py-0.5 text-[11px] ${group === g ? 'border-data text-data' : 'border-line text-muted hover:bg-panel-2'}`}>{g === 'all' ? 'all rows' : g}</button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="RDMA transport capability matrix">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="bg-panel-2">
            <tr>
              <th className="px-2 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">Capability</th>
              {TRANSPORTS.map((t) => (
                <th key={t} scope="col" className={`px-2 py-2 font-mono text-sm ${ok(t) ? 'text-fg' : 'text-muted line-through'}`}>{t}{t === 'DC' && <span className="text-[10px] text-warn"> *</span>}{!ok(t) && <span className="sr-only"> (cannot do the selected workload)</span>}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line align-top">
                <td className="px-2 py-1.5 font-semibold">{r.label}</td>
                {TRANSPORTS.map((t) => {
                  const [v, s] = r.cells[t];
                  return <td key={t} className={`px-2 py-1.5 ${ok(t) ? tone[v] : 'text-muted'}`}>{s}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reqs.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-live="polite">
          <Pill>fits: {TRANSPORTS.filter(ok).join(', ') || 'none'}</Pill>
        </div>
      )}

      <div className="rounded-xl border border-line bg-panel-2 p-3">
        <div className="mb-2 text-sm font-semibold">QP count calculator (every process talks to every other process)</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumIn label="Nodes N" value={nodes} set={setNodes} min={2} max={100000} />
          <NumIn label="Processes / node P" value={ppn} set={setPpn} min={1} max={256} />
          <NumIn label="RC QPs per peer" value={qpc} set={setQpc} min={1} max={16} />
          <NumIn label="DCIs per process" value={dcis} set={setDcis} min={1} max={64} />
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={intra} onChange={(e) => setIntra(e.target.checked)} className="accent-[var(--accent)]" />
          Also use RDMA to processes on the same node (usually NVLink / shared memory instead)
        </label>
        <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="QP counts per transport">
          <table className="w-full min-w-[520px] text-left font-mono text-xs">
            <thead className="text-muted"><tr><th className="py-1 pr-2">Transport</th><th className="pr-2">Per process</th><th className="pr-2">Per node</th><th className="pr-2">Cluster</th><th className="w-1/4">How</th></tr></thead>
            <tbody>
              {counts.map(({ t, c }) => (
                <tr key={t} className="border-t border-line">
                  <td className="py-1 pr-2 text-fg">{t}</td>
                  <td className="pr-2 text-data">{fmt(c.perProcess)}</td>
                  <td className="pr-2">{fmt(c.perNode)}</td>
                  <td className="pr-2">
                    <div>{fmt(c.cluster)}</div>
                    <div className="mt-0.5 h-1 rounded bg-panel" aria-hidden><div className="h-1 rounded bg-data" style={{ width: `${Math.max(1, (100 * Math.log10(c.cluster + 1)) / Math.log10(maxCluster + 1))}%` }} /></div>
                  </td>
                  <td className="font-sans text-[11px] text-muted">{c.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-xs text-muted">
          <li>peers per process = (N − 1)·P{intra ? ' + (P − 1)' : ''} = ({fmt(nodes)} − 1)·{ppn}{intra ? ` + ${ppn - 1}` : ''} = <span className="text-fg">{fmt(peers)}</span></li>
          <li>RC per node = P · peers · QPs-per-peer = {ppn} · {fmt(peers)} · {qpc} = <span className="text-fg">{fmt(ppn * peers * qpc)}</span>; cluster = N·P·peers·QPs-per-peer (each connection has a QP at both ends)</li>
          <li>XRC: each process opens one INI QP per remote node; a node hosts one TGT QP per incoming INI QP, shared by its local processes through the XRC domain</li>
          <li>DC and UD do not grow with N: DC keeps a small DCI pool, UD keeps one QP but needs an address handle per destination and gives up RDMA WRITE/READ</li>
        </ol>
        <p className="mt-2 text-[11px] text-muted">Bars are log-scaled. Bar length only shows QP objects: NIC context-cache pressure, memory and connection setup cost also matter.</p>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        RC, UC, UD and XRC per the InfiniBand Architecture Specification and rdma-core (XRC is an IBTA annex; ibv_open_xrcd). * DC is an NVIDIA (Mellanox)
        extension exposed through mlx5dv on ConnectX adapters, not part of the base specification; its limits and atomics support are device- and
        firmware-dependent, and the DCI pool size is a library setting (UCX, MPI), so the default of 4 here is illustrative. 2³¹ bytes is the
        IBTA message-size ceiling; the actual limit is the device's max_msg_sz in ibv_devinfo -v. UD payload is at most one path MTU (on RoCE, the
        active MTU, ≤ 4096). NCCL uses RC, with NCCL_IB_QPS_PER_CONNECTION QPs per peer connection; its ring/tree collectives keep the peer count far below
        the all-to-all worst case shown here, while all-to-all (point-to-point) traffic connects to many more peers.
      </p>
    </div>
  );
}
