---
id: hol-rocev2-wireshark
title: "RoCEv2 on the wire: capturing and decoding BTH opcodes, PSNs and QPNs"
kind: handson
level: 3
estimated_minutes: 75
environment: linux-vm
lessons: [rocev2-encapsulation]
files: labs/hol-rocev2-wireshark
verified: false
tier: 0
fabric: any
requires: [linux-vm]
summary: "Capture Soft-RoCE packets and decode the BTH: opcodes, PSNs, QPNs and ACKs, exactly as a packet analyzer sees RoCEv2."
---

> [!NOTE]
> Only the single-VM path (Option B: the synthetic capture with Tasks 2, 5 and 7, and `check.sh` on
> it) has been executed, with tshark 4.2.2 on Ubuntu 24.04; the field names below were confirmed
> there with `tshark -G fields`. The real two-VM Soft-RoCE capture (Option A) has not yet been run,
> so this lab stays unverified. If a command behaves differently on your system, please report it.

## Goal

See RoCEv2 exactly as a switch and a packet analyzer see it: Ethernet, IPv4, UDP destination port
4791, the InfiniBand **Base Transport Header (BTH)** and its extension headers. You will capture
Soft-RoCE traffic with `tcpdump` and decode it with `tshark`/Wireshark, whose InfiniBand dissector
understands RoCEv2.

By the end you can:

- Identify RoCEv2 packets and explain every layer of the header stack.
- Read BTH fields: opcode, destination QP, PSN, AckReq, P_Key.
- Recognize SEND, RDMA WRITE and RDMA READ message segmentation (FIRST/MIDDLE/LAST/ONLY) and
  acknowledgements (AETH), including a NAK.
- Explain where ECN bits and the UDP source port (ECMP entropy) live, and what a CNP looks like.

## Setup

### Why you need two machines for a real capture

With a single rxe device and client and server on the same host (the approach of the
`hol-soft-roce-perftest` lab), `rxe` loops packets back internally and they never pass through the
network interface, so `tcpdump` sees nothing. Two rxe devices inside one network namespace do not
work either (both addresses are local, so traffic is routed via `lo`). For a real capture use:

- **Option A (recommended): two VMs on the same virtual network** (for example two Multipass,
  VirtualBox, VMware or KVM VMs on a shared bridged or host-only network, or two cloud VMs in one
  subnet with UDP 4791 and TCP 18515 allowed between them). Each VM: Ubuntu 24.04, 2 vCPU, 2 GB RAM
  is plenty.
- **Option B (single VM, offline): a synthetic capture.** `labs/hol-rocev2-wireshark/make_roce_pcap.py`
  writes a small, hand-built RoCEv2 capture (SEND, WRITE, READ, ACK, NAK, a CE-marked packet and a
  CNP). The layout follows the IBTA RoCEv2 format, but the values are made up and the ICRC is a
  zero placeholder. Use it to practice Tasks 2-6 if you cannot run two VMs, then repeat on real
  traffic later.

### Prepare both VMs (Option A)

On **both** VMs:

```bash
sudo apt-get update
sudo apt-get install -y rdma-core ibverbs-utils ibverbs-providers perftest rdmacm-utils \
    tcpdump tshark linux-modules-extra-$(uname -r)
# Use the interface that faces the other VM (check with: ip -br addr)
IF=enp0s8
cd labs/hol-soft-roce-perftest
sudo ./setup.sh $IF
GID=$(./find_gid.sh -q rxe0); echo "GID index: $GID"
```

Note each VM's IP address on `$IF`. Below, **VM A** (IP `$A_IP`) is the server and **VM B** is the
client. On VM B, set it in the shell you use for the tasks (`A_IP=<VM A's address>`), and check
plain connectivity first: `ping -c 3 $A_IP` from VM B. If `tshark` asks whether
non-root users may capture packets, either answer is fine; this lab captures with `sudo tcpdump`
and reads files as a normal user.

Option B instead:

```bash
cd labs/hol-rocev2-wireshark
python3 make_roce_pcap.py /tmp/roce-synthetic.pcap
```

## Tasks

### Task 1: Capture a SEND/RECV ping-pong

On **VM B**, start a capture (it filters RoCEv2 data plus the TCP port that `ibv_rc_pingpong` uses
for its out-of-band QP exchange):

