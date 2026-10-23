---
id: requirements
title: Requirements and shopping list
order: 2
summary: What each tier of the real-hardware track needs, how to size servers, NICs, cables and switches, and the smallest lab that unlocks each set of labs.
---

## The tier ladder

The real-hardware track is built as a ladder. Every tier adds one piece of gear and unlocks a new
class of experiment; you can stop at any rung and still get real value.

| Tier | You add | What it unlocks | Labs |
|---|---|---|---|
| 0 · Virtual | One Linux VM (two for the capture lab) | Kernel networking, Soft-RoCE, containerlab fabrics, ECN on Linux qdiscs | All `hol-*` labs |
| 1 · Two RDMA hosts | Two servers, one RDMA NIC each, one cable | Real RoCEv2 (or InfiniBand) traffic, GIDs, perftest, host QoS, PFC between two NICs, link health, break/fix | hw-01, hw-02, hw-03, hw-04, hw-05, hw-09 (InfiniBand) |
| 2 · Lossless switched fabric | A third host and a configurable data-center switch | Real incast, switch PFC and ECN, buffer behaviour, congestion control in action | hw-06 |
| 3 · GPU nodes | An NVIDIA GPU in each of two RDMA hosts | GPUDirect RDMA, PCIe/NUMA affinity, multi-node NCCL tests | hw-07, hw-08 |

Tier 3 does not require Tier 2: two GPU hosts cabled back to back are enough for both GPU labs. The
InfiniBand lab (hw-09) is a Tier 1 lab with InfiniBand adapters instead of Ethernet ones.

> [!TIP]
> Buy for Tier 1 first, and make sure the NICs you choose can also do what you want later
> (Ethernet *and* InfiniBand if you are curious about both, a speed your future switch supports).
> Most of the learning value per unit of money is in Tier 1.

## Compatibility matrix

| Lab | Two RDMA hosts | Three hosts | PFC/ECN switch | NVIDIA GPU | InfiniBand | Root | SSH A to B/C |
|---|---|---|---|---|---|---|---|
| hw-01 Inventory and baseline | yes | | | optional | either fabric | yes | yes |
| hw-02 First RoCEv2 traffic | yes | | | | | yes | yes |
| hw-03 Host QoS: PFC and ECN | yes | | optional | | | yes | yes |
| hw-04 Break/fix on your gear | yes | | | | | yes | yes |
| hw-05 Link health and optics | yes | | optional | | either fabric | yes | yes |
| hw-06 Switch lossless and incast | yes | yes | yes | | | yes | yes |
| hw-07 GPUDirect and NUMA | yes | | | yes | either fabric | yes | yes |
| hw-08 NCCL across two nodes | yes | | | yes | either fabric | yes | yes |
| hw-09 InfiniBand bring-up | yes | | | | yes | yes | yes |

