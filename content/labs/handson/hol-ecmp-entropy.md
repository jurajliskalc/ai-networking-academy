---
id: hol-ecmp-entropy
title: "ECMP hashing and flow entropy: why a few big flows collide"
kind: handson
level: 3
estimated_minutes: 75
environment: linux-vm
lessons: [ecmp-hashing, flow-collisions-entropy]
files: labs/hol-ecmp-entropy
verified: false
---

> [!NOTE]
> This lab has been syntax-checked (`bash -n` on every script) but has not yet been executed end
> to end on a real VM. Your exact numbers will differ from any example: hashing results depend on
> the kernel version, a random per-boot hash key and the ephemeral ports your flows get.

## Goal

Static ECMP picks a path per **flow** by hashing header fields. AI training traffic has very low
**entropy**: few, long-lived, huge flows between a fixed set of endpoints. This lab makes that
visible with a two-spine "fabric" built from Linux network namespaces, where leaf1 load-balances
over two spines using the kernel's multipath routing.

By the end you can:

- Configure and inspect a Linux ECMP route and its hash policy.
- Show that an L3 (IP-pair) hash puts all flows between two hosts on one path, and an L4 (5-tuple)
  hash spreads them.
- Measure how the balance depends on the number of flows, and how a collision of two elephant flows
  halves their throughput.
- Explain why RoCEv2 UDP source ports, more QPs per connection, adaptive routing and packet
  spraying are used in AI fabrics.

```
                     +--- ecmp-sp1 ---+
  ecmp-h1 --- ecmp-leaf1            ecmp-leaf2 --- ecmp-h2
 10.5.1.10           +--- ecmp-sp2 ---+          10.5.2.10
```

## Setup

- Ubuntu 24.04 VM, 2+ vCPU. Packages: `iproute2`, `iperf3`, `python3` (installed by
  `labs/setup-ubuntu.sh`, or `sudo apt-get install -y iproute2 iperf3 python3`). If the iperf3
  package asks whether to start a daemon at boot, answer No.
- Lab files in `labs/hol-ecmp-entropy/`:
  - `setup.sh` / `cleanup.sh`: build and remove the six namespaces.
  - `count.sh`: runs any command and prints how many packets and bytes each spine received from
    leaf1 while it ran.
  - `udp_flows.py`: sends N UDP flows that differ only in source port.
  - `check.sh`: verification.

```bash
cd labs/hol-ecmp-entropy
sudo ./setup.sh
```

## Tasks

### Task 1: Inspect the ECMP route and the hash policy

```bash
sudo ip -n ecmp-leaf1 route show 10.5.2.0/24
sudo ip netns exec ecmp-leaf1 sysctl net.ipv4.fib_multipath_hash_policy
sudo ip netns exec ecmp-h1 ping -c 3 10.5.2.10
sudo ip -n ecmp-sp1 -s link show to-leaf1
sudo ip -n ecmp-sp2 -s link show to-leaf1
```

Illustrative route output:

```
10.5.2.0/24
        nexthop via 10.5.11.1 dev to-sp1 weight 1
        nexthop via 10.5.12.1 dev to-sp2 weight 1
```

**Why:** this is a static multipath route: two equal-weight next hops, the same thing BGP
installed in the `hol-clos-bgp-unnumbered` lab. The hash policy is a per-network-namespace sysctl;
each namespace here behaves like a separate switch. `ip -s link` RX counters on each spine's
`to-leaf1` interface tell you which path leaf1 chose; `count.sh` automates reading them.

The IPv4 hash policies are documented in the kernel's `Documentation/networking/ip-sysctl.rst`:

| Value | Fields hashed | Availability |
|---|---|---|
| 0 | Source and destination IP (L3) | Default |
| 1 | 5-tuple: IPs, protocol, ports (L4) | Long-standing |
| 2 | L3, or the inner L3 header of encapsulated packets | Newer kernels (check `ip-sysctl.rst` for your version) |
| 3 | Custom set of fields chosen with `net.ipv4.fib_multipath_hash_fields` | Newer kernels (check `ip-sysctl.rst` for your version) |