```bash
sudo tcpdump -ni $IF -w /tmp/roce-send.pcap 'udp port 4791 or tcp port 18515'
```

On **VM A** (server):

```bash
ibv_rc_pingpong -d rxe0 -g $GID -s 64 -n 5
```

On **VM B** (client), in a second terminal:

```bash
ibv_rc_pingpong -d rxe0 -g $GID -s 64 -n 5 $A_IP
```

Stop `tcpdump` with Ctrl-C. Then quickly look at the TCP part:

```bash
tshark -r /tmp/roce-send.pcap -Y tcp
```

**Why:** the TCP connection is the out-of-band exchange of LID, QPN, PSN and GID. Only after that
do RoCEv2 packets (UDP 4791) appear. In production, applications use `rdma_cm` (Task 6) or their
own bootstrap (NCCL uses its own TCP-based bootstrap) for the same purpose.

### Task 2: Decode the BTH

First, confirm the field names on your Wireshark version:

```bash
tshark -G fields | awk -F'\t' '$3 ~ /^infiniband\.(bth|reth|aeth)\./ {print $3"\t"$2}'
```

This prints names such as `infiniband.bth.opcode`, `infiniband.bth.destqp`,
`infiniband.bth.psn`, `infiniband.bth.a` (AckReq), `infiniband.bth.p_key`, `infiniband.reth.va`,
`infiniband.reth.r_key`, `infiniband.reth.dmalen`, `infiniband.aeth.syndrome` and
`infiniband.aeth.msn`. If your version differs, substitute its names below.

Summary view (Wireshark labels RoCEv2 as "RRoCE", routable RoCE):

```bash
tshark -r /tmp/roce-send.pcap -Y infiniband
```

Field view:

```bash
tshark -r /tmp/roce-send.pcap -Y infiniband -T fields -E header=y \
  -e frame.number -e ip.src -e udp.srcport -e udp.dstport \
  -e infiniband.bth.opcode -e infiniband.bth.destqp -e infiniband.bth.psn \
  -e infiniband.bth.a -e infiniband.aeth.syndrome -e infiniband.aeth.msn
```

Full decode of one SEND Only packet:

```bash
tshark -r /tmp/roce-send.pcap -V -Y 'infiniband.bth.opcode == 4' | sed -n '/^InfiniBand/,/Invariant CRC/p' | head -40
# or pick one frame number N from the summary: tshark -r /tmp/roce-send.pcap -V -Y 'frame.number == N'
```

If nothing decodes as InfiniBand (for example you changed the port), force the dissector:
`tshark -r FILE -d udp.port==4791,infiniband`.

**What to observe and why:**

| Field | What you see | Meaning |
|---|---|---|
| UDP dst port | 4791 | IANA port for RoCEv2; this is how switches and analyzers recognize RoCE. |
| UDP src port | varies per QP | Chosen by the sender per QP to give ECMP hashing entropy (Task 5). |
| Opcode | 4 = RC SEND Only, 17 = RC Acknowledge | The opcode's top 3 bits are the transport (RC = 000), the rest the operation. |
| Destination QP | the peer's QPN | Compare with the "remote address: QPN" line printed by `ibv_rc_pingpong`. |
| PSN | increments by one per packet | 24-bit Packet Sequence Number, starting from the PSN exchanged out of band. |
| AckReq | set on the last packet of a message | Asks the responder to acknowledge. |
| AETH syndrome / MSN | on ACK packets | Syndrome says ACK or NAK (and why); MSN counts completed messages. |
| Invariant CRC | last 4 bytes | End-to-end CRC over fields that do not change in flight (the synthetic file uses zeros). |

Match the QPN and PSN values against the `local address`/`remote address` lines that
`ibv_rc_pingpong` printed: the starting PSN each side announced is the first PSN you see from it.

### Task 3: Segmentation: one message, many packets

Repeat Task 1 without `-s 64` (the default message size is 4096 bytes) and with `-n 2`, writing to
`/tmp/roce-seg.pcap`. With the 1024-byte active MTU of a 1500-byte netdev you should see each
message split into **SEND First (0), SEND Middle (1), SEND Middle (1), SEND Last (2)** with
consecutive PSNs, and AckReq set only on the Last packet.

