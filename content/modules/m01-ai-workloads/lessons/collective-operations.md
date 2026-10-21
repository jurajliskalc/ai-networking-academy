---
id: collective-operations
title: "Collective operations: all-reduce and friends"
module: m01-ai-workloads
level: 1
estimated_minutes: 50
objectives:
  - Define broadcast, reduce, all-reduce, reduce-scatter, all-gather, all-to-all and send/recv, with their inputs and outputs.
  - Walk through the ring all-reduce step by step and derive the 2(N-1)/N data volume per rank.
  - Use the alpha-beta model to explain why small collectives are latency-bound and large ones bandwidth-bound.
  - Explain the difference between algorithm bandwidth and bus bandwidth as reported by nccl-tests.
prerequisites: [ai-training-101, parallelism-strategies]
quiz: quiz-collective-operations
widgets: [allreduce-sim]
labs: []
tags: [collectives, all-reduce, ring, tree, alpha-beta, nccl, busbw, ai-workloads]
further_reading:
  - title: NCCL User Guide - Collective operations
    url: https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/usage/collectives.html
  - title: nccl-tests performance notes (algorithm vs bus bandwidth)
    url: https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md
  - title: PyTorch torch.distributed documentation
    url: https://pytorch.org/docs/stable/distributed.html
  - title: MPI Standard (MPI Forum) - collective communication chapter
    url: https://www.mpi-forum.org/docs/
---

## Why this matters

In `parallelism-strategies` you saw that every way of splitting a model produces a characteristic communication pattern: all-reduce for data parallelism, all-gather and reduce-scatter for sharded training, all-to-all for mixture-of-experts. These patterns are called **collective operations** because a whole group of GPUs participates, and none can finish until the group's data has been exchanged. Collectives are the unit of work an AI network actually serves. A training job does not care about the latency of one packet; it cares how long an all-reduce of 256 MB across 1,024 GPUs takes.

Understanding collectives tells you how many bytes each GPU really sends, which links they cross, why performance depends so strongly on message size, and how to read the numbers that every AI networking team uses: the **bus bandwidth** reported by `nccl-tests`. Without it, you cannot judge whether a fabric is performing well or merely busy. Module `m08-nccl-collectives` goes deeper into algorithms and tuning; this lesson builds the core model.

## Concepts

### Ranks and communicators

Each participating process (typically one per GPU) is a **rank**, numbered 0 to N-1. A **communicator** is a group of ranks that perform collectives together, for example "the 8 GPUs of TP group 5" or "the 128 ranks of DP group 3". A single GPU belongs to several communicators at once, one per parallelism dimension.

### The core collectives

The table uses N ranks and a buffer of S bytes per rank (conventions on whether S means input or output size differ per operation; the NCCL documentation states them precisely).

| Operation | Input | Output | Typical AI use |
|---|---|---|---|
| Broadcast | Root has data | Every rank has a copy of the root's data | Sending initial weights from rank 0 |
| Reduce | Every rank has a buffer | Root holds the element-wise sum (or max, min...) | Rare in training |
| **All-reduce** | Every rank has a buffer | Every rank holds the element-wise sum | Gradient averaging (DP), TP activations |
| **Reduce-scatter** | Every rank has a buffer of S | Each rank holds 1/N of the summed result | FSDP gradients, sequence-parallel TP |
| **All-gather** | Each rank has a piece of S/N | Every rank holds all N pieces | FSDP weights, sequence-parallel TP |
| **All-to-all** | Each rank has N pieces, one per destination | Each rank holds the pieces addressed to it from everyone | MoE token dispatch/combine |
| Send / recv | One rank sends to one rank | Point to point | Pipeline parallel activations |
| Barrier | Nothing | Everyone has arrived | Synchronisation |

A tiny example with 4 ranks, each holding a vector of 4 numbers:

```
              rank0         rank1         rank2         rank3
input:      [1 1 1 1]     [2 2 2 2]     [3 3 3 3]     [4 4 4 4]

all-reduce: [10 10 10 10] on every rank
reduce-scatter: rank0 [10]  rank1 [10]  rank2 [10]  rank3 [10]   (each holds one quarter)
all-gather (from the reduce-scatter output): [10 10 10 10] on every rank
```

