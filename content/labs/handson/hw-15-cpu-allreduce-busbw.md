---
id: hw-15-cpu-allreduce-busbw
title: "Allreduce on CPUs over RDMA: algbw, busbw, ring versus recursive doubling, and where the limit really is"
kind: handson
level: 3
estimated_minutes: 90
environment: hardware
tier: 1
fabric: any
requires: [two-rdma-hosts, ssh-mesh]
changes_config: false
lessons: [collective-operations, collective-algorithms, nccl-tests-interpretation, nccl-configuration]
files: labs/hw-15-cpu-allreduce-busbw
verified: true
summary: "Run MPI allreduce across two RDMA hosts, compute nccl-tests style algbw and busbw, compare ring, recursive doubling, hierarchical and UCC algorithms and rank placements, and prove whether the network or the CPU sets the ceiling."
---

> [!NOTE]
> Verified end to end (every task and the check) on 2026-10-23 on two ConnectX-5 hosts cabled back to
> back (ESXi VMs with PCI passthrough, 110 vCPUs each; Ubuntu 26.04.1, NVIDIA DOCA-OFED 3.4 with UCX
> 1.21, Ubuntu's Open MPI 5.0.10 and UCC 1.7, OSU Micro-Benchmarks 7.5.2) on the RoCE port; the check
> also passed on the InfiniBand port. See `labs/README.md`.

## Goal

All-reduce is the collective that dominates data-parallel training, and **busbw** is the number
everyone quotes for it. In this lab you measure all-reduce yourself, over the RDMA port
`{{A_RDMA_DEV}}` between host A (`{{HOST_A}}`) and host B (`{{HOST_B}}`), with Open MPI over UCX on
CPUs, and learn to read the results the way you would read `nccl-tests`.

By the end you can:

- Compute algbw and busbw from a measured time and explain the 2(n-1)/n factor.
- Show where ring beats recursive doubling and where it loses, and why.
- See how rank placement changes how often a ring crosses the network.
- Prove from measurements whether the network or the endpoints limit a collective.

> [!NOTE]
> Output comes from the verification run: two ESXi VMs (110 vCPUs each) with ConnectX-5 ports back
> to back, 100 Gb/s RoCE (the InfiniBand port of the same cards gave the same picture), Open MPI
> 5.0.10 with UCX 1.21 and UCC 1.7, OSU Micro-Benchmarks 7.5.2. Comparison tables are assembled
> from those runs (plain text); the raw `osu-busbw.sh` output is labelled as a real capture. Numbers
> are illustrative for other hosts.

> [!WARNING]
> **This is not NCCL, and CPU numbers do not predict GPU numbers.** Here the CPU adds the vectors,
> from host memory, with MPI's algorithms. NCCL reduces on the GPU at HBM speed, runs several
> channels in parallel, uses NVLink inside a node and its own ring/tree (and NVLS/CollNet) algorithms
> across nodes. What carries over is the method: algbw versus busbw, algorithm crossover, placement,
> and finding the bottleneck before blaming the network.

## Before you start

- **[hw-14](#/hw/labs/hw-14-mpi-ucx-rdma) done:** Open MPI with UCX, the OSU benchmarks in `~/osu`
  on both hosts, and its check passing on this port. Task 5 needs `libucc-dev` from hw-14's Task 1.
- **CPUs:** the 8-rank runs place four ranks on each host; hosts with fewer than four cores
  oversubscribe and measure the scheduler instead.
- **Changes:** none. Algorithms and placement are per-run `mpirun` options.

Set up the shell on host A for all tasks:

```bash
cd {{AINA_DIR}}/labs/hw-15-cpu-allreduce-busbw
OSU=~/osu/libexec/osu-micro-benchmarks/mpi
DEVS={{A_RDMA_DEV}}:{{RDMA_PORT}}
MPI="mpirun --mca pml ucx -x UCX_NET_DEVICES=$DEVS"
RING="--mca coll ^han --mca coll_tuned_use_dynamic_rules 1 --mca coll_tuned_allreduce_algorithm ring"
```

(If host B's device has another name, use `DEVS={{A_RDMA_DEV}}:{{RDMA_PORT}},{{B_RDMA_DEV}}:{{RDMA_PORT}}`.)

## Tasks

### Task 1: Two ranks, and what busbw means

One rank per host, sizes from 8 bytes to 64 MiB, piped through the lab's `osu-busbw.sh`, which adds
nccl-tests style columns:

```bash
$MPI -np 2 --host {{HOST_A}},{{HOST_B}} $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 2
```

Sample output (trimmed):

```text real=doca
# OSU MPI Allreduce Latency Test v7.5.2
# Datatype: MPI_INT.
# allreduce, 2 ranks, busbw = algbw x 1.000
     size(B)       time(us)  algbw(GB/s)  busbw(GB/s)
           8           1.06        0.008        0.008
...
        1024           2.02        0.507        0.507
        4096           5.14        0.797        0.797
       16384          10.16        1.613        1.613
       65536          22.05        2.972        2.972
      262144          65.68        3.991        3.991
      524288         111.75        4.692        4.692
     1048576         236.37        4.436        4.436
     4194304         941.14        4.457        4.457
     8388608        1866.68        4.494        4.494
    16777216        4285.40        3.915        3.915
    33554432       17390.64        1.929        1.929
    67108864       36532.93        1.837        1.837
```

**Read it:**

- `osu_allreduce` reports the average time per call; `osu-busbw.sh` divides the message size by it:
  **algbw** = bytes / time, the rate at which the *application's* data gets all-reduced (GB/s =
  10^9 bytes, as in nccl-tests).
- **busbw** = algbw x 2(n-1)/n. A bandwidth-optimal all-reduce (reduce-scatter, then all-gather)
  makes every rank send and receive 2(n-1)/n of the data, so busbw is the rate each rank's link
  actually carries, comparable with the link rate whatever n is. With n = 2 the factor is 1.
- busbw tops out at about 4.5 GB/s here, **far below** the 11-12 GB/s that `osu_bw` reached on the
  same port in hw-14, and drops further at 32 MiB and up. Something other than the link sets the
  limit: Task 4 finds out what.
- In the latency region (up to a few KiB) time is a few microseconds and busbw is meaningless: read
  latency there, bandwidth only where the curve has flattened (the
  [nccl-tests lesson](#/lesson/nccl-tests-interpretation) makes the same point for GPUs).

### Task 2: Eight ranks: algorithms and their crossover

Four ranks per host, `--map-by node` (ranks alternate between hosts: 0 on A, 1 on B, 2 on A, ...).
First Open MPI's default, then a forced ring, then recursive doubling:

```bash
H8={{HOST_A}}:4,{{HOST_B}}:4
$MPI -np 8 --host $H8 --map-by node $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 8
$MPI -np 8 --host $H8 --map-by node $RING $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 8
$MPI -np 8 --host $H8 --map-by node --mca coll ^han --mca coll_tuned_use_dynamic_rules 1 --mca coll_tuned_allreduce_algorithm recursive_doubling $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 8
```

`coll_tuned_allreduce_algorithm` only takes effect with `coll_tuned_use_dynamic_rules 1`, and
`--mca coll ^han` disables Open MPI's hierarchical component, which would otherwise take over
multi-host collectives (it has a higher priority than `tuned`). `ompi_info --param coll tuned
--level 9` lists the algorithms: ignore, basic_linear, nonoverlapping, recursive_doubling, ring,
segmented_ring, rabenseifner.

Sample results (time in us, selected sizes; busbw in GB/s at 1 and 16 MiB):

```text
      size      default         ring    rec_doubl     (time per call, us)
         8         3.16         2.43         2.40
      1024         6.24        17.45         4.57
     65536       100.01        76.16        59.75
    262144       318.57       180.49       233.16
   1048576      1228.69       747.84       931.65
  16777216     20037.76     18466.76     29597.01
  67108864     81910.23     81567.07    183931.94
busbw (GB/s) at 1 MiB: default 1.493, ring 2.454, recursive doubling 1.970
busbw (GB/s) at 16 MiB: default 1.465, ring 1.590, recursive doubling 0.992
```

**Read it:**

- **Small messages: recursive doubling wins.** It needs log2(8) = 3 steps, each exchanging the
  whole (small) vector; a ring needs 2(n-1) = 14 steps. With latency-bound messages, step count is
  everything: at 1 KiB the ring takes almost 4x as long. (At 8 bytes the forced ring is as fast as
  recursive doubling because it *is* recursive doubling: with fewer elements than ranks, Open MPI's
  ring implementation switches to it, as its source in `coll_base_allreduce.c` says.)
- **Large messages: ring wins.** Recursive doubling sends the whole vector in each of its steps;
  the ring sends 1/n of it per step, which is what makes it bandwidth-optimal. The crossover was
  between 64 KiB and 256 KiB here, and at 64 MiB the gap is more than 2x.
- Open MPI's default (`han`, hierarchical: reduce inside each host first, then across hosts) is in
  between and follows its own size thresholds.
- **NCCL mapping:** NCCL makes the same trade-off between **ring** (bandwidth-optimal, latency grows
  with n) and **tree** (log-depth, better at small sizes and large scale), and picks per size from
  its tuning model; `NCCL_ALGO` forces one, for experiments. The crossover you just measured is the
  reason both exist.

### Task 3: Placement: how often does the ring cross the network?

Same forced ring, but with `--map-by slot`: ranks 0-3 on host A, 4-7 on host B:

```bash
$MPI -np 8 --host $H8 --map-by slot $RING $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 8
```

Sample results next to Task 2's ring:

```text
      size   ring_by_node   ring_by_slot     (time in us, busbw in GB/s in brackets)
      1024    17.45 (0.103)     8.98 (0.200)
     65536    76.16 (1.506)    48.62 (2.359)
   1048576   747.84 (2.454)   528.02 (3.475)
  16777216 18466.76 (1.590) 15458.69 (1.899)
  67108864 81567.07 (1.440) 75969.09 (1.546)
```

**Read it:** with `--map-by node`, every one of the 8 ring hops crosses the network (A-B-A-B...);
with `--map-by slot`, only 2 do (3 to 4 and 7 to 0) and the other 6 are shared-memory copies inside
a host (`mpirun ... --map-by slot sh -c 'echo $OMPI_COMM_WORLD_RANK $(hostname)'` shows the
placement). In the middle sizes that cuts the time by about a third. **NCCL mapping:** NCCL orders its
rings by topology for exactly this reason: inside a node the ring follows NVLink, and it leaves the
node through a NIC (one per rail in a rail-optimized fabric) as few times as possible. A job whose
ranks are numbered without regard to topology pays for it on every collective.

### Task 4: Who sets the ceiling, the network or the CPU?

Run the same 8-rank ring with **all eight ranks on host A**, no network at all, and an all-gather
(which moves data but computes nothing) over the network:

```bash
$MPI -np 8 --host {{HOST_A}}:8 $RING $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 8
$MPI -np 2 --host {{HOST_A}},{{HOST_B}} $OSU/collective/osu_allgather -m 8:16777216 | ./osu-busbw.sh allgather 2
```

Sample results next to the earlier runs:

```text
allreduce, 8 ranks, ring    (time in us, busbw in GB/s in brackets)
      size       ring_2_hosts        ring_1_host
     65536      76.16 (1.506)      42.46 (2.701)
   1048576     747.84 (2.454)     570.36 (3.217)
  16777216   18466.76 (1.590)   18998.85 (1.545)
  67108864   81567.07 (1.440)   83402.05 (1.408)
allgather, 2 ranks over the network: size(B) time(us) algbw busbw
     1048576         199.12       10.532        5.266
     4194304         830.45       10.101        5.051
    16777216        3492.89        9.606        4.803
```

**Read it:**

- At 16 and 64 MiB the 8-rank all-reduce takes about as long **on one host, without the network**,
  as across two hosts over RDMA. The network is not the bottleneck at these sizes: the CPU summing
  the vectors and the memory traffic of copying them are. The jump at 32 MiB and up in Task 1 fits
  the same picture: the buffers no longer fit in the CPU caches.
- The 2-rank all-gather over the network (no arithmetic at all) reaches about 5 GB/s per
  direction, only a little more than the 2-rank all-reduce and far below `osu_bw`'s 11 GB/s. So it
  is not just the summing: per-call endpoint work (copies, protocol handshakes, memory bandwidth)
  limits these collectives on these hosts. Finding out exactly which part is a profiling job
  (`perf`, UCX statistics) beyond this lab.
- This is the most important habit this lab can teach: **before blaming the fabric for a slow
  collective, measure the same collective without it** (or with point-to-point tests, hw-14). On GPU
  clusters the equivalent is comparing nccl-tests inside one node (NVLink only) with the same test
  across nodes, and the per-NIC `ib_write_bw` result with the busbw ceiling the
  [nccl-tests lesson](#/lesson/nccl-tests-interpretation) derives.
- On GPUs the balance is different: reduction runs at HBM bandwidth, so the network is much more
  often the real ceiling. Do not carry the CPU numbers over.

> [!VERIFIED]
> **On these CPU hosts, eight ranks on one host were as slow as eight ranks across the RDMA link.**
> With Open MPI 5.0.10 over UCX on two 110-vCPU ESXi VMs (ConnectX-5, 100 Gb/s RoCE), a forced-ring
> `osu_allreduce` with 4 ranks per host took 18.5 ms at 16 MiB and 81.6 ms at 64 MiB; the same 8
> ranks on one host, with no network, took 19.0 and 83.4 ms. The 2-rank busbw peaked at about
> 4.7 GB/s while `osu_bw` reached 11-12 GB/s on the same port.

### Task 5 (optional): UCC, a collectives library

UCC (Unified Collective Communication) is a collectives library from the same community as UCX,
with its own algorithms; Open MPI can hand collectives to it. Give its component a priority above
`han` and `tuned`:

```bash
$MPI -np 8 --host $H8 --map-by node --mca coll_ucc_enable 1 --mca coll_ucc_priority 100 $OSU/collective/osu_allreduce -m 8:67108864 | ./osu-busbw.sh allreduce 8
```

To confirm UCC really ran, add `--mca coll_ucc_verbose 3` to one run: every rank then logs
`mca_coll_ucc_allreduce() running ucc allreduce`. Sample results:

```text
      size  han_default          ucc     (time in us, busbw in GB/s in brackets)
         8     3.16 (0.004)     2.58 (0.005)
      1024     6.24 (0.287)     4.76 (0.376)
     65536   100.01 (1.147)    56.54 (2.028)
   1048576  1228.69 (1.493)   317.13 (5.786)
  16777216 20037.76 (1.465)  8314.17 (3.531)
  67108864 81910.23 (1.434) 43517.99 (2.699)
```

**Read it:** with the same ranks and placement, UCC's algorithms were faster than Open MPI's own in
the middle and large sizes here: about 4x at 1 MiB and 2x at 16 and 64 MiB, reaching a busbw of
5.8 GB/s. `--mca coll_ucc_enable 1` alone was **not** enough in the
verification run: `han` kept the collectives (identical times to the default). UCC also fails at
startup with `no CL components were found` if its plugins are not installed (hw-14's note on
`libucc-dev`). **NCCL mapping:** UCC plays the role for CPU and mixed jobs that NCCL plays for
NVIDIA GPUs: a collectives library under the framework, with its own algorithm selection.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-15-cpu-allreduce-busbw
```

The check runs `osu_allreduce` with result validation (`-c`) for 2 ranks (one per host) and for
8 ranks (four per host, forced ring), requires every message size to pass validation, and reports
algbw and busbw at 1 and 16 MiB.

## Restore

Nothing was changed. The packages and the OSU build are documented, and removed, in hw-14's
Restore section.

## What you learned

- algbw = bytes / time; busbw = algbw x 2(n-1)/n for all-reduce, the per-rank link load, comparable
  with the link rate.
- Recursive doubling wins on small messages (fewer steps), ring on large ones (each step moves only
  1/n of the data): the same reason NCCL has both ring and tree.
- Placement decides how many ring hops cross the network; topology-aware ordering is half of NCCL's
  ring construction.
- On these hosts the endpoints (CPU and memory), not the 100 Gb/s link, limited large all-reduces:
  the same collective on one host proved it. Measure without the network before blaming it.

## Going further

- Try `--mca coll_tuned_allreduce_algorithm rabenseifner` and `segmented_ring` (with
  `coll_tuned_allreduce_algorithm_segmentsize`) and place them on the crossover plot.
- Pin ranks (`--bind-to core --map-by ppr:4:numa` launched four ranks per host here; check the
  mapping options of your Open MPI version) and see whether the endpoint-bound region moves.
- Run `osu_reduce_scatter` and `osu_allgather` at 8 ranks: the two halves of a ring all-reduce.
- On GPU nodes, continue with [hw-08](#/hw/labs/hw-08-nccl-two-nodes) and compare the shape of the
  curves.
