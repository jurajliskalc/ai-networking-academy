---
id: hol-ecn-congestion
title: "ECN marking, DCTCP and incast on a Linux bottleneck"
kind: handson
level: 3
estimated_minutes: 90
environment: linux-vm
lessons: [ecn-and-dcqcn, incast-and-congestion-hotspots]
files: labs/hol-ecn-congestion
verified: true
tier: 0
fabric: any
requires: [linux-vm]
summary: "A Linux router namespace becomes a congested switch: tail drop vs RED/ECN marking vs DCTCP, plus an incast burst."
---

> [!NOTE]
> Verified end to end (every task, `check.sh` and `cleanup.sh`) on Ubuntu 24.04 under WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2) on 2026-10-22; see `labs/README.md` for the exact versions and the caveats of WSL2.
> Numbers depend on your VM's CPU and kernel; treat every result below as illustrative and focus on
> the differences between runs.

## Goal

Build a congested switch out of a Linux router namespace: three senders, one 100 Mbit/s bottleneck,
one receiver. Then compare what the queue does with **tail drop**, with **RED/ECN marking**, and with
**DCTCP**, and fire a small **incast** burst. You will read the evidence the same way you would on a
fabric: queue statistics (`tc -s qdisc`), ECN counters on the receiver (`nstat`), retransmissions on
the sender, and latency under load.

> [!WARNING]
> This lab uses **TCP**, not RoCE. ECN marking on the "switch" is the same mechanism a RoCE fabric
> uses, and DCTCP's proportional reaction is a close cousin of DCQCN's, but the sender side is
> different: DCQCN runs in the RDMA NIC, is rate-based, and is triggered by CNP packets, while TCP
> reacts in the kernel through ECE flags in ACKs and adjusts a congestion window. Task 8 maps the
> two precisely.

By the end you can:

- Configure a shaped bottleneck with HTB and an ECN-marking RED child qdisc, and read its
  `marked`/`early`/`dropped` counters.
- Show that ECN replaces drops with marks for ECN-capable traffic, and that non-ECT traffic is
  still dropped.
- Explain why DCTCP keeps throughput high with a short queue, and why it must not share a queue
  with classic TCP.
- Reproduce incast drops and explain how ECN and lossless designs address them.

```
 ecn-s1 10.6.1.2 --\
 ecn-s2 10.6.2.2 ---- ecn-r ==[HTB 100 Mbit/s + qdisc under test]==> ecn-rcv 10.6.9.2
 ecn-s3 10.6.3.2 --/          (egress of to-rcv)
```

## Setup

- Ubuntu 24.04 VM, 2+ vCPU. Packages: `iproute2` (provides `tc`, `ss`, `nstat`), `iperf3`,
  `ethtool` (installed by `labs/setup-ubuntu.sh`). The kernel modules `tcp_dctcp`, `sch_htb`,
  `sch_red` and `sch_fq_codel` ship with Ubuntu's generic kernel (some may be in
  `linux-modules-extra-$(uname -r)`).
- Lab files in `labs/hol-ecn-congestion/`:
  - `setup.sh`: builds the namespaces, disables TSO/GSO/GRO on all veths (so the queue holds
    MTU-sized packets), sets every namespace to CUBIC and starts three iperf3 servers on the
    receiver (ports 5201-5203, one per sender). `setup.sh --restart-servers` only restarts those
    servers (needed in Task 5). It also adds `dctcp` to the host-wide
    `net.ipv4.tcp_allowed_congestion_control` list (see Task 5); `cleanup.sh` restores it.
  - `bottleneck.sh MODE`: `fifo`, `red-ecn`, `fq_codel`, `off` or `show`.
  - `incast.sh`: synchronized burst from all three senders.
  - `cleanup.sh`, `check.sh`.

```bash
cd labs/hol-ecn-congestion
sudo ./setup.sh
```

Define a shortcut for reading the bottleneck:

```bash
q() { sudo ip netns exec ecn-r tc -s qdisc show dev to-rcv; }
```

## Tasks

### Task 1: Baseline without a bottleneck

```bash
sudo ./bottleneck.sh off
sudo ip netns exec ecn-s1 iperf3 -c 10.6.9.2 -p 5201 -t 3
```

**Observe:** several Gbit/s (CPU bound; offloads are off, so lower than usual veth numbers). There
is no queue to speak of. Everything that follows is about what happens when the egress link is
slower than the offered load, as it is on a fabric link under a collective or at an incast receiver.

