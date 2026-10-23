---
id: hw-14-mpi-ucx-rdma
title: "MPI over UCX on real RDMA: transports, protocols and MTU without a GPU"
kind: handson
level: 3
estimated_minutes: 90
environment: hardware
tier: 1
fabric: any
requires: [two-rdma-hosts, ssh-mesh, root]
changes_config: false
lessons: [collective-operations, nccl-architecture, verbs-qps-mrs, transport-types-operations, perftest-benchmarking]
files: labs/hw-14-mpi-ucx-rdma
verified: true
summary: "Install Open MPI with UCX and the OSU micro-benchmarks, then measure what a communication library does on your RDMA port: transport selection (RC, UD, DC), eager versus rendezvous, path MTU, and the gap to TCP."
---

> [!NOTE]
> Verified end to end (every task and the check; the optional removal in Restore was not run, the
> packages stay for hw-15) on 2026-10-23 on two ConnectX-5
> hosts cabled back to back (ESXi VMs with PCI passthrough; Ubuntu 26.04.1, kernel 7.0.0-38, NVIDIA
> DOCA-OFED 3.4 with UCX 1.21, Ubuntu's Open MPI 5.0.10, OSU Micro-Benchmarks 7.5.2), on the RoCE port
> and, for the check and Task 8, on the InfiniBand port; see `labs/README.md`. The distribution-only
> stack (Ubuntu's UCX without DOCA) was not tested.

## Goal

NCCL needs NVIDIA GPUs, but most of what it does on the network is not GPU-specific: pick a
transport, open queue pairs, switch protocols by message size, and keep the link full. **UCX** is the
communication framework that Open MPI (and many other HPC libraries) use for exactly that on RDMA
hardware, and it runs on CPUs. In this lab you install Open MPI with UCX on host A (`{{HOST_A}}`) and
host B (`{{HOST_B}}`), build the OSU micro-benchmarks, and measure point-to-point traffic on your
RDMA port `{{A_RDMA_DEV}}` port {{RDMA_PORT}}. [hw-15](#/hw/labs/hw-15-cpu-allreduce-busbw) builds
collectives on top.

By the end you can:

- Check that MPI really uses UCX and RDMA, and which transport UCX picked.
- Measure latency and bandwidth with `ucx_perftest` and the OSU benchmarks, and convert their units.
- Show how RC, UD and DC transports and the path MTU change the numbers.
- Compare RDMA with TCP, and map each of these knobs to its NCCL counterpart.

> [!NOTE]
> Output blocks labelled as a real capture come from the verification run: two ConnectX-5 ports back
> to back (100 Gb/s RoCE on `mlx5_0`, EDR InfiniBand on `mlx5_1` of the same cards), ESXi VMs with
> 110 vCPUs, Ubuntu 26.04, DOCA-OFED 3.4 (UCX 1.21), Ubuntu's Open MPI 5.0.10 and OSU
> Micro-Benchmarks 7.5.2. Tables assembled from several runs are marked as plain text. Numbers are
> illustrative for other hosts.

> [!WARNING]
> Nothing here is NCCL. UCX and NCCL solve similar problems in different code: NCCL has its own
> transports, protocols (LL, LL128, Simple) and tuning, and moves GPU memory. The mapping to NCCL in
> each task is a conceptual one, to explain what NCCL's settings are for.

## Before you start

- **Two RDMA hosts** that pass [hw-02](#/hw/labs/hw-02-roce-first-traffic) (RoCE) or
  [hw-09](#/hw/labs/hw-09-infiniband-bringup) (InfiniBand). The profile's `*_RDMA_DEV`,
  `RDMA_PORT`, `*_NETDEV` and `*_IP` describe the port to test. On InfiniBand, a subnet manager must
  run (hw-09 or hw-10's `lab-sm.sh`), and Task 7 needs IPoIB up ([hw-11](#/hw/labs/hw-11-ipoib)).
- **Same user, same paths:** `mpirun` on host A starts the remote rank over SSH as your user, with the
  same binary path. Key-based SSH from A to B must work for the name `{{HOST_B}}`, and from A to
  itself is not needed. Both hosts need the same packages and the OSU build in the same directory.
- **Packages (installed by Task 1, documented here):**
  - `openmpi-bin` and `libopenmpi-dev` from the distribution (Ubuntu 26.04: Open MPI 5.0.10, built
    with UCX and UCC). With NVIDIA's DOCA-OFED, `apt` satisfies their `libucx0` dependency with
    DOCA's `ucx` package (it declares `Provides: libucx0`), so MPI uses DOCA's UCX.
  - Not DOCA's own `openmpi` package: in DOCA-OFED 3.4 it is built **without** UCX (`ompi_info`
    lists no `pml ucx`), so it can only use TCP between hosts.
  - `libucc-dev`: Ubuntu's `libucc1` ships UCC's plugins only with version suffixes, and UCC finds
    no components without the unversioned names (`UCC ERROR no CL components were found`) that the
    `-dev` package adds. Only hw-15's optional UCC task needs it.
  - `ucx` utilities (`ucx_info`, `ucx_perftest`): part of DOCA-OFED; on a distribution stack they are
    in `ucx-utils`. The distribution-only path (no DOCA) was not tested in this lab's verification.
  - Build tools (`build-essential`), `curl`; the OSU source is downloaded from
    `mvapich.cse.ohio-state.edu` and checked against a pinned SHA-256.
- **CPU count:** hw-15 runs four ranks per host.
- **Changes:** packages and `~/osu`, `~/osu-build` only. No NIC, port or network setting changes
  (`changes_config: false`); the UCX settings in this lab are per-run environment variables.

## Tasks

### Task 1: Install Open MPI with UCX and build the OSU benchmarks

On **both** hosts:

```bash
sudo apt-get install -y --no-install-recommends openmpi-bin libopenmpi-dev libucc-dev build-essential curl
ompi_info | grep -E 'MCA (pml|coll): (ucx|ucc)'
cd {{AINA_DIR}}/labs/hw-14-mpi-ucx-rdma
./build-osu.sh
```

Sample output (host A):

```text real=doca
0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
                MCA coll: ucc (MCA v2.1.0, API v2.4.0, Component v5.0.10)
                 MCA pml: ucx (MCA v2.1.0, API v2.1.0, Component v5.0.10)
+ curl -fsSLO https://mvapich.cse.ohio-state.edu/download/mvapich/osu-micro-benchmarks-7.5.2.tar.gz
osu-micro-benchmarks-7.5.2.tar.gz: OK
+ ./configure CC=mpicc CXX=mpicxx --prefix=/home/aina/osu
+ make -j110 && make install
/home/aina/osu/libexec/osu-micro-benchmarks/mpi/collective/osu_allreduce
/home/aina/osu/libexec/osu-micro-benchmarks/mpi/pt2pt/osu_bw
Installed OSU Micro-Benchmarks 7.5.2 into /home/aina/osu
```

**Read it:** `MCA pml: ucx` is what matters: the PML (point-to-point messaging layer) is the part of
Open MPI that moves messages, and the UCX one hands them to UCX. If that line is missing, MPI falls
back to its TCP and shared-memory transports and every number in this lab measures TCP.
`mpirun --version` prints `Sorry! You were supposed to get help about: version` on this Ubuntu
release (PRRTE's help files are not installed where it looks); use `ompi_info --version` instead.
The same packaging gap turns some `mpirun` error messages into that "Sorry!" text.

> [!VERIFIED]
> **DOCA-OFED 3.4's own `openmpi` package has no UCX PML.** On Ubuntu 26.04 with DOCA-OFED 3.4,
> `ompi_info` of DOCA's `openmpi` (installed under `/usr/mpi/gcc/openmpi-5.0.10rc2...`) listed only
> the `cm`, `monitoring`, `ob1` and `v` PMLs, so it can only use TCP between hosts. Ubuntu's
> `openmpi-bin` 5.0.10 installed next to DOCA without removing anything (DOCA's `ucx` provides
> `libucx0`) and showed `MCA pml: ucx`. Its OSU benchmarks build (7.5.2) aborted on `--help` with
> `*** buffer overflow detected ***`; the benchmarks themselves ran normally.

### Task 2: What UCX sees, and a first multi-host run

```bash
ucx_info -v | head -1
ucx_info -d | grep -E 'Memory domain|Transport|Device' | grep -A12 'Memory domain: {{A_RDMA_DEV}}'
mpirun -np 2 --host {{HOST_A}},{{HOST_B}} hostname
```

Sample output:

```text real=doca
# Library version: 1.21.0
# Memory domain: mlx5_0
#      Transport: rc_verbs
#         Device: mlx5_0:1
#      Transport: ud_verbs
#         Device: mlx5_0:1
#      Transport: dc_mlx5
#         Device: mlx5_0:1
#      Transport: rc_mlx5
#         Device: mlx5_0:1
#      Transport: ud_mlx5
#         Device: mlx5_0:1
# Memory domain: mlx5_1
#      Transport: rc_verbs
ESXI-1-UbuntuServer-1
ESXI-2-UbuntuServer-1
```

**Read it:** UCX lists the transports it can run on the RDMA device: `rc_verbs` and `rc_mlx5`
(Reliable Connected, through generic verbs or mlx5's direct hardware access), `ud_verbs` and
`ud_mlx5` (Unreliable Datagram) and `dc_mlx5` (Dynamically Connected, NVIDIA-specific). The same
HCA would also appear as `tcp` on its netdev. `mpirun` reached host B over SSH and started a rank
there.

### Task 3: UCX on its own: `ucx_perftest`

Server on **host B**, client on **host A** (the handshake uses TCP 18620 over `{{HOST_B}}`):

```bash
UCX_NET_DEVICES={{B_RDMA_DEV}}:{{RDMA_PORT}} ucx_perftest -p 18620                                       # host B
UCX_NET_DEVICES={{A_RDMA_DEV}}:{{RDMA_PORT}} ucx_perftest {{HOST_B}} -p 18620 -t tag_lat -s 8 -n 100000   # host A
```

Then the same with `-t tag_bw -s 1048576 -n 5000` (start the server again first). Sample output
(trimmed, RoCE port; the same test on the InfiniBand port gave 11709.80 MB/s):

```text
[...] UCX  WARN  CPU affinity is not set (bound to 110 cpus). Performance may be impacted.
+--------------+--------------+------------------------------+---------------------+-----------------------+
|              |              |        latency (usec)        |   bandwidth (MB/s)  |  message rate (msg/s) |
+--------------+--------------+----------+---------+---------+----------+----------+-----------+-----------+
|    Stage     | # iterations | 50.0%ile | average | overall |  average |  overall |  average  |  overall  |
+--------------+--------------+----------+---------+---------+----------+----------+-----------+-----------+
Final:                100000      0.956     1.071     1.071        7.13       7.13      934047      934047
...
Final:                  5000      0.273    97.850    97.850    10219.71   10219.71       10220       10220
```

**Read it:** `tag_lat` reports one-way latency (half the round trip), `tag_bw` bandwidth.
**`ucx_perftest`'s MB/s are MiB/s**: its source divides by 1024 x 1024 (and UCX defines
`UCS_MBYTE` as 2^20), so multiply by 8.39 for Gb/s: 10219.71 MB/s is 85.7 Gb/s, 11709.80 MB/s is
98.2 Gb/s. The OSU benchmarks below use 10^6 bytes:
multiply by 0.008. The `CPU affinity is not set` warning is UCX reminding you that an unpinned
process can land far from the NIC (hw-07's NUMA lesson applies to CPU memory too).

### Task 4: MPI latency, bandwidth and protocol switching

Set two shell variables on host A for the rest of the lab:

```bash
OSU=~/osu/libexec/osu-micro-benchmarks/mpi
DEVS={{A_RDMA_DEV}}:{{RDMA_PORT}}
mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ucx -x UCX_NET_DEVICES=$DEVS $OSU/pt2pt/osu_latency -m 1:65536
mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ucx -x UCX_NET_DEVICES=$DEVS $OSU/pt2pt/osu_bw
```

`UCX_NET_DEVICES` restricts UCX to the lab port, `-x` exports it to every rank (if host B's device
has another name, list both: `DEVS={{A_RDMA_DEV}}:{{RDMA_PORT}},{{B_RDMA_DEV}}:{{RDMA_PORT}}`; UCX
uses the one that exists and warns `is specified multiple times` if both are the same), `--mca pml ucx` makes a missing UCX an error instead of a silent TCP fallback.
Now ask UCX which protocol it uses for which message size:

```bash
mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ucx -x UCX_NET_DEVICES=$DEVS -x UCX_PROTO_INFO=y $OSU/pt2pt/osu_bw -m 1048576:1048576 2>&1 | grep -A6 'inter-node cfg' | head -8
```

Sample output (trimmed):

```text
# OSU MPI Latency Test v7.5.2
# Datatype: MPI_CHAR.
# Size       Avg Latency(us)
1                       0.93
...
8                       0.92
...
256                     1.35
1024                    1.59
4096                    3.07
16384                   6.36
65536                  11.00
# OSU MPI Bandwidth Test v7.5.2
# Datatype: MPI_CHAR.
# Size      Bandwidth (MB/s)
1                       3.20
...
1024                 3162.71
2048                 6177.49
4096                 7516.58
8192                 9722.89
16384               10906.59
32768               11605.54
65536               11845.44
131072              11998.48
262144              11201.88
524288              11064.94
1048576             11047.74
2097152             10917.40
4194304             10909.14
[...]   | ucp_context_0 inter-node cfg#1 | tagged message by ucp_tag_send* from host memory             |
[...]   +--------------------------------+-------------------------------------------+------------------+
[...]   |                        0..2038 | eager short                               | rc_mlx5/mlx5_0:1 |
[...]   |                     2039..8246 | eager zero-copy copy-out                  | rc_mlx5/mlx5_0:1 |
[...]   |                    8247..42739 | multi-frag eager zero-copy copy-out       | rc_mlx5/mlx5_0:1 |
[...]   |                     42740..inf | (?) rendezvous zero-copy read from remote | rc_mlx5/mlx5_0:1 |
```

**Read it:**

- Latency is flat at about a microsecond up to a few hundred bytes, then grows with size: the
  transfer time starts to dominate.
- Bandwidth reaches 11-12 GB/s (88-96 Gb/s) from 32 KiB up, close to the line rate.
- The protocol table is the key to the shape of both curves: small messages go **eager short**
  (data inline with the header), medium ones **eager zero-copy** in one or several fragments, and
  large ones **rendezvous**: the sender announces the buffer and the receiver pulls it with an RDMA
  READ (`zero-copy read from remote`) once it has posted the receive. Eager costs a copy but no
  round trip; rendezvous costs a round trip but no copy. The thresholds are chosen per transport
  and device.
- **NCCL mapping:** NCCL also switches protocol by size (LL and LL128 for small and medium
  messages, Simple for large ones), for the same reason: small messages are latency-bound, large
  ones bandwidth-bound. `NCCL_PROTO` restricts the choice, as `UCX_RNDV_THRESH` (the eager-to-rendezvous switch point)
  does here; both are for experiments, not production defaults.

If one run is far below the others, run it again: in the verification run, the very first
`osu_bw` after installing reported about 2.5 GB/s for every large size and every later run 11-12
GB/s. The cause was not found; repeat measurements before you trust one.

### Task 5: RC, UD and DC

Restrict UCX to one transport family at a time (plus `self` for the rank's own messages):

```bash
for t in rc ud dc; do
  echo "== $t"
  mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ucx -x UCX_NET_DEVICES=$DEVS -x UCX_TLS=$t,self $OSU/pt2pt/osu_latency -m 8:8 | tail -1
  mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ucx -x UCX_NET_DEVICES=$DEVS -x UCX_TLS=$t,self $OSU/pt2pt/osu_bw -m 65536:4194304 | tail -7
done
```

Sample output:

```text real=doca
== rc
8                       0.98
65536               11672.01
131072              11940.48
262144              11164.53
524288              11177.49
1048576             11341.29
2097152             11250.42
4194304             11192.95
== ud
8                       1.16
65536                8522.27
131072               8634.94
262144               8816.11
524288               8605.80
1048576              8709.09
2097152              8644.57
4194304              8599.33
== dc
8                       2.79
65536               10183.53
131072              11847.90
262144              11211.72
524288              11189.65
1048576             11198.94
2097152             11147.45
4194304             11110.42
```

**Read it:**

- **RC** (reliable connected) gives the best latency and full bandwidth: one QP per peer, the
  hardware handles reliability and RDMA READ/WRITE.
- **UD** (unreliable datagram) has no RDMA operations and a message size limit of one MTU, so UCX
  fragments large messages and handles reliability in software: bandwidth is lower and less stable.
  Its advantage is scale: one QP talks to every peer.
- **DC** (dynamically connected) combines both: RDMA operations with a small pool of QPs that
  connect on demand, at a latency cost (1.2 us on InfiniBand, 2.8 us on RoCE in this run; the RoCE
  difference was not investigated). It matters at thousands of peers, not two.
- **NCCL mapping:** NCCL's InfiniBand/RoCE transport uses RC queue pairs (its debug output and
  `NCCL_IB_QPS_PER_CONNECTION` refer to them). The UD/DC trade-off is a reminder of why QP count per
  peer matters at scale.

### Task 6: Path MTU

UCX picks the path MTU from the port (4096 bytes on InfiniBand, and on RoCE with a 9000-byte netdev
MTU). Force smaller ones for one run each:

```bash
for m in 1024 2048 4096; do
  echo "== path MTU $m"
  mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ucx -x UCX_NET_DEVICES=$DEVS -x UCX_IB_PATH_MTU=$m $OSU/pt2pt/osu_bw -m 4096:1048576 | tail -9
done
```

Sample output:

```text real=doca
== path MTU 1024
4096                 7463.00
...
65536               10722.56
131072              10799.14
262144              10724.09
524288              10783.50
1048576             10725.30
== path MTU 2048
4096                 6739.18
...
65536               10999.97
131072              11873.44
262144              11408.22
524288              11513.18
1048576             11455.26
== path MTU 4096
4096                 7324.51
...
65536               11878.35
131072              11981.81
262144              11191.74
524288              11039.40
1048576             11107.93
```

**Read it:** with 1024-byte packets, each carries the same headers for a quarter of the payload:
bandwidth at large sizes drops by several percent. Between 2048 and 4096 the difference here is
within run-to-run noise. On RoCE the path MTU can never exceed what the netdev MTU allows (hw-02);
on InfiniBand it is the port's IB MTU, and the subnet manager's path records cap it (hw-13). An
invalid value is rejected (`UCX_IB_PATH_MTU=999` makes the UCX PML fail to create its worker), which
is a quick way to confirm that a UCX variable name is real.

### Task 7: The TCP baseline

Run the same benchmarks over TCP on the data interface `{{A_NETDEV}}` (on InfiniBand this is IPoIB,
hw-11), with Open MPI's own TCP transport:

```bash
mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ob1 --mca btl tcp,self --mca btl_tcp_if_include {{A_NETDEV}} $OSU/pt2pt/osu_latency -m 8:8 | tail -1
mpirun -np 2 --host {{HOST_A}},{{HOST_B}} --mca pml ob1 --mca btl tcp,self --mca btl_tcp_if_include {{A_NETDEV}} $OSU/pt2pt/osu_bw -m 65536:4194304 | tail -7
```

(`btl_tcp_if_include` takes interface names; if host B's data interface has a different name, give
the subnet instead, for example `{{A_IP}}/{{PREFIX_LEN}}` written as a network address.)

Sample output (`{{A_NETDEV}}` = the RoCE netdev `ens64f0np0`; over IPoIB the same test gave about
15 us and 5.7 GB/s):

```text real=doca
8                      14.40
65536                3319.32
131072               3987.22
262144               4632.21
524288               5307.94
1048576              5767.29
2097152              5997.17
4194304              6010.01
```

**Read it:** TCP costs an order of magnitude in latency and about half the bandwidth for one
connection, and burns CPU on both hosts for every byte. You cannot get this result with
`--mca pml ucx -x UCX_TLS=tcp`: Open MPI's UCX PML only enables itself when UCX offers an RDMA
transport (`pml_ucx_tls`), and otherwise fails with `No components were able to be opened in the
pml framework`.

**NCCL mapping:** this is what an NCCL job gets when it falls back to its socket transport, either
deliberately (`NCCL_IB_DISABLE=1`) or because it found no usable RDMA device (wrong `NCCL_IB_HCA`,
missing GID, port down). `NCCL_DEBUG=INFO` says which one it uses (`NET/IB` or `NET/Socket`):
checking that line is the first step of every slow-NCCL ticket.

### Task 8 (optional): The other fabric

If your hosts have both a RoCE and an InfiniBand port (a dual-port VPI card, as in the verification
run), repeat Tasks 4 and 5 with `DEVS` set to the other device, for example
`DEVS=mlx5_1:1`. Sample comparison (8-byte latency and 1 MiB bandwidth, RC):

```text
mlx5_0:1 rc: 8 B 0.98 us, 1 MiB 11145.08 MB/s      (RoCE)
mlx5_0:1 ud: 8 B 1.18 us, 1 MiB 8445.75 MB/s
mlx5_0:1 dc: 8 B 2.83 us, 1 MiB 10692.28 MB/s
mlx5_1:1 rc: 8 B 0.86 us, 1 MiB 11129.28 MB/s      (InfiniBand)
mlx5_1:1 ud: 8 B 1.04 us, 1 MiB 8546.98 MB/s
mlx5_1:1 dc: 8 B 1.24 us, 1 MiB 11415.94 MB/s
```

At this scale the two fabrics move data at the same rate; InfiniBand's latency is slightly lower
(no Ethernet/IP/UDP headers, no RoCE GID resolution). The differences that matter in large clusters
(congestion control, lossless operation, adaptive routing, SM-managed paths) do not show up between
two hosts.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-14-mpi-ucx-rdma
```

The check confirms that Open MPI has the UCX PML, that the OSU benchmarks are built on both hosts and
UCX sees the lab device on each, then runs `osu_latency` with `UCX_PROTO_INFO=y` (the inter-node
transport must be an RDMA one; latency under 5 us passes) and `osu_bw` at 1-4 MiB (at least 60% of
the port rate passes, less warns).

## Restore

Nothing on the NIC or network was changed. The packages and the OSU build stay for hw-15. To remove
them later, on both hosts:

```bash
rm -rf ~/osu ~/osu-build
sudo apt-get remove openmpi-bin libopenmpi-dev libucc-dev
```

## What you learned

- Open MPI uses RDMA through its UCX PML; `ompi_info` shows whether it is there, `UCX_PROTO_INFO=y`
  shows which transport and protocol UCX chose for each message size.
- `ucx_perftest` reports MiB/s, OSU MB/s (10^6): convert before comparing with Gb/s link rates.
- RC gives the best latency and bandwidth per peer, UD and DC trade some of it for fewer QPs at
  scale; a smaller path MTU costs bandwidth through header overhead.
- TCP over the same port is an order of magnitude slower in latency and needs far more CPU: the
  difference NCCL's `NET/IB` and `NET/Socket` lines in its debug output reveal.

## Going further

- Pin ranks next to the NIC (`--bind-to core --map-by ...`, `numactl`) and compare with unpinned runs.
- Run `osu_bibw` (bidirectional) and `osu_mbw_mr` (several pairs) to see when one port is full.
- Read the [NCCL architecture lesson](#/lesson/nccl-architecture) with this lab's protocol table in
  mind, and [hw-15](#/hw/labs/hw-15-cpu-allreduce-busbw) for collectives.
