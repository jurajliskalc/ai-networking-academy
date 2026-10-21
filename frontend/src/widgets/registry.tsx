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
];

export const widgetById = (id: string) => WIDGETS.find((w) => w.id === id);

export function WidgetFrame({ id, standalone = false }: { id: string; standalone?: boolean }) {
  const w = widgetById(id);
  if (!w) return <div className="rounded-xl border border-danger/40 p-4 text-sm text-danger">Unknown widget: {id}</div>;
  const C = w.component;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-4 border-b border-line bg-panel-2 px-4 py-2.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">Interactive</div>
          <div className="text-sm font-semibold">{w.title}</div>
        </div>
        {!standalone && <Link to={`/visualize/${w.id}`} className="text-muted hover:text-fg" title="Open full size"><Maximize2 size={16} /></Link>}
      </div>
      <div className="p-4 md:p-5">
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-panel-2" />}><C /></Suspense>
      </div>
    </section>
  );
}