The last two lines show the most important identity in this lesson:

> **all-reduce = reduce-scatter followed by all-gather.**

This is not just a curiosity. It is how bandwidth-optimal all-reduce algorithms work, and it is why sharded training (which uses reduce-scatter and all-gather separately) moves roughly the same data as all-reduce, split into two phases.

## How it works

### The ring all-reduce, step by step

Arrange N ranks in a logical ring: 0 -> 1 -> 2 -> ... -> N-1 -> 0. Split each rank's buffer of S bytes into N chunks of S/N.

**Phase 1, reduce-scatter (N-1 steps)**: in each step, every rank sends one chunk to its right-hand neighbour and receives one chunk from its left, adding the received chunk to its own copy. After N-1 steps, each rank holds the fully summed version of exactly one chunk.

**Phase 2, all-gather (N-1 steps)**: each rank passes its completed chunk around the ring; after another N-1 steps, everyone has every completed chunk.

```mermaid
flowchart LR
  R0["Rank 0"] -- "chunk, S/N per step" --> R1["Rank 1"]
  R1 --> R2["Rank 2"]
  R2 --> R3["Rank 3"]
  R3 --> R0
```

Counting bytes: each rank sends S/N per step for 2(N-1) steps:

```
bytes sent per rank = 2 x (N-1) / N x S
```

For large N this approaches **2S**: to all-reduce a 1 GB buffer, every GPU sends about 2 GB and receives about 2 GB, no matter whether there are 8 or 8,000 GPUs. That is the theoretical minimum for any algorithm in which ranks only exchange data (it can be beaten only by doing the arithmetic inside the network, see below). In every step, every rank sends and receives at the same time, so no link along the ring sits idle; together with the minimal volume this is why the ring is called **bandwidth-optimal**.

```widget
allreduce-sim
```

Step through the widget with 4 ranks and watch the chunks: count the steps (2 x 3 = 6) and the chunks each rank sends. Then switch to the tree algorithm and compare.

### The alpha-beta model

A simple and surprisingly useful model of a message transfer is:

```
time = alpha + bytes / bandwidth
```

**alpha** (latency) is the fixed cost per message: software overhead, NIC processing, switch hops, propagation, on the order of a few microseconds between servers on a scale-out fabric. **bandwidth** is per-link throughput, for example about 50 GB/s for a 400 Gb/s NIC. For the ring all-reduce:

```
T_ring = 2(N-1) x alpha  +  2(N-1)/N x S / bandwidth
         latency term        bandwidth term
```

Worked example, N = 1,024 ranks, alpha = 5 us, bandwidth = 50 GB/s:

| Message size S | Latency term | Bandwidth term | Total (approx.) | Bound by |
|---|---|---|---|---|
| 1 MB | 2 x 1023 x 5 us = 10.2 ms | 2 MB / 50 GB/s = 0.04 ms | 10.3 ms | Latency |
| 64 MB | 10.2 ms | 2.6 ms | 12.8 ms | Latency |
| 1 GB | 10.2 ms | 40 ms | 50 ms | Bandwidth |

The latency term grows **linearly** with N: a flat ring across 1,024 ranks pays 2,046 sequential latency steps. That is why real libraries do not use one flat ring at scale. They use:

- **Trees**: NCCL's double binary tree has a latency term proportional to log2(N) rather than N, a huge win for small and medium messages, while still using bandwidth well for large ones.
- **Hierarchical algorithms**: reduce inside each server over NVLink first, then run the inter-node part between servers (one or a few ranks per server per rail), then broadcast back inside the server. The inter-node step has N/8 participants instead of N.

Library implementations choose algorithms and protocols per message size automatically; `nccl-architecture` describes how NCCL does it.

### Other collectives' volumes

| Collective | Bytes sent per rank (bandwidth-optimal, large N) |
|---|---|
| All-reduce | about 2S |
| Reduce-scatter | about S (S = full input buffer) |
| All-gather | about S (S = full output buffer) |
| All-to-all | (N-1)/N x S, sent as N-1 separate pieces to N-1 different peers |
| Broadcast | about S (pipelined) |

