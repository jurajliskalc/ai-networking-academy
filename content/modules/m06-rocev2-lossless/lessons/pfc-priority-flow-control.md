---
id: pfc-priority-flow-control
title: "Priority Flow Control (PFC): pausing one class, not the link"
module: m06-rocev2-lossless
level: 3
estimated_minutes: 50
objectives:
  - Explain why RoCEv2 traditionally needs a lossless traffic class, in terms of go-back-N retransmission cost.
  - Decode an 802.1Qbb PFC frame (MAC control opcode 0x0101, class-enable vector, eight pause timers in 512-bit-time quanta).
  - Describe XOFF/XON threshold behaviour on a switch ingress priority group and how pause propagates hop by hop.
  - Compare PFC with InfiniBand credit-based flow control and with 802.3x link-level PAUSE.
  - Read host and switch PFC counters and tell a healthy pattern from a pathological one.
prerequisites: [rocev2-encapsulation, switching-and-queues, ib-flow-control-vls]
quiz: quiz-pfc-priority-flow-control
widgets: [pfc-ecn-sim, ib-credit-flow, headroom-calculator]
labs: []
tags: [pfc, lossless, 802.1qbb, pause, flow-control, xoff]
further_reading:
  - title: IEEE 802.1Qbb Priority-based Flow Control
    url: https://1.ieee802.org/dcb/802-1qbb/
  - title: "Guo et al., RDMA over Commodity Ethernet at Scale (SIGCOMM 2016)"
    url: https://dl.acm.org/doi/10.1145/2934872.2934908
  - title: "Linux kernel documentation: mlx5 ethtool counters"
    url: https://docs.kernel.org/networking/device_drivers/ethernet/mellanox/mlx5/counters.html
  - title: "SONiC command reference (show pfc counters, PFC watchdog)"
    url: https://github.com/sonic-net/sonic-utilities/blob/master/doc/Command-Reference.md
---

## Why this matters

Standard Ethernet drops packets when a queue overflows, and TCP shrugs it off: it retransmits a
segment, halves its window and carries on. The RDMA transport in most deployed NICs is much less
forgiving. Many RC implementations recover from a lost packet with **go-back-N**: the receiver
discards everything after the gap, and the sender retransmits from the lost PSN onward. One
dropped packet in a 1 MB message can cost hundreds of retransmitted packets plus a timeout or a NAK
round trip. AI training makes it worse. A collective step completes only when *every* GPU's
transfer completes, so one rank stuck in retransmission stalls thousands of GPUs. A loss rate that
TCP would not notice (say 0.1 %) can cut RDMA throughput dramatically.

The classic answer is to make the RoCE traffic class **lossless**: when a switch buffer for that
class fills up, the switch tells its upstream neighbour to stop sending that class for a while,
instead of dropping. That mechanism is **Priority Flow Control (PFC), IEEE 802.1Qbb**. It is
simple, it works, and it is also the source of the most spectacular failures in RoCE networks
(pause storms, congestion spreading, deadlock). You need to understand it at the frame and
threshold level to run an AI fabric.

## Concepts

### From link PAUSE to priority PAUSE

The original Ethernet flow control, **802.3x PAUSE**, stops *the entire link*. It uses a MAC
control frame with opcode `0x0001` and one timer. Pausing a link that also carries storage, TCP
management and RoCE traffic punishes everything for the sake of one class, so 802.3x is normally
disabled in data centres.

PFC keeps the frame format but makes it per priority. Ethernet already has 8 priorities: the 3-bit
PCP in the VLAN tag, or a priority derived internally from DSCP (see the QoS trust lesson). PFC lets
a receiver say "stop priority 3 for N time units" while priorities 0-2 and 4-7 keep flowing on the
same wire. Normally only one or two priorities are made lossless (for RoCE, typically priority 3),
and the rest stay ordinary lossy Ethernet.

