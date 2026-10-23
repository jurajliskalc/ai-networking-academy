---
id: hol-linux-net-basics
title: "Linux networking toolkit: namespaces, veth, bridges and an MTU black hole"
kind: handson
level: 1
estimated_minutes: 60
environment: linux-vm
lessons: [linux-networking-toolkit, mtu-jumbo-frames]
files: labs/hol-linux-net-basics
verified: true
tier: 0
fabric: any
requires: [linux-vm]
summary: "Namespaces, veth pairs and a bridge form a tiny rack; reproduce and diagnose the classic jumbo-frame black hole."
---

> [!NOTE]
> Verified end to end (every task, `check.sh` and `cleanup.sh`) on Ubuntu 24.04 under WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2) on 2026-10-22; see `labs/README.md` for the exact versions and the caveats of WSL2.
> If a command behaves differently on your system, please report it.

## Goal

Build a tiny "rack" out of Linux network namespaces, veth pairs and a Linux bridge, then use it to
reproduce the most common jumbo-frame failure in AI clusters: **an MTU mismatch on one hop that
silently drops large packets while small packets (ping, SSH, BGP keepalives) keep working.** Along
the way you will use the everyday toolkit: `ip`, `ip -s link`, `ethtool`, `ping -M do -s` and
`tcpdump`.

By the end you can:

- Create namespaces, veth pairs and a bridge, and explain what each object is.
- Prove an MTU mismatch with DF-bit pings and locate the dropping hop with counters and `tcpdump`.
- Explain why an L2 MTU mismatch is a black hole while an L3 mismatch produces an ICMP error.

## Setup

- Ubuntu 24.04 VM (any recent Linux works), root access via `sudo`.
- Packages: `iproute2`, `iputils-ping`, `ethtool`, `tcpdump` (all installed by
  `labs/setup-ubuntu.sh`, or `sudo apt-get install -y iproute2 iputils-ping ethtool tcpdump`).
- Lab files: `labs/hol-linux-net-basics/` (`setup.sh` builds Tasks 1-2 for you, `cleanup.sh`
  removes everything, `check.sh` verifies the end state).

Everything lives in namespaces and devices named `hol1-*`, `a-*`, `b-*`, `r-*`, `c-*` and
`br-hol1`, so it does not touch your VM's real interfaces.

```
 hol1-a                     host namespace                      hol1-b
+-----------+        +---------------------------+        +-----------+
| a-eth0    |==veth==| a-br    br-hol1     b-br  |==veth==| b-eth0    |
| 10.10.0.1 |        |      (Linux bridge)       |        | 10.10.0.2 |
+-----------+        +---------------------------+        +-----------+
```

## Tasks

### Task 1: Build two "servers" and a "switch"

A network namespace is a separate copy of the kernel network stack: its own interfaces, routes,
ARP table and sysctls. A veth pair is a virtual cable: whatever enters one end leaves the other.
A Linux bridge is a software L2 switch.

```bash
sudo ip netns add hol1-a
sudo ip netns add hol1-b

sudo ip link add br-hol1 type bridge
sudo ip link set br-hol1 up

# Let frames switched by br-hol1 pass the host firewall (see the note below)
sudo iptables -I FORWARD -i br-hol1 -o br-hol1 -j ACCEPT

# Cable 1: a-eth0 (inside hol1-a) <-> a-br (bridge port in the host)
sudo ip link add a-br type veth peer name a-eth0
sudo ip link set a-eth0 netns hol1-a
sudo ip link set a-br master br-hol1
sudo ip link set a-br up

# Cable 2: b-eth0 (inside hol1-b) <-> b-br
sudo ip link add b-br type veth peer name b-eth0
sudo ip link set b-eth0 netns hol1-b
sudo ip link set b-br master br-hol1
sudo ip link set b-br up

# Bring up the namespace ends and address them
for n in a b; do
  sudo ip -n hol1-$n link set lo up
  sudo ip -n hol1-$n link set $n-eth0 up
done
sudo ip -n hol1-a addr add 10.10.0.1/24 dev a-eth0
sudo ip -n hol1-b addr add 10.10.0.2/24 dev b-eth0
```

