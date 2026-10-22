# Curriculum plan: module and lesson ID map

IDs are permanent: learner progress is keyed by them. Rename a title freely, never an ID.
Quiz IDs are always `quiz-<lesson-id>`.

Levels: **L1 beginner** (no prior knowledge assumed) → **L2 practitioner** → **L3 engineer** → **L4 master**.

| Module | Level | Lessons (in order) |
|---|---|---|
| `m00-foundations`: Networking foundations for AI engineers | L1 | `osi-ethernet-frames`, `ip-addressing-routing`, `mtu-jumbo-frames`, `linux-networking-toolkit`, `switching-and-queues` |
| `m01-ai-workloads`: Why AI needs a different network | L1 | `ai-training-101`, `parallelism-strategies`, `collective-operations`, `ai-traffic-patterns`, `four-networks-of-an-ai-cluster`, `inference-networking` |
| `m02-gpu-server`: Inside the GPU server | L2 | `pcie-numa-topology`, `nics-dpus-supernics`, `gpudirect-rdma-storage`, `nvlink-nvswitch`, `reading-server-topology` |
| `m03-dc-fabrics`: Data center fabric fundamentals | L2 | `clos-leaf-spine`, `oversubscription-and-blocking`, `ecmp-hashing`, `bgp-in-the-data-center`, `evpn-vxlan-frontend` |
| `m04-rdma`: RDMA fundamentals | L2 | `why-rdma`, `verbs-qps-mrs`, `transport-types-operations`, `rdma-on-linux`, `perftest-benchmarking` |
| `m05-infiniband`: InfiniBand | L3 | `ib-architecture`, `subnet-manager-routing`, `ib-flow-control-vls`, `ib-speeds-cables`, `sharp-in-network-computing`, `ib-tools-diagnostics` |
| `m06-rocev2-lossless`: RoCEv2 and lossless Ethernet | L3 | `rocev2-encapsulation`, `pfc-priority-flow-control`, `buffers-headroom-ets`, `ecn-and-dcqcn`, `qos-trust-and-mapping`, `pfc-storms-deadlocks`, `rocev2-configuration-end-to-end` |
| `m07-load-balancing-congestion`: Load balancing and congestion at scale | L3 | `flow-collisions-entropy`, `adaptive-routing-packet-spraying`, `incast-and-congestion-hotspots`, `spectrum-x-architecture`, `ultra-ethernet` |
| `m08-nccl-collectives`: Collective communication and NCCL | L3 | `collective-algorithms`, `nccl-architecture`, `nccl-configuration`, `nccl-tests-interpretation`, `nccl-debugging` |
| `m09-cluster-design`: AI cluster architecture and design | L4 | `rail-optimized-topology`, `superpod-reference-architecture`, `fabric-sizing-math`, `optics-cabling-power`, `storage-and-frontend-networks`, `multi-tenancy-isolation`, `scale-up-domains-nvl72` |
| `m10-operations`: Operations, telemetry and automation | L4 | `telemetry-counters`, `streaming-telemetry-gnmi`, `fabric-validation-burn-in`, `network-automation-for-ai`, `ufm-netq-management` |
| `m11-troubleshooting`: Troubleshooting mastery | L4 | `troubleshooting-methodology`, `link-layer-ber-fec`, `lossless-misconfigurations`, `slow-collectives-stragglers`, `rdma-connection-failures`, `case-studies` |
| `m12-capstone`: Capstone and career prep | L4 | `design-review-capstone`, `interview-preparation`, `exam-strategy` |

## Labs