### Task 2: Tail drop: a FIFO that fills and overflows

```bash
sudo ./bottleneck.sh fifo                                      # HTB 100mbit + pfifo limit 50
sudo ip netns exec ecn-s1 sysctl -w net.ipv4.tcp_ecn=0         # classic TCP without ECN
sudo ip netns exec ecn-s1 nstat -saz TcpRetransSegs
```

Run a 15-second flow and, in a second terminal, measure latency through the same bottleneck while it
runs:

```bash
# Terminal 1
sudo ip netns exec ecn-s1 iperf3 -c 10.6.9.2 -p 5201 -t 15
# Terminal 2 (start right after)
sudo ip netns exec ecn-s3 ping -c 40 -i 0.2 10.6.9.2 | tail -3
```

Then:

```bash
q
sudo ip netns exec ecn-s1 nstat -saz TcpRetransSegs
```

**What to observe and why:**

- iperf3 reaches about 95 Mbit/s (the shaped rate minus header overhead) with a non-zero `Retr`
  column.
- `tc -s` shows `dropped` growing on the `pfifo` child: CUBIC increases its window until the
  50-packet queue overflows, then halves it. That loss is the congestion signal.
- Ping RTT rises from tens of microseconds to several milliseconds: 50 packets of 1514 bytes take
  about 6 ms to drain at 100 Mbit/s. Queueing delay = queue depth / drain rate. The same physics
  applies to a 400G switch port, only with bigger buffers and smaller times.

### Task 3: RED with ECN: marks instead of drops

```bash
sudo ./bottleneck.sh red-ecn
sudo ip netns exec ecn-s1 sysctl -w net.ipv4.tcp_ecn=1         # request ECN on outgoing connections
sudo ip netns exec ecn-rcv nstat -saz IpExtInNoECTPkts IpExtInECT0Pkts IpExtInCEPkts
sudo ip netns exec ecn-s1 iperf3 -c 10.6.9.2 -p 5201 -t 10
q
sudo ip netns exec ecn-rcv nstat -saz IpExtInNoECTPkts IpExtInECT0Pkts IpExtInCEPkts
```

Illustrative `red` statistics line:

```
qdisc red 10: parent 1:10 limit 400000b min 30000b max 35000b ecn
 Sent 118000000 bytes 78000 pkt (dropped 3, overlimits 2100 requeues 0)
 backlog 31780b 21p requeues 0
  marked 2096 early 3 pdrop 0 other 0
```

**What to observe and why:**

- The RED child marks packets when its **average** queue exceeds `min` (30 kB) and marks every
  packet once it reaches `max` (35 kB): a nearly single-threshold policy, like the `Kmin`/`Kmax`
  WRED-ECN profiles used on RoCE switches.
- `marked` grows, while `early`/`pdrop` (drops) stay near zero, and iperf3's `Retr` is close to 0.
  The sender learns about congestion without losing data.
- On the receiver, `IpExtInECT0Pkts` counts ECN-capable packets (Linux TCP uses ECT(0)) and
  `IpExtInCEPkts` counts the ones a "switch" marked Congestion Experienced. The receiver echoes
  this to the sender with the ECE flag in TCP ACKs.
- The ping from Task 2, if you run it again now, is **not** ECN-capable. RED cannot mark it, so it
  drops it instead: you may see ping loss. This is why real fabrics put control traffic (and CNPs)
  in a different queue from marked bulk traffic.

### Task 4: The same queue without ECN negotiation

```bash
sudo ip netns exec ecn-s1 sysctl -w net.ipv4.tcp_ecn=0
q > /tmp/before.txt
sudo ip netns exec ecn-s1 iperf3 -c 10.6.9.2 -p 5201 -t 10
q
```

