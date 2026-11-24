---
id: nccl-configuration
title: "Configuring NCCL for InfiniBand and RoCE fabrics"
module: m08-nccl-collectives
level: 3
estimated_minutes: 50
objectives:
  - Select the bootstrap interface and RDMA devices with NCCL_SOCKET_IFNAME and NCCL_IB_HCA, including prefix, exact-match and exclusion syntax.
  - Align NCCL's RoCE traffic with the fabric QoS using NCCL_IB_GID_INDEX and NCCL_IB_TC, and InfiniBand SLs with NCCL_IB_SL.
  - Tune or diagnose with NCCL_IB_QPS_PER_CONNECTION, NCCL_CROSS_NIC, NCCL_NET_GDR_LEVEL, NCCL_IB_TIMEOUT and NCCL_IB_RETRY_CNT, and know which knobs are for testing only.
  - Configure containers, launchers and PyTorch so NCCL settings reach every rank and failures surface cleanly.
prerequisites: [nccl-architecture, qos-trust-and-mapping]
quiz: quiz-nccl-configuration
widgets: [pcie-topo, nccl-env-explorer]
labs: []
tags: [nccl, configuration, environment-variables, roce, infiniband, gid, traffic-class, containers]
further_reading:
  - title: NCCL environment variables
    url: https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html
  - title: NCCL troubleshooting guide
    url: https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting.html
  - title: PyTorch ProcessGroupNCCL environment variables
    url: https://docs.pytorch.org/docs/stable/torch_nccl_environment_variables.html
---

## Why this matters

NCCL's defaults are good on hardware it understands: a DGX-style server on bare metal, with
InfiniBand or a correctly configured RoCE fabric. Real clusters add containers, virtual machines,
extra management NICs, docker bridges, storage NICs, custom QoS policies and launchers that do not
forward environment variables. Each of these can make NCCL pick the wrong interface, the wrong GID,
the wrong traffic class or no RDMA at all, and the job still runs, just several times slower or
with pauses that hurt neighbouring jobs.

Network engineers are often the ones asked "which NCCL variables should we set?" The honest answer
is: **as few as possible, each one for a reason you can explain**. This lesson covers the variables
that connect NCCL to your fabric design, the syntax that trips people up, and the settings that
should only ever appear in a debugging session.

## Concepts

### Where configuration comes from

| Source | Scope | Notes |
|---|---|---|
| Environment variables of each rank's process | Per process | The usual method; must reach **every** rank on every node |
| `/etc/nccl.conf` | System-wide | `NAME=value` lines; convenient for site defaults baked into images |
| `~/.nccl.conf` | Per user | Same format; check the docs for precedence and any additional config-file variables in your version |
| Framework settings (e.g. PyTorch process-group options) | Per job | Timeouts and error handling live here, not in NCCL |

Run with `NCCL_DEBUG=INFO` and `NCCL_DEBUG_SUBSYS=ENV` (or `INIT,ENV`) to have NCCL print which
variables it saw. That single habit prevents most "I set it but nothing changed" incidents.

### The variables that connect NCCL to the fabric

| Variable | Purpose | Typical use |
|---|---|---|
| `NCCL_SOCKET_IFNAME` | IP interface(s) for bootstrap and the socket transport | Exclude docker/loopback, or pin the cluster management network |
| `NCCL_IB_HCA` | Which RDMA devices/ports the IB verbs transport may use | Select back-end compute NICs, exclude storage or front-end NICs |
| `NCCL_IB_GID_INDEX` | GID table index used on RoCE ports | Select the RoCEv2 GID for the right IP (IPv4 vs IPv6) |
| `NCCL_IB_TC` | Traffic class (IP DS field byte) for RoCE packets | Put NCCL into the lossless, ECN-enabled class |
| `NCCL_IB_SL` | InfiniBand service level | Map NCCL to a specific SL/VL on IB |
| `NCCL_IB_QPS_PER_CONNECTION` | QPs per connection | More ECMP entropy on RoCE fabrics |
| `NCCL_IB_TIMEOUT` | IB verbs local ACK timeout exponent | Raise for large or congested fabrics if retry-exceeded errors appear |
| `NCCL_IB_RETRY_CNT` | IB verbs retry count | Usually leave at default (7, the protocol maximum) |
| `NCCL_CROSS_NIC` | Whether rings may use different NICs on different nodes | Keep rail alignment in rail-optimized fabrics |
| `NCCL_NET_GDR_LEVEL` | Max GPU-NIC topology distance for GPUDirect RDMA | Diagnose or override GDR decisions |
| `NCCL_IB_DISABLE` | Disable IB verbs transport | Testing only: force socket transport |
| `NCCL_P2P_DISABLE` | Disable intra-node P2P | Testing only: isolate NVLink/PCIe P2P problems |
| `NCCL_ALGO`, `NCCL_PROTO` | Restrict algorithms / protocols | Testing only, or a documented workaround |
| `NCCL_MIN_NCHANNELS`, `NCCL_MAX_NCHANNELS` | Bound channel count | Rare; trades SMs for bandwidth (recent NCCL docs mark these deprecated in favour of `NCCL_MIN_CTAS`/`NCCL_MAX_CTAS`) |

