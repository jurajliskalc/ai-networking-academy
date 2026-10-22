import { useState } from 'react';
import { Pill } from '../components/ui';

// ---------- Data (unit-testable) ----------
// Sources: rdma-core infiniband-diags sources and man pages (ibstat.c uses libibumad umad_get_ca, i.e. sysfs;
// scripts/ibstatus reads /sys/class/infiniband; sminfo.c sends SubnGet(SMInfo); iblinkinfo.c, ibnetdiscover.c and
// ibqueryerrors.c discover with libibnetdisc (directed-route SMPs); perfquery.c and ibqueryerrors.c use pma_query_via;
// saquery.c sends SA queries (NodeRecord by default); ibroute.c reads LinearForwardingTable blocks with smp_query_via
// (LID or -D); ibtracert.c queries the source and destination ports by LID, then walks hop by hop, extending a
// directed-route path (extend_dpath) and reading each switch's LFT entry for the destination LID; ibping.c uses IB_VENDOR_OPENIB_PING_CLASS = vendor range 2 start 0x30 + 2;
// scripts/ibhosts.in and ibswitches.in wrap ibnetdiscover), libibverbs (ibv_devinfo), the Linux kernel (uverbs device
// nodes are created 0666, umad nodes with the default root-only mode; a port in INIT passes only SMPs, so GMPs such as
// PMA, SA and vendor MADs need Active ports, i.e. a running SM), NVIDIA ibdiagnet (ibutils2) documentation, and
// the academy's ib-tools-diagnostics lesson and src/sim/ib.ts output model. Output lines are illustrative.

export type Mech = 'sysfs' | 'verbs' | 'smp-dr' | 'smp-lid' | 'pma' | 'sa' | 'vendor';
export const MECH_LABEL: Record<Mech, string> = {
  sysfs: 'Local sysfs, no MADs',
  verbs: 'Verbs query via /dev/infiniband/uverbsN, no MADs',
  'smp-dr': 'Directed-route SMPs (QP0, VL15): work before LIDs exist',
  'smp-lid': 'LID-routed SMPs (QP0, VL15)',
  pma: 'PMA GMPs: Performance Management class (QP1)',
  sa: 'SA queries: Subnet Administration GMPs to the master SM (QP1)',
  vendor: 'Vendor-class GMP (OpenIB ping class 0x32, QP1)',
};

export type Scope = 'local' | 'sm' | 'fabric' | 'cas' | 'switches' | 'port' | 'path' | 'switch';
export type Category = 'Host' | 'Subnet Manager' | 'Topology' | 'Counters' | 'Path and reachability' | 'Fabric-wide';

export interface IbTool {
  id: string; name: string; category: Category; cmd: string; pkg: string; answers: string; reads: string;
  mech: Mech[]; root: 'no' | 'usually'; needsSm: 'no' | 'yes' | 'partly'; smDown: string; scope: Scope; output: string; symptom: string;
  /** Illustrative output while no SM runs (ports in INIT, LID 0). Omitted when the tool fails outright or the output does not change. */
  outputSmDown?: string;
}

