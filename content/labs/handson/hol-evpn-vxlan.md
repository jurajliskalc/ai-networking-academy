---
id: hol-evpn-vxlan
title: "EVPN-VXLAN on FRR: stretch a Layer 2 segment over a routed fabric"
kind: handson
level: 3
estimated_minutes: 90
environment: containerlab
lessons: [evpn-vxlan-frontend]
files: labs/hol-evpn-vxlan
verified: true
tier: 0
fabric: any
requires: [linux-vm]
summary: "Two FRR VTEPs and a spine in containerlab stretch one Layer 2 segment over a routed underlay with EVPN type-2 and type-3 routes."
---

> [!NOTE]
> Verified end to end (every task, `check.sh` and the clean-up) with containerlab 0.81.1 and FRR
> 10.2.1 on Ubuntu 24.04 under WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2) on 2026-10-22; see `labs/README.md` for the exact versions and the caveats of WSL2. FRR output formats differ slightly between versions; treat all output below as
> illustrative.

## Goal

AI clusters usually run their **front-end** network (user access, storage, orchestration,
multi-tenant services) as an EVPN-VXLAN fabric: a routed leaf-spine underlay with Layer 2 and
Layer 3 services built on top. In this lab you build the smallest useful version: two leaves acting
as **VTEPs**, one spine, and two hosts in the same subnet on different leaves, connected through an
**L2VNI** (VNI 100).

By the end you can:

- Configure a Linux bridge + VXLAN device as a VTEP and enable EVPN for it in FRR.
- Read EVPN **type-3** (inclusive multicast, the flood list) and **type-2** (MAC/IP) routes and
  connect them to the kernel's bridge FDB.
- Capture VXLAN on the spine and identify outer and inner headers.
- Explain the overlay MTU requirement.

```
                 spine1 (AS 65000)  -- relays EVPN routes, routes the underlay
                /                \
   leaf1 (AS 65101)          leaf2 (AS 65102)
   VTEP 10.0.0.11            VTEP 10.0.0.12
   br100 + vxlan100          br100 + vxlan100     (VNI 100)
        |                         |
   h1 192.168.100.11/24      h2 192.168.100.12/24
```

## Setup

- Ubuntu 24.04 VM, 4 vCPU, 8 GB RAM; Docker and containerlab (`labs/setup-ubuntu.sh` or
  `labs/README.md`); the host's `iproute2` and `tcpdump`.
- Images: `quay.io/frrouting/frr:10.2.1` (pinned) and `alpine:3.20`.
- Lab files in `labs/hol-evpn-vxlan/`:
  - `topology.clab.yml`, `config/daemons`, `config/vtysh.conf`, `config/<node>/frr.conf`.
  - `vxlan-setup.sh`: creates `br100` and `vxlan100` on both leaves (the Linux equivalent of the
    interface configuration a switch OS would apply).
  - `check.sh`: verification.
- The `hol-clos-bgp-unnumbered` lab explains the underlay (eBGP unnumbered); this lab reuses it.

Helpers:

```bash
vt() { docker exec "clab-hol-evpn-$1" vtysh -c "$2"; }
cnet() { sudo nsenter -t "$(docker inspect -f '{{.State.Pid}}' "clab-hol-evpn-$1")" -n "${@:2}"; }
```

## Tasks

### Task 1: Deploy the underlay and look at the empty overlay

```bash
cd labs/hol-evpn-vxlan
sudo containerlab deploy -t topology.clab.yml
sleep 20
vt leaf1 "show bgp ipv4 unicast summary"
vt leaf1 "show ip route 10.0.0.12/32"
vt leaf1 "show bgp l2vpn evpn summary"
vt leaf1 "show evpn vni"
```

**Observe:** the underlay works (leaf1 has a BGP route to leaf2's loopback 10.0.0.12 via the
spine) and the EVPN address family is negotiated on the same sessions, but there are no VNIs yet and
no EVPN routes. Read `config/leaf1/frr.conf`: `advertise-all-vni` tells FRR to advertise every
VXLAN VNI that zebra finds in the kernel, and the `vni 100` block sets an explicit route
distinguisher and route targets. Explicit route targets are used because with one ASN per leaf the
automatically derived values (ASN:VNI) would differ between leaves. On the spine,
`attribute-unchanged next-hop` keeps the leaf's VTEP address as the EVPN next hop.

### Task 2: Create the VTEPs

```bash
sudo ./vxlan-setup.sh
cnet leaf1 ip -d link show vxlan100
cnet leaf1 bridge link show
vt leaf1 "show evpn vni"
vt leaf1 "show evpn vni 100"
```

Illustrative excerpt of `show evpn vni 100`:

