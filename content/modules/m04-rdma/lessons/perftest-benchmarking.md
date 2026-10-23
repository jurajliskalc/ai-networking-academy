---
id: perftest-benchmarking
title: "Benchmarking RDMA with perftest"
module: m04-rdma
level: 2
estimated_minutes: 45
objectives:
  - Run ib_write_bw, ib_read_bw, ib_send_bw and the matching latency tests between two hosts on InfiniBand and RoCE.
  - Choose the right flags (-d, -x, -q, -s, -a, -D, -b, --report_gbits, -F, -R) for a given question.
  - Read perftest output, including bandwidth, message rate and latency percentiles, and compare it with the theoretical limit.
  - Design a repeatable test plan that isolates host problems (NUMA, PCIe, GID) from fabric problems.
prerequisites: [rdma-on-linux, transport-types-operations]
quiz: quiz-perftest-benchmarking
widgets: [perftest-explorer]
labs: []
tags: [rdma, perftest, ib_write_bw, ib_read_lat, benchmarking, validation]
further_reading:
  - title: "perftest: RDMA benchmark suite (GitHub, README lists all options)"
    url: https://github.com/linux-rdma/perftest
  - title: NVIDIA RDMA Aware Networks Programming User Manual
    url: https://docs.nvidia.com/networking/display/rdmaawareprogrammingv17
  - title: "rdma-core: libraries and examples (GitHub)"
    url: https://github.com/linux-rdma/rdma-core
---

## Why this matters

Before an AI cluster is handed to users, every NIC, cable and switch port must be proven to deliver close to line rate. When a training job later runs slowly, the first question is "is the network itself healthy between these hosts?" perftest is the standard answer to both: a suite of small, focused RDMA benchmarks that measure raw verbs performance without NCCL, GPUs or frameworks in the way.

A perftest number is only useful if you know what it should be and which variable you changed. An engineer who runs `ib_write_bw` with defaults, sees "MB/sec" and a number below line rate, and declares the fabric broken — when actually the test used the wrong GID, the wrong NUMA node or a tiny message size — wastes days. This lesson teaches you to run perftest deliberately and read it critically.

## Concepts

### The tools

perftest is distributed separately from rdma-core (package usually named `perftest`). Each tool tests one operation, in bandwidth or latency mode:

| Tool | Measures | Notes |
|---|---|---|
| `ib_write_bw` / `ib_write_lat` | RDMA Write | The closest match to how NCCL moves bulk data |
| `ib_read_bw` / `ib_read_lat` | RDMA Read | Sensitive to outstanding-read limits and round-trip time |
| `ib_send_bw` / `ib_send_lat` | Send/Receive | Exercises receive posting; supports UD |
| `ib_atomic_bw` / `ib_atomic_lat` | Atomics | Message rate of 8-byte atomics |
| `raw_ethernet_bw` and friends | Raw Ethernet packets via verbs | Ethernet-only, for packet-rate tests |

Despite the `ib_` prefix, all of them work over RoCE as well as InfiniBand.

### Client/server model