export const TOOLS: IbTool[] = [
  { id: 'ibstat', name: 'ibstat', category: 'Host', cmd: 'ibstat mlx5_0', pkg: 'infiniband-diags',
    answers: 'Is my HCA port up, at what rate, with which LID and SM LID?', reads: 'The local HCA\'s ports from /sys/class/infiniband (through libibumad).',
    mech: ['sysfs'], root: 'no', needsSm: 'no', smDown: 'Works: shows State Initializing, Base lid 0, SM lid 0, which is itself the clue.', scope: 'local',
    output: '\tState: Active\n\tPhysical state: LinkUp\n\tRate: 400\n\tBase lid: 12\n\tSM lid: 1',
    outputSmDown: '\tState: Initializing\n\tPhysical state: LinkUp\n\tRate: 400\n\tBase lid: 0\n\tSM lid: 0', symptom: 'One host is slow or cannot join the job' },
  { id: 'ibstatus', name: 'ibstatus', category: 'Host', cmd: 'ibstatus', pkg: 'infiniband-diags (shell script)',
    answers: 'Summary of every local IB port: state, physical state, rate, LID, default GID.', reads: '/sys/class/infiniband/*/ports/* directly.',
    mech: ['sysfs'], root: 'no', needsSm: 'no', smDown: 'Works: state 2: INIT with a rate but LID 0x0.', scope: 'local',
    output: '\tbase lid:\t 0xc\n\tsm lid:\t\t 0x1\n\tstate:\t\t 4: ACTIVE\n\tphys state:\t 5: LinkUp\n\trate:\t\t 400 Gb/sec (4X NDR)',
    outputSmDown: '\tbase lid:\t 0x0\n\tsm lid:\t\t 0x0\n\tstate:\t\t 2: INIT\n\tphys state:\t 5: LinkUp\n\trate:\t\t 400 Gb/sec (4X NDR)', symptom: 'One host is slow or cannot join the job' },
  { id: 'ibv_devinfo', name: 'ibv_devinfo', category: 'Host', cmd: 'ibv_devinfo -d mlx5_0', pkg: 'rdma-core (libibverbs utils)',
    answers: 'What do verbs applications see: device, port state, link_layer, active_mtu, limits (-v)?', reads: 'ibv_query_device / ibv_query_port through libibverbs, the provider and the kernel.',
    mech: ['verbs'], root: 'no', needsSm: 'no', smDown: 'Works: state PORT_INIT (2), port_lid 0.', scope: 'local',
    output: '\t\t\tstate:\t\t\tPORT_ACTIVE (4)\n\t\t\tactive_mtu:\t\t4096 (5)\n\t\t\tport_lid:\t\t12\n\t\t\tlink_layer:\t\tInfiniBand',
    outputSmDown: '\t\t\tstate:\t\t\tPORT_INIT (2)\n\t\t\tactive_mtu:\t\t4096 (5)\n\t\t\tport_lid:\t\t0\n\t\t\tlink_layer:\t\tInfiniBand', symptom: 'An application or container reports no RDMA device' },
  { id: 'sminfo', name: 'sminfo', category: 'Subnet Manager', cmd: 'sminfo', pkg: 'infiniband-diags',
    answers: 'Which SM is master: its LID, GUID, priority and state.', reads: 'The SMInfo attribute of the SM, at the SM LID the local port was given (or a LID / DR path you pass).',
    mech: ['smp-lid'], root: 'usually', needsSm: 'yes', smDown: 'Fails, typically with "sminfo: iberror: failed: query": the local port has SM LID 0, so there is no SM to ask.', scope: 'sm',
    output: 'sminfo: sm lid 1 sm guid 0x7cfe900300a2c3d1, activity count 48213 priority 0 state 3 SMINFO_MASTER', symptom: 'Ports stuck in INIT, or after an SM failover' },
  { id: 'iblinkinfo', name: 'iblinkinfo', category: 'Topology', cmd: 'iblinkinfo', pkg: 'infiniband-diags',
    answers: 'Every link in the fabric with width, speed, state and the node at each end.', reads: 'NodeInfo / PortInfo of every node, found by a directed-route sweep (libibnetdisc).',
    mech: ['smp-dr'], root: 'usually', needsSm: 'no', smDown: 'Works: directed routes need no LIDs; links show Initialize/LinkUp.', scope: 'fabric',
    output: '           4    1[  ] ==( 4X        106.25 Gbps Active/  LinkUp)==>      12    1[  ] "node01 mlx5_0" ( )',
    outputSmDown: '           0    1[  ] ==( 4X        106.25 Gbps Initialize/  LinkUp)==>       0    1[  ] "node01 mlx5_0" ( )', symptom: 'A link trained at lower width or speed, or is down' },
  { id: 'ibnetdiscover', name: 'ibnetdiscover', category: 'Topology', cmd: 'ibnetdiscover > fabric.topo', pkg: 'infiniband-diags',
    answers: 'The full topology: every switch and CA, every cable, GUIDs, node descriptions, width and speed.', reads: 'A directed-route sweep of the whole subnet (libibnetdisc).',
    mech: ['smp-dr'], root: 'usually', needsSm: 'no', smDown: 'Works: discovery is directed-route; LIDs print as 0.', scope: 'fabric',
    output: '[1]\t"H-b83fd20300a1b2c4"[1](b83fd20300a1b2c4) \t\t# "node01 mlx5_0" lid 12 4xNDR',
    outputSmDown: '[1]\t"H-b83fd20300a1b2c4"[1](b83fd20300a1b2c4) \t\t# "node01 mlx5_0" lid 0 4xNDR', symptom: 'Suspected miscabling; compare with the cabling plan' },
  { id: 'ibhosts', name: 'ibhosts', category: 'Topology', cmd: 'ibhosts', pkg: 'infiniband-diags (script around ibnetdiscover)',
    answers: 'List of channel adapters (hosts) in the fabric.', reads: 'ibnetdiscover output, filtered to CA lines.',
    mech: ['smp-dr'], root: 'usually', needsSm: 'no', smDown: 'Works, like ibnetdiscover.', scope: 'cas',
    output: 'Ca\t: 0xb83fd20300a1b2c4 ports 1 "node01 mlx5_0"', symptom: 'Suspected miscabling; compare with the cabling plan' },
  { id: 'ibswitches', name: 'ibswitches', category: 'Topology', cmd: 'ibswitches', pkg: 'infiniband-diags (script around ibnetdiscover)',
    answers: 'List of switches with GUID, port count, description and management LID.', reads: 'ibnetdiscover output, filtered to switch lines.',
    mech: ['smp-dr'], root: 'usually', needsSm: 'no', smDown: 'Works, like ibnetdiscover; switch LIDs print as 0.', scope: 'switches',
    output: 'Switch\t: 0x900a84030060b1c0 ports 65 "MF0;leaf01:MQM9700/U1" enhanced port 0 lid 4 lmc 0',
    outputSmDown: 'Switch\t: 0x900a84030060b1c0 ports 65 "MF0;leaf01:MQM9700/U1" enhanced port 0 lid 0 lmc 0', symptom: 'Suspected miscabling; compare with the cabling plan' },
  { id: 'perfquery', name: 'perfquery', category: 'Counters', cmd: 'perfquery 14 1', pkg: 'infiniband-diags',
    answers: 'Error, congestion and traffic counters of one port anywhere in the subnet (-x: 64-bit extended).', reads: 'PortCounters / PortCountersExtended from the target port\'s PMA, addressed by LID and port number.',
    mech: ['pma'], root: 'usually', needsSm: 'yes', smDown: 'Fails: PMA queries are LID-routed GMPs, no port has a LID, and a port in INIT passes only SMPs.', scope: 'port',
    output: 'PortRcvErrors:...................0\nPortXmitWait:....................1288227', symptom: 'Errors or a suspected bad cable on a known port' },
  { id: 'ibqueryerrors', name: 'ibqueryerrors', category: 'Counters', cmd: 'ibqueryerrors', pkg: 'infiniband-diags',
    answers: 'Which ports in the whole fabric have error counters above threshold.', reads: 'Discovers by directed route, then reads every port\'s PMA counters.',
    mech: ['smp-dr', 'pma'], root: 'usually', needsSm: 'partly', smDown: 'Discovery works (directed route), but every PMA query fails: no LIDs, and ports in INIT pass only SMPs.', scope: 'fabric',
    output: '   GUID 0xfc6a1c0300e4f300 port 7: [SymbolErrorCounter == 52113] [PortRcvErrors == 409]',
    outputSmDown: '(the fabric is discovered, but the PMA query to every port fails, so no counters are reported; exact messages vary by version)', symptom: 'The job is slow and you do not know where to look' },
  { id: 'saquery', name: 'saquery', category: 'Subnet Manager', cmd: 'saquery', pkg: 'infiniband-diags',
    answers: 'What the SM\'s database holds: node, path, port, multicast, service records (node records by default).', reads: 'Subnet Administration records from the SA, which runs with the master SM.',
    mech: ['sa'], root: 'usually', needsSm: 'yes', smDown: 'Fails: there is no SA to answer (and ports in INIT pass only SMPs).', scope: 'sm',
    output: 'NodeRecord dump:\n\t\tlid.....................14\n\t\t...\n\t\tNodeDescription.........node03 mlx5_0', symptom: 'Path records, partitions or multicast groups look wrong' },
  { id: 'ibtracert', name: 'ibtracert', category: 'Path and reachability', cmd: 'ibtracert 12 14', pkg: 'infiniband-diags',
    answers: 'Which switches and ports a packet from one LID to another crosses.', reads: 'Finds the source and destination ports by LID, then walks hop by hop along a growing directed route, reading NodeInfo / PortInfo / SwitchInfo and each switch\'s Linear Forwarding Table entry for the destination LID.',
    mech: ['smp-lid', 'smp-dr'], root: 'usually', needsSm: 'yes', smDown: 'Fails: there are no LIDs to trace between and the SM has programmed no forwarding tables.', scope: 'path',
    output: 'From ca {0xb83fd20300a1b2c4} portnum 1 lid 12-12 "node01 mlx5_0"\n[1] -> switch port {0x900a84030060b1c0}[1] lid 4-4 "MF0;leaf01:MQM9700/U1"\n...\nTo ca {0xb83fd20300a1b7f0} portnum 1 lid 14-14 "node03 mlx5_0"', symptom: 'Traffic takes an unexpected path or uplinks look unbalanced' },
  { id: 'ibroute', name: 'ibroute', category: 'Path and reachability', cmd: 'ibroute 4', pkg: 'infiniband-diags',
    answers: 'One switch\'s unicast (or -M multicast) forwarding table: destination LID to output port.', reads: 'LinearForwardingTable blocks of the switch (LID-routed, or by directed route with -D).',
    mech: ['smp-lid', 'smp-dr'], root: 'usually', needsSm: 'partly', smDown: 'ibroute 4 fails (no switch has LID 4). With a directed route (ibroute -D 0,1 reaches leaf01) the switch answers, but the SM is what programs the table, so it holds nothing useful.', scope: 'switch',
    output: '  Lid  Out   Destination\n       Port     Info \n0x000c 001 : (Channel Adapter portguid 0xb83fd20300a1b2c4: \'node01 mlx5_0\')',
    outputSmDown: '(ibroute 4 fails: no LID 4 exists. ibroute -D 0,1 reads leaf01 by directed route, but its forwarding table has not been programmed, so there are no useful entries)', symptom: 'Traffic takes an unexpected path or uplinks look unbalanced' },
  { id: 'ibping', name: 'ibping', category: 'Path and reachability', cmd: 'ibping 14', pkg: 'infiniband-diags',
    answers: 'Can this port reach that port at the IB level, independent of IP and the application?', reads: 'A reply from an ibping server (ibping -S) on the target host.',
    mech: ['vendor'], root: 'usually', needsSm: 'yes', smDown: 'Fails: the ping is a LID-routed GMP (a -G GUID target is resolved through the SA), and ports in INIT pass only SMPs.', scope: 'path',
    output: '(node03 is already running: ibping -S)\nPong from node03.(none) (Lid 14): time 0.012 ms', symptom: 'Host A cannot talk to host B' },
  { id: 'ibdiagnet', name: 'ibdiagnet', category: 'Fabric-wide', cmd: 'ibdiagnet', pkg: 'NVIDIA ibutils2 (DOCA-OFED / MLNX_OFED, UFM)',
    answers: 'Fabric-wide health: duplicate GUIDs/LIDs, link speed/width, counters, routing checks, cable info; options vary by version.', reads: 'Directed-route discovery plus SMP and PMA queries across the subnet, and more depending on options.',
    mech: ['smp-dr', 'smp-lid', 'pma'], root: 'usually', needsSm: 'partly', smDown: 'Discovery and link checks run; anything needing LIDs or the SM reports errors. Check your version\'s manual.', scope: 'fabric',
    output: '(summary of errors and warnings on screen; details in ibdiagnet2.log, ibdiagnet2.db_csv and other files under /var/tmp/ibdiagnet2/ by default; layout varies by version)',
    outputSmDown: '(discovery completes and link checks run; checks that need LIDs, PMA counters or the SM report errors; exact output varies by version)', symptom: 'Acceptance test or after maintenance' },
];