```bash
tshark -r /tmp/roce-seg.pcap -Y infiniband -T fields -e frame.number -e ip.src \
  -e infiniband.bth.opcode -e infiniband.bth.psn -e infiniband.bth.a -e udp.length
```

**Why:** RDMA messages can be up to 2 GB; the NIC (here rxe) segments them into path-MTU-sized
packets, and only the responder's final ACK covers the whole message. `udp.length` for full
packets is 1024 payload + 12 BTH + 4 ICRC + 8 UDP = 1048 bytes, which is why the Ethernet MTU must
be larger than the RDMA MTU.

### Task 4: RDMA WRITE and RDMA READ

Capture again (`-w /tmp/roce-write.pcap`), then run a tiny WRITE test:

```bash
ib_write_bw -d rxe0 -x $GID -F -s 3000 -n 5            # VM A
ib_write_bw -d rxe0 -x $GID -F -s 3000 -n 5 $A_IP      # VM B
```

And a READ test into `/tmp/roce-read.pcap`:

```bash
ib_read_bw -d rxe0 -x $GID -F -s 2048 -n 5             # VM A
ib_read_bw -d rxe0 -x $GID -F -s 2048 -n 5 $A_IP       # VM B
```

Decode both:

```bash
for f in /tmp/roce-write.pcap /tmp/roce-read.pcap; do
  echo "== $f"
  tshark -r $f -Y infiniband -T fields -e ip.src -e infiniband.bth.opcode \
    -e infiniband.bth.psn -e infiniband.reth.va -e infiniband.reth.r_key \
    -e infiniband.reth.dmalen -e infiniband.aeth.syndrome | head -20
done
```

(perftest may run a few extra warm-up or synchronization operations, so do not expect exactly five
messages.)

**What to observe and why:**

- **WRITE**: opcode 6 (WRITE First) carries a **RETH** with the remote virtual address, R_Key and
  total DMA length (3000), then 7 (Middle) and 8 (Last). Only the first packet needs the RETH: the
  responder remembers where it is writing. The responder's CPU is not involved; you see only ACKs
  (17) coming back.
- **READ**: the requester sends opcode 12 (READ Request) with a RETH and no payload; the responder
  returns 13 (READ Response First), 14 (Middle) or 15 (Last), or 16 (Only), and the First, Last and
  Only responses carry an **AETH**. A READ Request consumes as many PSNs as the response packets
  it triggers.
- Older Wireshark versions may flag a READ Request as "Malformed" because a heuristic dissector
  (LNet) tries to parse the trailing ICRC; `tshark --disable-protocol lnet ...` silences it.

### Task 5: ECN bits and UDP source-port entropy

```bash
tshark -r /tmp/roce-write.pcap -Y infiniband -T fields \
  -e ip.dsfield.dscp -e ip.dsfield.ecn -e udp.srcport -e infiniband.bth.destqp | sort | uniq -c
```

**What to observe and why:**

- `ip.dsfield.dscp`: the DSCP the sender used. Soft-RoCE uses whatever the kernel default is
  (normally 0), unless you set a traffic class. On a real lossless fabric, RoCE traffic is marked
  with a dedicated DSCP that switches map to a PFC-enabled queue; which value depends on your
  design and vendor defaults.
- `ip.dsfield.ecn`: `0` = Not-ECT, `2` = ECT(0), `1` = ECT(1), `3` = CE (congestion experienced).
  RDMA NICs that implement DCQCN send ECN-capable packets; switches mark CE instead of dropping,
  and the receiver answers with a **CNP** (opcode 0x81 = 129). Whether rxe sets ECT depends on the
  kernel version; on the synthetic file you will see one CE-marked WRITE Middle and one CNP. Some
  Wireshark versions show the CNP as an "Unknown OpCode" because they do not name opcode 0x81.
- `udp.srcport`: one value per QP (rxe derives it from the QP number; hardware NICs use their own
  schemes and some let you configure it). Switches hash on the UDP 5-tuple, so this port is the
  only per-connection entropy that ECMP sees: two QPs between the same pair of hosts can take
  different spine paths only because their source ports differ.

### Task 6: Connection setup with rdma_cm

Capture into `/tmp/roce-cm.pcap` and run perftest with `-R` (use `rdma_cm` to connect):

```bash
ib_send_bw -d rxe0 -x $GID -F -R -n 5           # VM A
ib_send_bw -d rxe0 -x $GID -F -R -n 5 $A_IP     # VM B
```

