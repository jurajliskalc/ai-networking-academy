# Curriculum plan: module and lesson ID map

IDs are permanent: learner progress is keyed by them. Rename a title freely, never an ID.
Quiz IDs are always `quiz-<lesson-id>`.

Levels: **L1 noob** (no prior knowledge assumed) → **L2 practitioner** → **L3 engineer** → **L4 master**.

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