Every test has a **server** (started without a peer address) and a **client** (given the server's host name or IP). Before RDMA starts, the two exchange QP numbers, PSNs, addresses and rkeys over a TCP socket (default TCP port 18515, changeable with `-p`). With `-R` they use the RDMA connection manager instead, which also resolves the GID from the IP address. Both sides must use compatible options (same test, same size, same number of QPs).

### The flags you will use most

| Flag | Meaning |
|---|---|
| `-d <dev>` | RDMA device, for example `mlx5_0` (NVIDIA stack) or `rocep3s0f0` (distro rdma-core); take the name from `ibv_devices` or `rdma link` |
| `-i <port>` | Port number on the device (default 1) |
| `-x <index>` | GID index (needed on RoCE unless `-R` is used; picks RoCE version, IP and VLAN) |
| `-s <bytes>` | Message size |
| `-a` | Sweep all message sizes from 2 bytes to 8 MiB (powers of two) |
| `-n <iters>` | Number of iterations per size |
| `-D <seconds>` | Run for a duration instead of an iteration count (the default is 5000 iterations); BW peak is then not measured and prints `0.00` |
| `-q <num>` | Number of QPs (spreads traffic over more connections, and on RoCE over more ECMP hashes) |
| `-b` | Bidirectional bandwidth test |
| `-c <type>` | Connection (transport) type such as `RC`, `UC`, `UD`, where the operation supports it |
| `-m <mtu>` | Path MTU to use (256-4096) |
| `--report_gbits` | Report bandwidth in Gb/s instead of the default MiB/s (labelled `MB/sec` in older releases) |
| `-F` | Suppress the CPU-frequency-scaling check (current perftest only prints a "Conflicting CPU frequency values" warning without it; some older releases refused to produce a report) |
| `-R` | Connect using rdma_cm |
| `-p <port>` | TCP port for the out-of-band exchange (run several tests in parallel) |
| `--use_cuda=<gpu>` | Use GPU memory for buffers, in builds compiled with CUDA support (check `ib_write_bw --help \| grep -i cuda` on your build: distribution packages often have none; NVIDIA's DOCA build adds options such as `--cuda_mem_type`, `--use_cuda_bus_id` and `--use_cuda_dmabuf`) |

Always check `ib_write_bw --help` on your installed version: options evolve between perftest releases.

> [!ANALOGY]
> perftest is to an RDMA fabric what `iperf3` and an RFC 2544 tester are to an IP network: a synthetic, controlled load that tells you what the plumbing can do. Like RFC 2544, it says nothing about the application's real traffic pattern — a fabric that passes perftest pair by pair can still struggle under an all-to-all collective with incast. Use NCCL tests (`nccl-tests-interpretation`) for that.

## How it works

### What a bandwidth test does

In `ib_write_bw` the client keeps up to `-t` (TX depth, default on the order of 128) RDMA Writes in flight on each QP, refilling the send queue as completions arrive, and the server simply waits. Bandwidth is the bytes moved divided by time measured with the CPU cycle counter. A latency test (`ib_write_lat`) instead does a ping-pong: one message in flight, each side waits for the other's write to land before replying.

### Reading bandwidth output

```text
$ ib_write_bw -d mlx5_0 -x 3 -s 65536 -F --report_gbits 10.0.0.12
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : mlx5_0
 Number of qps   : 1		Transport type : IB
 Connection type : RC		Using SRQ      : OFF
 PCIe relax order: ON		Lock-free      : OFF
 ibv_wr* API     : ON		Using DDP      : OFF
 TX depth        : 128
 CQ Moderation   : 1
 Mtu             : 4096[B]
 Link type       : Ethernet
 GID index       : 3
 Max inline data : 0[B]
 rdma_cm QPs	 : OFF
 Data ex. method : Ethernet
---------------------------------------------------------------------------------------
 local address: LID 0000 QPN 0x0123 PSN 0x4a5b6c RKey 0x1fff00 VAddr 0x007f5a2c000000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:00:00:11
 remote address: LID 0000 QPN 0x0456 PSN 0x1c2d3e RKey 0x2fff00 VAddr 0x007f9b10000000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:00:00:12
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             392.10             391.85  		     0.747395
---------------------------------------------------------------------------------------
```

*(Illustrative output for a 400 Gb/s RoCE link, client side; the header lines differ a little between perftest versions. NVIDIA's DOCA build, for example, prints `Using Enhanced Reorder` instead of `Using DDP` and adds `CQE Poll Batch` and `NUMA node` lines. The server prints a `Waiting for client to connect` banner first and has no `TX depth` line.)*

- **Header block**: verify device, transport, connection type, MTU, link type and GID index match what you intended. `Transport type : IB` is normal on RoCE too (the verbs transport). `Data ex. method : Ethernet` means the out-of-band exchange used TCP; with `-R` it says rdma_cm.
- **Address lines**: on RoCE each address line is followed by the GID being used, printed as 16 decimal bytes (`...:255:255:10:00:00:11` is `::ffff:10.0.0.11`) — the fastest way to confirm you picked the right GID index. LIDs are 0 on RoCE; on InfiniBand the address lines carry the ports' LIDs. With `-q N` there is one local/remote pair per QP.
- **BW average** is the number to report. **BW peak** is the best interval and is less meaningful; with `-D` perftest prints ` WARNING: BW peak won't be measured in this run.` and BW peak reads `0.00`.
- **MsgRate** is messages per second in millions: here 391.85 Gb/s ÷ (65,536 B × 8) ≈ 0.75 million messages per second. At small message sizes the message rate, not the bandwidth, is the limit.

On real hardware (two 100G ConnectX-5 hosts cabled back to back, RoCE) the same test prints the following on the client; switch the stack to compare the distribution's perftest 25.01 with NVIDIA's DOCA build (6.29):

```text stack=inbox real
$ ib_write_bw -d rocep3s0f0 -x 3 -F --report_gbits 10.10.10.2
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : rocep3s0f0
 Number of qps   : 1		Transport type : IB
 Connection type : RC		Using SRQ      : OFF
 PCIe relax order: ON		Lock-free      : OFF
 ibv_wr* API     : ON		Using DDP      : OFF
 TX depth        : 128
 CQ Moderation   : 1
 Mtu             : 4096[B]
 Link type       : Ethernet
 GID index       : 3
 Max inline data : 0[B]
 rdma_cm QPs	 : OFF
 Data ex. method : Ethernet
---------------------------------------------------------------------------------------
 local address: LID 0000 QPN 0x004b PSN 0xd59040 RKey 0x184d00 VAddr 0x0071e7d1051000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:01
 remote address: LID 0000 QPN 0x0186 PSN 0xb9398 RKey 0x004300 VAddr 0x00784a42c47000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:02
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             94.73              94.72  		     0.180663
---------------------------------------------------------------------------------------
```

```text stack=doca real
$ ib_write_bw -d mlx5_0 -x 3 -F --report_gbits 10.10.10.2
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
 Dual-port       : OFF		Device         : mlx5_0
 Number of qps   : 1		Transport type : IB
 Connection type : RC		Using SRQ      : OFF
 PCIe relax order: ON		Lock-free      : OFF
 ibv_wr* API     : ON		Using Enhanced Reorder      : OFF
 TX depth        : 128
 CQ Moderation   : 1
 CQE Poll Batch  : Dynamic
 Mtu             : 4096[B]
 Link type       : Ethernet
 GID index       : 3
 Max inline data : 0[B]
 rdma_cm QPs	 : OFF
 Data ex. method : Ethernet
 NUMA node       : 0
---------------------------------------------------------------------------------------
 local address: LID 0000 QPN 0x004b PSN 0x47e235 RKey 0x201dbc VAddr 0x00792fd34ab000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:01
 remote address: LID 0000 QPN 0x008a PSN 0xcaa37b RKey 0x0353bc VAddr 0x00790ff303a000
 GID: 00:00:00:00:00:00:00:00:00:00:255:255:10:10:10:02
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             95.73              95.73  		     0.182590
---------------------------------------------------------------------------------------
```

95-96 Gb/s on a 100 Gb/s link is the "mid-90s of percent" you should expect (see below). The GID lines end in `10:10:10:01` and `10:10:10:02`: the IPv4-mapped RoCEv2 addresses 10.10.10.1 and 10.10.10.2, so GID index 3 was the right choice on these hosts.

> [!VERIFIED]
> **With `-D` perftest prints a warning first and reports BW peak as `0.00`.** On both stacks (ConnectX-5, perftest 25.01 and DOCA's 6.29) `ib_write_bw -D 5` started with ` WARNING: BW peak won't be measured in this run.` and ended with a result line such as `65536      554823           0.00               96.97 ...`: no peak, an iteration count that reflects the duration (about 555,000 messages in 5 s) and a BW average of 96.97 Gb/s (97.23 with DOCA). That is expected, not a failure: in duration mode read `BW average`.

### What "line rate" really is

You will never see the nominal link rate as `BW average`, because headers and link-level overheads consume part of it:

- **Encoding and FEC** are already excluded from the nominal data rate of modern links (for example NDR 4x is 400 Gb/s of data), but per-packet headers are not.
- **Per-packet headers** on InfiniBand are LRH (8) + BTH (12) + ICRC (4) + VCRC (2), plus RETH on first packets, so a 4,096-byte payload carries well under 1 % header overhead (link-level framing and flow-control packets add a little more). On RoCEv2 each packet carries Ethernet, IP, UDP and BTH headers, the FCS, and the Ethernet preamble and inter-frame gap, so overhead is a few percent at a 4,096-byte RDMA MTU. The `rocev2-packet` widget in `rocev2-encapsulation` lets you compute it.
- **Flow-control and management traffic** take a small share.

So for large messages, results in the mid-90s of percent of the nominal rate are typical on a healthy link; treat any specific percentage as adapter- and firmware-dependent. Well below that — say 50 % or 75 % — means something is wrong.

### The bandwidth curve

Running with `-a` produces bandwidth for every message size. A healthy curve rises steeply and then flattens:

| Message size | Typical behaviour |
|---|---|
| Tens of bytes to a few KiB | Limited by message rate (millions of messages/s); bandwidth far below line rate |
| Tens of KiB | Approaches line rate |
| 64 KiB and above | Flat at near line rate |

If the curve never flattens, or flattens well below line rate, suspect the host (PCIe, NUMA, power-saving states) or the path (lower negotiated link speed, errors, congestion).

A real sweep on the 100G ConnectX-5 pair (inbox stack; header block trimmed) shows the shape:

```text real=inbox
$ ib_write_bw -d rocep3s0f0 -x 3 -a -F --report_gbits 10.10.10.2
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
...
 CQ Moderation   : 100
...
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 2          5000           0.077181            0.067564            4.222733
 4          5000             0.15               0.15   		     4.814764
 8          5000             0.31               0.31   		     4.814219
 16         5000             0.65               0.64   		     5.037279
...
 256        5000             10.36              10.01  		     4.885645
 512        5000             20.62              20.53  		     5.012389
 1024       5000             40.86              40.58  		     4.953721
 2048       5000             73.24              72.83  		     4.445205
 4096       5000             94.88              94.81  		     2.893450
 8192       5000             96.15              94.06  		     1.435192
 16384      5000             96.73              96.71  		     0.737872
 32768      5000             96.91              96.91  		     0.369676
 65536      5000             96.94              96.93  		     0.184877
 131072     5000             96.78              96.74  		     0.092257
 262144     5000             92.22              92.14  		     0.043934
 524288     5000             91.53              91.53  		     0.021821
...
 8388608    5000             91.96              91.96  		     0.001370
---------------------------------------------------------------------------------------
```

Up to about 1 KiB the message rate is flat at roughly 5 million messages per second, so bandwidth doubles with every size step; from 4 KiB on the link is the limit. On these hosts bandwidth settled about 5 % lower (around 92 Gb/s) from 256 KiB upwards, with both stacks (the cause was not investigated): one more reason to compare hosts at one fixed size rather than across sizes. Note also that `-a` switched `CQ Moderation` to 100 in the header, and that it needs the 8 MiB buffers registered, so it fails with a low memlock limit (see the pitfalls).

Try it in the explorer below: change the message-rate ceiling and the MTU to see where the curve reaches half its ceiling, then paste a `BW average` from your own run into the converter to turn MiB/s into Gb/s and a percentage of line rate.

```widget
perftest-explorer
```

### Reading latency output

```text stack=inbox real
$ ib_write_lat -d rocep3s0f0 -x 3 -F 10.10.10.2
---------------------------------------------------------------------------------------
                    RDMA_Write Latency Test
...
 TX depth        : 1
 Max inline data : 220[B]
...
---------------------------------------------------------------------------------------
 #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]   99% percentile[usec]   99.9% percentile[usec] 
 2       1000          1.09           3.32         1.11     	       1.12        	0.05   		1.22    		3.32   
---------------------------------------------------------------------------------------
```

```text stack=doca real
$ ib_write_lat -d mlx5_0 -x 3 -F 10.10.10.2
Disabling dynamic polling
---------------------------------------------------------------------------------------
                    RDMA_Write Latency Test
...
 TX depth        : 1
 Max inline data : 220[B]
...
---------------------------------------------------------------------------------------
 #bytes #iterations    t_min[usec]    t_max[usec]  t_typical[usec]    t_avg[usec]    t_stdev[usec]   99% percentile[usec]   99.9% percentile[usec] 
 2       1000          0.98           6.01         1.00     	       1.01        	0.13   		1.14    		6.01   
---------------------------------------------------------------------------------------
```

*(Real captures, header block trimmed: the default 2-byte message and 1000 iterations, back to back without a switch. A latency test runs with `TX depth : 1` and inlines small messages, `Max inline data : 220[B]`. Small-message latency on modern adapters through one switch is commonly around 1-2 µs, but depends on adapter, switch hops, CPU and settings; the same ConnectX-5 pair measured 0.83 µs minimum write latency over native InfiniBand.)* For write and send latency tests perftest reports half of the measured round trip; `ib_read_lat` reports the full time for the read to return, so read latency looks roughly double. Look at **t_typical** and the **99 %/99.9 % percentiles**: a large gap between typical and 99.9 % points at jitter from CPU power states, interrupts or a congested path.

### Where the bottleneck can be

```mermaid
flowchart LR
    MEM["Buffer memory (host DRAM or GPU)"] -- "NUMA / PCIe P2P" --> PCIE["PCIe slot (Gen4 or Gen5, lane width)"]
    PCIE --> NIC["NIC (firmware, link speed)"]
    NIC --> CABLE["Cable / optics"]
    CABLE --> SW["Switch port and fabric path"]
    SW --> NIC2["Remote NIC"]
```

Each stage has its own ceiling. PCIe is a frequent one: a PCIe Gen4 x16 slot has 256 Gb/s of raw signalling per direction and somewhat less after protocol overhead, which is enough for 200 Gb/s but not for 400 Gb/s; 400 Gb/s adapters need PCIe Gen5 x16 or an equivalent multi-slot arrangement. Check `lspci -vv` for the negotiated link speed and width ("LnkSta") when bandwidth caps at an odd value.

## In practice

### A basic pair test on InfiniBand

```text
server$ ib_write_bw -d mlx5_0 -D 10 --report_gbits
client$ ib_write_bw -d mlx5_0 -D 10 --report_gbits server-hostname
```

On InfiniBand the header says `Link type : IB`, there is no `GID index` line, and the address lines carry the LIDs the Subnet Manager assigned, with no `GID:` line. From the ConnectX-5 pair with port 2 in InfiniBand mode (EDR, DOCA-OFED; `mlx5_1` is the IB device there, and the out-of-band exchange went over the management network):

```text real=doca
$ ib_write_bw -d mlx5_1 -i 1 -F --report_gbits 192.0.2.12
---------------------------------------------------------------------------------------
                    RDMA_Write BW Test
...
 Mtu             : 4096[B]
 Link type       : IB
 Max inline data : 0[B]
...
---------------------------------------------------------------------------------------
 local address: LID 0x01 QPN 0x014c PSN 0x9b74b6 RKey 0x03df00 VAddr 0x007edbd6e34000
 remote address: LID 0x02 QPN 0x014a PSN 0x7b3292 RKey 0x23bf00 VAddr 0x00771145b11000
---------------------------------------------------------------------------------------
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             94.79              94.79  		     0.180790
---------------------------------------------------------------------------------------
```

### The same on RoCE

```text
server$ ib_write_bw -d mlx5_0 -x 3 -q 4 -D 10 --report_gbits
client$ ib_write_bw -d mlx5_0 -x 3 -q 4 -D 10 --report_gbits 10.0.0.12
```

`-x 3` selects the RoCEv2 GID in our example table (confirm yours with `show_gids` on NVIDIA's stack or sysfs on any install, see `rdma-on-linux`). `-q 4` uses four QPs; on RoCE each QP typically gets a different UDP source port, giving the fabric more ECMP entropy. Alternatively, `-R` lets rdma_cm choose the GID from the IP address.

### Pin to the right NUMA node

The process and its buffers should live on the CPU socket closest to the NIC:

```text
$ cat /sys/class/infiniband/mlx5_0/device/numa_node
1
$ numactl --cpunodebind=1 --membind=1 ib_write_bw -d mlx5_0 -D 10 --report_gbits 10.0.0.12
```

### Testing GPU memory (GPUDirect RDMA)

If perftest was built with CUDA support, `--use_cuda=<gpu index>` places buffers in GPU memory, which tests the GPU-NIC PCIe path that NCCL will use:

```text
client$ ib_write_bw -d mlx5_0 --use_cuda=0 -D 10 --report_gbits 10.0.0.12
```

Distribution perftest packages are often built without CUDA. Check your build first:

```text stack=inbox real
$ ib_write_bw --help | grep -i cuda
$ ib_write_bw -d rocep3s0f0 -x 3 --use_cuda=0 -F --report_gbits 10.10.10.2
 Parser function exited with Error
 Unsupported memory type
```

```text stack=doca real
$ ib_write_bw --help | grep -i cuda
      --use_cuda=<cuda device id> Use CUDA specific device for GPUDirect RDMA testing
      --cuda_mem_type=<value> Set CUDA memory type <value>=0(device,default),1(managed),4(malloc)
      --use_cuda_bus_id=<cuda full BUS id> Use CUDA specific device, based on its full PCIe address, for GPUDirect RDMA testing
      --use_cuda_dmabuf Use CUDA DMA-BUF for GPUDirect RDMA testing
      --use_cuda_pcie_mapping Use CUDA DMABUF handle mapping via PCIe BAR1
      --use_data_direct Use Data-Direct CUDA DMA-BUF for GPUDirect RDMA testing
```

Ubuntu's perftest 25.01 has no CUDA options at all (the grep prints nothing), while NVIDIA's DOCA build lists them. Use NVIDIA's build (DOCA-Host) or build perftest yourself against CUDA; the DOCA build still needs a GPU, the CUDA libraries and GPUDirect RDMA support to run the test.

Pick a GPU that shares a PCIe switch with the NIC (`nvidia-smi topo -m`, see `reading-server-topology`). A large gap between host-memory and GPU-memory results points at topology or at GPUDirect RDMA not being active.

### A validation plan

| Step | Test | Catches |
|---|---|---|
| 1 | Per-NIC pair test, same rail, large messages, unidirectional | Bad cables, wrong link speed, PCIe issues |
| 2 | Same with `-b` (bidirectional) | Asymmetric problems, PCIe or memory bandwidth limits |
| 3 | `-a` sweep | Message-rate or MTU problems at specific sizes |
| 4 | `ib_write_lat` / `ib_read_lat` with percentiles | Jitter, power management, extra hops |
| 5 | GPU memory with `--use_cuda` | GPUDirect RDMA and GPU-NIC topology |
| 6 | Many pairs at once across the fabric | Oversubscription, ECMP collisions, congestion (then move to NCCL tests) |

Record results per NIC and per pair in a table and compare against peers. Outliers are more informative than averages: the slow pair is where your faulty cable or misconfigured host lives.

> [!TIP]
> Run several tests in parallel between different NIC pairs by giving each a different `-p` port. This is how burn-in scripts exercise all eight rails of a server at once.

> [!INTERVIEW]
> *"ib_write_bw between two 400G hosts shows 190 Gb/s. How do you narrow it down?"* Strong answer: check that the link negotiated 400G on both ends (`ibstat` or `ethtool`), that the PCIe link is Gen5 x16 (`lspci -vv`), that the process is pinned to the NIC's NUMA node, that you used a large message size and `--report_gbits`, and on RoCE that the GID index is RoCEv2; then try `-q` with more QPs and a different peer to see whether the problem follows the host or the path. Roughly half of line rate often means half the PCIe bandwidth or half the lanes.

## Common pitfalls

- **Misreading units.** Symptom: "only 46,000 — something is badly wrong". Cause: default output is in 2^20-byte units (labelled `MB/sec` in older perftest releases and `MiB/sec` in current ones), so 46,000 is about 386 Gb/s. Fix: use `--report_gbits`.
- **Wrong device name.** Symptom: `IB device mlx5_0 not found` / ` Unable to find the Infiniband/RoCE device`. Cause: a command copied from a guide for the other driver stack (distro rdma-core names devices like `rocep3s0f0`). Fix: take the name from `ibv_devices` or `rdma link`.
- **Locked-memory limit too low.** Symptom: single-size tests pass, but `-a` (up to 8 MiB buffers) fails with `Couldn't allocate MR` and ` Couldn't create IB resources`. Cause: the default memlock limit (8192 KiB on Ubuntu, for example). Fix: set memlock to unlimited for the test user and log in again.
- **Wrong or missing GID index on RoCE.** Symptom: the client hangs or the test fails with a completion error. Cause: default GID index is not RoCEv2 with the fabric IP. Fix: pass `-x` with the right index or use `-R`.
- **CPU frequency warnings.** Symptom: perftest prints "Conflicting CPU frequency values detected" (older releases could also abort without a report). Cause: frequency scaling makes the cycle-counter conversion unreliable. Fix: use `-F` to suppress the check (and consider setting a performance governor for repeatable latency).
- **Testing the wrong path.** Symptom: excellent results that do not match production. Cause: both NICs on the same leaf switch, or the test used the management network's IP for the out-of-band exchange and an unexpected device. Fix: name the device with `-d`, check address lines, and test across the spine as well.
- **Small messages or short runs.** Symptom: low and noisy bandwidth. Cause: message-rate limited sizes or too few iterations. Fix: use 64 KiB or larger and `-D 10` or more for bandwidth checks.
- **TCP exchange blocked.** Symptom: the client prints `Couldn't connect to 10.0.0.12:18515` and ` Unable to init the socket connection` (the same happens when no server is running). Cause: host firewall or wrong IP for the exchange port. Fix: open the perftest TCP port or choose another with `-p`.
- **Judging a fabric only by pair tests.** Symptom: perftest perfect, NCCL slow. Cause: collectives create many simultaneous flows, incast and ECMP collisions. Fix: graduate to multi-pair tests and nccl-tests.

## Key takeaways

- perftest tools measure one verbs operation each; `ib_write_bw` is the closest proxy for NCCL's bulk traffic.
- The essential flags are `-d` (device), `-x` (GID index on RoCE), `-s`/`-a` (sizes), `-q` (QPs), `-D` (duration), `-b` (bidirectional), `--report_gbits`, `-F` and `-R`.
- Report `BW average` for large messages; healthy links typically land in the mid-90s of percent of nominal rate because headers cost a few percent.
- Latency tests report percentiles; write/send latency is half the round trip, read latency is the full round trip.
- PCIe width/generation, NUMA placement and GPU-NIC topology are as likely to limit results as the network.
- Pair tests validate links and hosts; collective performance needs multi-pair and NCCL tests.