```
VNI: 100
 Type: L2
 Tenant VRF: default
 VxLAN interface: vxlan100
 Local VTEP IP: 10.0.0.11
 Mcast group: 0.0.0.0
 Remote VTEPs for this VNI:
  10.0.0.12 flood: HER
```

**Why:** `vxlan100` is a VXLAN device with VNI 100, source address 10.0.0.11 (the loopback),
destination UDP port 4789 (IANA), and `nolearning`: the kernel must not learn remote MACs from
incoming packets, because EVPN will program them. It is a port of bridge `br100` together with the
host-facing `eth2`, so the bridge connects the local host to the overlay. zebra detected the new
VNI, bgpd originated an EVPN route for it, and leaf2 did the same, so each leaf now lists the other
as a remote VTEP with **head-end replication** (HER) for flooding.

### Task 3: Type-3 routes build the flood list

```bash
vt leaf1 "show bgp l2vpn evpn route type multicast"
cnet leaf1 bridge fdb show dev vxlan100
```

Illustrative excerpt:

```
   Network          Next Hop            Metric LocPrf Weight Path
Route Distinguisher: 10.0.0.11:100
*> [3]:[0]:[32]:[10.0.0.11]
                    10.0.0.11                          32768 i
Route Distinguisher: 10.0.0.12:100
*> [3]:[0]:[32]:[10.0.0.12]
                    10.0.0.12                              0 65000 65102 i
...
00:00:00:00:00:00 dst 10.0.0.12 self permanent
```

**Why:** a type-3 (Inclusive Multicast Ethernet Tag) route says "VTEP 10.0.0.12 is interested in
VNI 100's broadcast, unknown-unicast and multicast traffic". zebra turns it into the all-zeros FDB
entry on `vxlan100`: BUM frames are copied to each listed VTEP (head-end replication), so no
multicast is needed in the underlay.

### Task 4: Traffic creates type-2 routes

```bash
docker exec clab-hol-evpn-h1 ping -c 3 192.168.100.12
docker exec clab-hol-evpn-h2 ip link show eth1          # note h2's MAC address
vt leaf1 "show bgp l2vpn evpn route type macip"
vt leaf1 "show evpn mac vni 100"
cnet leaf1 bridge fdb show br br100 | grep -v permanent
```

**What to observe and why:**

- The first ARP request from h1 is flooded to leaf2 via the type-3 flood list. h2's MAC is learned
  **locally** on leaf2 (on `eth2`, by the bridge), and leaf2 advertises it as a **type-2** route
  (`[2]:[0]:[48]:[<mac>]`). leaf1 installs it into the kernel.
- `show evpn mac vni 100` lists h1's MAC as `local` (interface `eth2`) and h2's MAC as `remote`
  with VTEP 10.0.0.12.
- In the bridge FDB, the remote MAC appears on `vxlan100` with `extern_learn` (installed by the
  control plane, not learned from traffic) together with its `dst 10.0.0.12`.
- These type-2 routes carry only a MAC address. FRR adds the IP (MAC+IP routes) when it can learn
  host IP-to-MAC bindings, for example from neighbor entries on an SVI with an IP address in the
  bridge; that is also the basis for ARP suppression (see "Going further").

### Task 5: Read one EVPN route in full

```bash
vt leaf1 "show bgp l2vpn evpn route rd 10.0.0.12:100"
```

**Observe in the output:** the route distinguisher (makes the route unique per VTEP), the AS path
(`65000 65102`), the next hop **10.0.0.12** (the remote VTEP, unchanged by the spine), the label
(VNI 100), and extended communities such as the route target `RT:65000:100` and the encapsulation
type (FRR prints it as `ET:8`; 8 is the BGP tunnel encapsulation type for VXLAN). The type-3 route
also carries a `PMSI Tunnel Type: Ingress Replication` attribute: that is how leaf2 asks for
head-end replication. The route target is what decides that leaf1 imports this route into VNI 100.

### Task 6: See VXLAN on the wire

```bash
# Terminal 2: capture on the spine's link to leaf1
cnet spine1 tcpdump -ni eth1 -c 6 udp port 4789
# Terminal 1
docker exec clab-hol-evpn-h1 ping -c 3 192.168.100.12
```

Illustrative output:

```
IP 10.0.0.11.48213 > 10.0.0.12.4789: VXLAN, flags [I] (0x08), vni 100
IP 192.168.100.11 > 192.168.100.12: ICMP echo request, id 7, seq 0, length 64
```

**Why:** the spine only routes outer IPv4/UDP packets between loopbacks; it knows nothing about
192.168.100.0/24 or the hosts' MACs. The outer UDP source port is derived from a hash of the inner
frame, which gives the underlay ECMP entropy per inner flow (the same idea as the RoCEv2 source
port). VXLAN adds 50 bytes (outer Ethernet 14 + IPv4 20 + UDP 8 + VXLAN 8) to every frame.