**Observe:** the `marked` counter stops increasing and `early` (RED's probabilistic drops) grows
instead; `Retr` goes up again. An ECN-marking queue only helps traffic whose sender and receiver
negotiated ECN: on a RoCE fabric, that means the NIC's ECN/DCQCN settings and the switch's marking
profile must match the traffic class you actually use.

### Task 5: DCTCP: react in proportion to the marks

DCTCP estimates the fraction of marked packets per window (its `alpha`) and cuts the window by
`alpha/2` instead of by half. Linux implements the DCTCP receiver's precise ECE echo inside the
`dctcp` module, so **both** ends must use DCTCP.

```bash
sudo ip netns exec ecn-s2  sysctl -w net.ipv4.tcp_congestion_control=dctcp
sudo ip netns exec ecn-s2  sysctl -w net.ipv4.tcp_ecn=1
sudo ip netns exec ecn-rcv sysctl -w net.ipv4.tcp_congestion_control=dctcp
sudo ./setup.sh --restart-servers
```

If the first `sysctl` fails with `Operation not permitted`: Linux lets a network namespace other
than the host's make a congestion control its default only if that algorithm is listed in the
host-wide `net.ipv4.tcp_allowed_congestion_control` (by default typically just `reno cubic`).
`setup.sh` adds `dctcp` to that list; check with `sysctl net.ipv4.tcp_allowed_congestion_control`.

**Why restart the servers:** a DCTCP sender marks even its SYN as ECN-capable (ECT), which classic
RFC 3168 TCP does not do. Linux accepts ECN on such a SYN only if the *listening* socket itself
uses DCTCP, and a listening socket keeps the congestion control that was the default when it was
created (the servers were started under CUBIC). Without the restart, ECN is not negotiated and the
DCTCP sender silently falls back to Reno-style behavior without ECN, so RED drops instead of marks.

Run a 15-second DCTCP flow and, in a second terminal, sample the queue and the socket state:

```bash
# Terminal 1
sudo ip netns exec ecn-s2 iperf3 -c 10.6.9.2 -p 5202 -t 15
# Terminal 2
for i in $(seq 1 10); do q | grep -o 'backlog [^ ]* [^ ]*' | tail -1; sleep 1; done
sudo ip netns exec ecn-s2 ss -tin dst 10.6.9.2
```

Compare with CUBIC+ECN under the same RED queue (from s1, Task 3 settings):

```bash
sudo ip netns exec ecn-s1 sysctl -w net.ipv4.tcp_ecn=1
# Terminal 1
sudo ip netns exec ecn-s1 iperf3 -c 10.6.9.2 -p 5201 -t 15
# Terminal 2
for i in $(seq 1 10); do q | grep -o 'backlog [^ ]* [^ ]*' | tail -1; sleep 1; done
```

**What to observe and why:**

- Both reach high throughput with few or no retransmissions. Check the `ss -tin` line of the
  DCTCP flow: it shows the congestion control (`dctcp`), `delivered_ce` (segments that arrived
  CE-marked) and, on recent iproute2 versions, a `dctcp:(...)` block with its internal state such
  as `alpha` (field names vary by version).
- DCTCP backs off only a little for each window that contains marks, so it keeps the queue
  hovering around the marking threshold with small oscillations. CUBIC halves its window on each
  congestion signal (at most once per round trip), so its queue oscillates more. With only
  100 Mbit/s and microsecond RTTs, the difference is modest (both flows may see a similar number
  of marks and reach the same throughput here); it grows with the bandwidth-delay product.

### Task 6: DCTCP and classic TCP in one queue

Run both at the same time (s1: CUBIC with ECN, s2: DCTCP):

```bash
sudo ip netns exec ecn-s1 iperf3 -c 10.6.9.2 -p 5201 -t 15 > /tmp/s1.txt &
sudo ip netns exec ecn-s2 iperf3 -c 10.6.9.2 -p 5202 -t 15 > /tmp/s2.txt &
wait
grep receiver /tmp/s1.txt /tmp/s2.txt
```

**What to observe and why:** the split is usually far from 50/50, typically in DCTCP's favor:
the same stream of marks makes CUBIC halve its window repeatedly while DCTCP shaves off a little.
This is why DCTCP (RFC 8257) is meant for controlled environments such as a data center, with its
own queue or traffic class. The same rule applies to RoCE: DCQCN-controlled RDMA traffic gets its
own lossless queue and its own marking profile.

### Task 7: Incast

Make all three senders use DCTCP, then fire a synchronized 4 MB burst from each into the FIFO
queue, then into the RED/ECN queue:

```bash
for i in 1 2 3; do
  sudo ip netns exec ecn-s$i sysctl -q -w net.ipv4.tcp_congestion_control=dctcp
  sudo ip netns exec ecn-s$i sysctl -q -w net.ipv4.tcp_ecn=1
done

sudo env FIFO_LIMIT=30 ./bottleneck.sh fifo
sudo ./incast.sh 4M

sudo ./bottleneck.sh red-ecn
sudo ./incast.sh 4M
```

**What to observe and why:**

- With the short FIFO, three senders starting together overflow the queue within a few round
  trips: `dropped` jumps and the per-sender `Retr` values in the iperf3 summaries are non-zero.
  This is incast: many-to-one traffic (like the gather phase of a collective or many storage
  servers answering one client) exceeding one egress port's buffer.
- With RED/ECN, the burst is absorbed by early marking: `marked` grows, drops stay near zero,
  and the receiver's `IpExtInCEPkts` increases. Marking only works if the senders slow down
  before the buffer is full; with very large or very synchronized bursts the queue can still
  overflow, which is why RoCE fabrics add PFC as a last line of defense against loss.
- Try `sudo ./bottleneck.sh fq_codel` and repeat: fq_codel marks based on queueing **delay**
  (sojourn time) per flow rather than on queue length; its statistics line shows `ecn_mark`.

### Task 8: Map what you saw to RoCE and DCQCN

| Role | This lab (TCP) | RoCEv2 fabric (DCQCN) |
|---|---|---|
| Congestion point | `red ... ecn` on the router egress queue | Switch egress queue with an ECN/WRED profile (Kmin, Kmax, Pmax) |
| Mark | IP ECN field set to CE | Same: IP ECN field set to CE |
| Notification point | TCP receiver sets ECE in ACKs | Receiver NIC sends a **CNP** (BTH opcode 0x81) to the sender QP, rate-limited per QP (interval is NIC-configurable) |
| Reaction point | Kernel TCP: window cut (CUBIC: by half; DCTCP: by alpha/2) | Sender NIC: rate cut using its own alpha estimate, then timer- and byte-based recovery |
| Drop fallback | Retransmission after loss | PFC pauses the priority to avoid loss; loss on RC triggers NAK and retransmission (expensive) |
| Evidence | `tc -s` marked, `nstat IpExtInCEPkts`, `ss -tin` | Switch ECN-marked counters, NIC CNP sent/received counters (names are vendor-specific) |

The principle is identical: signal congestion before the buffer fills, and let the sender slow down
in proportion. The implementation differs: DCQCN is rate-based and in hardware, and its parameters
(and their defaults) are NIC-vendor and firmware specific.

## Verify

Leave the bottleneck in `red-ecn` mode, then:

```bash
sudo ./bottleneck.sh red-ecn
sudo ./check.sh
```

The script checks the namespaces, reachability, the three iperf3 servers, DCTCP availability and the
HTB+RED/ECN configuration, then runs a 3-second DCTCP flow (temporarily setting DCTCP on s2 and the
receiver and restoring the previous values, against a one-off iperf3 server on port 5299 that it
starts after switching the receiver to DCTCP) and verifies that RED marked packets and that the
receiver counted CE-marked packets.

## Clean up

```bash
sudo ./cleanup.sh
rm -f /tmp/s1.txt /tmp/s2.txt /tmp/before.txt
```

## What you learned

- A shaped egress port plus a queue discipline is a faithful model of a congested switch port;
  `tc -s qdisc` gives you the queue's backlog, drops and marks.
- ECN turns drops into marks for ECN-capable traffic only; non-ECT traffic is still dropped by an
  ECN-enabled RED queue.
- DCTCP reacts in proportion to the fraction of marks, keeping queues short and throughput high,
  but it is unfair to classic TCP in a shared queue.
- Incast overflows shallow queues within a few RTTs; early marking helps, PFC is the lossless
  fabric's backstop.
- DCQCN follows the same congestion-point / notification-point / reaction-point structure, with
  CNPs and NIC rate limiters instead of ACK flags and windows.

## Going further on real hardware

- On a RoCE fabric, find the ECN marking profile of the RDMA traffic class on your switches
  (minimum/maximum thresholds and marking probability) and the DCQCN settings on the NICs. Check
  that ECN is enabled on the same priority that carries RoCE, and that CNPs are sent in a
  high-priority class. Names and defaults depend on the switch OS and NIC firmware.
- Run an NCCL all-to-all or all-reduce test across several servers while watching switch ECN-mark
  counters and NIC CNP counters; correlate bursts of marks with collective phases.
- Repeat Task 7 with real RDMA traffic (several `ib_write_bw` clients to one server) and observe
  PFC pause counters on the receiver's leaf port.
