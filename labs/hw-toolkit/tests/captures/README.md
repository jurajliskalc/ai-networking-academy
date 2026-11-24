# Real-hardware captures

Raw command output (stdout and stderr) captured on real lab hosts. The only edit: the adapter's GUID bytes are
replaced with placeholders (`...:0000:11ee`), as in every capture in this repository. `test_aina_hw.py`
(`RealCaptures`) runs the parsers against these files so they cannot drift from what the tools print.

| Directory | Hosts | Stack |
|---|---|---|
| `cx5-ubuntu2604-inbox/` | 2x ConnectX-5 MCX556A-ECAT (fw 16.29.1016 / 16.34.1002), back to back, 100GbE DAC; ESXi VMs with PCI passthrough | Ubuntu 26.04.1 LTS, kernel 7.0.0-38-generic, inbox `mlx5_core`, rdma-core 61.0, iproute2 6.19, ethtool 6.19 |

Captured 2026-10-23. Counters and rates are from that run; only the format matters to the tests. No adapter or
cable serial numbers are included: keep it that way when adding captures.