| Property | 802.3x PAUSE | 802.1Qbb PFC |
|---|---|---|
| Scope | Whole link | Per priority (8 independent classes) |
| MAC control opcode | 0x0001 | **0x0101** |
| Timers in the frame | 1 | **8** (one per priority) plus a class-enable vector |
| Typical use in AI fabrics | Disabled | Enabled on the RoCE priority only |

### The key ideas in one paragraph

PFC is **hop by hop** and **per priority, per link**. It is triggered by **ingress** buffer
occupancy: a switch accounts the packets it has received on port X for priority 3 (an ingress
*priority group*, PG). When that occupancy crosses an **XOFF** threshold, the switch sends a PFC
frame *out of port X* to the neighbour that is sending them. When occupancy falls below an **XON**
threshold, it sends a frame with a zero timer (resume). The neighbour stops *transmitting* priority
3 on that link. If the neighbour's own buffers then fill, it pauses *its* upstream, and so on back
to the sending NIC. The switch never drops for lack of buffer in that class, as long as enough
**headroom** is reserved to absorb what is already in flight when the pause is sent (next lesson).

```mermaid
flowchart RL
  R["Receiver NIC (slow)"] -- "PFC prio 3" --> L2["Leaf 2"]
  L2 -- "PFC prio 3" --> S["Spine"]
  S -- "PFC prio 3" --> L1["Leaf 1"]
  L1 -- "PFC prio 3" --> T["Sender NIC"]
```

Data flows left to right (sender to receiver). Pause frames flow right to left, one hop at a time,
each triggered by the buffer at that hop.

> [!ANALOGY]
> A motorway on-ramp meter with traffic lights per lane. When the exit is jammed, the lane for
> trucks (priority 3) gets a red light at the previous junction, while cars in other lanes keep
> moving. If the trucks then back up past that junction, the junction before it gets a red light
> too. The analogy breaks down because a real red light stops only *new* traffic, while trucks
> already between junctions still arrive. Those in-flight trucks are exactly what headroom must
> absorb.

### PFC versus InfiniBand credits

InfiniBand reaches losslessness the other way round. The receiver advertises **credits** (buffer
space) per virtual lane, and the sender transmits *only* when it holds credit. PFC is reactive: the
sender transmits freely until told to stop.

```widget
ib-credit-flow
```

| | InfiniBand credit-based flow control | Ethernet PFC |
|---|---|---|
| Model | Proactive: send only with credit | Reactive: send until paused |
| Granularity | Per virtual lane | Per priority |
| Overflow possible? | No, by construction | Only if headroom is under-sized |
| Buffer needed for long links | Credits must cover the round trip | Headroom must cover the round trip |
| Control traffic | Continuous flow control packets | Only when thresholds are crossed |
| Failure modes | Credit loops and deadlock are possible (handled by SM routing and VL design) | Pause storms, deadlock, congestion spreading |

Both need about one round trip of buffering per lossless class per port. Both can suffer from
head-of-line blocking and congestion spreading. Neither is "free losslessness".

## How it works

### The PFC frame

```text
 Destination MAC      01-80-C2-00-00-01   (reserved MAC control multicast, never forwarded)
 Source MAC           port MAC of the sender of the PAUSE
 EtherType            0x8808              (MAC control)
 MAC control opcode   0x0101              (PFC; 802.3x PAUSE is 0x0001)
 Class-enable vector  2 octets            (upper octet reserved = 0; bit n = 1 => time[n] is valid)
 time[0] .. time[7]   8 x 2 octets        (pause duration per priority, in quanta)
 Pad                  zeros to the 64-byte minimum frame
 FCS                  4 octets
```

- The **class-enable vector** says which of the eight timers to act on. A frame that pauses only
  priority 3 has vector `0x0008` (bit 3 set). A frame can address several priorities at once.
- Each **timer** is a 16-bit value in **quanta**. One quantum is the time to transmit **512 bits** at
  the link's speed. A value of 0 means "resume now" (XON).
- The frame is consumed by the MAC of the directly attached device. It is link-local and is never
  forwarded.