### Task 2: Start an iperf3 server on h2

```bash
sudo ip netns exec ecmp-h2 iperf3 -s -D -I /tmp/ecmp-iperf3.pid
```

(`-D` daemonizes, `-I` writes a PID file that `cleanup.sh` uses to stop it.)

### Task 3: L3 hashing: eight flows, one path

```bash
sudo ./count.sh ip netns exec ecmp-h1 iperf3 -c 10.5.2.10 -P 8 -t 5
```

Illustrative result:

```
spine       packets     pkt%            bytes    byte%
sp1          412345     100%       6123456789     100%
sp2              12       0%             1032       0%
```

**Why:** with policy 0 every one of the 8 TCP connections has the same source and destination IP,
so the same hash, so the same spine. Half of the fabric is idle. This is the default behavior of
the Linux kernel's IPv4 multipath routing; switches have their own (configurable) defaults, so
always check what your fabric hashes on.

### Task 4: L4 hashing: the same flows, spread (unevenly)

```bash
sudo ip netns exec ecmp-leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=1
sudo ./count.sh ip netns exec ecmp-h1 iperf3 -c 10.5.2.10 -P 8 -t 5
sudo ./count.sh ip netns exec ecmp-h1 iperf3 -c 10.5.2.10 -P 8 -t 5
sudo ./count.sh ip netns exec ecmp-h1 iperf3 -c 10.5.2.10 -P 8 -t 5
```

**What to observe and why:** now both spines carry traffic, but the split is rarely 50/50 and
changes from run to run (for example 62/38, then 50/50, then 75/25). Each run gets new ephemeral
source ports, so new hashes. With only 8 flows, the law of large numbers has not kicked in: the
chance that 8 flows split exactly 4/4 over 2 paths is only about 27%. Remember that a split in
**bytes** is what matters for congestion; a split in flow count is not the same thing when flows
have different sizes.

### Task 5: Predict the path of a flow

The kernel can tell you which next hop it would pick for a given 5-tuple:

```bash
for sp in $(seq 20000 20015); do
  printf 'sport %s -> ' $sp
  sudo ip -n ecmp-leaf1 route get 10.5.2.10 from 10.5.1.10 iif to-h1 \
      ipproto udp sport $sp dport 9999 | grep -o 'dev [a-z0-9-]*'
done
```

**Why:** this is the same deterministic function the data plane uses, so you can predict
collisions before they happen. Switch vendors offer similar "which member would this flow use"
commands on some platforms; check your NOS documentation. If your `ip` version rejects the
`ipproto`/`sport`/`dport` keywords, skip this task.

### Task 6: Entropy: more flows, better balance

Use `udp_flows.py` to send N flows of 100 small packets each, all between the same two IPs, varying
only the UDP source port (policy is still 1):

```bash
for n in 2 4 16 64 256; do
  echo "=== $n flows"
  sudo ./count.sh ip netns exec ecmp-h1 python3 udp_flows.py --flows $n --pkts 100 | tail -3
done
```

Then repeat with a different port range, for example `--base-port 31000`.

**What to observe and why:** with 2 or 4 flows you often get 100/0 or 75/25 splits; with 256 flows
the split is close to 50/50. Every flow here carries the same number of packets, so imbalance comes
only from hash collisions. This is the core problem of AI traffic: one training job between a few
GPU servers may present only a handful of RoCEv2 flows per link, so static ECMP regularly stacks
two elephant flows on one link while another link idles. For RoCEv2, the per-QP **UDP source port**
is the knob that adds entropy (see the `hol-rocev2-wireshark` lab); collective libraries can also
spread traffic over more QPs (NCCL has settings for this; check its documentation for your
version).

To prove that only the 5-tuple matters, switch back to policy 0 and run 256 flows: everything goes
to one spine again.

```bash
sudo ip netns exec ecmp-leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=0
sudo ./count.sh ip netns exec ecmp-h1 python3 udp_flows.py --flows 256 --pkts 20 | tail -3
sudo ip netns exec ecmp-leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=1
```

