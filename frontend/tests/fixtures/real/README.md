# Real captures for the golden-format tests

Raw output of host tools on real hardware, one command per file, used by `tests/sim-golden.test.ts` to check
that the Fabric Simulator prints the same line skeleton (see docs/SIMULATOR.md, "Golden-format tests").

Hardware: 2x Dell R640, ESXi VMs with the adapters in PCI passthrough, ConnectX-5 MCX556A-ECAT (VPI) cabled back
to back with a 1 m DAC; port 1 Ethernet (100GbE, RoCEv2), port 2 InfiniBand (4X EDR). Firmware 16.29.1016 (host A,
where every capture was taken) and 16.34.1002 (host B). Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic.
Captured 2026-10-23.

| Directory | Stack | Device |
|---|---|---|
| `doca-roce/` | NVIDIA DOCA-OFED 3.4.0 (rdma-core 2604.0.7, perftest 26.04.16, mlnx-tools 2604.0.13, MFT 4.37) | `mlx5_0`, netdev `ens64f0np0` |
| `inbox-roce/` | Ubuntu inbox: kernel `mlx5_core`, rdma-core 61.0, perftest 25.01.0, iproute2 6.19, ethtool 6.19 | `rocep3s0f0` |
| `doca-ib-sm/` | DOCA-OFED 3.4.0, infiniband-diags 2604.0.7, OpenSM (DOCA) running on host A | `mlx5_1` (IB port) |
| `doca-ib-nosm/` | as above, no subnet manager running (ports INIT, LID 65535) | `mlx5_1` |

File format: `### cmd:` is the command line as the capture script ran it (`$D`, `$N` and `$B` stand for the RDMA
device, the netdev and the peer's address; `srv "..."` started the perftest server on host B first), `### ----`
starts the output, `### rc=` is the exit status of the whole command line. Only the capture script's `### host:`
line was removed. Where the command line ended in `; echo rc=$?` or a second command, a `### note:` line says that
those lines were removed; the tool's own output is unchanged. The `mlxlink` files are the first two runs of a
separate `mlxlink -d /dev/fwctl/fwctl0` capture (the `-m` run, which lists the cable serial number, is not included).

The values (GUIDs, MACs, IPs, counters, rates) are those of this lab and this run; the tests mask them and compare
only the format. No adapter or cable serial numbers are included: keep it that way when adding captures.