> [!VERIFIED]
> **PFC frames are consumed by the NIC: `tcpdump` captured 0 while `rx_prio3_pause` rose by 2178.**
> On ConnectX-5 (fw 16.29, DOCA-OFED 3.4, PFC on priority 3, back to back), `tcpdump -i ens64f0np0 -nn -e ether proto 0x8808`
> ran during a 5-second `ib_write_bw` and reported `0 packets captured`, while `ethtool -S` showed
> `rx_prio3_pause` +2178 over the same run. The libpcap RDMA sniffer captured no 0x8808 frames either. On a host,
> count pause frames with the `prioN_pause` counters (and the switch's PFC counters); seeing the frames
> themselves needs a passive tap or a capture appliance.

Quantum durations scale with speed, so the same timer value means less wall-clock time on faster links:

| Link speed | 1 quantum (512 bit times) | Maximum timer (65 535 quanta) |
|---|---|---|
| 100 Gb/s | 5.12 ns | ≈ 335 µs |
| 200 Gb/s | 2.56 ns | ≈ 168 µs |
| 400 Gb/s | 1.28 ns | ≈ 84 µs |
| 800 Gb/s | 0.64 ns | ≈ 42 µs |

Switches therefore do not send one pause and wait. While a priority group stays above XOFF, they
**refresh** the pause before the timer expires, and they send an explicit XON (timer 0) once the PG
drains below the XON threshold. On some platforms both thresholds and the refresh behaviour are
tuneable. On most, they are derived automatically from the buffer profile.

### Thresholds on an ingress priority group

```text
 Ingress PG for priority 3 on port X (lossless)

   +-----------------------------+  <- reserved headroom (absorbs in-flight data after XOFF)
   |         HEADROOM            |
   +-----------------------------+  <- XOFF threshold: send PAUSE(prio 3, time=T)
   |                             |
   |   shared-buffer usage       |
   |                             |
   +-----------------------------+  <- XON threshold: send PAUSE(prio 3, time=0)
   |   min / guaranteed buffer   |
   +-----------------------------+
```

1. Packets arrive on port X with priority 3 and are counted against PG3 of port X. They may be
   queued in any egress port's queue, but the *ingress accounting* decides when to pause.
2. When PG3 usage crosses XOFF, the switch sends a PFC frame for priority 3 out of port X.
3. The upstream device finishes the frame it is currently transmitting, then stops sending
   priority 3 on that link. Meanwhile, data already on the cable keeps arriving and lands in **headroom**.
4. As egress queues drain, PG3 usage falls. Below XON, the switch sends a resume.

XOFF is often *dynamic*. With a shared buffer, the threshold is a function of free shared buffer
(the "alpha" or dynamic-threshold factor), not a fixed byte value. The next lesson covers this.

Size the headroom region in the diagram above: change the cable length and speed and see how many bytes must fit above XOFF.

```widget
headroom-calculator
```

### Who sends PFC, and who receives it

- **Switches** send PFC upstream when their ingress PGs fill, and stop transmitting a priority when
  they receive PFC from downstream.
- **NICs** send PFC when *their* receive buffer fills. This happens when the host cannot drain it
  fast enough, because of PCIe back-pressure, a slow memory subsystem, too few receive WQEs, or a
  stalled driver. NICs also honour PFC from the switch by pausing their transmit on that priority.
- A NIC-generated pause is a strong hint that the bottleneck is **inside the host**, not in the
  network. That distinction is gold in troubleshooting.

### The cost: head-of-line blocking and congestion spreading

PFC cannot pause one flow. It pauses a whole priority on a whole link. Suppose many senders
converge on one receiver (incast, common in all-to-all and reduce-scatter phases), and the
receiver's leaf port is the bottleneck. The leaf fills and pauses its spine uplinks for priority 3.
Every priority-3 flow on those uplinks stops, including flows heading to completely different,
uncongested receivers. These **victim flows** suffer from a hot spot they have nothing to do with.
If the spine fills, it pauses other leaves, and the "pause tree" can spread across the fabric.

```widget
pfc-ecn-sim
```

In the simulator, turn ECN off and raise the offered load. The queue reaches XOFF, PFC fires, and the
sender is throttled only by pauses. Then turn ECN on: marking starts at a lower threshold, DCQCN
slows the sender, and the queue rarely reaches XOFF. That is the design goal for every RoCE fabric:
**ECN does the steady-state work, and PFC is the last-resort safety net.**

### PFC and lossless are not the same thing

PFC guarantees no *congestion* drops in a class, as long as headroom is correct. Packets can still
be lost to bit errors (FEC can correct only so much), to MTU mismatches, to ACL drops, to routing
blackholes, and to a PFC watchdog deliberately dropping on a stuck queue. The RDMA transport must
still retransmit correctly. PFC only makes loss rare enough that a simple retransmission scheme performs well.

## In practice

### Host side: is PFC on, and is it being used?

With the distribution's (inbox) driver stack, iproute2's `dcb` sets and shows PFC per priority. With
NVIDIA's stack (MLNX_OFED / DOCA-OFED) the usual tool is `mlnx_qos`, which is not part of a distro
install (`dcb` keeps working under DOCA too). Enable PFC on priority 3 and read it back:

```bash stack=inbox
sudo dcb pfc set dev ens64f0np0 prio-pfc all:off 3:on
dcb pfc show dev ens64f0np0
```

```text stack=inbox real
pfc-cap 8 macsec-bypass off delay 7
prio-pfc 0:off 1:off 2:off 3:on 4:off 5:off 6:off 7:off
```

```bash stack=doca
sudo mlnx_qos -i ens64f0np0 --pfc 0,0,0,1,0,0,0,0   # prints the full status afterwards
mlnx_qos -i ens64f0np0
```

```text stack=doca real
DCBX mode: OS controlled
Priority trust state: dscp
dscp2prio mapping:
	prio:0 dscp:07,06,05,04,03,02,01,00,
...
Receive buffer size (bytes): 130944,130944,0,0,0,0,0,0,max_buffer_size=262016
Cable len: 7
PFC configuration:
	priority    0   1   2   3   4   5   6   7
	enabled     0   0   0   1   0   0   0   0
	buffer      0   0   0   1   0   0   0   0
...
```

(The `mlnx_qos` capture was taken with trust set to DSCP, hence the `dscp2prio` block. `mlnx_qos` wants
all eight values: `--pfc 0,0,0,1` fails with `pfc list must have 8 items`.)

Make sure global 802.3x pause is off, so that it cannot pause the whole link:

```bash
ethtool -a ens64f0np0            # show global pause settings
ethtool -A ens64f0np0 rx off tx off
```

```text real=inbox
Pause parameters for ens64f0np0:
Autonegotiate:	off
RX:		off
TX:		off
```

On ConnectX (mlx5) the two settings interact. Global pause is on by default (`RX: on`, `TX: on`),
and enabling PFC on any priority turns it off automatically. The reverse is a trap: running
`ethtool -A <if> rx on tx on` while PFC is enabled silently clears PFC on **all** priorities, with
no warning and exit code 0. Re-check the PFC vector after any `ethtool -A`:

```bash stack=inbox
sudo ethtool -A ens64f0np0 rx on tx on; echo rc=$?
dcb pfc show dev ens64f0np0 prio-pfc
```

```text stack=inbox real
rc=0
prio-pfc 0:off 1:off 2:off 3:off 4:off 5:off 6:off 7:off
```

```bash stack=doca
sudo ethtool -A ens64f0np0 rx on tx on; echo rc=$?
mlnx_qos -i ens64f0np0 | sed -n '/PFC configuration/,/buffer/p'
```

```text stack=doca real
rc=0
PFC configuration:
	priority    0   1   2   3   4   5   6   7
	enabled     0   0   0   0   0   0   0   0
	buffer      0   0   0   0   0   0   0   0
```

> [!VERIFIED]
> **Enabling PFC turned 802.3x global pause off, and `ethtool -A <if> rx on tx on` silently cleared PFC again.**
> On ConnectX-5 (fw 16.29) with both the inbox stack (`dcb pfc`) and DOCA-OFED 3.4 (`mlnx_qos`), `ethtool -a`
> read `RX: off` / `TX: off` right after PFC was enabled on priority 3. Turning global pause back on returned
> rc 0 with no warning, and PFC was then off on every priority. Treat `ethtool -A` and PFC as one setting:
> after any pause change, re-read `dcb pfc show` or `mlnx_qos` and the `ethtool -S` pause counters.

The mlx5 driver exposes per-priority pause counters through `ethtool -S`. The names below are
documented in the kernel's mlx5 counters page. Availability depends on driver version, and the
per-priority pause counters appear only for priorities that have PFC enabled on the NIC: no
`rx_prio3_pause` line means PFC is not enabled on priority 3 there. The capture below is host A after a
10-second, 4-QP `ib_write_bw` in priority 3, back to back at 100G:

```bash
ethtool -S ens64f0np0 | grep -E 'prio3_pause|pause_storm|global_pause'
```

```text real=inbox
     rx_prio3_pause: 696
     rx_prio3_pause_duration: 608
     tx_prio3_pause: 26
     tx_prio3_pause_duration: 114
     rx_prio3_pause_transition: 348
     tx_pause_storm_warning_events: 0
     tx_pause_storm_error_events: 0
```

The fields: `rx_prio3_pause` counts PFC frames received for priority 3 (the peer, here the receiving
NIC, paused us) and `rx_prio3_pause_duration` the time spent paused; `tx_prio3_pause` counts PFC frames
this NIC sent (its own receive path could not keep up); `rx_prio3_pause_transition` counts XOFF-to-XON
transitions. Note that the grep also asked for `global_pause` and got nothing: with PFC on, those
counters are gone.

How to read it:

- The global-pause counters (`rx_global_pause`, `tx_global_pause` and their `_duration`) exist only
  while 802.3x pause is on. When PFC is enabled they disappear and the `prioN_pause` counters appear
  instead, so seeing `rx_global_pause` on a RoCE port means PFC is not enabled there. The
  `pause_storm` counters are always present.
- `rx_prio3_pause` rising slowly during heavy collectives: normal. The fabric occasionally pushes
  back on this sender.
- `rx_prio3_pause` rising fast on *many* hosts at once, with throughput down: congestion spreading.
  Look for a hot spot or an ECN misconfiguration.
- `tx_prio3_pause` rising on one host: that host's receive path is the bottleneck (PCIe, NUMA, a
  stalled process, firmware). Investigate the host, not the switch. Some pauses from a NIC that is
  receiving at line rate are normal (in a back-to-back 100G lab test, the receiver paused the sender
  hundreds of times in ten seconds). Compare rate and duration across hosts rather than reacting to
  any non-zero value.