Defaults change between NCCL releases. Whenever this lesson mentions a default, verify it against
the environment-variable page of the NCCL version in your container.

> [!ANALOGY]
> NCCL variables are like static routes in an enterprise network: a few well-documented ones fix
> genuine design constraints (do not route via the management VLAN), but a router full of
> unexplained static routes is a future outage. Where it breaks down: NCCL variables are set per
> process, so a "route" that only reached half the ranks produces inconsistent behaviour that no
> single node's config reveals.

## How it works

### Interface and device selection syntax

`NCCL_SOCKET_IFNAME` and `NCCL_IB_HCA` share a matching syntax:

| Pattern | Meaning | Example |
|---|---|---|
| `name` | Prefix match | `NCCL_SOCKET_IFNAME=eth` matches eth0, eth1 |
| `=name` | Exact match | `NCCL_SOCKET_IFNAME==eth0` (leading `=` then the name) |
| `^name` | Exclude names with this prefix | `NCCL_SOCKET_IFNAME=^docker,lo` |
| `^=name` | Exclude exact names | `NCCL_IB_HCA=^=mlx5_8` |
| `dev:port` | Specific HCA port (IB_HCA) | `NCCL_IB_HCA=mlx5_0:1,mlx5_1:1` |

The prefix rule causes a classic mistake: `NCCL_IB_HCA=mlx5_1` also matches `mlx5_10` and
`mlx5_11`. On servers with more than ten RDMA devices, use exact matching or list explicit ports.

```bash
# Example for a server with 8 compute NICs (mlx5_0..mlx5_7) and 2 storage NICs (mlx5_8, mlx5_9)
export NCCL_IB_HCA==mlx5_0,mlx5_1,mlx5_2,mlx5_3,mlx5_4,mlx5_5,mlx5_6,mlx5_7
export NCCL_SOCKET_IFNAME=^docker,lo,virbr
```

Open `NCCL_IB_HCA` in the explorer and type `mlx5_1`, then `=mlx5_1`, into the matcher to see the prefix trap on a server with twelve RDMA devices; the table lists the other variables in this lesson with their defaults.

```widget
nccl-env-explorer
```

### RoCE: GID index and traffic class

On RoCE, each port has a GID table with entries for each IP address and RoCE version. NCCL must use
a **RoCEv2** GID whose IP is on the back-end network. Inspect it with the `show_gids` script that
ships with NVIDIA's driver stack (MLNX_OFED/DOCA; it is not part of distro rdma-core), or by reading
`/sys/class/infiniband/<dev>/ports/<port>/gids/<index>`, `gid_attrs/types/<index>` (`IB/RoCE v1` or
`RoCE v2`) and `gid_attrs/ndevs/<index>`, which works on any stack. Device names follow the stack
too: NVIDIA's names devices `mlx5_0`, distro rdma-core names them like `rocep3s0f0`; take the names
for `NCCL_IB_HCA` from `rdma link` or `ibv_devices` on your image.

```text
# Illustrative show_gids output (one port shown; tab-separated)
DEV	PORT	INDEX	GID					IPv4  		VER	DEV
---	----	-----	---					------------  	---	---
mlx5_0	1	0	fe80:0000:0000:0000:0a42:a1ff:fe12:3456			v1	ens1f0
mlx5_0	1	1	fe80:0000:0000:0000:0a42:a1ff:fe12:3456			v2	ens1f0
mlx5_0	1	2	0000:0000:0000:0000:0000:ffff:0a64:0001	10.100.0.1  	v1	ens1f0
mlx5_0	1	3	0000:0000:0000:0000:0000:ffff:0a64:0001	10.100.0.1  	v2	ens1f0
n_gids_found=4
```

Here index 3 is RoCEv2 with the IPv4 address. Index 3 is common on such systems, but it is **not**
universal: extra IPs, IPv6 addresses or VLAN interfaces change the table. Recent NCCL versions try
to select a suitable RoCEv2 GID automatically; set `NCCL_IB_GID_INDEX` explicitly when the
automatic choice is wrong or when your site standard requires it.

`NCCL_IB_TC` sets the 8-bit traffic class carried in the IP header's DS field byte, which is
**DSCP × 4** (the low two bits are the ECN field). If your fabric maps DSCP 26 to the lossless
priority:

