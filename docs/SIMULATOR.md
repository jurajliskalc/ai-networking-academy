# Fabric Simulator

The Fabric Simulator is a deterministic, in-browser model of a small rail-optimized RoCEv2 GPU cluster.
It exists so that learners can practise **reading real tool output and reasoning from evidence** without
owning a GPU cluster. Code: `frontend/src/sim/` (`fabric.ts` model, `shell.ts` commands, `lab.ts` grading).

> It is a teaching model, not an emulator. It reproduces *which* counters move, *which* tests fail and
> *roughly how much* bandwidth is lost for each fault class. Absolute numbers, counter magnitudes and
> exact output formats of real products differ by hardware generation, firmware and software version.

## The cluster

| Item | Model |
|---|---|
| Nodes | `node01`-`node04`, 8 H100-class GPUs each (32 ranks) |
| NICs | 8 per node, `mlx5_0`-`mlx5_7`, 400G RoCEv2, PCIe Gen5 x16, one per GPU (`PIX` in `nvidia-smi topo -m`) |
| Netdevs | `enp24s0np0`, `enp41s0np0`, `enp82s0np0`, `enp99s0np0`, `enp154s0np0`, `enp170s0np0`, `enp204s0np0`, `enp220s0np0` |
| Rail leaves | `leaf01`-`leaf08`; rail *r* (`mlx5_r`) of node *n* lands on `leaf0(r+1)` port `swp<n>` |
| Spines | `spine01`, `spine02`; every leaf has `swp31` → spine01 and `swp32` → spine02 |
| Addressing | routed /31 per host link: host `10.<rail>.<node>.1`, leaf `10.<rail>.<node>.0` |
| QoS | RoCE on DSCP 26 → priority 3 (lossless, PFC + ECN), CNP on DSCP 48 → priority 6. `NCCL_IB_TC=106` |
| NCCL | `/etc/nccl.conf` on every node: `NCCL_SOCKET_IFNAME=eno1`, `NCCL_IB_HCA=mlx5`, `NCCL_IB_GID_INDEX=3`, `NCCL_IB_TC=106` |

The DSCP/priority choices follow a common NVIDIA convention; they are not a standard.

## How performance is computed

* **Point-to-point** (`ib_write_bw`, one RC QP, unloaded fabric): 391.8 Gb/s × the worst *non-load*
  factor on the path: high BER (×0.55), PCIe below line rate (PCIe GB/s × 0.9 / 400), RoCE path MTU
  below 4096 (×0.93 at 2048, ×0.82 at ≤1024). Lossless misconfigurations do **not** show here, because a
  single flow never congests the fabric. That is a deliberate teaching point.
* **Collective** (`all_reduce_perf`, 32 ranks): 46.5 GB/s of bus bandwidth per used rail, times the
  number of rails NCCL may use, times the worst factor on any (node, rail), including load-only factors:
  RoCE QoS off on the leaf (×0.3), NIC trusting PCP (×0.35), PFC not on priority 3 (×0.35), wrong
  `NCCL_IB_TC` (×0.35). The slowest rail paces the ring, as in reality.
* **Fatal conditions** fail the job with a realistic NCCL WARN: a dead link or a path MTU smaller than the
  RoCE packet (retry exceeded, `status=12`), a non-routable GID index (`ibv_modify_qp` timeout), a bad
  `NCCL_SOCKET_IFNAME` (bootstrap failure). `NCCL_IB_DISABLE=1`, or an `NCCL_IB_HCA` that matches no device, falls back to sockets over the 25GbE management NIC (~2.6 GB/s), as real NCCL does.
* **Counters** advance deterministically every time a test runs, according to the active faults: drops,
  `out_of_sequence`, `packet_seq_err`, pause frames, ECN marks and CNPs, symbol and CRC errors.

## Commands

GPU nodes: `ssh`, `ip`, `ibdev2netdev`, `ibv_devices`, `ibv_devinfo`, `show_gids`, `rdma link|statistic`,
`ethtool [-S|-m|-a]`, `mlnx_qos`, `lspci [-vv -s]`, `nvidia-smi topo -m`, `dmesg`, `mlxlink [-c]`, `ping`,
`ib_write_bw`, `all_reduce_perf` (directly or via `mpirun`), `cat`, `sed -i 's/…/…/'`, `sed -i '/…/d'`,
`echo … >> /etc/nccl.conf`, with pipes to `grep`, `head`, `tail`, `wc -l`, `sort`.

Switches (Cumulus Linux NVUE subset): `nv show interface [<swp> [counters]]`, `nv show qos roce`,
`nv set|unset interface <swp> link mtu|state`, `nv set|unset qos roce [mode lossless|lossy]`,
`nv config diff`, `nv config apply`. Changes are staged until applied, as in NVUE. The output shapes
are modelled on NVUE and may differ from any given release.

Lab actions for physical work: `replace-cable <switch> <port>`, `reseat-nic <node> <dev>`.

## Writing a simulator lab

`content/labs/sim/<id>.yaml`:

```yaml
id: sim-42-example
title: "Short, specific title"
level: 3                     # 1-4
estimated_minutes: 30
lessons: [pfc-priority-flow-control]   # lessons this lab practises
summary: One sentence for the lab list.
start: node01
ticket: |                    # Markdown: the incident as a user would report it
  **INC-0000 · Sev3 · ...**
faults:                      # applied to a healthy cluster, in order
  - { type: host_pfc, node: node03, rail: 5, prios: [4] }
hints: [ "...", "..." ]      # revealed one at a time; counted
diagnosis:                   # one correct option, every option explained
  prompt: What is the root cause?
  options: [ { id: a, text: ..., correct: true, explanation: ... }, ... ]
checks:                      # graded against the live simulator state
  - { description: "...", check: host_pfc_only, args: { node: node03, rail: 5, prio: 3 } }
  - { description: "...", check: allreduce_min_busbw, args: { value: 360 } }
solution: |                  # Markdown, shown after grading
  ...
fix:                         # "host: command" lines; the test suite replays them
  - "node03: mlnx_qos -i enp170s0np0 --pfc 0,0,0,1,0,0,0,0"
```

Fault types: `switch_port_mtu`, `switch_port_admin_down`, `cable_unplugged`, `bad_cable` (`ber`),
`switch_roce` (`mode: lossless|lossy|off`), `host_mtu`, `host_pfc` (`prios`), `host_trust`,
`nic_admin_down`, `pcie_downtrain` (`width`, `speed`), `nccl_conf` (`set: {KEY: value|null}`).
`node: all` applies a host fault to every node.

Checks: `allreduce_min_busbw`, `ib_write_bw_min`, `port_mtu_min`, `port_up`, `link_clean`, `host_mtu`,
`host_pfc_only`, `host_trust`, `nic_up`, `pcie_ok`, `switch_roce`, `no_pending`, `nccl_conf`,
`nccl_conf_absent`, `nccl_hca_all`.

`frontend/tests/sim-labs.test.ts` requires every lab to fail its checks before the fix and pass all of
them after replaying `fix`. A lab that does not pass this test cannot be merged.