- Pause-storm counters non-zero: the NIC's storm protection triggered. See the storms and deadlocks lesson.

### Switch side

The exact command depends on the network OS. Two common examples:

```bash
# SONiC: per-port, per-priority PFC frame counters
show pfc counters
```

```text
# illustrative, trimmed
  Port Rx    PFC0  PFC1  PFC2     PFC3  PFC4  PFC5  PFC6  PFC7
-----------  ----  ----  ----  -------  ----  ----  ----  ----
  Ethernet0     0     0     0   45,112     0     0     0     0
  Ethernet8     0     0     0        0     0     0     0     0
...
  Port Tx    PFC0  PFC1  PFC2     PFC3  PFC4  PFC5  PFC6  PFC7
-----------  ----  ----  ----  -------  ----  ----  ----  ----
  Ethernet0     0     0     0      214     0     0     0     0
```

On Cumulus Linux, hardware counters for a switch port, including PFC counters, are visible with
`ethtool -S swpN`. NVUE also offers per-interface QoS counter views. Check the NVUE command
reference for your release for the exact `nv show interface <port> counters ...` path.

Patterns to look for:

| Observation | Likely meaning |
|---|---|
| Tx PFC3 on leaf downlinks to hosts, Rx PFC3 on those hosts | Leaf is congested towards hosts (incast). ECN should be doing more of the work. |
| Rx PFC3 on a leaf downlink (pause *from* a host) | Host receive path is slow. Check that host's `tx_prio3_pause`. |
| Tx PFC3 on spine ports towards many leaves | Congestion has spread into the spine layer |
| PFC counters on a priority that should be lossy | Classification mismatch: PFC enabled on the wrong priority, or traffic arriving with the wrong priority |
| Pause counters stuck increasing at a constant high rate with no traffic draining | Possible storm or deadlock. Check the PFC watchdog. |