### Task 7: The overlay MTU trap

containerlab creates its links with a large default MTU (9500 at the time of writing; check with
`docker exec clab-hol-evpn-h1 ip link show eth1`), and `vxlan-setup.sh` set `vxlan100` to 1500.

```bash
docker exec clab-hol-evpn-h1 ip link show eth1 | grep -o 'mtu [0-9]*'
docker exec clab-hol-evpn-h1 ping -c 2 -W 1 -s 1400 192.168.100.12    # works
docker exec clab-hol-evpn-h1 ping -c 2 -W 1 -s 2000 192.168.100.12    # fails
```

**Why:** h1 believes it can send 2028-byte packets unfragmented, but the bridge cannot forward a
frame larger than the `vxlan100` port's MTU and silently drops it (the same L2 black hole as in
`hol-linux-net-basics`). Two fixes:

```bash
# Fix A: hosts use the overlay MTU (h1 now fragments large pings itself)
docker exec clab-hol-evpn-h1 ip link set eth1 mtu 1500
docker exec clab-hol-evpn-h2 ip link set eth1 mtu 1500
docker exec clab-hol-evpn-h1 ping -c 2 -s 2000 192.168.100.12

# Fix B (what fabrics do): give the overlay a jumbo MTU; the underlay must carry it + 50 bytes
cnet leaf1 ip link set vxlan100 mtu 9000
cnet leaf2 ip link set vxlan100 mtu 9000
```

After Fix B, set the host MTUs back up (for example to 9000) and test with `-s 8000`. The rule:
**underlay MTU >= overlay MTU + 50** (more with IPv6 underlay or extra tags).

### Task 8: Withdraw a MAC

```bash
docker exec clab-hol-evpn-h2 ip link set eth1 down
sleep 3
vt leaf1 "show evpn mac vni 100"
docker exec clab-hol-evpn-h2 ip link set eth1 up
docker exec clab-hol-evpn-h2 ping -c 1 192.168.100.11
vt leaf1 "show evpn mac vni 100"
```

**Observe:** when h2's link goes down, leaf2's bridge flushes the MAC, leaf2 withdraws the type-2
route, and leaf1 removes the remote entry. When h2 sends traffic again, the MAC is relearned and
re-advertised. EVPN also tracks MAC moves between VTEPs with a sequence number (shown in the route
details) so that a host moving between leaves is handled deterministically.

## Verify

```bash
sudo ./check.sh
```

The script checks the containers, EVPN sessions on the spine and both leaves, that each leaf has
`vxlan100` and lists the other leaf as a remote VTEP, that h1 can ping h2, that leaf1 holds type-2
and type-3 routes, and that leaf1's `vxlan100` FDB points to VTEP 10.0.0.12.

## Clean up

```bash
sudo containerlab destroy -t topology.clab.yml --cleanup
```

The bridge and VXLAN devices live inside the containers' network namespaces and disappear with them.

## What you learned

- A VTEP on Linux is a bridge plus a VXLAN device sourced from the loopback; EVPN (`advertise-all-vni`)
  replaces flood-and-learn with BGP routes.
- Type-3 routes build the per-VNI flood list (head-end replication); type-2 routes distribute MAC
  (and MAC+IP) reachability, which zebra programs into the bridge FDB.
- The spine only routes VXLAN packets between VTEP loopbacks and relays EVPN routes, keeping the
  next hop unchanged.
- VXLAN adds 50 bytes; the underlay MTU must account for it, or large frames vanish silently.

## Going further on real hardware

- **ARP suppression and MAC+IP routes:** add an SVI (an IP on `br100` or a VLAN interface) and
  enable neighbor suppression on the VXLAN port (`bridge link set dev vxlan100 neigh_suppress on`);
  then check `show evpn arp-cache vni 100`. On switches, use your NOS's ARP/ND suppression feature.
- **Routing between subnets:** configure an L3VNI with a tenant VRF and a distributed anycast
  gateway (symmetric IRB), which produces type-5 (IP prefix) routes. FRR's EVPN documentation has
  worked examples.
- **Multihoming:** connect a host to two leaves with an Ethernet Segment (ESI) and LACP; observe
  type-1 and type-4 routes. Support and syntax differ by NOS.
- In AI clusters, EVPN-VXLAN typically serves the front-end and storage networks and multi-tenant
  isolation, while the GPU back-end fabric is usually plain routed (or InfiniBand) to keep the RDMA
  path simple; check the cluster design lessons for when that changes.
