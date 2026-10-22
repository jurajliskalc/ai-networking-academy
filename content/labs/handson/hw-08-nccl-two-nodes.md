---
id: hw-08-nccl-two-nodes
title: "NCCL across two nodes: build nccl-tests, read the logs, and catch a silent socket fallback"
kind: handson
level: 4
estimated_minutes: 150
environment: hardware
tier: 3
fabric: any
requires: [gpu, two-rdma-hosts, ssh-mesh]
changes_config: false
lessons: [nccl-architecture, nccl-configuration, nccl-debugging, nccl-tests-interpretation, collective-algorithms, collective-operations, slow-collectives-stragglers]
files: labs/hw-08-nccl-two-nodes
verified: false
summary: "Run a real multi-node all-reduce with nccl-tests and Open MPI, prove from the NCCL log that it used RDMA (and GPUDirect), read algbw versus busbw, then break NIC selection on purpose and watch the fallback."
---

## Goal

Everything in this track leads here: **GPUs on two hosts exchanging gradients through NCCL over your
RDMA fabric**. You will build the standard benchmark (`nccl-tests`), launch it across
**host A** (`{{HOST_A}}`) and **host B** (`{{HOST_B}}`) with Open MPI, and learn to answer the three
questions every AI-cluster engineer is asked about a slow job:

1. Did NCCL use the RDMA network at all, and which NICs?
2. Did it use GPUDirect RDMA, or stage data through host memory?
3. Is the bandwidth it achieved what this hardware should deliver?

Then you will break NIC selection on purpose and see how a misconfiguration that does **not** crash
the job shows up in the log and in the numbers.

By the end you can:

- Build nccl-tests with MPI support and run it across nodes.
- Read an `NCCL_DEBUG=INFO` log for the network, devices, GPUDirect RDMA and channels.
- Explain `algbw` and `busbw`, and estimate a sensible `busbw` for your NIC.
- Set `NCCL_IB_HCA`, `NCCL_SOCKET_IFNAME`, `NCCL_IB_GID_INDEX` and `NCCL_IB_TC` deliberately.
- Recognise a socket fallback and explain the bandwidth collapse.

> [!NOTE]
> All logs and numbers below are **illustrative**. NCCL's log wording changes between versions;
> look for the concepts, not exact strings.

## Before you start

