---
id: hol-clos-bgp-unnumbered
title: "Build a leaf-spine Clos with BGP unnumbered and watch ECMP reconverge"
kind: handson
level: 2
estimated_minutes: 90
environment: containerlab
lessons: [clos-leaf-spine, bgp-in-the-data-center, ecmp-hashing]
files: labs/hol-clos-bgp-unnumbered
verified: true
tier: 0
fabric: any
requires: [linux-vm]
summary: "Six FRR routers in containerlab: eBGP unnumbered over IPv6 link-local, ECMP across two spines, and reconvergence when links fail."
---

> [!NOTE]
> Verified end to end (every task, `check.sh` and the clean-up) with containerlab 0.81.1 and FRR
> 10.2.1 on Ubuntu 24.04 under WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2) on 2026-10-22; see `labs/README.md` for the exact versions and the caveats of WSL2. FRR output formats differ slightly between versions; treat all output below as
> illustrative.

## Goal

Build the routing design used by most AI back-end and front-end Ethernet fabrics: a two-tier Clos
(leaf-spine) running **eBGP with one ASN per leaf**, **BGP unnumbered** (sessions over IPv6
link-local addresses, no IPv4 addresses on fabric links) and **ECMP** across all spines. Then fail a
link two ways and watch the fabric reconverge.

```
              spine1 (AS 65000)        spine2 (AS 65000)
              lo 10.0.0.1              lo 10.0.0.2
             /   |    |   \           /   |    |   \
        leaf1  leaf2  leaf3  leaf4  (each leaf: eth1 -> spine1, eth2 -> spine2)
        65101  65102  65103  65104
        lo .11  .12    .13    .14   (10.0.0.x)
          |      |      |      |
         h1     h2     h3     h4    (192.168.1N.10/24 on leafN eth3)
```

By the end you can:

- Explain and configure BGP unnumbered with FRR (`neighbor ethX interface`).
- Read ECMP routes in FRR and in the Linux kernel, and explain why spines share an ASN.
- Distinguish a failure the leaf sees immediately (link down) from one it detects only by timers,
  and explain what BFD changes.

## Setup

- Ubuntu 24.04 VM, 4 vCPU, 8 GB RAM, internet access to pull images.
- Docker and containerlab: run `labs/setup-ubuntu.sh` or follow `labs/README.md`.
- Images (pulled automatically on first deploy): `quay.io/frrouting/frr:10.2.1` (pinned) and
  `alpine:3.20`. If the FRR tag cannot be pulled, choose another released tag on quay.io and edit
  `topology.clab.yml`.
- Lab files in `labs/hol-clos-bgp-unnumbered/`:
  - `topology.clab.yml`: the containerlab topology.
  - `config/daemons`, `config/vtysh.conf`: shared FRR files (bgpd and bfdd enabled).
  - `config/<node>/frr.conf`: per-node FRR configuration.
  - `check.sh`: verification.

Two helpers make the commands shorter. Paste them into your shell:

```bash
# Run vtysh on a node
vt() { docker exec "clab-hol-clos-$1" vtysh -c "$2"; }
# Run a host binary (ip, tc, tcpdump ...) inside a node's network namespace
cnet() { sudo nsenter -t "$(docker inspect -f '{{.State.Pid}}' "clab-hol-clos-$1")" -n "${@:2}"; }
```

`cnet` uses the host's full `iproute2` instead of the minimal tools inside the containers.

## Tasks

### Task 1: Deploy and read the configuration

```bash
cd labs/hol-clos-bgp-unnumbered
sudo containerlab deploy -t topology.clab.yml
sudo containerlab inspect -t topology.clab.yml
cat config/leaf1/frr.conf
```

Read `config/leaf1/frr.conf` line by line:

| Line | Purpose |
|---|---|
| `frr defaults datacenter` | Data-center timer and behavior profile (for example faster BGP keepalive/hold timers than the "traditional" profile). |
| `interface lo` / `ip address 10.0.0.11/32` | The leaf's loopback: router ID and the address that is advertised and pinged. |
| `router bgp 65101` | A unique private ASN per leaf: loop prevention by AS path, and the AS path tells you which leaf originated a prefix. |
| `no bgp ebgp-requires-policy` | FRR otherwise refuses to send or accept eBGP routes without a route-map (RFC 8212 behavior). A production fabric would use explicit policies instead. |
| `bgp bestpath as-path multipath-relax` | Allows ECMP across paths with different AS paths of equal length. Not strictly needed here (spines share an ASN), but standard in fabrics. |
| `neighbor FABRIC remote-as external` | Accept any eBGP peer ASN; no per-neighbor ASN bookkeeping. |
| `neighbor eth1 interface peer-group FABRIC` | **BGP unnumbered**: peer with whatever router is on `eth1`, discovered via IPv6 router advertisements and link-local addresses. |
| `network ...` | Advertise the loopback and the host subnet. |
| `maximum-paths 64` | Install up to 64 equal-cost paths. |

Wait about 30 seconds for the sessions, then:

```bash
sudo ./check.sh
```