> [!TIP]
> Absolute PFC counts mean little on their own. Rate (frames per second), *duration* and *where in
> the topology* they appear tell the story. Graph pause duration per port over time. A healthy RoCE
> fabric under load shows occasional short bursts, not a continuous plateau.

## Common pitfalls

- **PFC enabled on the host but not on the switch (or on a different priority).** *Symptom:*
  RDMA retransmissions (`out_of_sequence`, `packet_seq_err` hardware counters rise) and poor
  throughput under load, but no PFC counters anywhere. *Cause:* the switch treats priority 3 as lossy
  and drops on congestion. *Fix:* enable PFC on the same priority on every hop, and verify by
  generating incast while watching Tx PFC on the switch.
- **802.3x global pause left on.** *Symptom:* unrelated traffic classes, such as TCP control traffic,
  stall when RoCE is congested. *Cause:* link-level pause stops all priorities. *Fix:*
  `ethtool -A <if> rx off tx off` on hosts, and disable link pause on switch ports carrying PFC.
  On ConnectX hosts the usual failure is the opposite: a script that "restores" global pause with
  `ethtool -A <if> rx on tx on` silently disables PFC on every priority.
- **Too many lossless priorities.** *Symptom:* headroom cannot be allocated, or the shared buffer
  is too small and lossy traffic drops early. *Cause:* each lossless PG on each port needs headroom.
  *Fix:* keep one lossless priority for RoCE (two at most, for example RoCE and storage).
