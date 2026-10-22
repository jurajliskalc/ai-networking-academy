import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Link } from 'react-router-dom';
import { Maximize2 } from 'lucide-react';

export interface WidgetInfo { id: string; title: string; summary: string; component: LazyExoticComponent<ComponentType> }

// Each widget is a self-contained component with no props (see docs/AUTHORING.md for IDs).
export const WIDGETS: WidgetInfo[] = [
  { id: 'rocev2-packet', title: 'RoCEv2 packet anatomy', summary: 'Every header of a RoCEv2 packet, its size, and how much of the wire carries payload at each MTU.', component: lazy(() => import('./RocePacket')) },
  { id: 'allreduce-sim', title: 'All-reduce: ring vs tree', summary: 'Step through ring and tree all-reduce and see how latency and bandwidth terms scale with GPUs and message size.', component: lazy(() => import('./AllReduceSim')) },
  { id: 'pfc-ecn-sim', title: 'PFC and ECN in a switch queue', summary: 'Drive an egress queue into congestion and watch ECN marking, PFC XOFF/XON and the DCQCN sender react.', component: lazy(() => import('./PfcEcnSim')) },
  { id: 'ecmp-collision', title: 'ECMP collisions vs adaptive routing', summary: 'Hash elephant flows onto spine uplinks and compare static ECMP, adaptive routing and packet spraying.', component: lazy(() => import('./EcmpCollision')) },
  { id: 'fabric-sizer', title: 'Fabric sizer', summary: 'Size a two- or three-tier rail-optimized fat tree: switches, links, transceivers and oversubscription.', component: lazy(() => import('./FabricSizer')) },
  { id: 'qp-state-machine', title: 'RDMA QP state machine', summary: 'Drive a queue pair from RESET to RTS and into the error states, with the attributes each ibv_modify_qp needs.', component: lazy(() => import('./QpStateMachine')) },
  { id: 'pcie-topo', title: 'GPU server topology explorer', summary: 'Read nvidia-smi topo -m: which GPU talks to which NIC over which path, and why it matters.', component: lazy(() => import('./PcieTopo')) },
  { id: 'parallelism-map', title: 'Parallelism to network map', summary: 'See which traffic data, tensor, pipeline and expert parallelism put on NVLink and on the scale-out fabric.', component: lazy(() => import('./ParallelismMap')) },
  { id: 'ib-credit-flow', title: 'Credits vs pause', summary: 'InfiniBand credit-based flow control next to Ethernet PFC: why one never drops and the other needs headroom.', component: lazy(() => import('./IbCreditFlow')) },
  { id: 'ethernet-frame', title: 'Ethernet frame builder', summary: 'Build an Ethernet II frame with optional 802.1Q tag and IPv4/IPv6/UDP/RoCE headers; inspect every field and its size.', component: lazy(() => import('./EthernetFrame')) },
  { id: 'subnet-calculator', title: 'Subnet and rail addressing calculator', summary: 'CIDR math including /31 point-to-point links, plus a generated per-rail addressing plan for a GPU cluster.', component: lazy(() => import('./SubnetCalculator')) },
  { id: 'mtu-calculator', title: 'End-to-end MTU checker', summary: 'Host MTU, switch MTU, VXLAN or VLAN overhead and RoCE active MTU along a path: see which packets fit and which are dropped.', component: lazy(() => import('./MtuCalculator')) },
  { id: 'queue-latency', title: 'Queueing and incast calculator', summary: 'Serialization delay, queueing delay and buffer fill time for N-to-1 incast at a chosen link speed and buffer size.', component: lazy(() => import('./QueueLatency')) },
  { id: 'training-step-timeline', title: 'Training step timeline', summary: 'Forward, backward and gradient all-reduce buckets on a timeline: see overlap, exposed communication and the cost of one straggler.', component: lazy(() => import('./TrainingStepTimeline')) },
  { id: 'collective-explorer', title: 'Collective operations explorer', summary: 'Broadcast, reduce, all-gather, reduce-scatter, all-reduce and all-to-all: what each rank holds before and after, and the busbw factor.', component: lazy(() => import('./CollectiveExplorer')) },
  { id: 'pcie-bandwidth', title: 'PCIe bandwidth calculator', summary: 'PCIe generation and width to usable bandwidth, compared with NIC line rates: when the slot, not the network, is the bottleneck.', component: lazy(() => import('./PcieBandwidth')) },
  { id: 'nvlink-generations', title: 'NVLink and scale-up domains', summary: 'NVLink generations, per-GPU bandwidth and NVLink domain sizes side by side with scale-out NIC bandwidth.', component: lazy(() => import('./NvlinkGenerations')) },
  { id: 'bgp-path-sim', title: 'Leaf-spine BGP and ECMP simulator', summary: 'Fail spine links and watch the eBGP routes, AS paths and ECMP next-hop sets on every leaf update.', component: lazy(() => import('./BgpPathSim')) },
  { id: 'evpn-route-explorer', title: 'EVPN route type explorer', summary: 'EVPN route types 1-5: what each carries, when it is sent and which problem it solves, with example NLRI fields.', component: lazy(() => import('./EvpnRouteExplorer')) },
  { id: 'ib-addressing', title: 'InfiniBand addressing explorer', summary: 'GUIDs, LIDs, GIDs and P_Keys: watch the subnet manager sweep, assign LIDs and program forwarding tables.', component: lazy(() => import('./IbAddressing')) },
  { id: 'ib-speeds', title: 'InfiniBand speeds and lanes', summary: 'SDR to XDR: lane rate, encoding, width and data rate in one interactive table, with a link-rate calculator.', component: lazy(() => import('./IbSpeeds')) },
  { id: 'verbs-flow', title: 'Life of an RDMA WRITE', summary: 'Step through ibv_post_send, the doorbell, DMA reads, the wire, remote placement, the ACK and the completion.', component: lazy(() => import('./VerbsFlow')) },
  { id: 'transport-matrix', title: 'RDMA transport capability matrix', summary: 'RC, UC, UD, XRC and DC compared: operations, reliability, message size limits, connection scaling.', component: lazy(() => import('./TransportMatrix')) },
  { id: 'headroom-calculator', title: 'PFC headroom calculator', summary: 'Cable length, link speed, MTU and response time to the headroom each lossless priority needs per port.', component: lazy(() => import('./HeadroomCalculator')) },
  { id: 'dscp-mapper', title: 'DSCP, ToS and priority mapper', summary: 'Convert between DSCP, the ToS byte, ECN bits and NCCL_IB_TC, and follow a packet through trust, priority and queue mapping.', component: lazy(() => import('./DscpMapper')) },
  { id: 'pfc-deadlock', title: 'PFC deadlock builder', summary: 'Create a cyclic buffer dependency on a small topology and watch pause frames lock the loop; then break it.', component: lazy(() => import('./PfcDeadlock')) },
  { id: 'nccl-env-explorer', title: 'NCCL environment variable explorer', summary: 'Searchable table of the NCCL variables that matter for networking: what each does, typical values and the symptom of a wrong one.', component: lazy(() => import('./NcclEnvExplorer')) },
  { id: 'nccl-tests-reader', title: 'nccl-tests result reader', summary: 'Choose a collective, rank count and measured time; get algbw, busbw and a verdict against the fabric ceiling.', component: lazy(() => import('./NcclTestsReader')) },
  { id: 'optics-planner', title: 'Cable and optics planner', summary: 'Link distance and speed to cable or transceiver type, with reach, power and the trade-offs of DAC, ACC, AEC, AOC and optics.', component: lazy(() => import('./OpticsPlanner')) },
  { id: 'ber-fec', title: 'BER and FEC calculator', summary: 'Pre-FEC BER, link speed and FEC type to errors per second, margin to the FEC limit and time between uncorrectable errors.', component: lazy(() => import('./BerFec')) },
  { id: 'troubleshooting-tree', title: 'Slow-job triage tree', summary: 'An interactive decision tree from "the job is slow" to the evidence and command that confirms each root cause.', component: lazy(() => import('./TroubleshootingTree')) },
  { id: 'counter-decoder', title: 'Counter decoder', summary: 'Tick the counters that are rising on a NIC or switch port and see the likely causes, ranked, with the next check to run.', component: lazy(() => import('./CounterDecoder')) },
  { id: 'telemetry-sampling', title: 'Telemetry sampling and microbursts', summary: 'A bursty queue sampled at different polling intervals: see what averages hide and why streaming and watermarks matter.', component: lazy(() => import('./TelemetrySampling')) },
  { id: 'rail-path-explorer', title: 'Rail-optimized path explorer', summary: 'Pick two GPUs in a rail-optimized cluster and see the path traffic takes: same rail through one leaf, other rails through the spines or over NVLink with PXN.', component: lazy(() => import('./RailPathExplorer')) },
  { id: 'pipeline-schedule', title: 'Pipeline parallel schedules', summary: 'GPipe and 1F1B schedules across pipeline stages: the bubble, how micro-batches shrink it, and the activation traffic each stage boundary sends.', component: lazy(() => import('./PipelineSchedule')) },
  { id: 'kv-cache-transfer', title: 'KV cache transfer calculator', summary: 'Model shape, prompt length and link speed to the KV cache size a disaggregated prefill node must ship to decode, and how long it takes.', component: lazy(() => import('./KvCacheTransfer')) },
  { id: 'pkey-membership', title: 'P_Key membership matrix', summary: 'InfiniBand partitions with full and limited members: which ports can talk, and how tenants and shared storage are isolated.', component: lazy(() => import('./PkeyMembership')) },
  { id: 'perftest-explorer', title: 'perftest message-size explorer', summary: 'Latency and bandwidth across message sizes, MiB/s to Gb/s, header overhead and the half-bandwidth point, as ib_write_bw and ib_write_lat show them.', component: lazy(() => import('./PerftestExplorer')) },
  { id: 'sharp-aggregation', title: 'In-network reduction (SHARP)', summary: 'Bytes each host sends and receives for an all-reduce with a ring versus a switch reduction tree, and the steps each takes.', component: lazy(() => import('./SharpAggregation')) },
  { id: 'straggler-tail', title: 'Straggler and tail amplification', summary: 'Why one slow GPU in a thousand sets the pace: the odds that a synchronous step waits on a straggler as the job grows.', component: lazy(() => import('./StragglerTail')) },
  { id: 'cabling-validator', title: 'Cabling plan validator', summary: 'Compare the intended cabling plan with LLDP neighbors, inject miswires and see how an automated check finds each one.', component: lazy(() => import('./CablingValidator')) },
  { id: 'ib-tools-map', title: 'InfiniBand diagnostic tools map', summary: 'What each InfiniBand tool reads, from which part of the subnet and through which management interface (SMP, PMA, SA).', component: lazy(() => import('./IbToolsMap')) },
  { id: 'host-stack-paths', title: 'Kernel TCP/IP vs RDMA data path', summary: 'Follow a send through the Linux TCP/IP stack and through RDMA kernel bypass, and see which tools can observe each layer.', component: lazy(() => import('./HostStackPaths')) },
  { id: 'bandwidth-ladder', title: 'GPU bandwidth ladder', summary: 'HBM, NVLink, PCIe and the scale-out NIC side by side for one GPU: bandwidth and the time to move the same data over each.', component: lazy(() => import('./BandwidthLadder')) },
  { id: 'spray-reorder', title: 'Packet spraying and reordering', summary: 'Spray one message over paths with different delays and watch packets arrive out of order, and how the receiver copes.', component: lazy(() => import('./SprayReorder')) },
];