### Task 2: Inspect the unnumbered sessions

```bash
vt leaf1 "show bgp summary"
vt leaf1 "show bgp neighbors eth1" | head -40
cnet leaf1 ip -br addr show
cnet leaf1 ip -6 neigh show dev eth1
```

**What to observe and why:**

- `show bgp summary` lists neighbors by interface (FRR may display `spine1(eth1)`, using the
  hostname capability). A number in the `State/PfxRcd` column means the session is Established
  and shows how many prefixes were received.
- `ip -br addr` shows that `eth1` and `eth2` have **only an IPv6 link-local** address (`fe80::`).
  No /31s to plan, no IPAM for fabric links: with 64 spines and hundreds of leaves this removes a
  lot of configuration.
- `show bgp neighbors eth1` shows the link-local peer address and the negotiated capabilities,
  including the **extended next hop** capability (RFC 8950, previously RFC 5549), which lets IPv4
  routes be advertised with an IPv6 next hop.

### Task 3: ECMP in the control plane and the kernel

```bash
vt leaf1 "show bgp ipv4 unicast 10.0.0.14/32"
vt leaf1 "show ip route bgp"
cnet leaf1 ip route show 10.0.0.14
cnet leaf1 ip route show 192.168.14.0/24
cnet leaf1 ip nexthop show
```

Illustrative excerpt of `show bgp ipv4 unicast 10.0.0.14/32`:

```
Paths: (2 available, best #1, table default)
  65000 65104
    spine1(eth1) from spine1(eth1) (10.0.0.1)
      Origin IGP, metric 0, valid, external, multipath, best (Router ID)
  65000 65104
    spine2(eth2) from spine2(eth2) (10.0.0.2)
      Origin IGP, metric 0, valid, external, multipath
```

Illustrative kernel view (the exact form depends on the FRR and kernel versions):

```
10.0.0.14 nhid 30 proto bgp metric 20
        nexthop via inet6 fe80::a8c1:abff:fe11:2201 dev eth1 weight 1
        nexthop via inet6 fe80::a8c1:abff:fe22:2201 dev eth2 weight 1
```

**Why:** both paths have the same AS path length, so both are marked `multipath` and installed
as an ECMP group. Depending on versions, the kernel shows a nexthop group (`nhid`, inspect it with
`ip nexthop show id N`), IPv4-over-IPv6 next hops (`via inet6 fe80::...`), or the older
`via 169.254.0.1 ... onlink` trick with a static neighbor entry. All three forward IPv4 packets to
the neighbor's MAC address without any IPv4 address on the link.

### Task 4: Why the spines share one ASN (valley-free routing)

```bash
vt spine1 "show bgp ipv4 unicast 10.0.0.12/32"
vt leaf1 "show bgp ipv4 unicast neighbors eth2 advertised-routes"
```

**Observe:** spine1 has a single path to leaf2's loopback, directly from leaf2. leaf1 does
re-advertise what it learned from spine1 towards spine2, but spine2 drops it because its own ASN
(65000) is already in the AS path. That is the point of giving all spines one ASN: a path
leaf -> spine -> leaf -> spine (a "valley") is never accepted, so traffic between leaves always
crosses exactly one spine. With a different ASN per spine, valley paths would be accepted as
longer backups, which can attract traffic through leaves during failures.

### Task 5: Watch the data plane pick a path

```bash
docker exec clab-hol-clos-h1 ping -c 3 192.168.14.10
docker exec clab-hol-clos-h1 traceroute -n 192.168.14.10
```

Illustrative traceroute:

```
 1  192.168.11.1    0.05 ms  0.03 ms  0.03 ms
 2  10.0.0.1        0.06 ms  0.04 ms  0.04 ms
 3  10.0.0.14       0.07 ms  0.05 ms  0.05 ms
 4  192.168.14.10   0.08 ms  0.06 ms  0.06 ms
```

**Why:** the spine has no IPv4 address on its links, so it sources ICMP time-exceeded messages from
another local address, typically its loopback; that is how you can tell which spine a hop is.

All three probes per hop normally take the same spine because Linux hashes only on source and
destination IP by default (`fib_multipath_hash_policy=0`). Switch leaf1 to a 5-tuple hash and run
traceroute a few times (each run uses a new UDP source port, so each run is a different "flow"):

```bash
cnet leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=1
for i in 1 2 3 4 5; do docker exec clab-hol-clos-h1 traceroute -n 192.168.14.10 | sed -n 3p; done
cnet leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=0
```

Usually some runs now show `10.0.0.1` and others `10.0.0.2` at hop 2 (with 5 runs, all of them
pick the same spine about one time in 16). Traceroute also changes the UDP destination port for
every probe, yet in this lab all probes of one run normally take the same spine. The most likely
reason: with policy 1, a forwarding Linux router reuses an L4 flow hash that is already attached to
the packet (computed on the sending host and carried across the veth links) instead of hashing the
headers again. A hardware switch hashes the headers it receives, so there the probes of one hop can
spread over both spines. The `hol-ecmp-entropy` lab explores hashing in depth.