- **Fabric Simulator labs** (`content/labs/sim/*.yaml`): break/fix tickets in a browser-simulated
  rail-optimized cluster. They run anywhere, including on GitHub Pages. See [AUTHORING.md](AUTHORING.md#simulator-labs).
- **Hands-on labs** (`content/labs/handson/*.md` plus files in `labs/`): real Linux work with
  containerlab/FRR and Soft-RoCE (`rdma_rxe`). They need a Linux host or VM.

## Widgets

| ID | What it shows |
|---|---|
| `rocev2-packet` | RoCEv2 header stack, per-header overhead, payload efficiency vs MTU |
| `allreduce-sim` | Ring vs tree all-reduce, step by step, plus an alpha-beta time model |
| `pfc-ecn-sim` | Egress queue with ECN marking and PFC XOFF/XON thresholds, DCQCN sender reaction |
| `ecmp-collision` | Elephant flows hashed on spine uplinks: static ECMP vs adaptive routing vs packet spraying |
| `fabric-sizer` | Two- and three-tier fat-tree / rail-optimized sizing: switches, links, optics, oversubscription |
| `qp-state-machine` | RDMA QP states (RESET, INIT, RTR, RTS, SQD, SQE, ERR) and the attributes each transition needs |
| `pcie-topo` | `nvidia-smi topo -m` matrix explorer: PIX/PXB/PHB/NODE/SYS/NV# and GPU-NIC affinity |
| `parallelism-map` | Which parallelism (DP, TP, PP, EP) puts which traffic on which network |
| `ib-credit-flow` | InfiniBand credit-based link-level flow control vs PFC pause |
| `ethernet-frame` | Build an Ethernet II frame with optional 802.1Q tag and IPv4/IPv6/UDP/RoCE headers; inspect every field and its size. |
| `subnet-calculator` | CIDR math including /31 point-to-point links, plus a generated per-rail addressing plan for a GPU cluster. |
| `mtu-calculator` | Host MTU, switch MTU, VXLAN or VLAN overhead and RoCE active MTU along a path: see which packets fit and which are dropped. |
| `queue-latency` | Serialization delay, queueing delay and buffer fill time for N-to-1 incast at a chosen link speed and buffer size. |
| `training-step-timeline` | Forward, backward and gradient all-reduce buckets on a timeline: see overlap, exposed communication and the cost of one straggler. |
| `collective-explorer` | Broadcast, reduce, all-gather, reduce-scatter, all-reduce and all-to-all: what each rank holds before and after, and the busbw factor. |
| `pcie-bandwidth` | PCIe generation and width to usable bandwidth, compared with NIC line rates: when the slot, not the network, is the bottleneck. |
| `nvlink-generations` | NVLink generations, per-GPU bandwidth and NVLink domain sizes side by side with scale-out NIC bandwidth. |
| `bgp-path-sim` | Fail spine links and watch the eBGP routes, AS paths and ECMP next-hop sets on every leaf update. |
| `evpn-route-explorer` | EVPN route types 1-5: what each carries, when it is sent and which problem it solves, with example NLRI fields. |
| `ib-addressing` | GUIDs, LIDs, GIDs and P_Keys: watch the subnet manager sweep, assign LIDs and program forwarding tables. |
| `ib-speeds` | SDR to XDR: lane rate, encoding, width and data rate in one interactive table, with a link-rate calculator. |
| `verbs-flow` | Step through ibv_post_send, the doorbell, DMA reads, the wire, remote placement, the ACK and the completion. |
| `transport-matrix` | RC, UC, UD, XRC and DC compared: operations, reliability, message size limits, connection scaling. |
| `headroom-calculator` | Cable length, link speed, MTU and response time to the headroom each lossless priority needs per port. |
| `dscp-mapper` | Convert between DSCP, the ToS byte, ECN bits and NCCL_IB_TC, and follow a packet through trust, priority and queue mapping. |
| `pfc-deadlock` | Create a cyclic buffer dependency on a small topology and watch pause frames lock the loop; then break it. |
| `nccl-env-explorer` | Searchable table of the NCCL variables that matter for networking: what each does, typical values and the symptom of a wrong one. |
| `nccl-tests-reader` | Choose a collective, rank count and measured time; get algbw, busbw and a verdict against the fabric ceiling. |
| `optics-planner` | Link distance and speed to cable or transceiver type, with reach, power and the trade-offs of DAC, ACC, AEC, AOC and optics. |
| `ber-fec` | Pre-FEC BER, link speed and FEC type to errors per second, margin to the FEC limit and time between uncorrectable errors. |
| `troubleshooting-tree` | An interactive decision tree from "the job is slow" to the evidence and command that confirms each root cause. |
| `counter-decoder` | Tick the counters that are rising on a NIC or switch port and see the likely causes, ranked, with the next check to run. |
| `telemetry-sampling` | A bursty queue sampled at different polling intervals: see what averages hide and why streaming and watermarks matter. |