### Task 7: What a collision costs

Give each leaf1 uplink a 200 Mbit/s capacity with a token bucket filter, so the links become the
bottleneck (as fabric links are under a collective):

```bash
for l in to-sp1 to-sp2; do
  sudo ip netns exec ecmp-leaf1 tc qdisc add dev $l root tbf rate 200mbit burst 64kb latency 50ms
done
for i in 1 2 3 4 5; do
  sudo ip netns exec ecmp-h1 iperf3 -c 10.5.2.10 -P 2 -t 5 | grep -E 'SUM.*receiver'
done
```

**What to observe and why:** two TCP flows, 400 Mbit/s of total uplink capacity. When the hash puts
the flows on different spines, the `[SUM]` receiver line shows close to 400 Mbit/s; when both land
on the same spine, the sum drops to about 200 Mbit/s: two flows share one link while the other is
empty. On average over many runs, with 2 flows and 2 paths, half of the runs collide. In a
synchronized collective, the slowest flow sets the step time, so one collision slows down the whole
job.

Remove the shapers:

```bash
for l in to-sp1 to-sp2; do sudo ip netns exec ecmp-leaf1 tc qdisc del dev $l root; done
```

### Task 8 (optional): Custom hash fields

If your kernel supports policy 3, you can choose exactly which fields are hashed. Read the
`fib_multipath_hash_fields` description in your kernel's `ip-sysctl.rst` first (the field bitmask
is documented there), then for example hash only on source IP and source port:

```bash
sudo ip netns exec ecmp-leaf1 sysctl net.ipv4.fib_multipath_hash_fields
# Example from the documentation's bit list; verify the bit values for your kernel before using:
# sudo ip netns exec ecmp-leaf1 sysctl -w net.ipv4.fib_multipath_hash_fields=<bitmask>
# sudo ip netns exec ecmp-leaf1 sysctl -w net.ipv4.fib_multipath_hash_policy=3
```

Re-run Task 6 and confirm that varying the source port still spreads flows, and that varying only
the destination port (edit `udp_flows.py` or use iperf3 with different server ports) does not.

## Verify

```bash
sudo ./check.sh
```

The script checks the namespaces, the two-next-hop route and h1-to-h2 reachability, then sends 64
UDP flows under policy 0 (expects one spine to carry at least 95% of packets) and under policy 1
(expects each spine to carry at least 10%), and restores the original policy.

## Clean up

```bash
sudo ./cleanup.sh
```

## What you learned

- Linux multipath routes hash per flow; `fib_multipath_hash_policy` selects L3 (0) or L4 (1)
  fields, and newer kernels add more options.
- An L3 hash cannot separate flows between the same two hosts; an L4 hash can, if ports differ.
- Few flows means poor balance and frequent collisions; collisions halve the throughput of the
  colliding flows on a saturated fabric.
- AI fabrics fight low entropy with more flows (QPs), RoCEv2 source-port entropy, and ultimately
  adaptive routing or packet spraying instead of static per-flow hashing.

## Going further on real hardware

- On your switches, find the ECMP hash configuration (fields, seed, and whether RoCEv2 UDP source
  port is included). The commands and defaults are vendor-specific.
- **Polarization:** when two tiers of switches use the same hash function, seed and fields, the
  second tier can make the same decision for every flow the first tier sent to it, leaving some
  paths unused. Try to reproduce it here: add a second ECMP stage (for example, give each spine two
  parallel links to leaf2 with a multipath route) and compare the split on the second stage. Because
  all namespaces share one kernel, they may share the same hash key; newer kernels also offer a
  `net.ipv4.fib_multipath_hash_seed` sysctl (check `ip-sysctl.rst`) that would let you give each
  "switch" a different seed. Real fabrics avoid polarization with per-switch seeds or different
  hash fields per tier.
- Compare static ECMP with fabrics that use adaptive routing or packet spraying (covered in the
  load-balancing lessons) by running the same collision experiment with real RoCE NICs.