export const SYMPTOMS: { id: string; text: string; tools: string[] }[] = [
  { id: 'slow-host', text: 'One host is slow or cannot join the job', tools: ['ibstat', 'ibstatus', 'iblinkinfo', 'perfquery'] },
  { id: 'init', text: 'Ports stuck in INIT, or after an SM failover', tools: ['ibstat', 'sminfo', 'iblinkinfo'] },
  { id: 'nodev', text: 'An application or container reports no RDMA device', tools: ['ibv_devinfo', 'ibstat'] },
  { id: 'width', text: 'A link trained at lower width or speed, or is down', tools: ['iblinkinfo', 'ibstat', 'perfquery'] },
  { id: 'errors', text: 'Errors or a suspected bad cable on a known port', tools: ['perfquery', 'ibqueryerrors', 'iblinkinfo'] },
  { id: 'where', text: 'The job is slow and you do not know where to look', tools: ['ibqueryerrors', 'iblinkinfo', 'ibdiagnet'] },
  { id: 'cabling', text: 'Suspected miscabling; compare with the cabling plan', tools: ['ibnetdiscover', 'ibhosts', 'ibswitches', 'iblinkinfo'] },
  { id: 'path', text: 'Traffic takes an unexpected path or uplinks look unbalanced', tools: ['ibtracert', 'ibroute', 'perfquery'] },
  { id: 'reach', text: 'Host A cannot talk to host B', tools: ['ibping', 'ibtracert', 'saquery'] },
  { id: 'sa', text: 'Path records, partitions or multicast groups look wrong', tools: ['saquery', 'sminfo'] },
  { id: 'accept', text: 'Acceptance test or after maintenance', tools: ['ibdiagnet', 'ibqueryerrors', 'iblinkinfo'] },
];

