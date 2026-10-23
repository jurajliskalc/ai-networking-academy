---
id: hw-07-gpudirect-numa
title: "GPUDirect RDMA and PCIe affinity: put the GPU and the NIC on the same path"
kind: handson
level: 3
estimated_minutes: 120
environment: hardware
tier: 3
fabric: any
requires: [gpu, two-rdma-hosts, root, ssh-mesh]
changes_config: false
lessons: [pcie-numa-topology, reading-server-topology, gpudirect-rdma-storage, nics-dpus-supernics, perftest-benchmarking, slow-collectives-stragglers]
files: labs/hw-07-gpudirect-numa
verified: false
summary: "Read the PCIe and NUMA topology of a GPU server, confirm the GPUDirect RDMA plumbing, then measure RDMA from host memory and from GPU memory, near and far from the NIC."
---

## Goal

In an AI cluster the bytes that cross the network live in **GPU memory**. With **GPUDirect RDMA**
the NIC reads and writes that memory directly over PCIe, without bouncing through host DRAM. Whether
that works well depends on two things you can inspect on your own servers: the **kernel plumbing**
that lets the RDMA stack register GPU memory, and the **PCIe path** between the GPU and the NIC.

You will work on **host A** (`{{HOST_A}}`, NIC `{{A_RDMA_DEV}}`) and **host B** (`{{HOST_B}}`, NIC
`{{B_RDMA_DEV}}`), each with at least one NVIDIA GPU. By the end you can:

- Read `nvidia-smi topo -m` and `lspci -tv` and say which GPU is "next to" which NIC.
- Find the NUMA node of every GPU and NIC from sysfs, and explain why a mismatch costs bandwidth.
- Tell whether GPU memory registration goes through `nvidia-peermem` or DMA-BUF on your stack.
- Explain how PCIe Access Control Services (ACS) and the IOMMU affect peer-to-peer traffic.
- Measure RDMA WRITE bandwidth from host memory and from GPU memory, with a near and a far GPU.

> [!NOTE]
> All output in this lab is **illustrative**. GPU models, PCIe layouts, bus addresses and numbers
> differ widely between server designs; reading *your* layout is the skill.

## Before you start

- **Hardware:** two GPU servers, each with an RDMA NIC (RoCE or InfiniBand) and at least one
  NVIDIA GPU, connected as in [hw-02](#/hw/labs/hw-02-roce-first-traffic) (or the InfiniBand
  bring-up lab). Complete that lab first: if plain host-memory RDMA does not work, GPU memory will
  not either.
- **Software:** the NVIDIA GPU driver on both hosts (`nvidia-smi` works), the RDMA stack from
  `labs/hw-toolkit/setup-rdma-host.sh`, and for Tasks 5-6 a **CUDA-enabled perftest** build (Task 4
  explains how to tell and how to get one).
