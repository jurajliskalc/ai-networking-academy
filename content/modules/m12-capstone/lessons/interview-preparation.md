---
id: interview-preparation
title: "Interview preparation: how AI networking interviews work and how to answer"
module: m12-capstone
level: 4
estimated_minutes: 90
objectives:
  - Describe the typical interview loop for network test/verification engineer, fabric architect and network SRE roles in AI infrastructure.
  - Answer core RDMA, InfiniBand, RoCEv2, NCCL, design and troubleshooting questions with a structured, layered answer.
  - Run a whiteboard design round by clarifying requirements, sizing out loud and stating trade-offs.
  - Run a live troubleshooting round with a hypothesis-driven method and narrate evidence, not guesses.
prerequisites: [design-review-capstone, troubleshooting-methodology]
quiz: quiz-interview-preparation
widgets: []
labs: []
tags: [career, interview, rdma, roce, infiniband, nccl, design, troubleshooting]
further_reading:
  - title: NVIDIA NCCL User Guide (environment variables and troubleshooting)
    url: https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/index.html
  - title: NVIDIA RDMA Aware Networks Programming User Manual
    url: https://docs.nvidia.com/networking/display/rdmaawareprogrammingv17
  - title: "RFC 7938: Use of BGP for Routing in Large-Scale Data Centers"
    url: https://www.rfc-editor.org/rfc/rfc7938
  - title: Google SRE book (free online)
    url: https://sre.google/sre-book/table-of-contents/
---

## Why this matters

AI networking hiring is unusual. The field is young, so few candidates have run a thousand-GPU fabric,
and interviewers know it. What they look for instead is evidence that you can reason from first
principles across layers that traditionally belonged to different teams: PCIe topology, RDMA
transport, lossless Ethernet or InfiniBand, routing, and the collective library on top. A candidate
who can explain why an all-reduce is slow, starting from `nvidia-smi topo -m` and ending at a PFC
counter on a spine port, beats one who has memorised more acronyms.