/** Does the tool give a useful answer when no Subnet Manager is running (ports in INIT, no LIDs)? */
export const worksWithoutSm = (t: IbTool) => t.needsSm === 'no';

// ---------- topology ----------

export interface Node { id: string; label: string; kind: 'host' | 'switch'; lid: number; x: number; y: number }
export const NODES: Node[] = [
  { id: 'spine01', label: 'spine01', kind: 'switch', lid: 2, x: 230, y: 40 },
  { id: 'spine02', label: 'spine02', kind: 'switch', lid: 3, x: 410, y: 40 },
  { id: 'leaf01', label: 'leaf01', kind: 'switch', lid: 4, x: 160, y: 130 },
  { id: 'leaf02', label: 'leaf02', kind: 'switch', lid: 5, x: 480, y: 130 },
  { id: 'node01', label: 'node01 (you)', kind: 'host', lid: 12, x: 80, y: 220 },
  { id: 'node02', label: 'node02', kind: 'host', lid: 13, x: 240, y: 220 },
  { id: 'node03', label: 'node03', kind: 'host', lid: 14, x: 400, y: 220 },
  { id: 'sm01', label: 'sm01 (SM)', kind: 'host', lid: 1, x: 560, y: 220 },
];
export const LINKS: [string, string][] = [
  ['node01', 'leaf01'], ['node02', 'leaf01'], ['node03', 'leaf02'], ['sm01', 'leaf02'],
  ['leaf01', 'spine01'], ['leaf01', 'spine02'], ['leaf02', 'spine01'], ['leaf02', 'spine02'],
];
const PATH_TO_NODE03 = ['node01', 'leaf01', 'spine01', 'leaf02', 'node03'];
const PATH_TO_SM = ['node01', 'leaf01', 'spine01', 'leaf02', 'sm01'];
const pathLinks = (p: string[]) => p.slice(1).map((n, i) => `${p[i]}-${n}`);
const linkKey = (a: string, b: string) => `${a}-${b}`;
const ALL_LINKS = LINKS.map(([a, b]) => linkKey(a, b));