The exact requirement keys of each lab are shown on its card in [the lab list](#/hw/labs); the
[Connect page](#/hw/connect) checks them against your profile and your imported inventory.

## Servers

Almost any x86_64 server or workstation from the last decade works for Tier 1. What matters is the
**PCIe slot**, not the CPU.

### PCIe arithmetic: will the slot feed the NIC?

A NIC can only move data as fast as its PCIe link. Per lane and direction:

| PCIe generation | Transfer rate | Encoding | Usable raw rate per lane (approx.) | x8 | x16 |
|---|---|---|---|---|---|
| Gen2 | 5 GT/s | 8b/10b | 4 Gb/s | 32 Gb/s | 64 Gb/s |
| Gen3 | 8 GT/s | 128b/130b | 7.9 Gb/s | 63 Gb/s | 126 Gb/s |
| Gen4 | 16 GT/s | 128b/130b | 15.8 Gb/s | 126 Gb/s | 252 Gb/s |
| Gen5 | 32 GT/s | 128b/130b | 31.5 Gb/s | 252 Gb/s | 504 Gb/s |

Those are line-encoding rates. Real throughput is lower again because of transaction-layer
packet headers, flow control and the read-request round trips the NIC does; a common rule of thumb
is to budget roughly 10 to 20 percent below the raw figure, depending on payload sizes and the
platform. So:

- A **100 Gb/s** NIC wants **Gen3 x16** or **Gen4 x8**. In a Gen3 x8 slot (about 63 Gb/s raw) it
  will link up at 100G and still never exceed roughly 50 to 55 Gb/s of RDMA payload.
- A **200 Gb/s** NIC wants **Gen4 x16**.
- A **400 Gb/s** NIC wants **Gen5 x16** (or a vendor-specific multi-host/Socket Direct arrangement).
- A **dual-port** card shares one PCIe link between both ports: two 100G ports on a Gen3 x16 card
  cannot both run at line rate at the same time.

> [!WARNING]
> Check that the **slot** is electrically as wide as it looks. Many x16-sized slots are wired x8 or
> x4, and some share lanes with M.2 or other slots. The motherboard manual is the authority; the
> Inventory lab (hw-01) shows the negotiated width and speed so you can confirm it.

### Other server considerations

| Item | Minimum | Recommended | Why |
|---|---|---|---|
| CPU | Any 64-bit x86 with 4 cores | 8+ cores, one or two sockets | perftest and the collectors are light; a dual-socket box teaches NUMA effects (hw-02, hw-07) |
| Memory | 8 GB | 32 GB+ | RDMA pins (locks) memory; GPU labs and NCCL need more |
| Slots | One slot that feeds your NIC (see above) | A second full-width slot for a GPU in Tier 3, ideally under the same CPU socket or PCIe switch as the NIC | GPUDirect performance depends on the PCIe path between GPU and NIC |
| Management | SSH over a separate 1G port | A BMC (IPMI/Redfish) | You can recover a host after a bad network change without walking to it |
| OS disk | 64 GB | 200 GB+ SSD | CUDA, NCCL and container images are large |

Used enterprise 1U/2U servers are the usual home-lab path. They are loud and power-hungry (see "Power, noise
and cooling" below); a tower workstation with the right slots is
often the better neighbour.

## RDMA NICs

The labs are written and tested-by-design against NVIDIA ConnectX adapters (the `mlx5` driver),
because they are the most common RDMA NICs in AI clusters and on the used market. Other RoCE NICs
(Broadcom `bnxt_re`, Intel `irdma`, ...) work for the generic tasks (verbs, perftest, GIDs), but the
QoS and counter tasks use mlx5-specific tools and counter names; expect to translate.

| Family (NVIDIA ConnectX) | Typical port speeds | Fabrics | Notes for this course |
|---|---|---|---|
| ConnectX-4 Lx | 10/25/40/50 GbE | Ethernet only | The cheapest useful RoCEv2 card. Fine for Tiers 1 and 2. |
| ConnectX-4 | up to 100 Gb/s (EDR IB / 100 GbE) | VPI (IB or Ethernet) on VPI models | Older generation; check that your chosen driver stack still supports it. |
| ConnectX-5 | up to 100 Gb/s | Ethernet; VPI on some models | A good all-round choice for Tier 1 and 3. |
| ConnectX-6 Dx | up to 100/200 GbE | Ethernet only | Modern RoCE features; common in cloud and enterprise servers. |
| ConnectX-6 (VPI) | up to 200 Gb/s (HDR) | VPI | InfiniBand HDR or 200 GbE. |
| ConnectX-7 | up to 400 Gb/s (NDR) | VPI or Ethernet-only models | Current AI-cluster generation; needs Gen5 x16 to reach line rate. |

These ranges are by family; individual part numbers differ in port count, speed and whether they
are VPI (InfiniBand-capable). Check the part number's product brief before buying.

- **VPI** means one adapter can run each port as InfiniBand or Ethernet; the port type is a
  firmware setting (see [Host setup](#/hw/host-setup)). Ethernet-only ("EN") models cannot run
  InfiniBand.
- **Avoid** the ConnectX-3 generation for new labs: current driver stacks have dropped or limited it,
  and its RoCEv2 support depends on the "Pro" variant.
- **OEM cards** (sold by server vendors under their own part numbers) usually work, but they may run
  OEM-specific firmware (a different PSID) that NVIDIA's generic images do not update.
- **Used-market reality (as of 2026):** 25G and 100G ConnectX-4 Lx/5 cards are widely available
  second-hand at a small fraction of their original price, typically tens of dollars to low hundreds
  per card; 200G/400G cards remain far more expensive. Prices move fast; treat these as orders of
  magnitude.

## Cables and optics

Back to back (Tier 1) needs exactly one cable; a switch (Tier 2) needs one per host.

| Option | Typical reach | Pros | Cons |
|---|---|---|---|
| DAC (passive copper, direct attach) | A few metres at 100G, shorter at higher speeds | Cheapest, no lasers, lowest power | Thick, short, speed-specific |
| AOC (active optical cable) | Tens of metres | Thin, longer reach, no separate optics to buy | Fixed length, a failure means replacing the whole cable |
| Transceivers + fibre | Hundreds of metres (multimode) to kilometres (single-mode) | Flexible, standard patching | Most expensive, needs laser safety discipline and clean connectors |

- Match the **form factor** (SFP28, QSFP28, QSFP56, QSFP112, OSFP, ...) and the **speed** on both
  ends. A QSFP28 100G DAC between two QSFP28 cards is the classic Tier 1 cable.
- **Breakout cables** (one 100G or 400G switch port to several slower host ports) work, but the
  switch port must be configured for breakout; check the switch documentation before you buy.
- **Coding and compatibility:** some switches and NICs check the vendor coding in the cable's
  EEPROM and refuse or warn about "unsupported" modules. NVIDIA NICs generally accept third-party
  cables, but switches vary. Buy cables known to work with your switch, or confirm its policy.
- Cable choice and link health are the subject of
  [hw-05](#/hw/labs/hw-05-link-health-optics) and the
  [optics and cabling lesson](#/lesson/optics-cabling-power).

## Switches (Tier 2)

Any switch will carry Tier 1 traffic. For Tier 2 you need one whose **QoS you can configure** for
lossless RoCE. The feature checklist:

- [ ] **PFC** (IEEE 802.1Qbb) on at least one priority, per port.
- [ ] **ECN marking** (WRED/ECN thresholds) on the egress queue that carries RoCE.
- [ ] **DSCP trust and DSCP-to-priority/queue mapping** (L3 RoCE uses DSCP, not VLAN PCP).
- [ ] **Buffer configuration** for the lossless priority (headroom and shared pool), or a vendor
  RoCE profile that sets it for you.
- [ ] **Per-queue and per-priority counters**: PFC frames sent and received, ECN-marked packets,
  drops per queue. Without counters you cannot see what the lab is teaching.
- [ ] **Jumbo frames** (MTU 9216 or so) on every port.
- [ ] Nice to have: a **PFC watchdog**, LLDP, and an API or CLI that you can script.

| NOS option | What to know |
|---|---|
| NVIDIA Cumulus Linux on Spectrum switches | Has a single-command RoCE QoS profile (`nv set qos roce`). This course gives exact NVUE commands. Licensing and supported hardware depend on the release; check NVIDIA's terms. |
| SONiC | Open source, runs on many merchant-silicon switches. Lossless defaults come from per-platform templates and vary by platform and release. Community images are free; hardware support varies. |
| Vendor NOS (Arista EOS, Cisco NX-OS, Juniper, ...) | Fully capable of lossless RoCE; follow the vendor's RoCE/AI deployment guide. The course gives a vendor-neutral checklist rather than syntax. |

> [!WARNING]
> Older or campus-class switches often advertise "PFC" without usable buffer tuning or counters.
> Before buying, find the vendor's RoCE configuration guide for that exact model: if none exists,
> assume the switch is not a good Tier 2 teacher.

## GPUs (Tier 3)

- One NVIDIA GPU per host is enough. GPUDirect RDMA needs a data-center or workstation GPU and a
  driver stack that supports peer memory or DMA-BUF; consumer GeForce cards have historically not
  been supported for GPUDirect RDMA. Check NVIDIA's GPUDirect RDMA documentation for your GPU.
- **Placement matters more than the GPU model:** put the GPU and the NIC under the same CPU socket,
  ideally the same PCIe switch. `nvidia-smi topo -m` (lab hw-07) tells you what you got.
- Check power connectors, slot width (most GPUs are double-width) and airflow before buying.
- NCCL tests (hw-08) need CUDA, NCCL and an MPI implementation on both hosts.

## InfiniBand

- InfiniBand **HCAs** (or VPI adapters with the port type set to InfiniBand) on both hosts, and
  InfiniBand cables (DAC/AOC of the right generation; Ethernet DACs of the same form factor are not
  guaranteed to work).
- A **subnet manager**: without one, ports stay in `INIT` and nothing passes. Back to back, run
  OpenSM on one host (`setup-rdma-host.sh --opensm` installs it). With a managed InfiniBand switch,
  its embedded SM can do the job. Exactly one SM should be master.
- An unmanaged InfiniBand switch works with OpenSM running on a host.

## Software

| Item | Tested-by-design target | Also works |
|---|---|---|
| Operating system | Ubuntu 24.04 LTS (generic kernel) | RHEL 9 family (Rocky, Alma), Ubuntu 22.04, Debian 12 |
| RDMA stack | Inbox kernel drivers + distribution rdma-core | NVIDIA DOCA-Host (the successor of MLNX_OFED) |
| Python | 3.8 or newer (for `aina-hw`) | |
| GPU stack (Tier 3) | NVIDIA driver, CUDA, NCCL, nccl-tests, Open MPI | |

**Inbox versus DOCA-Host/MLNX_OFED:** both are valid. Inbox is simpler and enough for every lab
except where a task uses an NVIDIA-only script (`mlnx_qos`, `show_gids`, `cma_roce_tos`), which
come with DOCA/OFED or with NVIDIA's separately distributed tools, not from the distribution
archives; [Host setup](#/hw/host-setup) lists the inbox equivalents. What you must not do is **mix**
them: installing the distribution's rdma-core packages on top of a DOCA/OFED install (or the
reverse) leads to conflicting libraries and providers. `setup-rdma-host.sh` detects an OFED/DOCA
install (via `ofed_info`) and skips the RDMA packages in that case.

Use the **same OS, kernel and driver stack on every host**. Many "RDMA does not work between these
two hosts" problems are version skew.

## Power, noise and cooling

- A used 1U server can draw on the order of 100 to 300 W idle and is loud enough to be unpleasant in
  a living space; GPU servers draw much more. Measure with a plug-in meter rather than trusting the
  PSU rating.
- 100G optics and NICs run hot. Server NICs expect server airflow; in a quiet tower, add a fan that
  blows across the card or it may throttle or shut down.
- Data-center switches are loud and many have front-to-back or back-to-front airflow variants;
  match them to how you install them.
- Plan circuits: a few servers, a switch and a GPU node can approach the limit of a single
  domestic circuit in some countries.
- A BMC and a smart PDU let you power-cycle remotely; they pay for themselves the first time a lab
  leaves a host unreachable.

## Minimum viable lab per tier

| Tier | Minimum viable lab | Comfortable lab |
|---|---|---|
| 0 | One Ubuntu 24.04 VM, 4 vCPU, 8 GB | Two VMs on the same virtual network |
| 1 | Two PCs/servers, each with a 25G ConnectX-4 Lx in a slot that feeds it, one SFP28 DAC | Two servers with 100G ConnectX-5/6 (VPI if you want InfiniBand too) in Gen3 x16/Gen4 x8 slots, QSFP28 DAC, a BMC each |
| 2 | Tier 1 + a third host + a used Spectrum (Cumulus) or SONiC-capable switch at the NIC speed | Same, with LLDP on hosts and a dedicated management switch |
| 3 | Tier 1 hosts with one data-center/workstation NVIDIA GPU each, GPU and NIC on the same socket | GPU and NIC under the same PCIe switch, CUDA/NCCL/MPI identical on both hosts |
| IB | Two VPI cards set to InfiniBand, one IB DAC, OpenSM on one host | Add a small InfiniBand switch |

Next step: [Host setup](#/hw/host-setup).