### Task 6: Hard failure: the leaf sees the link go down

In a second terminal, watch leaf1's routes:

```bash
watch -n 0.5 "docker exec clab-hol-clos-leaf1 vtysh -c 'show ip route 10.0.0.14/32'"
```

In the first terminal, take down leaf1's link to spine1 and bring it back after a while:

```bash
date +%T; cnet leaf1 ip link set eth1 down
vt leaf1 "show bgp summary"
# ... observe for ~20 s, then restore:
date +%T; cnet leaf1 ip link set eth1 up
```

**What to observe and why:** the route drops to a single next hop (`eth2`) essentially
immediately (FRR may briefly list the `eth1` next hop as `inactive` before BGP removes it). When
an interface goes down, FRR tears down the BGP session at once (fast external
fallover) and zebra removes the next hop from the kernel. When the link comes back, the session
needs a few seconds to re-establish and readvertise (router advertisements, TCP connect, OPEN,
UPDATE), so recovery is slower than failure. Note that the veth peer on spine1 also sees the link
lose carrier, so spine1 reacts immediately too.

### Task 7: Gray failure: the link stays up but drops everything

Real optics and cables often fail "gray": the link is up but frames are corrupted or lost in one
direction. Simulate it by dropping everything spine1 sends towards leaf1 (requires the `sch_netem`
kernel module on the host; on Ubuntu it may be in `linux-modules-extra-$(uname -r)`):

```bash
date +%T; cnet spine1 tc qdisc add dev eth1 root netem loss 100%
for i in $(seq 1 15); do date +%T; vt leaf1 "show bgp summary" | grep eth1; sleep 1; done
vt leaf1 "show bgp neighbors eth1" | grep -iE 'hold time|keepalive'
```

Restore:

```bash
cnet spine1 tc qdisc del dev eth1 root
```

**What to observe and why:** leaf1's interface stays up, so nothing happens until the **BGP hold
timer** expires (with the datacenter profile, a hold time of about 9 seconds; the
`show bgp neighbors` output shows the actual values). During that time leaf1 keeps hashing part of
its traffic onto a path that black-holes it. In an AI training job, several seconds of loss on some
flows can stall a collective and trip application-level timeouts.

### Task 8 (optional): BFD shrinks the detection time

BFD sends small hello packets at a high rate and tears down BGP when they stop. `bfdd` is already
enabled in `config/daemons`. Enable BFD for the fabric peer group on leaf1 and spine1:

```bash
docker exec -it clab-hol-clos-leaf1 vtysh
```

```
configure terminal
router bgp 65101
 neighbor FABRIC bfd
end
show bfd peers brief
exit
```

```bash
docker exec -it clab-hol-clos-spine1 vtysh
```

```
configure terminal
router bgp 65000
 neighbor FABRIC bfd
end
show bfd peers brief
exit
```

Repeat Task 7. With FRR's default BFD timers (300 ms intervals, detect multiplier 3; check
`show bfd peers` for the values in your version), the session should drop in roughly a second
instead of the hold time. On leaf1, the BFD session towards spine2 stays `down` because spine2 has
no BFD configured; when this lab was tested, that did not affect the Established leaf1-spine2 BGP
session (check `show bgp summary`).

## Verify

```bash
sudo ./check.sh
```

With all links restored, the script checks that all 10 containers are running, that each spine has
4 and each leaf 2 Established sessions, that leaf1 reaches leaf4's loopback and subnet over 2 ECMP
next hops, and that h1 can ping h2, h3 and h4.

## Clean up

```bash
sudo containerlab destroy -t topology.clab.yml --cleanup
```

`--cleanup` also removes the lab directory containerlab created (`clab-hol-clos/`).

## What you learned

- A leaf-spine Clos with eBGP, a shared spine ASN and one ASN per leaf gives loop-free,
  valley-free ECMP with a very small configuration.
- BGP unnumbered removes per-link IPv4 addressing by peering over IPv6 link-local addresses and
  using extended next hops.
- ECMP shows up in FRR as multiple `multipath` paths and in the kernel as a multipath route or a
  nexthop group.
- Link-down failures converge almost instantly; gray failures wait for the hold timer unless you run
  BFD.

## Going further on real hardware

- Production data-center switches (for example SONiC, Cumulus Linux/NVIDIA, Arista EOS, Cisco
  NX-OS) all support BGP unnumbered or an equivalent; the syntax differs, so consult your NOS
  documentation. Many AI fabrics use hundreds of leaves and dozens of spines; check how many ECMP
  next hops your switch ASIC supports.
- Add route-maps instead of `no bgp ebgp-requires-policy`: allow only loopbacks and host subnets,
  and consider tagging prefixes with communities per pod.
- Measure convergence properly: run a constant-rate stream between hosts (for example `iperf3 -u`
  with a fixed rate) and count lost packets during each failure type, with and without BFD.
- In a rail-optimized AI back-end fabric the same eBGP design is used per rail or per plane; the
  lessons on cluster design explain how the topology changes.