- **Profile:** set `GPU_INDEX` on the [Connect page](#/hw/connect) to the GPU closest to your NIC
  once Task 1 has told you which one that is. Currently `GPU_INDEX={{GPU_INDEX}}`.
- **SSH:** key-based SSH from host A to host B.
- **Changes:** none. The lab reads topology and runs tests. Loading `nvidia-peermem` in Task 3 is
  optional and does not persist across reboot unless you configure it to.

## Tasks

### Task 1: Read the GPU/NIC topology matrix

On host A:

```bash
nvidia-smi topo -m
```

Illustrative output (a two-socket server with two GPUs and two NIC ports):

```
        GPU0    GPU1    NIC0    NIC1    CPU Affinity    NUMA Affinity   GPU NUMA ID
GPU0     X      SYS     PIX     SYS     0-31            0               N/A
GPU1    SYS      X      SYS     PIX     32-63           1               N/A
NIC0    PIX     SYS      X      SYS
NIC1    SYS     PIX     SYS      X

Legend:
  X    = Self
  SYS  = Connection traversing PCIe as well as the SMP interconnect between NUMA nodes (e.g., QPI/UPI)
  NODE = Connection traversing PCIe as well as the interconnect between PCIe Host Bridges within a NUMA node
  PHB  = Connection traversing PCIe as well as a PCIe Host Bridge (typically the CPU)
  PXB  = Connection traversing multiple PCIe bridges (without traversing the PCIe Host Bridge)
  PIX  = Connection traversing at most a single PCIe bridge
  NV#  = Connection traversing a bonded set of # NVLinks

NIC Legend:
  NIC0: mlx5_0
  NIC1: mlx5_1
```

**How to read it**, from best to worst path between a GPU and a NIC:

| Code | Path between GPU and NIC | What it means for GPUDirect RDMA |
|---|---|---|
| `PIX` | At most one PCIe bridge (typically a shared PCIe switch) | Ideal: peer-to-peer traffic stays inside the switch. |
| `PXB` | Several PCIe bridges, still below the CPU | Good: does not touch the CPU root complex. |
| `PHB` | Through the CPU's PCIe host bridge | Works, but uses the root complex; performance depends on the CPU. |
| `NODE` | Between host bridges inside one NUMA node | Often noticeably slower for peer-to-peer. |
| `SYS` | Across the socket interconnect (UPI, Infinity Fabric, ...) | Usually poor for GPUDirect; frameworks may avoid it. |

The `NIC Legend` (printed by recent drivers) maps `NIC0`, `NIC1` to RDMA device names (`mlx5_0`
with NVIDIA's OFED/DOCA stack; with distribution rdma-core they look like `rocep59s0f0`). Find
`{{A_RDMA_DEV}}` and read down its column: the GPU with `PIX` or `PXB` there is the one to pair
with it. Many GPU servers are built with exactly one NIC per GPU under a shared PCIe switch for
this reason (the "rail" design in the cluster-design lessons).

Repeat on host B. Decide on one GPU index per host that is closest to the NIC. If it differs from
`{{GPU_INDEX}}`, update the profile. (If the hosts differ from each other, the check script uses
the profile value on both sides; choose a layout where the same index is the near GPU, or note it.)

**Why:** NCCL reads the same topology to decide which NIC each GPU should use and whether
GPUDirect RDMA is worth enabling for a given pair. If your mental model of the box is wrong, every
later performance conclusion will be too.

### Task 2: Confirm with the PCIe tree and sysfs

`nvidia-smi` summarises; the kernel shows the actual tree. On host A:

```bash
lspci -tv | less
```

Look for the NVIDIA GPU (`NVIDIA Corporation`) and the NIC (for example `Mellanox Technologies`)
under the same branch: a PCIe switch shows up as an extra level of bridges between the root port
and the devices.

Now get the NUMA node of each device straight from sysfs. The GPU's PCI address comes from
`nvidia-smi`; it prints an 8-digit PCI domain, while sysfs uses 4:

```bash
nvidia-smi --query-gpu=index,name,pci.bus_id --format=csv,noheader
# Illustrative: 0, NVIDIA H100 80GB HBM3, 00000000:1B:00.0
for g in $(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader); do
  a=$(echo "${g: -12}" | tr 'A-F' 'a-f')
  echo "GPU $a numa_node=$(cat /sys/bus/pci/devices/$a/numa_node)"
done
echo "NIC {{A_RDMA_DEV}} numa_node=$(cat /sys/class/infiniband/{{A_RDMA_DEV}}/device/numa_node)"
```

**What to observe:** the near GPU and the NIC report the same NUMA node. `-1` means the platform
does not report a node (common on single-socket systems and some VMs); then rely on the topology
matrix. Also check the negotiated PCIe link of both devices, since a GPU or NIC that trained at a
lower width or speed caps everything after it:

```bash
NIC_PCI=$(basename "$(readlink -f /sys/class/infiniband/{{A_RDMA_DEV}}/device)")
sudo lspci -vv -s "$NIC_PCI" | grep -E 'LnkCap:|LnkSta:'
```

`LnkSta` shows the current speed and width; if it is below `LnkCap`, `lspci` marks it
`(downgraded)`. GPUs may lower their link speed at idle to save power, so check a GPU's link while
it is busy before calling it a fault. Inside a virtual machine with passed-through devices, `lspci`
shows the hypervisor's virtual PCIe ports (for example `Speed 5GT/s, Width x32`) and the topology
matrix reflects the virtual layout, so do this lab on bare metal if the PCIe path is what you want
to learn about.

### Task 3: Which GPUDirect RDMA mechanism does this host use?

For the NIC to DMA into GPU memory, the RDMA stack must be able to **register** a GPU buffer as a
memory region. There are two mechanisms on Linux:

| Mechanism | How it works | How to see it |
|---|---|---|
| Peer memory (`nvidia-peermem`) | A kernel module shipped with the NVIDIA driver plugs into the RDMA core's peer-memory interface; `ibv_reg_mr()` on a GPU address is handed to it. | `lsmod` lists `nvidia_peermem`. |
| DMA-BUF | The GPU driver exports GPU memory as a DMA-BUF file descriptor, registered with `ibv_reg_dmabuf_mr()`. Upstream kernel interface (Linux 5.12 and later). | No module to see; depends on kernel, GPU kernel-module flavour, driver, CUDA and application support. |

On both hosts:

```bash
lsmod | grep -E 'nvidia_peermem|nv_peer_mem'
uname -r
cat /proc/driver/nvidia/version | head -1
```

Illustrative:

```
nvidia_peermem         16384  0
ib_core               446464  9 rdma_cm,ib_ipoib,nvidia_peermem,...
```

If you rely on peer memory and the module is not loaded, load it (as root):

```bash
sudo modprobe nvidia-peermem
```

If it fails to load, the usual reason is a mismatch between the NVIDIA driver and the RDMA stack it
was built against (for example after installing or upgrading NVIDIA's OFED/DOCA stack after the GPU
driver); the GPU driver and DOCA/OFED release notes describe the supported combinations. `nv_peer_mem`
is the older, out-of-tree predecessor of `nvidia-peermem`; do not load both.

If you rely on DMA-BUF instead, the module may legitimately be absent. The exact requirements
(kernel version, the open GPU kernel modules, driver and CUDA versions) change between releases;
check the CUDA and NCCL documentation for your versions rather than assuming.

**Why:** without either mechanism, applications still work but stage data through host memory:
GPU to host copy, then RDMA from host memory. NCCL reports this in its logs (the next lab shows
`GDRDMA` on network channels when GPUDirect RDMA is in use).

### Task 4: ACS, the IOMMU, and a CUDA-enabled perftest

**ACS.** PCIe Access Control Services can force peer-to-peer requests that would stay inside a
PCIe switch to be redirected up to the root complex (for isolation, typically when the IOMMU is
used for device assignment). That turns a `PIX` path into a much longer one, or breaks it. Look at
the ACS control bits on the bridges above your GPU and NIC:

```bash
sudo lspci -vvv | grep -E '^[0-9a-f]|ACSCtl' | grep -B1 ACSCtl | head -40
```

Illustrative line on a bridge:

```
ACSCtl: SrcValid+ TransBlk- ReqRedir+ CmpltRedir+ UpstreamFwd+ EgressCtrl- DirectTrans-
```

`ReqRedir+` and `CmpltRedir+` on the switch ports between a GPU and a NIC mean peer-to-peer
traffic is redirected upstream. NVIDIA's GPUDirect RDMA and NCCL documentation discuss when ACS
should be disabled on bare-metal hosts and how platforms expose this (BIOS options, or scripts run
at boot). **Do not change BIOS, IOMMU or ACS settings blindly**: they also affect security
isolation, virtualization and device assignment. Record what you see, compare it with your
platform vendor's guidance, and decide deliberately.

Also note the IOMMU mode the kernel booted with:

```bash
tr ' ' '\n' </proc/cmdline | grep -i iommu || echo "no IOMMU flags: platform default"
```

**perftest with CUDA.** perftest can allocate its buffers in GPU memory, but only if it was **built
with CUDA support**. Distribution packages are usually built without it. Check:

```bash
ib_write_bw --help 2>&1 | grep -i cuda
```

If `--use_cuda` appears, you are ready. NVIDIA's DOCA-Host perftest, for example, lists
`--use_cuda`, `--cuda_mem_type`, `--use_cuda_bus_id`, `--use_cuda_dmabuf`, `--use_cuda_pcie_mapping`
and `--use_data_direct`. If nothing appears (the usual case for distribution packages), the build has
no CUDA support: passing `--use_cuda=0` anyway makes it stop with ` Parser function exited with
Error` and ` Unsupported memory type`. Then build perftest from source on both
hosts following the CUDA section of the perftest README (github.com/linux-rdma/perftest): you run
its `autogen.sh` and `configure` with the path to the CUDA headers, then `make`. Option names have
changed between perftest versions (older builds took `--use_cuda` with no GPU index; newer ones
take an index and may add a DMA-BUF variant), so trust `--help` on your build over any example.
Install the result somewhere that is on your `PATH` on both hosts, or the check script will keep
using the distribution binary.

### Task 5: Host memory versus GPU memory

First a baseline from host memory, with the test pinned to the NIC's NUMA node. Find the GID index
as in hw-02 (on InfiniBand, omit `-x`):

```bash
# host B (server)
N=$(cat /sys/class/infiniband/{{B_RDMA_DEV}}/device/numa_node); [ "$N" -lt 0 ] && N=0
numactl --cpunodebind=$N --membind=$N ib_write_bw -d {{B_RDMA_DEV}} -x {{GID_INDEX}} -F --report_gbits
# host A (client)
N=$(cat /sys/class/infiniband/{{A_RDMA_DEV}}/device/numa_node); [ "$N" -lt 0 ] && N=0
numactl --cpunodebind=$N --membind=$N ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} -F --report_gbits {{B_IP}}
```

Then the same test with buffers in GPU `{{GPU_INDEX}}` on **both** sides:

```bash
ib_write_bw -d {{B_RDMA_DEV}} -x {{GID_INDEX}} --use_cuda={{GPU_INDEX}} -F --report_gbits               # host B
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} --use_cuda={{GPU_INDEX}} -F --report_gbits {{B_IP}}      # host A
```

Illustrative excerpt of the CUDA run (perftest prints which GPU it initialised and where the buffer
was allocated before the result table; wording varies by version):

```
initializing CUDA
Listing all CUDA devices in system:
CUDA device 0: PCIe address is 1B:00
Picking device No. 0
...
allocated 131072 bytes of GPU buffer at 0x7f2c4e000000
...
 #bytes     #iterations    BW peak[Gb/sec]    BW average[Gb/sec]   MsgRate[Mpps]
 65536      5000             97.10              97.05  		     0.185111
```

**What to observe:** with a `PIX`/`PXB` path and working GPUDirect RDMA, GPU-memory bandwidth should
be close to the host-memory baseline at large messages. A large gap points to the path (Task 1),
ACS redirection (Task 4), a downgraded PCIe link (Task 2), or registration not using GPUDirect at
all. If the run fails while registering memory, revisit Task 3.

Sweep message sizes (`-a`) for both runs and compare where each curve flattens (`-a` registers
buffers up to 8 MiB, so memlock must be unlimited: `ulimit -l` on both hosts, otherwise perftest
stops with `Couldn't allocate MR`). Small messages on GPU
memory are often slower, because the NIC's reads of GPU memory travel over PCIe to the GPU instead of
coming from host memory caches.

### Task 6: Near GPU versus far GPU

If your hosts have more than one GPU, repeat the GPU run on host A with a GPU that is `SYS` or `NODE`
from the NIC (keep host B on the near GPU so only one variable changes):

```bash
ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} --use_cuda=<far GPU index> -F --report_gbits {{B_IP}}
```

**What to observe:** bandwidth drops, sometimes sharply, and run-to-run variance usually grows,
because every packet now crosses the root complex or the socket interconnect. On some platforms
the far path still reaches line rate for a single NIC at moderate speeds; the penalty grows with
link speed and with how many GPU/NIC pairs share the interconnect at once. Write down your own
numbers: this is the quantitative reason rail-optimized servers pair each GPU with its own NIC.

Single-GPU hosts can still do a weaker version: run the host-memory test pinned to the far NUMA
node (`--cpunodebind`/`--membind` with the other node) and compare with Task 5.

### Task 7: Record the layout

Collect the inventory so the academy can show it next to your notes:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw collect-all
```

The report includes the `nvidia-smi topo -m` matrix, each GPU's PCI address and each RDMA device's
NUMA node and PCIe link. Import it on the [Connect page](#/hw/connect) and confirm the health review
does not flag the NIC's PCIe link or a missing `nvidia_peermem`.

## Verify

On host A:

```bash
cd {{AINA_DIR}}/labs
./hw-toolkit/aina-hw check hw-07-gpudirect-numa
```

The check confirms `nvidia-smi` and the RDMA device on both hosts, that GPU `GPU_INDEX` exists on both,
whether the GPU and the NIC share a NUMA node (a warning if not), and whether `nvidia_peermem` is loaded
(a warning if not, since DMA-BUF may be in use instead). It then runs a 5-second host-memory
`ib_write_bw` from A to B and, **if** both perftest builds support `--use_cuda`, a 5-second GPU-memory
run, and reports both bandwidths. Without a CUDA-enabled perftest the GPU test is skipped, not failed.

## Restore

Nothing to restore. If you loaded `nvidia-peermem` in Task 3 and do not want it, unload it with
`sudo modprobe -r nvidia-peermem` (nothing may be using it). If you installed a self-built perftest,
it stays where you put it; remove it from your `PATH` if you want the distribution build back.

## What you learned

- `nvidia-smi topo -m` ranks GPU-to-NIC paths from `PIX` (best) to `SYS` (worst); pair each NIC
  with a GPU on a `PIX`/`PXB` path.
- NUMA nodes and negotiated PCIe links come from sysfs and `lspci -vv`; check both ends.
- GPUDirect RDMA needs a registration mechanism: `nvidia-peermem` or DMA-BUF, depending on the stack.
- ACS redirection and IOMMU settings can silently lengthen or break peer-to-peer paths; change them
  only deliberately.
- perftest measures GPU-memory RDMA only when built with CUDA; with a good path it approaches the
  host-memory number, with a far GPU it does not.

## Going further

- Run the [NCCL two-node lab](#/hw/labs/hw-08-nccl-two-nodes) with `NCCL_DEBUG=INFO` and look for
  `GDRDMA` on the network channels: that is NCCL confirming what you measured here.
- Dump NCCL's view of the topology with `NCCL_TOPO_DUMP_FILE` and compare it with Task 1.
- If your hosts have several NICs, repeat Task 6 as a full matrix (every GPU against every NIC) and
  keep it as the reference for the machine type.