export const widgetById = (id: string) => WIDGETS.find((w) => w.id === id);

/** Groups for the Visualizations page, in curriculum order. Every widget belongs to exactly one (unit-tested). */
export const TOPICS: { name: string; ids: string[] }[] = [
  { name: 'Networking foundations', ids: ['ethernet-frame', 'subnet-calculator', 'mtu-calculator', 'queue-latency', 'host-stack-paths'] },
  { name: 'AI workloads', ids: ['parallelism-map', 'training-step-timeline', 'pipeline-schedule', 'kv-cache-transfer', 'straggler-tail'] },
  { name: 'GPU server and scale-up', ids: ['pcie-topo', 'pcie-bandwidth', 'nvlink-generations', 'bandwidth-ladder'] },
  { name: 'Fabric design and routing', ids: ['fabric-sizer', 'rail-path-explorer', 'bgp-path-sim', 'evpn-route-explorer', 'ecmp-collision', 'spray-reorder', 'optics-planner'] },
  { name: 'RDMA and InfiniBand', ids: ['rocev2-packet', 'verbs-flow', 'qp-state-machine', 'transport-matrix', 'perftest-explorer', 'ib-addressing', 'ib-speeds', 'ib-credit-flow', 'ib-tools-map', 'pkey-membership'] },
  { name: 'Lossless Ethernet', ids: ['pfc-ecn-sim', 'headroom-calculator', 'dscp-mapper', 'pfc-deadlock'] },
  { name: 'Collectives and NCCL', ids: ['collective-explorer', 'allreduce-sim', 'sharp-aggregation', 'nccl-env-explorer', 'nccl-tests-reader'] },
  { name: 'Operations and troubleshooting', ids: ['cabling-validator', 'telemetry-sampling', 'counter-decoder', 'ber-fec', 'troubleshooting-tree'] },
];

export function WidgetFrame({ id, standalone = false }: { id: string; standalone?: boolean }) {
  const w = widgetById(id);
  if (!w) return <div className="rounded-xl border border-danger/40 p-4 text-sm text-danger">Unknown widget: {id}</div>;
  const C = w.component;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel" aria-label={`Interactive: ${w.title}`}>
      <div className="flex items-center justify-between gap-4 border-b border-line bg-panel-2 px-4 py-2.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">Interactive</div>
          <div className="text-sm font-semibold">{w.title}</div>
        </div>
        {!standalone && <Link to={`/visualize/${w.id}`} className="rounded p-1 text-muted hover:text-fg" title="Open full size" aria-label={`Open ${w.title} full size`}><Maximize2 size={16} aria-hidden /></Link>}
      </div>
      <div className="p-4 md:p-5">
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-panel-2" />}><C /></Suspense>
      </div>
    </section>
  );
}