```bash
export NCCL_IB_TC=104   # DSCP 26 << 2 = 104
```

Many deployment guides use **106** instead: the same DSCP 26 plus ECT(0) in the two ECN bits, so the
packets are ECN-capable from the start. Both put the traffic in the DSCP 26 class; which one your site
uses is part of its QoS profile (see `qos-trust-and-mapping`, and the Real HW labs, which use 106).

The NIC may also apply its own QoS settings (trust mode, default DSCP for RDMA traffic), configured
with vendor tools (`mlnx_qos` and `cma_roce_tos` with NVIDIA's stack; `dcb` from iproute2 and the
rdma_cm configfs `default_roce_tos` file with the distro stack). Whichever mechanism you use, the
packets on the wire must carry the DSCP the switches classify into the PFC/ECN-enabled queue; verify
with a packet capture on a mirror port or switch per-queue counters, not by reading the
configuration. On the host, `tcpdump -i <netdev>` does not see RoCE traffic (the NIC offloads it);
libpcap's RDMA sniffer on mlx5 does, when you capture on the RDMA device name (`tcpdump -i mlx5_0`).

### InfiniBand: service level

On InfiniBand, `NCCL_IB_SL` selects the SL in NCCL's traffic. The SL-to-VL mapping is configured by
the subnet manager. Use it when the fabric reserves VLs for different traffic types (for example,
separating storage from compute), and ensure the SM's QoS policy matches.

### Timeouts and retries

`NCCL_IB_TIMEOUT` is the exponent of the verbs local ACK timeout: roughly 4.096 µs × 2^value per
attempt, and `NCCL_IB_RETRY_CNT` is how many times the NIC retries before reporting a
"retry exceeded" error. Larger values tolerate longer congestion or link flaps before the
connection fails; they do not make anything faster. If you see transport retry errors, investigate
the cause (links flapping, PFC deadlock, black-holed paths) before raising the timeout.

| NCCL_IB_TIMEOUT | Approximate timeout per attempt |
|---|---|
| 14 | ~67 ms |
| 18 | ~1.07 s |
| 20 | ~4.3 s |
| 22 | ~17 s |

### Rail alignment: NCCL_CROSS_NIC

In a rail-optimized fabric, NIC k of every server is on rail k. If a ring leaves node A through NIC
2 and enters node B through NIC 5, the packets must cross the spine. `NCCL_CROSS_NIC=0` asks NCCL to
use the same NIC index on both sides of an inter-node hop; `1` allows different NICs; the default
(`2` in recent releases, per the docs) prefers matching NICs but allows crossing when beneficial.
For rail-optimized fabrics, rail alignment is usually what you want; for fabrics where any NIC
reaches any other at full bandwidth, crossing is harmless.

### GPUDirect RDMA level

`NCCL_NET_GDR_LEVEL` takes topology-distance values such as `LOC`, `PIX`, `PXB`, `PHB` and `SYS`:
NCCL uses GDR when the GPU-NIC distance is at or below the level. Raising it to `SYS` forces GDR
across sockets, which may be slower than staging through host memory; lowering it disables GDR
except on the closest paths.

```widget
pcie-topo
```

Compare GPU-NIC pairs in the widget with their PIX/PXB/PHB/SYS labels: that is the distance NCCL
compares with `NCCL_NET_GDR_LEVEL`.

## In practice

### A minimal, explained RoCE profile

```bash
# Site profile (sourced shell file) for a RoCEv2 rail-optimized back-end fabric.
# Example values; adapt to your design. (In /etc/nccl.conf, use plain NAME=value lines without comments on the same line.)
export NCCL_SOCKET_IFNAME==bond0          # bootstrap over the cluster management bond only
export NCCL_IB_HCA==mlx5_0,mlx5_1,mlx5_2,mlx5_3,mlx5_4,mlx5_5,mlx5_6,mlx5_7   # compute NICs only
export NCCL_IB_GID_INDEX=3                # RoCEv2 IPv4 GID verified with show_gids on this image
export NCCL_IB_TC=104                     # DSCP 26 = lossless, ECN-enabled class on the switches
export NCCL_IB_QPS_PER_CONNECTION=2       # extra ECMP entropy; measured improvement in variance
export NCCL_CROSS_NIC=0                   # keep rings rail-aligned
```

Every line has a reason that maps to the fabric design. Notice what is **absent**: no `NCCL_ALGO`,
no `NCCL_PROTO`, no channel overrides, no `NCCL_P2P_DISABLE`.

### Containers and Kubernetes

