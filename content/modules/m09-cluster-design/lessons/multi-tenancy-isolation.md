---
id: multi-tenancy-isolation
title: "Multi-tenancy and isolation: PKeys, VXLAN/EVPN, DPUs and noisy neighbours"
module: m09-cluster-design
level: 4
estimated_minutes: 55
objectives:
  - Distinguish reachability isolation from performance isolation and name the mechanisms for each.
  - Configure InfiniBand partitions conceptually with PKeys, including full and limited membership.
  - Design tenant separation on Ethernet with VRFs and VXLAN/EVPN, and compute the encapsulation overhead for RoCEv2.
  - Explain host-based isolation with BlueField DPUs and why it changes the trust model.
  - Allocate tenants to a rail-optimized cluster so that shared links, and therefore interference, are minimized.
prerequisites: [evpn-vxlan-frontend, subnet-manager-routing, spectrum-x-architecture]
quiz: quiz-multi-tenancy-isolation
widgets: [parallelism-map, evpn-route-explorer, pkey-membership]
labs: []
tags: [multi-tenancy, pkey, vxlan, evpn, vrf, bluefield, isolation]
further_reading:
  - title: InfiniBand Trade Association specification (partitioning and P_Keys)
    url: https://www.infinibandta.org/ibta-specification/
  - title: "RFC 8365: A Network Virtualization Overlay Solution Using Ethernet VPN (EVPN)"
    url: https://www.rfc-editor.org/rfc/rfc8365
  - title: "RFC 7348: Virtual eXtensible Local Area Network (VXLAN)"
    url: https://www.rfc-editor.org/rfc/rfc7348
  - title: NVIDIA BlueField DPU documentation
    url: https://docs.nvidia.com/networking/dpu-doca/index.html
---

## Why this matters

Few AI clusters serve one team forever. GPU clouds rent slices to customers who must never see each
other's traffic; enterprises share a cluster between research groups, production inference and
contractors; and even a single team runs many jobs that compete for the same spines. A tenant
expects two guarantees: **nobody else can reach my endpoints**, and **nobody else can slow my job
down**. The first is a security property and is well understood from classic networking. The second
is much harder in AI fabrics, because synchronous collectives turn a small amount of interference on
one link into a slowdown of the whole job.

An architect designing for multiple tenants has to choose mechanisms at three layers: fabric
(PKeys, VRFs, VXLAN), host (SR-IOV, DPUs) and placement (which tenant gets which servers and links).
Placement is the one most often forgotten, and the one that gives the strongest performance
isolation for free.

## Concepts

### Kinds of isolation

| Kind | Question | Mechanisms |
|---|---|---|
| **Reachability** (security) | Can tenant A's endpoints exchange packets with tenant B's? | IB partitions (PKeys), VLANs/VRFs, VXLAN/EVPN, ACLs, DPU-enforced policy |
| **Performance** | Can tenant A's traffic slow tenant B's job? | Placement on disjoint links, adaptive routing, congestion control, traffic classes, rate limits |
| **Management** | Can tenant A see or change tenant B's resources or telemetry? | Role-based access in fabric managers, per-tenant views, DPU separation from host |

A design can be perfect on reachability and still fail tenants on performance: two partitions on
the same spine links share the same queues and buffers.

### InfiniBand partitions and PKeys

InfiniBand isolates tenants with **partitions**. Each partition is identified by a 16-bit **P_Key**
carried in the Base Transport Header of every packet:

- The low **15 bits** are the partition number; the **top bit** is the membership type: **1 = full**,
  **0 = limited**.
- Two ports can communicate only if they share a partition and **at least one of them is a full
  member**. Limited members can talk to full members but not to each other.
- The **default partition** is 0x7FFF (0xFFFF as a full member). In multi-tenant designs, tenant
  nodes are often made limited members of the default partition (so they can reach shared services
  that are full members) and full members of their own tenant partition.
- The **subnet manager** programs each port's PKey table. HCAs check incoming packets against it,
  and switches can optionally enforce partitions at their ports as well, which protects against a
  host that ignores its own table.

Because the P_Key is checked in hardware per packet, partitioning has no throughput cost.

Assign tenant nodes, shared storage, UFM and the SM to partitions as full or limited members and watch which pairs can talk; compare the shared storage partition with the variant where tenants were made full members:

```widget
pkey-membership
```

### Ethernet: VRFs and VXLAN/EVPN

On Ethernet fabrics tenants are separated by:

- **VRFs**: separate routing tables per tenant on the leaf switches. Routes from one VRF are not
  visible in another unless explicitly leaked.
- **VXLAN**: a 24-bit VNI (about 16.7 million identifiers, versus 4,094 usable VLAN IDs) carried in
  a UDP encapsulation, so tenant segments can span a routed underlay.