All-to-all is special: its volume is not huge, but every rank sends a distinct piece to every other rank **at the same time**. In network terms that is a full-mesh burst, the pattern most likely to cause incast and congestion hotspots (`ai-traffic-patterns`, `incast-and-congestion-hotspots`).

### In-network reduction

An all-reduce could be done with fewer bytes per GPU if the network itself did the adding. **SHARP** (Scalable Hierarchical Aggregation and Reduction Protocol) does exactly that on NVIDIA InfiniBand switches, and NVLink SHARP does it inside NVSwitch-based systems: each GPU sends its buffer once into the network, switches sum the data as it flows up a tree, and the result flows back down. Each GPU then sends about S and receives about S instead of about 2S each way, roughly halving the data each NIC must move and cutting latency. Availability depends on switch generation, firmware and software stack; `sharp-in-network-computing` covers it.

### Algorithm bandwidth vs bus bandwidth

The standard benchmark suite, `nccl-tests`, reports two numbers per message size:

- **algbw** (algorithm bandwidth) = S / time. Easy to understand but not comparable across collectives or rank counts.
- **busbw** (bus bandwidth) = algbw multiplied by a correction factor that reflects how many bytes each rank actually moves on its links. For all-reduce the factor is 2(N-1)/N; for all-gather and reduce-scatter (N-1)/N; for broadcast and reduce 1.

The point of busbw is that, for a well-implemented algorithm, it should approach the **bandwidth of the bottleneck in the algorithm's path**, largely independent of N. Which link is the bottleneck depends on the test shape:

- **One GPU per server** (for example two servers, one rank each): all traffic crosses one NIC, so busbw should approach that NIC's speed, about 50 GB/s for 400 Gb/s minus protocol overhead.
- **All 8 GPUs per server, one NIC per GPU, NVLink inside**: NCCL runs several rings or trees in parallel (channels), each crossing the network on a different NIC while the intra-server hops ride NVLink. The inter-node bottleneck is then the server's *combined* NIC bandwidth, so all-reduce busbw can reach a few hundred GB/s, approaching the order of 8 x 50 GB/s minus overhead.

A number far below the expected bottleneck signals a problem. Interpreting these results precisely, including the effects of NVLink and in-network reduction, is the subject of `nccl-tests-interpretation`.

> [!ANALOGY]
> A ring all-reduce is like a group of accountants in a circle each holding one department's expense sheets. Each passes one page to the right, adds what they receive to their own copy, and passes it on; after one lap everyone owns a fully summed page, and after a second lap everyone has a copy of all summed pages. Nobody ever shouts to the whole room, and every hand-off happens in parallel. The analogy breaks down at scale: with a thousand accountants the "pass a page" delay, not the paper volume, dominates, which is why trees and hierarchies exist.

## In practice