- **Treating PFC as congestion control.** *Symptom:* the fabric works in small tests but throughput
  collapses and pauses spread under all-to-all at scale. *Cause:* no ECN/DCQCN, so PFC is the only
  brake. *Fix:* configure ECN marking below XOFF and enable DCQCN (or the NIC's congestion-control
  algorithm) on the RoCE priority.
- **Assuming switch-side PFC means a network problem.** *Symptom:* hunting for a bad switch.
  *Cause:* the pauses originate from a host NIC (`tx_prioN_pause` on the host). *Fix:* follow pause
  direction to its *origin*. The device that sends pauses without receiving any is the root.
- **Forgetting that the PFC frame is link-local.** *Symptom:* expecting to see a PAUSE "from the
  receiver" at the sender. *Cause:* PFC is hop by hop. Each device regenerates pauses based on its
  own buffers. *Fix:* correlate counters hop by hop along the path.

## Key takeaways

- RoCE uses a lossless class because many RDMA transports recover from loss with go-back-N, which is
  very expensive for large, synchronised AI collectives.
- PFC (802.1Qbb) is an 802.3x-style MAC control frame (EtherType 0x8808, **opcode 0x0101**, DA
  01-80-C2-00-00-01) with a **class-enable vector** and **eight timers** in quanta of **512 bit times**.
- PFC acts **per priority, per link, hop by hop**, and is triggered by **ingress PG** occupancy
  crossing XOFF. XON (timer 0) resumes.
- Headroom must absorb data in flight after XOFF. Without enough of it, "lossless" drops anyway.
- PFC causes head-of-line blocking and congestion spreading. ECN/DCQCN should keep queues below XOFF
  so that PFC fires rarely.
- Pause frames sent *by a host NIC* point at a slow host receive path. Pause frames sent by switches
  point at fabric congestion.