(Or run `sudo ./setup.sh` from `labs/hol-linux-net-basics/`.)

> [!WARNING]
> **Why the `iptables` line?** Docker (installed by `setup-ubuntu.sh` for the containerlab labs)
> loads the `br_netfilter` module, which makes IPv4 frames crossing *any* Linux bridge traverse the
> host's iptables `FORWARD` chain, and Docker sets that chain's policy to `DROP`. Without the
> `ACCEPT` rule, ARP still works (it is not IP) but every ping across `br-hol1` silently disappears:
> a firewall black hole that looks a lot like the MTU black hole this lab is about. Check with
> `sysctl net.bridge.bridge-nf-call-iptables` (1 = bridged traffic is filtered) and
> `sudo iptables -S FORWARD`. On a VM without Docker the rule is harmless. `cleanup.sh` removes it.

**Observe:**

```bash
ip netns list
ip -br link show master br-hol1
sudo ip -n hol1-a -br addr
sudo ip netns exec hol1-a ping -c 3 10.10.0.2
sudo ip netns exec hol1-a ip neigh
bridge fdb show br br-hol1 | grep -v permanent
```

**Why:** `ip -n NS ...` is shorthand for `ip netns exec NS ip ...`. `ip -br link` shows the veth
peer as `a-br@if7` style names: the number after `@if` is the interface index of the other end,
which lives in another namespace. The bridge FDB now holds the two MAC addresses it learned from the
ping, exactly like a hardware switch's MAC table.

### Task 2: Read the interfaces like an engineer

```bash
sudo ethtool a-br         # speed/duplex/link as reported by the driver
ethtool -i a-br           # driver name
ethtool -S a-br           # driver statistics
ethtool -k a-br | grep -E 'segmentation|scatter|receive-offload'
ip -s -s link show dev a-br
ip -d link show dev a-br  # -d shows type-specific details (veth, bridge_slave ...)
```

**Observe and why:**

- `ethtool -i` reports `driver: veth`. The "speed" a veth reports is a value the driver makes up;
  it is not a limit. Never trust a virtual interface's speed field for capacity planning.
- `ethtool -S` on a veth includes `peer_ifindex`, a quick way to find the other end of the cable.
  Real NICs expose hundreds of counters here (per-queue, per-priority, PFC, discards); the exact
  names are driver-specific, so always check your NIC vendor's counter documentation.
- `ip -s -s link` shows RX/TX packets, bytes, errors and **dropped**. Note the current values; you
  will watch `dropped` change in Task 4.
- `ethtool -k` lists offloads (TSO, GSO, GRO). These matter later: with offloads on, `tcpdump` can
  show "packets" much larger than the MTU because it captures before segmentation or after
  aggregation.

### Task 3: Turn on jumbo frames... almost everywhere