In code, collectives are a single call. PyTorch exposes them in `torch.distributed`, backed by NCCL on NVIDIA GPUs (and RCCL, AMD's NCCL-compatible library, on AMD GPUs):

```python
import torch
import torch.distributed as dist

dist.init_process_group(backend="nccl")        # one process per GPU, launched with torchrun
rank = dist.get_rank()
torch.cuda.set_device(rank % torch.cuda.device_count())

grad = torch.ones(64 * 1024 * 1024, device="cuda") * rank   # 64 Mi floats = 256 MB
dist.all_reduce(grad, op=dist.ReduceOp.SUM)                  # every rank now holds the sum
```

The network engineer's standard tool is `nccl-tests`. A typical run sweeps message sizes from 8 bytes to several GB, doubling each time:

```
$ mpirun -np 16 ... ./build/all_reduce_perf -b 8 -e 8G -f 2 -g 1
#       size         count      type   redop    root     time   algbw   busbw  #wrong
#        (B)    (elements)                                (us)  (GB/s)  (GB/s)
           8             2     float     sum      -1    41.2    0.00    0.00       0
     1048576        262144     float     sum      -1    98.7   10.62   19.92       0
   134217728      33554432     float     sum      -1    838.9  160.00  300.00       0
  8589934592    2147483648     float     sum      -1    44740  192.00  360.00       0
```
*(illustrative output, trimmed and simplified; real output has separate out-of-place and in-place columns and a header describing each rank's device. 16 ranks on 2 nodes of 8 GPUs with 8 x 400 Gb/s NICs each; the large-message busbw is well above one NIC's 50 GB/s because NCCL spreads the inter-node traffic over all eight NICs)*

- `-b 8 -e 8G -f 2`: start at 8 bytes, end at 8 GB, multiply by 2 each step. `-g 1`: one GPU per process.
- Small sizes: time is roughly constant (tens of microseconds): **latency-bound**.
- Large sizes: busbw plateaus: **bandwidth-bound**. The plateau is the number you compare against hardware.
- `#wrong` must be 0; non-zero means data corruption.

Setting the real NCCL environment variable `NCCL_DEBUG=INFO` makes NCCL print which transports, devices and algorithms it selected, invaluable when results are unexpectedly low (`nccl-debugging`).

> [!TIP]
> Always read collective performance as a **curve over message size**, not one number. A fabric problem often shows up only in one region: high latency at small sizes points to per-message overhead or too many hops; a low plateau at large sizes points to bandwidth (slow links, congestion, collisions).

## Common pitfalls

- **Comparing algbw across rank counts.** Symptom: "the all-reduce got slower when we went from 8 to 64 GPUs". Cause: algbw naturally falls as N grows because more data must move per byte of result. Fix: compare busbw, which normalises for N.
- **Comparing busbw with the wrong hardware limit.** Symptom: alarm because a test with one GPU per server shows "only" 47 GB/s on a server with 8 x 400G NICs, or false comfort because an 8-GPU-per-server test shows 300 GB/s while one NIC is actually degraded. Cause: the bottleneck depends on the test shape: one rank per server uses one NIC; eight ranks per server spread over all NICs. Fix: work out the bottleneck link for the exact test shape before judging the number, and test single NICs and rails separately.
- **Judging the fabric with one message size.** Symptom: a quick 1 MB test "proves" the fabric is slow. Cause: 1 MB at scale is latency-bound. Fix: sweep sizes and look at the curve.
- **Forgetting that one slow rank slows all.** Symptom: one test run is 30 % slow but most links look idle. Cause: a ring or tree waits for its slowest member. Fix: test subsets (pairs, single rails) to isolate the straggler (`slow-collectives-stragglers`).
- **Treating all-to-all like all-reduce.** Symptom: all-reduce numbers look great, MoE training is slow. Cause: all-to-all creates simultaneous full-mesh traffic and incast. Fix: benchmark `alltoall_perf` too.

> [!INTERVIEW]
> "Explain ring all-reduce and why each GPU sends about twice the buffer size." A strong answer: split the buffer into N chunks; a reduce-scatter phase of N-1 steps leaves each rank with one fully reduced chunk; an all-gather phase of N-1 steps distributes them; each step sends S/N, so 2(N-1)/N x S in total, approaching 2S. Then add the alpha-beta model: the latency term grows with N, which is why NCCL uses trees and hierarchical algorithms at scale, and mention that in-network reduction (SHARP) can cut per-GPU traffic to about S. Finish with busbw = algbw x 2(N-1)/N as the hardware-comparable metric.

## Key takeaways

- Collectives (broadcast, reduce, all-reduce, reduce-scatter, all-gather, all-to-all, send/recv) are the unit of work an AI network serves.
- All-reduce = reduce-scatter + all-gather; ring all-reduce sends 2(N-1)/N x S per rank, approaching 2S.
- The alpha-beta model: small collectives are latency-bound, large ones bandwidth-bound; flat rings scale badly in latency, so libraries use trees and hierarchies.
- All-to-all creates simultaneous full-mesh traffic, the hardest pattern for a fabric.
- In-network reduction (SHARP) roughly halves the data each GPU must send for all-reduce.
- nccl-tests busbw normalises for the algorithm and should approach the bottleneck link's bandwidth; read it as a curve over message size.