| Requirement | Why | How (examples) |
|---|---|---|
| RDMA devices visible | IB verbs needs `/dev/infiniband/*` | Docker `--device=/dev/infiniband`, or an RDMA device plugin / NVIDIA Network Operator on Kubernetes |
| Locked memory | Memory registration pins pages | `--ulimit memlock=-1`, `IPC_LOCK` capability where required |
| Large `/dev/shm` | SHM transport and NCCL buffers use shared memory | `--shm-size` (e.g. several GB) or `--ipc=host`; Docker's 64 MB default is too small |
| Host networking or SR-IOV | Bootstrap and RDMA addressing | `--network=host`, or SR-IOV VFs / Multus secondary networks |
| Correct topology | VMs and some containers hide the PCIe tree | Provide a topology file via `NCCL_TOPO_FILE` if the cloud/vendor publishes one |

### Launchers

- **mpirun (Open MPI)**: environment variables are not all forwarded by default; use `-x NCCL_DEBUG
  -x NCCL_IB_HCA ...` or your MPI's equivalent.
- **Slurm `srun`**: exports the submission environment by default (`--export=ALL`), but site
  policies differ; verify with `NCCL_DEBUG_SUBSYS=ENV`.
- **torchrun / Kubernetes operators**: set variables in the pod spec or job template, not only in an
  interactive shell.

### PyTorch-specific settings

Error handling and timeouts for NCCL collectives in PyTorch are **PyTorch** settings, not NCCL ones:

- `TORCH_NCCL_ASYNC_ERROR_HANDLING` controls how ProcessGroupNCCL reacts to failed or timed-out
  collectives (older PyTorch versions used the name `NCCL_ASYNC_ERROR_HANDLING`, now deprecated).
- The collective timeout is passed as `timeout=` to `torch.distributed.init_process_group`.
- Further `TORCH_NCCL_*` variables (for example for the watchdog and its debug dumps) are listed in
  the PyTorch documentation for your version.

> [!WARNING]
> Never ship `NCCL_IB_DISABLE=1`, `NCCL_P2P_DISABLE=1` or a forced `NCCL_ALGO`/`NCCL_PROTO` in a
> production image "because it fixed a hang once". They mask the real fault and can cost a large
> fraction of performance. Record such settings as temporary workarounds with an owner and an expiry.

## Common pitfalls

- **Prefix surprise in NCCL_IB_HCA.** Symptom: NCCL uses storage NICs `mlx5_10`/`mlx5_11`. Cause:
  `NCCL_IB_HCA=mlx5_1` prefix-matches them. Fix: use `=` for exact matching or list `dev:port`.
- **Wrong GID index.** Symptom: connections fail or traffic goes out as RoCEv1 or over the wrong
  IP. Cause: index copied from another image or host with a different GID table. Fix: check
  `show_gids` on the target system; prefer automatic selection where your NCCL version supports it.
- **TC set as DSCP.** Symptom: NCCL traffic lands in the wrong queue. Cause: `NCCL_IB_TC=26`
  instead of 104. Fix: multiply DSCP by four.
- **Variables not reaching all ranks.** Symptom: some ranks use different NICs or settings; hangs or
  uneven performance. Cause: launcher not forwarding environment. Fix: forward explicitly; verify
  with `NCCL_DEBUG_SUBSYS=ENV` on every node.
- **Raising timeouts to hide faults.** Symptom: jobs hang for many seconds before failing. Cause:
  very high `NCCL_IB_TIMEOUT` and retry counts mask flapping links. Fix: find and fix the link or
  congestion issue; keep timeouts reasonable.
- **Tiny /dev/shm in containers.** Symptom: errors mentioning shared memory or bus errors during
  init. Cause: Docker's default 64 MB `/dev/shm`. Fix: `--shm-size` or `--ipc=host`.

## Key takeaways

- Set as few NCCL variables as possible, each mapped to a fabric design decision, and verify with
  `NCCL_DEBUG_SUBSYS=ENV`.
- `NCCL_SOCKET_IFNAME` and `NCCL_IB_HCA` use prefix matching; `=` means exact, `^` excludes.
- On RoCE, use a RoCEv2 GID (`NCCL_IB_GID_INDEX`) and set `NCCL_IB_TC` to DSCP × 4 so NCCL lands in
  the lossless, ECN-enabled class; on IB, `NCCL_IB_SL` selects the SL.
- `NCCL_CROSS_NIC=0` keeps rings rail-aligned; `NCCL_IB_QPS_PER_CONNECTION` adds ECMP entropy.
- `NCCL_IB_DISABLE`, `NCCL_P2P_DISABLE`, `NCCL_ALGO` and `NCCL_PROTO` are diagnostic tools.
- PyTorch error handling uses `TORCH_NCCL_ASYNC_ERROR_HANDLING` and the process-group timeout, not
  NCCL variables.