/** Which nodes and links a tool touches. Path links are keyed in the direction of travel; lookups test both orders. */
export function scopeOf(s: Scope): { nodes: string[]; links: string[]; text: string } {
  switch (s) {
    case 'local': return { nodes: ['node01'], links: [], text: 'only the local HCA on node01; nothing crosses the fabric' };
    case 'sm': return { nodes: PATH_TO_SM, links: pathLinks(PATH_TO_SM), text: 'node01 and the master SM on sm01, across leaf01, spine01 and leaf02' };
    case 'fabric': return { nodes: NODES.map((n) => n.id), links: ALL_LINKS, text: 'every node and link in the subnet' };
    case 'cas': return { nodes: NODES.filter((n) => n.kind === 'host').map((n) => n.id), links: ALL_LINKS, text: 'the whole subnet is walked, the hosts (CAs) are reported' };
    case 'switches': return { nodes: NODES.filter((n) => n.kind === 'switch').map((n) => n.id), links: ALL_LINKS, text: 'the whole subnet is walked, the switches are reported' };
    case 'port': return { nodes: ['node01', 'node03'], links: pathLinks(PATH_TO_NODE03), text: 'one target port (node03, LID 14, port 1); the query is routed to it by LID' };
    case 'path': return { nodes: PATH_TO_NODE03, links: pathLinks(PATH_TO_NODE03), text: 'the route from node01 (LID 12) to node03 (LID 14): leaf01, spine01, leaf02' };
    case 'switch': return { nodes: ['node01', 'leaf01'], links: pathLinks(['node01', 'leaf01']), text: 'one switch: leaf01 (LID 4) and its forwarding table' };
  }
}
const hasLink = (links: string[], a: string, b: string) => links.includes(linkKey(a, b)) || links.includes(linkKey(b, a));