AI fabrics typically run a jumbo MTU (often around 9000 bytes on the host side; check your
platform's supported maximum) so that RDMA and storage traffic carry more payload per header. The
classic mistake is to miss one hop. Do that deliberately: set 9000 everywhere **except** on
`b-eth0`.

```bash
sudo ip -n hol1-a link set a-eth0 mtu 9000
sudo ip link set a-br mtu 9000
sudo ip link set b-br mtu 9000
sudo ip link set br-hol1 mtu 9000
# b-eth0 inside hol1-b stays at 1500

ip link show master br-hol1 | grep -o '^[0-9]*: [^:]*\|mtu [0-9]*'
sudo ip -n hol1-a link show a-eth0 | grep -o 'mtu [0-9]*'
sudo ip -n hol1-b link show b-eth0 | grep -o 'mtu [0-9]*'
```

**Why:** a veth pair is allowed to have different MTUs on its two ends, just as two real devices
on a cable can be configured differently. Nothing warns you.

### Task 4: Reproduce the black hole and find it

`ping -M do` sets the Don't Fragment bit and forbids local fragmentation; `-s N` sets the ICMP
payload size. IP packet size = N + 8 (ICMP header) + 20 (IPv4 header), so `-s 1472` builds a
1500-byte packet and `-s 8972` builds a 9000-byte packet.

```bash
# Small packets: fine
sudo ip netns exec hol1-a ping -c 3 -M do -s 1472 10.10.0.2

# Jumbo packets from A to B: 100% loss, and no error message
sudo ip netns exec hol1-a ping -c 3 -W 1 -M do -s 8972 10.10.0.2

# The same jumbo ping from B: an immediate local error
sudo ip netns exec hol1-b ping -c 1 -M do -s 8972 10.10.0.1
```

Illustrative output of the last command (wording depends on your iputils version):

```
PING 10.10.0.1 (10.10.0.1) 8972(9000) bytes of data.
ping: sendmsg: Message too long

--- 10.10.0.1 ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
```

(`ping: local error: message too long, mtu=1500` is the related message for a path MTU the host
has *learned*, which you will see later in this lab.)

**Why:** host B knows its own MTU and refuses to send. Host A only knows *its* MTU (9000); the frame
is perfectly legal on every hop until the very last one, where the receiving interface (MTU 1500)
drops it. An L2 device does not send ICMP errors, so A just sees silence. This is exactly how a
single misconfigured NIC or switch port turns into "NCCL hangs on large messages but ping works".

Now locate the drop. Open a second terminal for each capture.

```bash
# Terminal 2: the bridge port towards B (host namespace). You WILL see the 9014-byte frames.
sudo tcpdump -eni b-br -c 3 icmp

# Terminal 3: inside B. You will NOT see the jumbo frames arrive.
sudo ip netns exec hol1-b tcpdump -eni b-eth0 -c 3 icmp

# Terminal 1: send a few jumbo pings again
sudo ip netns exec hol1-a ping -c 3 -W 1 -M do -s 8972 10.10.0.2
```

Then compare counters before and after another round of jumbo pings:

```bash
ip -s link show dev b-br
sudo ip -n hol1-b -s link show dev b-eth0
```

**What to observe:** frames leave the bridge on `b-br` (TX packets increase, and `tcpdump -e`
shows `length 9014`: 9000 bytes of IP plus a 14-byte Ethernet header) but never appear in
`tcpdump` on `b-eth0`. A `dropped` counter increases on the `b-br`/`b-eth0` pair; whether it shows
up as TX dropped on `b-br`, RX dropped on `b-eth0`, or both, depends on the kernel version. On real
hardware the equivalent evidence is an RX "oversize"/"giant"/"MTU exceeded" style counter on the
receiving port; the counter name is vendor-specific.

> [!TIP]
> Find the exact boundary by bisection: try `-s 1472`, `-s 1480`, `-s 2000`, `-s 4000` from A to B.
> You may find that a few bytes more than 1472 still get through, because the receiving veth allows
> some slack for a VLAN tag. Real NICs and switches also differ in how strictly they enforce MTU,
> which is one more reason to test with the exact sizes your workload uses.

### Task 5: Fix it and prove the fix

```bash
sudo ip -n hol1-b link set b-eth0 mtu 9000
sudo ip netns exec hol1-a ping -c 3 -M do -s 8972 10.10.0.2
sudo ip netns exec hol1-b ping -c 3 -M do -s 8972 10.10.0.1
```

**Why:** both directions must be tested. MTU problems are often asymmetric (one side's switch port
is wrong), and a request/response protocol fails if either direction fails.

### Task 6: Contrast: a routed hop tells you about the MTU

Add a router namespace `hol1-r` on the same bridge (MTU 9000 on its LAN side) with a second network
towards host `hol1-c` where the MTU is 1500.

```bash
sudo ip netns add hol1-r
sudo ip netns add hol1-c

# Router LAN side, on the bridge, jumbo
sudo ip link add r-br type veth peer name r-eth0
sudo ip link set r-eth0 netns hol1-r
sudo ip link set r-br master br-hol1
sudo ip link set r-br mtu 9000 up
sudo ip -n hol1-r link set r-eth0 mtu 9000 up
sudo ip -n hol1-r link set lo up
sudo ip -n hol1-r addr add 10.10.0.254/24 dev r-eth0

# Router WAN side <-> hol1-c, standard 1500
sudo ip link add r-eth1 type veth peer name c-eth0
sudo ip link set r-eth1 netns hol1-r
sudo ip link set c-eth0 netns hol1-c
sudo ip -n hol1-r link set r-eth1 up
sudo ip -n hol1-c link set c-eth0 up
sudo ip -n hol1-c link set lo up
sudo ip -n hol1-r addr add 10.20.0.254/24 dev r-eth1
sudo ip -n hol1-c addr add 10.20.0.1/24 dev c-eth0

# Routing
sudo ip netns exec hol1-r sysctl -w net.ipv4.ip_forward=1
sudo ip -n hol1-a route add 10.20.0.0/24 via 10.10.0.254
sudo ip -n hol1-c route add default via 10.20.0.254
```

Now send a jumbo DF ping from A to C while capturing on A:

```bash
# Terminal 2
sudo ip netns exec hol1-a tcpdump -ni a-eth0 -v icmp

# Terminal 1
sudo ip netns exec hol1-a ping -c 3 -M do -s 8972 10.20.0.1
sudo ip -n hol1-a route get 10.20.0.1
```

Illustrative output:

```
From 10.10.0.254 icmp_seq=1 Frag needed and DF set (mtu = 1500)
ping: local error: message too long, mtu=1500
...
10.20.0.1 via 10.10.0.254 dev a-eth0 src 10.10.0.1 uid 0
    cache expires 597sec mtu 1500
```

**Why:** a router that cannot forward a DF packet sends ICMP "fragmentation needed" (type 3,
code 4) with the next-hop MTU. A caches that as a *path MTU exception* (`cache ... mtu 1500` in
`ip route get`) and from then on refuses large DF packets locally. That is Path MTU Discovery. It
only works if ICMP is not filtered, and it never helps inside one L2 segment (Task 4). Note also
that RDMA traffic (RoCEv2) does not use PMTUD at all: the RDMA path MTU is negotiated per queue pair
and must simply fit the fabric, so MTU must be correct by design.

Clear the exception if you want to repeat the experiment: `sudo ip -n hol1-a route flush cache`.

## Verify

```bash
cd labs/hol-linux-net-basics
sudo ./check.sh
```

The script checks that the namespaces and bridge exist, that all host and bridge-port MTUs are
9000, that small and 9000-byte DF pings succeed from A to B, and (if you did Task 6) that a
1500-byte DF ping through the router succeeds. Every line prints `PASS:` or `FAIL:`.

## Clean up

```bash
sudo ./cleanup.sh
```

Deleting a namespace deletes the veth ends inside it, and with them their peers.

## What you learned

- Namespaces, veth pairs and bridges are the building blocks of containers, containerlab and
  Kubernetes networking, and they make perfect test benches.
- `ping -M do -s <MTU-28>` is the standard way to test an IPv4 path MTU end to end.
- An MTU mismatch inside one L2 domain is a silent black hole: small packets work, large ones
  disappear, and the only evidence is a drop counter on the receiving port.
- A routed hop reports its MTU via ICMP fragmentation-needed, and the sender caches a PMTU
  exception; RDMA does not rely on this.
- `tcpdump -e` on both sides of a hop, plus `ip -s link` deltas, localizes almost any drop.

## Going further on real hardware

- On a GPU server, check every hop of the RDMA path: host NIC MTU (`ip link`), the RDMA active MTU
  (`ibv_devinfo` shows `active_mtu`, which is derived from the netdev MTU on RoCE NICs), and the
  switch port MTU on both leaf and spine. The RDMA MTU (for example 4096) is smaller than the
  Ethernet MTU because it counts only the RDMA payload; headers must fit on top.
- Use your NIC's driver counters (`ethtool -S`) and the switch's interface error counters to find
  oversize drops; names differ by vendor and generation, so look them up in the vendor's counter
  reference rather than guessing.
- Automate an MTU sweep (for example with a fabric validation tool or a simple script running
  DF-bit pings at your exact MTU between every pair of hosts) as part of cluster burn-in.