- **Hardware:** two GPU hosts with RDMA NICs, working with host-memory RDMA
  ([hw-02](#/hw/labs/hw-02-roce-first-traffic)) and ideally with GPUDirect RDMA
  ([hw-07](#/hw/labs/hw-07-gpudirect-numa)). One GPU per host is enough; the profile uses
  `GPUS_PER_NODE={{GPUS_PER_NODE}}`.
- **Software on both hosts:** the NVIDIA driver, the CUDA toolkit, NCCL (library and headers), and
  Open MPI. Task 1 shows typical package names; versions must be compatible with each other (check
  the NCCL and CUDA release notes).
- **Same paths everywhere:** MPI starts the remote rank by running the same binary path on host B,
  so nccl-tests must be built at `{{NCCL_TESTS_DIR}}` on **both** hosts.
- **SSH:** key-based SSH from host A to host B **as the user who runs the test** (Open MPI uses it to
  launch the remote rank).
- **Firewall:** Open MPI and NCCL's bootstrap open TCP connections on dynamic ports between the
  hosts. For the lab, allow all TCP between the hosts' data addresses or stop the firewall.
- **For RoCE:** the traffic class `{{TCLASS}}` (DSCP `{{ROCE_DSCP}}`) only matters once lossless QoS
  is configured ([hw-03](#/hw/labs/hw-03-host-qos-pfc-ecn)); the test works without it on an idle link.
- **Changes:** none. All settings are environment variables of the test run.

## Tasks

### Task 1: Install the pieces and build nccl-tests

On Ubuntu with NVIDIA's CUDA repository configured, typical packages are:

```bash
sudo apt-get install -y openmpi-bin libopenmpi-dev     # Open MPI runtime and headers
sudo apt-get install -y libnccl2 libnccl-dev           # NCCL, from NVIDIA's CUDA repository
```

(Other distributions and NVIDIA's HPC SDK package these differently; the requirement is simply a
working `mpirun`, `mpicc` headers, CUDA and NCCL.)

Build nccl-tests on **both** hosts, at the same path:

```bash
cd ~ && git clone https://github.com/NVIDIA/nccl-tests.git && cd nccl-tests
make MPI=1 MPI_HOME=/usr/lib/x86_64-linux-gnu/openmpi CUDA_HOME=/usr/local/cuda NCCL_HOME=/usr
ls build/
```

The `make` variables are documented in the nccl-tests README: `MPI=1` builds the MPI-aware binaries
needed for multi-node runs; `MPI_HOME`, `CUDA_HOME` and `NCCL_HOME` point at the installations
(adjust them to where yours live; `mpicc --showme:incdirs` prints Open MPI's include directory, and
NCCL installed from packages usually has its headers under `/usr/include`). The binaries land in
`build/`, which is the profile's `{{NCCL_TESTS_DIR}}`.

**Why MPI?** nccl-tests needs something to start one process per node and distribute NCCL's
unique ID. MPI does only that; the collective's data never goes through MPI.

### Task 2: A single-node baseline

On each host:

```bash
{{NCCL_TESTS_DIR}}/all_reduce_perf -b 8 -e 1G -f 2 -g {{GPUS_PER_NODE}}
```

With several GPUs this measures the **intra-node** path (NVLink or PCIe), which is usually much
faster than the network. With a single GPU there is nothing to reduce across, so the numbers only
prove that CUDA and NCCL work. Either way, `#wrong` must be `0`.

**Why:** if a single node fails or is slow, the network is not your problem yet. Always measure the
parts before the whole.

### Task 3: The two-node run

From host A, the lab's wrapper builds the full command from your profile:

```bash
cd {{AINA_DIR}}/labs/hw-08-nccl-two-nodes
./run-allreduce.sh
```

It prints the exact command and environment, which is essentially:

```bash
export NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,NET
export NCCL_SOCKET_IFNAME={{A_NETDEV}}
export NCCL_IB_HCA=={{A_RDMA_DEV}}:{{RDMA_PORT}}      # value "={{A_RDMA_DEV}}:{{RDMA_PORT}}": exact name, port {{RDMA_PORT}}
export NCCL_IB_GID_INDEX={{GID_INDEX}} NCCL_IB_TC={{TCLASS}}   # RoCE only
mpirun -np 2 -H {{HOST_A}}:1,{{HOST_B}}:1 --bind-to none \
  -x NCCL_DEBUG -x NCCL_DEBUG_SUBSYS -x NCCL_SOCKET_IFNAME -x NCCL_IB_HCA \
  -x NCCL_IB_GID_INDEX -x NCCL_IB_TC -x PATH -x LD_LIBRARY_PATH \
  {{NCCL_TESTS_DIR}}/all_reduce_perf -b 8M -e 1G -f 2 -g {{GPUS_PER_NODE}}
```

What each piece does:

| Setting | Purpose |
|---|---|
| `-np 2 -H host:1,...` | Open MPI: two ranks in total, one slot on each host. Each rank drives `-g` GPUs. |
| `-x VAR` | Open MPI: export the variable to every rank, including the remote one. |
| `--bind-to none` | Do not pin the rank to one core; NCCL and CUDA manage their own threads. |
| `NCCL_SOCKET_IFNAME` | The IP interface for NCCL's bootstrap (and the socket transport, if used). |
| `NCCL_IB_HCA` | Which RDMA devices NCCL may use; `=` asks for exact names instead of prefix matches. |
| `NCCL_IB_GID_INDEX` | RoCE only: the RoCE v2 GID index (the wrapper detects it on both hosts). |
| `NCCL_IB_TC` | RoCE only: the traffic-class byte, DSCP `{{ROCE_DSCP}}` shifted left by two plus ECT(0). |

Other MPI launchers (Slurm's `srun`, MPICH, Intel MPI) spell these options differently. If Open MPI
picks the wrong interface for its own TCP traffic, restrict it with its MCA parameters
`--mca btl_tcp_if_include {{A_NETDEV}} --mca oob_tcp_if_include {{A_NETDEV}}` (add them to the
`mpirun` line; see the Open MPI documentation for your version).

**If it hangs at start-up:** that is almost always SSH, the firewall, or `NCCL_SOCKET_IFNAME`
pointing at an interface the hosts cannot reach each other on. NCCL's bootstrap must connect before
any RDMA happens.

### Task 4: Read the NCCL log like an engineer

The wrapper saved the full log (its path is printed at the end). Open it and find these lines.
Illustrative excerpt:

```
node-a:2041:2041 [0] NCCL INFO Bootstrap : Using ens1f0np0:192.168.50.11<0>
node-a:2041:2041 [0] NCCL INFO NCCL version 2.x.x+cuda12.x
node-a:2041:2063 [0] NCCL INFO NET/IB : Using [0]mlx5_0:1/RoCE [RO]; OOB ens1f0np0:192.168.50.11<0>
node-a:2041:2063 [0] NCCL INFO Using network IB
node-a:2041:2063 [0] NCCL INFO NET/IB : GPU Direct RDMA Enabled for HCA 0 'mlx5_0'
node-a:2041:2063 [0] NCCL INFO Channel 00/02 :    0   1
node-a:2041:2063 [0] NCCL INFO Channel 00/0 : 1[0] -> 0[0] [receive] via NET/IB/0/GDRDMA
node-a:2041:2063 [0] NCCL INFO Channel 00/0 : 0[0] -> 1[0] [send] via NET/IB/0/GDRDMA
```

Read it in this order:

1. **Bootstrap interface:** the IP interface and address NCCL used to find its peers. It should be
   `{{A_NETDEV}}` (or whatever you chose), not `docker0` or a management interface you did not intend.
2. **NET/IB device list:** exactly the NICs you expect, with the link layer: `/RoCE` or `/IB`.
3. **"Using network IB":** NCCL chose the verbs transport (it is called IB for RoCE too). `Socket`
   here means TCP through the kernel.
4. **GPUDirect RDMA:** channel lines ending in `/GDRDMA` mean the NIC reads and writes GPU memory
   directly. `via NET/IB/0` without `GDRDMA` means data is staged through host memory: revisit hw-07.
5. **Channels:** with one NIC per host you will see few channels; servers with a NIC per GPU show
   many, one ring per rail.

```bash
grep -E 'Bootstrap|NET/IB|NET/Socket|Using network|GDRDMA|via NET' <log file> | head -20
```

### Task 5: Read the numbers: algbw, busbw and what to expect

The result table (illustrative, two hosts with one GPU and one 100 Gb/s NIC each):

```
#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong
#        (B)    (elements)                               (us)  (GB/s)  (GB/s)            (us)  (GB/s)  (GB/s)
     8388608       2097152     float     sum      -1    790.2   10.62   10.62      0    788.9   10.63   10.63      0
   134217728      33554432     float     sum      -1  11620.5   11.55   11.55      0  11598.7   11.57   11.57      0
  1073741824     268435456     float     sum      -1  92310.4   11.63   11.63      0  92277.9   11.64   11.64      0
# Out of bounds values : 0 OK
# Avg bus bandwidth    : 11.27
```

- **`algbw`** is the message size divided by the time: what the application sees.
- **`busbw`** corrects for the algorithm so the number is comparable with link speeds. For
  all-reduce, `busbw = algbw × 2(n−1)/n`, where `n` is the total number of GPUs taking part. With two GPUs
  in total the factor is 1, which is why both columns match here; with 2 hosts × 8 GPUs it is 1.875.
- **`#wrong`** must be `0`: anything else means corrupted data, and no bandwidth figure matters.

**What should you expect?** Convert the NIC rate to bytes: 100 Gb/s is 12.5 GB/s, 200 Gb/s is
25 GB/s, 400 Gb/s is 50 GB/s. With a ring all-reduce across nodes, `busbw` at large messages is
roughly bounded by the slowest link in the ring, here the NIC. After protocol overhead and with a
healthy setup, large-message `busbw` typically lands at a high fraction of that figure; well below it
points to no GPUDirect RDMA, a far GPU/NIC pairing, a downgraded PCIe link, or congestion. Treat
these as orders of magnitude: NCCL version, algorithm choice (ring or tree), message size and server
design all move the result. Use small messages to judge latency, large ones to judge bandwidth.

Save your large-message `busbw`: it is your baseline for the next task and for any future change.

### Task 6: Break it on purpose: the socket fallback

Now force NCCL off RDMA and compare. First, disable the IB transport explicitly:

```bash
./run-allreduce.sh --socket          # sets NCCL_IB_DISABLE=1
```

Then make the mistake that happens in real clusters: an `NCCL_IB_HCA` value that matches no device
(a typo, a renamed device after a driver change, a container without the device):

```bash
./run-allreduce.sh --wrong-hca       # NCCL_IB_HCA==aina_no_such_hca:1
```

Compare the logs:

```bash
grep -E 'NET/IB|NET/Socket|Using network|via NET' <log file> | head
```

Illustrative excerpt of a fallback:

```
node-a:2210:2230 [0] NCCL INFO NET/IB : No device found.
node-a:2210:2230 [0] NCCL INFO NET/Socket : Using [0]ens1f0np0:192.168.50.11<0>
node-a:2210:2230 [0] NCCL INFO Using network Socket
node-a:2210:2230 [0] NCCL INFO Channel 00/0 : 0[0] -> 1[0] [send] via NET/Socket/0
```

**What to observe:**

- The job **still completes** with `#wrong = 0`. Nothing crashes. That is exactly why socket
  fallbacks survive in production for weeks: only the log and the bandwidth tell you.
- `busbw` drops, often to a small fraction of the RDMA result, and the CPU on both hosts gets busy
  (watch `top` during the run) because the kernel TCP stack now moves every byte.
- Depending on the NCCL version and settings, a non-matching `NCCL_IB_HCA` may lead to a socket
  fallback or to an error at initialization. Either way, the first lines to read are the `NET/IB`
  and `Using network` lines.

**Why this matters:** "training got 5x slower after the upgrade" with no errors is a classic ticket.
The fix is not in the model code; it is one environment variable or one missing device.

### Task 7 (RoCE): confirm the traffic class on the wire

If you configured host QoS in hw-03, prove that NCCL's traffic lands in the lossless priority: run the
two-node test again and watch the per-priority counters on host A (NVIDIA mlx5 counter names; other
NICs differ):

```bash
watch -n1 "ethtool -S {{A_NETDEV}} | grep -E 'tx_prio{{ROCE_PRIO}}_(bytes|packets)'"
```

The bytes of priority `{{ROCE_PRIO}}` should climb with the test. If they do not, the DSCP NCCL
stamps (`NCCL_IB_TC={{TCLASS}}`) is not mapped to that priority on the NIC, so your PFC and ECN
configuration does not protect NCCL traffic. Run once without `NCCL_IB_TC` (edit the wrapper's
environment or unset it) and compare where the bytes go.

### Task 8: Compare NCCL's view of the topology with yours

```bash
NCCL_TOPO_DUMP_FILE=/tmp/nccl_topo.xml {{NCCL_TESTS_DIR}}/all_reduce_perf -b 8 -e 8 -g {{GPUS_PER_NODE}}
grep -E '<gpu|<nic|<net|<pci' /tmp/nccl_topo.xml | head -30
```

The XML shows the PCIe tree, GPUs and NICs as NCCL detected them, including link speeds and widths.
Compare it with `nvidia-smi topo -m` (hw-07): a NIC missing from the XML, or attached somewhere
unexpected, explains bad channel choices. Virtual machines often present a flattened or misleading
PCIe topology; NCCL then needs a corrected topology file (`NCCL_TOPO_FILE`, see the NCCL docs).

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-08-nccl-two-nodes
```

The check confirms `mpirun`, the nccl-tests binary at `{{NCCL_TESTS_DIR}}` and enough GPUs on both
hosts, then runs `all_reduce_perf` from 8 MB to 256 MB across both hosts with your profile's NCCL
settings. It passes if the run completes, the log shows the IB verbs transport (`NET/IB`, for
InfiniBand or RoCE) and no socket transport, and every `#wrong` column is 0. It reports the average
bus bandwidth and whether `GDRDMA` appeared as information, so you can compare with Task 5.

## Restore

Nothing to restore: every setting in this lab was an environment variable of a single run. The logs
the wrapper wrote stay in `labs/hw-toolkit/results/` (or `$AINA_RESULTS`); delete them when you no
longer need them.

## What you learned

- nccl-tests needs an MPI build (`make MPI=1 ...`) and the same binary path on every node; MPI only
  launches ranks and distributes the NCCL ID.
- The NCCL log answers the first questions about any slow job: bootstrap interface, NET/IB device
  list, "Using network IB", and `GDRDMA` on the network channels.
- `busbw = algbw × 2(n−1)/n` for all-reduce; compare large-message `busbw` with the NIC rate in GB/s.
- A wrong `NCCL_IB_HCA` or a disabled IB transport does not crash the job: it silently falls back to
  sockets and collapses bandwidth.
- On RoCE, `NCCL_IB_TC` and `NCCL_IB_GID_INDEX` must match what the fabric expects; per-priority
  counters prove where the traffic went.

## Going further

- Run `all_gather_perf`, `reduce_scatter_perf` and `alltoall_perf` across the two nodes and compare
  their `busbw` with all-reduce.
- Try `NCCL_ALGO=Ring` and `NCCL_ALGO=Tree` and see how the small- and large-message results change.
- On RoCE with a switch, run the test while another host floods the receiver
  ([hw-06](#/hw/labs/hw-06-switch-lossless-incast)) and watch NCCL's bandwidth and the PFC counters.
- Break the GPUDirect path (for example by unloading `nvidia-peermem` on a peer-memory stack) and see
  `GDRDMA` disappear from the channel lines and the bandwidth change.