// ---------- UI ----------

const btn = (on: boolean) => `min-h-6 rounded-md border px-2 py-1 font-mono text-xs ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel hover:bg-panel-2'}`;
const CATEGORIES: Category[] = ['Host', 'Subnet Manager', 'Topology', 'Counters', 'Path and reachability', 'Fabric-wide'];
const node = (id: string) => NODES.find((n) => n.id === id)!;

function Diagram({ tool, smDown }: { tool: IbTool; smDown: boolean }) {
  const sc = scopeOf(tool.scope);
  const fails = smDown && tool.needsSm === 'yes';
  return (
    <svg viewBox="0 0 640 255" className="w-full min-w-[540px]" role="img"
      aria-label={`InfiniBand subnet: two spines, two leaves, hosts node01, node02, node03 and the SM host sm01. ${tool.name} run on node01 reaches ${sc.text}.${smDown ? ` The SM is down, so no port has a LID${fails ? `, and ${tool.name} fails` : ''}.` : ''}`}>
      {LINKS.map(([a, b]) => {
        const on = hasLink(sc.links, a, b);
        const A = node(a), B = node(b);
        return <line key={`${a}-${b}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={on ? (fails ? 'var(--danger)' : 'var(--data)') : 'var(--border)'} strokeWidth={on ? 3 : 1.5} strokeDasharray={on ? undefined : '4 4'} />;
      })}
      {NODES.map((n) => {
        const on = sc.nodes.includes(n.id);
        const w = n.kind === 'switch' ? 96 : 112;
        const lidText = smDown ? 'no LID' : `LID ${n.lid}`;
        return (
          <g key={n.id}>
            <rect x={n.x - w / 2} y={n.y - 17} width={w} height={34} rx={n.kind === 'switch' ? 4 : 10} fill="var(--panel-2)"
              stroke={on ? 'var(--data)' : 'var(--border)'} strokeWidth={on ? 2.5 : 1} />
            <text x={n.x} y={n.y - 3} fontSize={11} textAnchor="middle" fill="var(--text)" fontFamily="var(--font-mono)" fontWeight={on ? 700 : 400}>{n.label}</text>
            <text x={n.x} y={n.y + 11} fontSize={10} textAnchor="middle" fill={smDown ? 'var(--warn)' : 'var(--muted)'} fontFamily="var(--font-mono)">{n.id === 'sm01' && smDown ? 'SM stopped' : lidText}</text>
            {on && <text x={n.x} y={n.kind === 'host' ? n.y + 30 : n.y - 22} fontSize={10} textAnchor="middle" fill="var(--data)" fontFamily="var(--font-mono)">in scope</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function IbToolsMap() {
  const [toolId, setToolId] = useState('iblinkinfo');
  const [symptom, setSymptom] = useState<string | null>(null);
  const [smDown, setSmDown] = useState(false);
  const tool = TOOLS.find((t) => t.id === toolId)!;
  const sym = SYMPTOMS.find((s) => s.id === symptom) ?? null;
  const fails = smDown && tool.needsSm !== 'no';

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Start from a symptom (optional)</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Symptom">
          {SYMPTOMS.map((s) => (
            <button key={s.id} type="button" aria-pressed={symptom === s.id} className={btn(symptom === s.id)}
              onClick={() => { if (symptom === s.id) setSymptom(null); else { setSymptom(s.id); setToolId(s.tools[0]); } }}>{s.text}</button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {CATEGORIES.map((c) => (
          <div key={c}>
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{c}</div>
            <div className="flex flex-wrap gap-1" role="group" aria-label={`${c} tools`}>
              {TOOLS.filter((t) => t.category === c).map((t) => {
                const rec = !!sym?.tools.includes(t.id);
                return (
                  <button key={t.id} type="button" aria-pressed={toolId === t.id} onClick={() => setToolId(t.id)}
                    className={`${btn(toolId === t.id)} ${rec && toolId !== t.id ? 'border-data text-data' : ''}`}>
                    {t.name}{rec && <span className="sr-only"> (suggested for this symptom)</span>}{rec && <span aria-hidden> ★</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {sym && <p className="text-xs text-muted">★ suggested for “{sym.text}”, in the order to try: {sym.tools.join(' → ')}.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={smDown} onClick={() => setSmDown(!smDown)}
          className={`min-h-6 rounded-md border px-2 py-1 font-mono text-xs ${smDown ? 'border-warn bg-panel-2 text-warn' : 'border-line bg-panel hover:bg-panel-2'}`}>
          {smDown ? '✓ ' : ''}Subnet Manager down (ports in INIT, no LIDs)
        </button>
      </div>

      <div className="rounded-lg border border-line bg-panel p-2">
        <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Scope of {tool.name}, run on node01</div>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Subnet diagram for ${tool.name}`}>
          <Diagram tool={tool} smDown={smDown} />
        </div>
        <p className="px-1 text-xs text-muted">Highlighted (thick, solid, “in scope”): {scopeOf(tool.scope).text}.</p>
      </div>

      <div className="rounded-lg border border-line p-3" aria-live="polite">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-base font-semibold">{tool.name}</span>
          <span className="font-mono text-xs text-muted">$ {tool.cmd}</span>
        </div>
        <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Answers</dt><dd>{tool.answers}</dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Reads</dt><dd className="text-muted">{tool.reads}</dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Mechanism</dt>
          <dd><ul className="space-y-0.5">{tool.mech.map((m) => <li key={m} className="text-data">{MECH_LABEL[m]}</li>)}</ul></dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Needs root</dt>
          <dd>{tool.root === 'no' ? 'No' : 'Usually: it opens /dev/infiniband/umadN, which is root-only by default'}</dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Without an SM</dt>
          <dd className={smDown ? (fails ? (tool.needsSm === 'yes' ? 'text-danger' : 'text-warn') : 'text-accent') : ''}>
            {tool.needsSm === 'no' ? 'Works. ' : tool.needsSm === 'yes' ? 'Does not work. ' : 'Partly. '}{tool.smDown}
          </dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Reach for it when</dt><dd>{tool.symptom}</dd>
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Package</dt><dd className="text-muted">{tool.pkg}</dd>
        </dl>
        <pre className="mt-2 overflow-x-auto rounded-lg p-3 font-mono text-[11.5px] leading-relaxed" style={{ background: 'var(--code-bg)', color: 'var(--code-text)' }} tabIndex={0} role="region" aria-label={`Illustrative ${tool.name} output`}>
          {smDown && tool.needsSm === 'yes' ? `$ ${tool.cmd}\n(fails: no LIDs and no SM to answer; exact error text varies by tool and version)` : `$ ${tool.cmd}\n${smDown && tool.outputSmDown ? tool.outputSmDown : tool.output}`}
        </pre>
        <p className="mt-1 text-[11px] text-muted">Illustrative output line(s), trimmed{smDown ? ', as they would look with no SM running' : ''}; layout follows the tool's source and varies by version.</p>
      </div>

      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="All tools compared">
        <table className="w-full min-w-[560px] text-left text-xs">
          <caption className="mb-1 text-left text-xs text-muted">All tools at a glance</caption>
          <thead className="font-mono text-[10px] uppercase text-muted">
            <tr><th className="pr-3">Tool</th><th className="pr-3">Mechanism</th><th className="pr-3">Root</th><th>Works without SM</th></tr>
          </thead>
          <tbody>
            {TOOLS.map((t) => (
              <tr key={t.id} className={`border-t border-line ${t.id === toolId ? 'font-semibold' : ''}`}>
                <td className="py-1 pr-3"><button type="button" onClick={() => setToolId(t.id)} aria-pressed={t.id === toolId} className="min-h-6 font-mono text-accent underline-offset-2 hover:underline">{t.name}</button></td>
                <td className="pr-3 text-muted">{t.mech.map((m) => ({ sysfs: 'sysfs', verbs: 'verbs', 'smp-dr': 'DR SMP', 'smp-lid': 'LID SMP', pma: 'PMA', sa: 'SA', vendor: 'vendor GMP' }[m])).join(' + ')}</td>
                <td className="pr-3">{t.root === 'no' ? 'no' : 'usually'}</td>
                <td className={t.needsSm === 'no' ? 'text-accent' : t.needsSm === 'yes' ? 'text-danger' : 'text-warn'}>{t.needsSm === 'no' ? 'yes' : t.needsSm === 'yes' ? 'no' : 'partly'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Pill>SMP: QP0, VL15</Pill><Pill>GMP (PMA, SA): QP1</Pill><Pill>directed route: no LIDs needed</Pill><Pill>PortXmitData × 4 = bytes</Pill>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Simplified subnet with one master SM on a host; GUIDs, LIDs and outputs are illustrative. Most infiniband-diags tools address targets by LID and
        accept -G (GUID) or -D (directed route) instead; check each man page for your version. "Needs root" reflects the default umad device permissions;
        sites can grant access differently. Management keys (M_Key) and SA keys can restrict what these tools may read. ibdiagnet is an NVIDIA tool with
        many version-dependent options and output files; its manual is the reference.
      </p>
    </div>
  );
}