- **EVPN** (BGP address family; RFC 7432 and RFC 8365 for overlays) as the control plane that
  distributes MAC and IP reachability per VNI and VRF, replacing flood-and-learn.

The VXLAN tunnel endpoint (VTEP) can be the **leaf switch** or the **host** (typically a DPU or
SuperNIC that performs encapsulation in hardware).

Step through a tenant host coming up to see which EVPN routes carry its MAC, IP and subnet, and which VNI (L2 or the tenant's L3 VNI) each one uses:

```widget
evpn-route-explorer
```

> [!ANALOGY]
> PKeys are like VLAN membership with a twist: limited membership is a built-in "private VLAN"
> (isolated ports that can only reach promiscuous ones). VRFs plus EVPN are exactly the MPLS L3VPN
> model of a service provider, moved into the data center. Where the analogy breaks: in an SP
> network, a customer's traffic is a small fraction of each link; in an AI fabric, one tenant's job
> can fill every link it touches.

### Host-based isolation with DPUs

A **BlueField DPU** runs its own Arm-based operating system separate from the host. When tenant
policy (VXLAN encapsulation, firewall rules, virtual switching, storage virtualization) is enforced
on the DPU:

- The host, including a bare-metal tenant with root access, **cannot change the policy**, because it
  lives on a separate trust domain.
- Encapsulation and filtering run in hardware at line rate, offloaded from host CPUs.
- The underlay switches can stay simple (pure L3, no per-tenant state), and tenants are defined by
  software on the DPUs.

This is the model used by many GPU clouds offering bare-metal servers. NVIDIA's Spectrum-X reference
designs pair Spectrum-4 switches with BlueField-3 devices and describe both multi-tenant isolation
and performance isolation as goals; treat performance claims as vendor positioning and validate them
with your own multi-tenant tests.

## How it works

### Performance interference: where it actually happens

In a 1:1 rail-optimized fabric, think link by link:

1. **Host-to-leaf links** belong to one server, so they are never shared between tenants if tenants
   get whole servers.
2. **Inside a leaf**, traffic between two ports of the same tenant uses those ports only. A
   non-blocking leaf has no shared bottleneck for it (output-port contention only arises when two
   senders target the same destination port, which belongs to one tenant).
3. **Leaf-to-spine links** are shared by every tenant whose traffic leaves the leaf: cross-SU jobs,
   cross-rail traffic without PXN, and all-to-all patterns. This is where noisy neighbours live,
   through ECMP collisions, shared queues and, on lossless Ethernet, PFC pauses that spread
   congestion to innocent flows.

Conclusion: **whole-server allocation plus SU-aware placement eliminates most sharing**. Fabric
mechanisms (adaptive routing, congestion control such as DCQCN or vendor-specific schemes, and on
InfiniBand separate service levels and virtual lanes) then handle what remains.

### Worked example: placing tenants on a 4-SU cluster

Cluster: 4 SUs x 256 GPUs = **1,024 GPUs**. Requests: A = 512, B = 256, C = 128, D = 64, E = 64 GPUs
(total 512 + 256 + 128 + 64 + 64 = **1,024**).

1. A gets SU 1 and SU 2 (2 x 256 = 512). Its DP traffic within one SU stays on rail leaves; traffic
   between SU 1 and SU 2 crosses spines.
2. B gets SU 3 (256). All its rail-local traffic stays on SU 3's leaves; it touches spines only for
   cross-rail traffic without PXN.
3. C, D and E share SU 4: C gets 16 servers (128 GPUs), D and E get 8 servers each (64 GPUs). All
   three use all 8 rail leaves of SU 4, but on disjoint ports, so rail-local traffic does not
   interfere.
4. Spine sharing: only A's cross-SU traffic and any cross-rail traffic use spines. If A's job is
   placed so that heavy DP groups stay within an SU and only lighter traffic crosses SUs, A barely
   disturbs anyone.

Compare a topology-blind allocation that scatters D's 8 servers across all four SUs: D's rail-local
traffic now crosses spines that A's cross-SU traffic also uses. Same fabric, same mechanisms, worse
isolation.

```widget
parallelism-map
```

### Encapsulation overhead for RoCEv2 over VXLAN

VXLAN adds an outer Ethernet header (14 bytes), outer IPv4 (20), UDP (8) and VXLAN (8): **50 bytes**
(outer IPv6 makes it 70). For a RoCEv2 packet carrying a 4,096-byte payload:

1. Inner packet without VXLAN, counting Ethernet (14) + IPv4 (20) + UDP (8) + BTH (12) + ICRC (4)
   = 58 bytes of headers: 4,096 + 58 = **4,154** bytes (FCS excluded).
2. With VXLAN: 4,154 + 50 = **4,204** bytes.
3. Extra overhead = 50 / 4,204 = **1.2%**.

The bandwidth cost is small; the operational cost is not. The underlay MTU must carry the larger
frame (jumbo frames on every underlay hop), the QoS marking must be copied from the inner DSCP to the
outer header so the underlay applies the lossless or congestion-controlled class, and ECN marks
must survive encapsulation and decapsulation. Verify each of these on your switch and DPU platform;
behaviour is implementation specific.

### Scale limits to check

| Mechanism | Identifier space | Practical limit to check |
|---|---|---|
| IB partitions | 15-bit partition number (up to 32,767 values) | HCA PKey table size (`max_pkeys` in `ibv_devinfo -v`) and SM limits |
| VLANs | 12 bits (4,094 usable) | Per-switch VLAN and MAC table sizes |
| VXLAN VNIs | 24 bits (about 16.7 million) | Per-switch VNI and VRF scale, EVPN route scale |
| VRFs | Implementation specific | Hardware VRF count on leaves |

## In practice

### InfiniBand: partitions in the subnet manager

With OpenSM, partitions are defined in a partitions configuration file; with UFM, through its GUI or
API. An illustrative OpenSM-style definition (check the OpenSM or UFM documentation for the exact
syntax and options of your version):

```text
# Illustrative partitions definition
Default=0x7fff, ipoib : ALL=limited, SELF=full, <shared-service-GUIDs>=full ;
tenant_a=0x0101, ipoib : <tenant-A port GUIDs>=full ;
tenant_b=0x0102, ipoib : <tenant-B port GUIDs>=full ;
```

Read it as: every port is a limited member of the default partition (so tenants cannot reach each
other through it), shared services are full members (so everyone can reach them), and each tenant
has its own partition with full membership. On a host, the PKey table is visible in sysfs under
`/sys/class/infiniband/<device>/ports/<port>/pkeys/`.

### Ethernet: a tenant VRF with EVPN (FRR syntax, illustrative)

```text
vrf tenant-a
 vni 50001
exit-vrf
!
router bgp 65011
 address-family l2vpn evpn
  neighbor FABRIC activate
  advertise-all-vni
 exit-address-family
!
router bgp 65011 vrf tenant-a
 address-family l2vpn evpn
  advertise ipv4 unicast
 exit-address-family
```

This maps VRF `tenant-a` to L3 VNI 50001 and advertises its routes as EVPN type-5 prefixes. Vendor
network operating systems (NVUE on Cumulus Linux, SONiC, others) express the same model with their
own syntax.

### Proving performance isolation

Run tenant A's all-reduce benchmark alone, then again while tenant B runs an all-to-all on adjacent
servers. Record bus bandwidth and tail latency for A in both cases. A well-isolated design shows a
change within run-to-run noise; a poorly placed one shows double-digit drops. Repeat with B placed
across SUs to see the effect of placement directly.

## Common pitfalls

- **Default partition left as full membership for all.** Symptom: tenants can reach each other's
  IPoIB addresses. Cause: every port is a full member of 0x7FFF. Fix: make tenant ports limited
  members of the default partition and full members only of their own.
- **No switch-side enforcement on bare-metal tenants.** Symptom: a tenant with root access crafts
  packets for another partition. Cause: relying only on the host's PKey table. Fix: enable switch
  partition enforcement or host isolation on DPUs.
- **Underlay MTU not raised for VXLAN.** Symptom: RoCE works for small messages, fails or fragments
  for large ones. Cause: 50-byte overhead exceeds the underlay MTU. Fix: jumbo frames on every
  underlay hop.
- **QoS marking lost on encapsulation.** Symptom: RoCE traffic in a VXLAN overlay sees drops or no
  ECN marking. Cause: outer DSCP not derived from the inner header. Fix: configure DSCP copy and
  verify the lossless or congestion-managed class end to end.
- **Topology-blind tenant placement.** Symptom: small tenants see variable performance. Cause:
  their servers are scattered across SUs, sharing spines with large jobs. Fix: allocate by SU and
  rail group; pack small tenants into the same SU on disjoint servers.

## Key takeaways

- Reachability isolation and performance isolation are different problems; solve both.
- InfiniBand partitions use 16-bit P_Keys (15-bit number plus full/limited bit), programmed by the
  SM and checked in hardware.
- Ethernet tenants use VRFs plus VXLAN/EVPN; RoCEv2 over VXLAN adds 50 bytes (about 1.2% at a
  4,096-byte payload) and needs jumbo underlay MTU and correct QoS/ECN handling.
- DPUs enforce tenant policy outside the host's trust domain, which suits bare-metal GPU clouds.
- Whole-server, SU-aware placement removes most link sharing; fabric mechanisms handle the rest.
- Validate isolation with simultaneous multi-tenant benchmarks, not with configuration review alone.