Speaking as a hiring manager: most rejections are not about missing facts. They come from unstructured
answers, confident statements that turn out to be wrong, and troubleshooting by guessing ("I would
reboot the switch"). This lesson shows you how the loops are built, gives you a question bank with model
answer outlines, and teaches the tactics for the two rounds that decide most offers: the whiteboard
design and the live troubleshooting scenario.

## Concepts

### The roles

| Role | What the job is | What the loop emphasises |
|---|---|---|
| Network test / verification engineer | Qualify NICs, switches, optics, firmware and fabric configs before they reach production; build test automation and benchmarks. | Test methodology, perftest/nccl-tests fluency, reading counters, scripting (Python/Bash), writing bug reports a vendor can act on. |
| Fabric / network architect | Design back-end, storage and front-end networks; choose technology; size and cost them; own the reference design. | Whiteboard design, sizing math, trade-offs, standards and vendor landscape, communication with ML and facilities teams. |
| Network SRE / production engineer | Keep the fabric healthy at scale: telemetry, automation, incident response, capacity. | Troubleshooting rounds, on-call scenarios, automation and coding, observability, post-incident thinking. |
| Systems / ML infrastructure engineer (network-heavy) | Make training jobs fast and reliable across GPUs, NICs and NCCL. | NCCL behaviour, topology, GPUDirect, performance debugging from the host side. |

### The typical loop

Loops differ by company, but most contain some combination of:

1. **Recruiter / hiring manager screen** (30 min): your background, why this role, a couple of
   calibration questions ("what is RDMA, and why do AI clusters use it?").
2. **Technical phone screen** (45-60 min): rapid-fire fundamentals across Ethernet/IP, RDMA, and either
   InfiniBand or RoCE, sometimes a short coding exercise (parse counter output, write a test harness).
3. **Onsite / virtual loop** (4-6 interviews):
   - **Deep dive** on one technology (RoCEv2 lossless, InfiniBand, or NCCL).
   - **System design / whiteboard**: design a fabric for N GPUs.
   - **Troubleshooting**: a live scenario with counters and logs revealed as you ask.
   - **Coding / automation**: Python, often around parsing, test orchestration or telemetry.
   - **Behavioural**: incidents you owned, disagreements, how you work with vendors.

### The answer shape that works

For conceptual questions, use **layers**: one-sentence definition → mechanism → why it matters for AI
→ a failure mode or trade-off → how you would verify it on a real system. Stop after each layer and let
the interviewer steer. This shows depth without monologuing.

> [!TIP]
> "I don't know, but here is how I would find out" is a strong answer when followed by a real method
> (which document, which command, which experiment). Bluffing a CLI flag or a counter name is the
> fastest way to lose a technical interviewer's trust.

## How it works

### Question bank with model answer outlines

The outlines below are what a strong candidate covers, not scripts to memorise. Practise saying each
answer out loud in two minutes, then in thirty seconds.

#### RDMA fundamentals

**1. What is RDMA and why do AI clusters depend on it?**
Direct memory-to-memory transfer between hosts, with the NIC executing transport in hardware, kernel
bypass for the data path and zero-copy. For AI: collectives move gigabytes per step; CPU-based TCP would
burn cores and add latency and jitter. With GPUDirect RDMA the NIC reads and writes GPU memory directly.

**2. Explain QP, CQ, MR and PD and how they relate.**
QP = send + receive queue, the endpoint; CQ = where completions land; MR = registered memory with lkey
(local) and rkey (remote); PD = protection domain grouping QPs and MRs so a QP can only use MRs in its
PD. Mention registration pins memory and is expensive, so applications cache registrations.

**3. Walk through the RC QP state machine.**
RESET → INIT (port, pkey, access flags) → RTR (remote QPN, path/AH, PSN, path MTU) → RTS (timeout,
retry counts, SQ PSN). Errors move it to ERR. Mention that exchanging QPN/GID/PSN out of band (or via
RDMA-CM) is what connection setup really is.

**4. Compare RC, UC, UD (and DC if you know it).**
RC: reliable, connected, supports RDMA read/write/atomics, one QP per peer. UC: unreliable connected,
no read. UD: datagrams, MTU-limited messages, scales to many peers, send/recv only. DC (NVIDIA dynamically
connected): reliable with fewer QPs. NCCL's IB/RoCE transport uses RC.

**5. One-sided versus two-sided operations?**
Write/read are one-sided: the remote CPU is not involved and no receive is posted. Send/recv are
two-sided: the receiver must post a buffer. Write-with-immediate generates a completion at the receiver,
which is a common way to signal "data arrived".

**6. What does "retry exceeded" (IBV_WC_RETRY_EXC_ERR) usually mean?**
The sender's transport timed out retransmitting: the peer is unreachable, the path drops packets, a
wrong GID/route, or the remote QP is gone. Check link state, GID index, routing/ARP, MTU, and whether
loss in the network (for RoCE, a lossless class that is not actually lossless) is causing go-back-N storms.

#### InfiniBand

**7. What does the Subnet Manager do?**
Discovers the topology, assigns LIDs, computes forwarding tables (routing engine choice such as
min-hop, up-down, fat-tree-aware engines), programs switches, configures SL-to-VL mapping and
partitions, and reacts to changes. Mention a standby SM and SM priority.

**8. How does InfiniBand avoid loss without PFC?**
Credit-based link-level flow control: a sender transmits only when the receiver has advertised buffer
credits, per virtual lane. No pause storms in the Ethernet sense, but head-of-line blocking and
congestion spreading still exist, which is why IB has its own congestion control and adaptive routing.

**9. What are LID, GUID and GID?**
LID: 16-bit local address assigned by the SM, used for forwarding in the subnet. GUID: 64-bit
hardware identifier. GID: 128-bit, IPv6-format address (subnet prefix + GUID) used for routing across
subnets and as the RoCE address.

**10. A port shows `LinkDownedCounter` incrementing and rising `SymbolErrorCounter`. What next?**
Physical layer: inspect the cable/transceiver (`mlxlink` for eye/BER/FEC information on NVIDIA
hardware, or vendor equivalent), reseat or swap the optic, check bend radius and cleanliness, compare
with neighbours on the same switch. Distinguish errors corrected by FEC from errors after FEC.

**11. What is SHARP and when does it help?**
In-network reduction: switches perform the reduction of all-reduce, so data crosses each link fewer
times and the hosts do less work. Helps bandwidth-bound and latency-bound all-reduce at scale; requires
supported switches, the aggregation manager, and NCCL plugin support. Hedge on generation-specific
features.

#### RoCEv2 and lossless Ethernet

**12. Describe the RoCEv2 packet.**
Ethernet / IP / UDP (destination port 4791) / InfiniBand BTH / payload / ICRC. Being routable over IP
is the point; the UDP source port provides ECMP entropy.

**13. Why does RoCEv2 traditionally want a lossless network?**
NIC go-back-N retransmission is expensive: one drop can resend many packets and collapse throughput.
PFC prevents drops for the RoCE priority; ECN + DCQCN reduces the rate before buffers fill. Mention that
newer NICs with selective repeat and congestion control reduce, but do not remove, sensitivity to loss.

**14. Explain PFC and the risks it introduces.**
802.1Qbb pauses one priority on one link when ingress buffers cross XOFF; resumes at XON. Risks:
head-of-line blocking, congestion spreading, PFC storms from a misbehaving NIC, and deadlock with cyclic
buffer dependencies. Mitigations: PFC watchdog, ECN tuned to act first, correct headroom, lossless on
only one or two priorities.

**15. Explain ECN and DCQCN end to end.**
Switch marks CE when queue depth exceeds a threshold (RED/WRED-style probability between min and max).
The receiving NIC (notification point) sends a CNP to the sender. The sending NIC (reaction point)
cuts its rate, then recovers in steps. The goal: keep queues short so PFC rarely triggers.

**16. How do you map RoCE traffic to the lossless queue?**
Trust DSCP on switch and NIC; set the RDMA traffic class (for NCCL `NCCL_IB_TC`, for RDMA-CM tools the
ToS setting); map DSCP to a switch priority with PFC enabled; put CNPs in their own high-priority class.
Verify with counters: per-priority packets and pause frames on the expected priority only.

**17. What is PFC headroom and why does cable length matter?**
Buffer reserved above XOFF to absorb data in flight after the pause is sent: roughly round-trip
propagation × rate + maximum frames + response time. Longer cables and higher speeds need more; too
little headroom means drops on a "lossless" class.

#### NCCL and collectives

**18. Ring versus tree all-reduce?**
Ring: bandwidth-optimal, each rank sends 2(n−1)/n of the data, latency grows linearly with ranks. Tree
(double binary tree): logarithmic latency, better at small messages and large scale. NCCL picks per
size and topology; `NCCL_ALGO` can force it for experiments, not production.

**19. What are algbw and busbw in nccl-tests?**
algbw = size ÷ time. busbw applies the collective's factor (for all-reduce 2(n−1)/n) so it is comparable
to link bandwidth regardless of rank count. Compare busbw with the bandwidth of the bottleneck path:
NVLink inside one server; across servers, the NIC bandwidth the job can use (with one NIC per GPU and
all eight GPUs of each server in the job, roughly the server's aggregate NIC bandwidth, because NCCL
stripes channels across all NICs).

**20. A job logs `NET/Socket` instead of `NET/IB`. Why?**
NCCL fell back to TCP sockets: the RDMA devices were not visible (container without the devices or
libraries), the IB plugin failed to load, or `NCCL_IB_DISABLE` was set. Check `NCCL_DEBUG=INFO` output,
`ibv_devinfo` inside the container, and the environment.

**21. How does NCCL choose which NIC a GPU uses?**
It reads the PCIe/NVLink topology and prefers the NIC closest to each GPU (same PCIe switch). Wrong
affinity (GPU and NIC on different sockets) costs bandwidth. `NCCL_TOPO_DUMP_FILE` dumps what NCCL saw;
`nvidia-smi topo -m` shows the matrix.

**22. What is PXN?**
NCCL can move data over NVLink to a GPU whose NIC is on the destination's rail, then send it over the
network, so traffic stays rail-aligned. It trades NVLink bandwidth for fewer spine crossings.

#### Fabric design

**23. Why rail-optimized topologies?**
GPU *r* of every server connects to leaf *r*, so same-rank traffic (most data-parallel and many
collective steps) is one hop away, and NVLink handles cross-rail movement inside the server.

**24. Size a non-blocking two-tier fabric for 2,048 GPUs on radix-64 switches.**
k²/2 = 2,048, so it fits exactly: 64 leaves (32 down/32 up), 32 spines, one link per leaf-spine pair,
2,048 + 2,048 links. State that growth beyond requires a third tier or a larger radix.

**25. Static ECMP versus adaptive routing versus packet spraying?**
ECMP hashes flows, and AI flows are few and large, so collisions leave some links at 2× and others idle.
Adaptive routing picks less-loaded paths per packet or flowlet; spraying distributes packets across all
paths and needs NIC tolerance of reordering. Trade-off: utilisation versus ordering and debuggability.

**26. Why eBGP in the data-centre underlay?**
Simple, scalable, one protocol, clear failure domains, good multipath (RFC 7938). Mention ASN design,
BFD for fast failure detection, and `multipath-relax`-style behaviour.

#### Troubleshooting

**27. Training throughput dropped 20% overnight on a 512-GPU job. Walk me through it.**
Scope (one job or all jobs? one SU?), timeline (what changed: firmware, config, node swap), find the
straggler (per-rank timings, nccl-tests per node pair), then host (GPU clocks, PCIe width/speed, NIC
link), then fabric (errors, PFC pauses, ECN marks on the involved ports), then confirm the fix with the
same test.

**28. RDMA works between two hosts on the same leaf but fails across the spine.**
Routing (are the RoCE subnets advertised?), MTU on fabric links smaller than host MTU, ACL or DSCP
remark on spine links, wrong GID index (IPv4 vs IPv6 GID or RoCE v1 vs v2), PFC/ECN not configured on
spine ports.

**29. You see `tx_prio3_pause` increasing fast on one host's NIC. What does it mean?**
That host is sending pause frames on priority 3: its receive side cannot drain (host slow to consume,
PCIe bottleneck, receive buffer pressure, or a stuck application/driver). Check `rx_discards_phy`,
`out_of_buffer`, PCIe link status, CPU/NUMA placement, and whether the pause is spreading upstream.
Counter names are driver-specific; these are NVIDIA mlx5 names.

**30. nccl-tests shows `#wrong` greater than zero. What is your reaction?**
Data corruption: stop treating it as a performance issue. Suspect faulty GPU or memory, NIC or
firmware bugs, or a broken path with errors not caught; isolate the node with pairwise runs, and run GPU
diagnostics (for example DCGM diagnostics) before returning it to service.

### The whiteboard design round

The interviewer usually gives a short prompt ("design the network for 4,096 GPUs") and watches how you
handle ambiguity. A reliable sequence:

1. **Clarify (3-5 min).** GPUs per server and NICs per GPU, link speed, training versus inference,
   growth, storage throughput, multi-tenancy, InfiniBand or Ethernet preference, power/space limits.
   Write the answers on the board as your requirements list.
2. **State assumptions** for anything they will not answer, and say you will revisit them.
3. **Draw the four networks** (compute, storage, front-end, management) before diving into one; this
   shows you understand the whole system.
4. **Size out loud.** Endpoints → ports → radix → leaves → spines → links → optics. Do the arithmetic on
   the board; round deliberately and say so.
5. **Pick a technology and defend it** with requirements, not preference.
6. **Walk a failure** before they ask: one leaf, one spine, one link.
7. **Close with validation and operations**: how you will test it and what you will monitor.

> [!WARNING]
> The most common failure in design rounds is jumping straight to a favourite topology without asking
> a single question. The second is spending the whole hour on QoS details and never sizing anything.
> Watch the clock and keep moving down the list.

### The troubleshooting round

These rounds are usually interactive: you ask for data, the interviewer gives you (made-up) output.
They are grading method more than the answer.

- **Restate the symptom precisely** and ask about scope and timeline first.
- **Form two or three hypotheses** and say which data would distinguish them. "If it is a PFC storm I
  expect pause counters climbing on many ports; if it is a bad optic, errors on one link."
- **Ask for one piece of evidence at a time** and interpret it out loud, including what it rules out.
- **Bisect**: by layer (physical → link → RDMA → NCCL → application) and by location (node pairs, SU,
  rail).
- **State the fix and how you would prove it worked**, then what you would change to prevent recurrence
  (monitoring, automation, runbook).

## In practice

### A four-week preparation plan

| Week | Focus | Concrete output |
|---|---|---|
| 1 | Fundamentals: RDMA, IB, RoCEv2, PFC/ECN, NCCL basics | Two-minute spoken answers to questions 1-22 recorded and reviewed |
| 2 | Design: sizing math, rail-optimized, storage/front-end | Two full whiteboard designs (1,024 and 4,096 GPUs) with sizing workbook |
| 3 | Troubleshooting: counters, tools, case studies | Five mock troubleshooting rounds with a friend or with this academy's simulator labs |
| 4 | Coding, behavioural, mock exams, rest | A parsing script for counter output; three behavioural stories; one mock exam per two days |

### Hands-on fluency checks

Interviewers notice whether you have actually typed these commands. On a lab host (Soft-RoCE works for
the RDMA ones) make sure you can run and interpret:

```bash
ibv_devinfo -v                  # device, port state, active MTU, link layer
rdma link show                  # RDMA link state and associated netdev
ethtool -S eth2 | grep -E 'pause|discard|ecn|cnp'   # driver-specific counter names
ib_write_bw -d mlx5_0 -x 3 --report_gbits <server>  # client side; GID index depends on your setup
nvidia-smi topo -m              # GPU/NIC affinity matrix
```

```text
# illustrative nvidia-smi topo -m excerpt, not a real capture
        GPU0  GPU1  NIC0  NIC1
GPU0     X    NV18  PXB   SYS
GPU1    NV18   X    SYS   PXB
NIC0    PXB   SYS    X    SYS
NIC1    SYS   PXB   SYS    X
```

Be ready to say what each entry means: `PXB` means the path crosses multiple PCIe bridges/switches
without the CPU host bridge (good affinity for GPUDirect RDMA), `SYS` means traversing the inter-socket
link (avoid for GPU-NIC pairs), `NV18` means 18 NVLink links between the GPUs on that system.

### Behavioural stories to prepare

Prepare three stories using situation, action, result, and what you learned:

- An incident you led or contributed to, with the evidence that found the root cause.
- A time you disagreed with a design or a vendor and how it resolved.
- A test or automation you built that caught a problem before production.

> [!INTERVIEW]
> "Tell me about a time you were wrong." Strong answers name the specific wrong belief, how evidence
> changed your mind, and what process you changed so it would not happen again. Weak answers pick a
> fake weakness.

## Common pitfalls

- **Monologuing.** Symptom: the interviewer cannot steer and runs out of time. Cause: trying to show
  everything at once. Fix: answer in layers and pause after each.
- **Inventing specifics.** Symptom: an interviewer who knows the tool asks a follow-up you cannot
  answer. Cause: guessing a flag, counter or default. Fix: describe the concept and say where you would
  confirm the exact syntax.
- **Skipping clarification in design rounds.** Symptom: a beautiful design for the wrong problem. Fix:
  spend the first five minutes on requirements and write them down.
- **Troubleshooting by action instead of evidence.** Symptom: "I'd reboot it" or "I'd replace the
  switch" as a first step. Fix: hypothesis → data → interpretation, and only then a change.
- **Ignoring the host.** Symptom: blaming the fabric for a GPU or PCIe problem. Fix: always check GPU
  and NIC affinity, PCIe link width/speed and NIC link state in your first pass.
- **Treating one vendor's defaults as universal.** Symptom: confident wrong answers in a shop that runs
  different gear. Fix: name the generation and vendor when you quote a number.
- **No questions for the interviewer.** Symptom: you seem uninterested. Fix: ask about their fabric
  scale, on-call model, test infrastructure and the hardest incident of the last year.

## Key takeaways

- Loops combine fundamentals, a deep dive, a design whiteboard, a troubleshooting scenario, coding and
  behavioural rounds; the design and troubleshooting rounds usually decide the outcome.
- Answer conceptual questions in layers: definition, mechanism, AI relevance, failure mode, how to
  verify.
- In design rounds: clarify, assume explicitly, draw all four networks, size out loud, defend the
  technology choice, walk a failure, close with validation.
- In troubleshooting rounds: scope and timeline, competing hypotheses, one piece of evidence at a
  time, bisect by layer and location, prove the fix.
- Never invent a flag, counter or default; "here is how I would find out" is a strong answer.
- Hands-on fluency with `ibv_devinfo`, `rdma`, `ethtool -S`, perftest, nccl-tests and
  `nvidia-smi topo -m` is visible within minutes, so practise on a real or virtual host.