Look for packets to **QP 1** (the General Services Interface QP that carries management datagrams):

```bash
tshark -r /tmp/roce-cm.pcap -Y 'infiniband.bth.destqp == 1'
tshark -r /tmp/roce-cm.pcap -Y 'infiniband.bth.destqp == 1' -V | grep -iE 'opcode|attribute|method|ConnectRequest|ConnectReply|ReadyToUse' | head -30
```

**Why:** with `rdma_cm`, the QP exchange happens inside RoCEv2 itself, as Communication Manager
MADs (ConnectRequest, ConnectReply, ReadyToUse) sent with the UD SEND Only opcode (0x64 = 100) to
QP 1. The exact Wireshark labels for CM messages vary between versions, so look at the decoded tree
rather than relying on specific field names. If the `-R` test fails on rxe in your environment,
skip this task; the concept is what matters.

### Task 7 (optional): A NAK

The synthetic file contains a lost-packet scenario: A sends a PSN that skips one value and B
answers with an ACK packet whose AETH syndrome is `0x60` (96 decimal), a **NAK: PSN sequence
error**, carrying the PSN B expected. Find it:

```bash
tshark -r /tmp/roce-synthetic.pcap -Y 'infiniband.bth.opcode == 17 && infiniband.aeth.syndrome >= 0x60' -V | sed -n '/InfiniBand/,$p'
```

**Why:** an RC requester that receives this NAK retransmits from the expected PSN ("go-back-N" on
many implementations). On a fabric with drops, this is why a tiny loss rate destroys RDMA
throughput, and why RoCE fabrics are engineered to be lossless or use NICs with selective
retransmission. On real captures, a NAK appears only when packets are actually lost.

## Verify

```bash
cd labs/hol-rocev2-wireshark
./check.sh /tmp/roce-send.pcap /tmp/roce-write.pcap /tmp/roce-read.pcap
# or, for Option B:
./check.sh /tmp/roce-synthetic.pcap
```

For each file the script checks that packets to UDP 4791 exist, that tshark decodes InfiniBand
BTHs, prints a count per opcode, and checks that at least one RC ACKNOWLEDGE is present.

## Clean up

```bash
# On both VMs
cd labs/hol-soft-roce-perftest && sudo ./cleanup.sh
sudo rm -f /tmp/roce-*.pcap
```

## What you learned

- RoCEv2 = Ethernet + IP + UDP (dst 4791) + IB BTH (+RETH/AETH/...) + payload + ICRC.
- The BTH opcode encodes transport and operation; PSNs number packets, not messages.
- WRITE carries the remote address and key in the first packet only; READ is request/response.
- The UDP source port is the per-QP ECMP entropy; ECN bits and CNPs are how DCQCN signals
  congestion.
- A NAK with a PSN sequence error is the visible symptom of loss on an RC connection.

## Going further on real hardware

- On servers with RDMA NICs, hardware RoCE traffic bypasses the kernel, so `tcpdump` on the netdev
  sees nothing of it (`udp port 4791` captures zero packets during a perftest run). On NVIDIA
  ConnectX (mlx5) NICs, libpcap's **RDMA sniffer** can capture the offloaded traffic: `sudo tcpdump
  -D` lists the RDMA device (for example `mlx5_0 (RDMA sniffer)`; with distribution rdma-core it is
  named like `rocep59s0f0`), and `sudo tcpdump -i mlx5_0 -w /tmp/roce.pcap` on that RDMA device,
  not the netdev, records RoCEv2 packets you can open in Wireshark exactly as in this lab. Filter
  when reading (`tcpdump -r /tmp/roce.pcap 'udp port 4791'`). On Ubuntu, tcpdump's AppArmor
  profile blocks the sniffer (tcpdump then reports `No such device exists`) until you put the
  profile in complain mode. NVIDIA's driver stack also ships `ibdump`. Switch port mirroring
  (SPAN/ERSPAN) to a capture host is the vendor-neutral approach.
- Capture during an NCCL test and count opcodes per QP to see how NCCL splits traffic across QPs
  and how many distinct UDP source ports (ECMP entropy) it produces.
- Compare the DSCP/ECN marking on the wire with your intended QoS design; mismatches between host
  marking and switch trust/mapping are a classic cause of RoCE traffic landing in a lossy queue.
