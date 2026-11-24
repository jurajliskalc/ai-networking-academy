# Roadmap

Open work, ordered by value within each group. What exists today and how it was verified is in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); released changes are in [CHANGELOG.md](CHANGELOG.md).

Nothing here is promised by a date. Items that need hardware stay open until someone runs them on that
hardware: a lab is not marked `verified: true` on the strength of a review.

## Hardware verification still open

| Item | Needs | State today |
|---|---|---|
| `hw-06-switch-lossless-incast` (incast, PFC and ECN on switch counters) | A lossless Ethernet switch (Cumulus Linux or SONiC) and a third host | Written, `bash -n` and ShellCheck clean, `verified: false` |
| `hw-07-gpudirect-numa`, `hw-08-nccl-two-nodes` | GPU nodes with RDMA NICs | Written, `verified: false` |
| Switched-fabric output: InfiniBand switch LIDs and routing, PFC and ECN at a switch, NVUE and SONiC CLIs | A switch | Follows tool sources and vendor documentation, labelled illustrative |
| 400G-specific strings (`mlxlink` speed and FEC), optical-module `ethtool -m` lines | 400G adapters, optical modules | Illustrative; the reference hardware is 100GbE / EDR over passive DAC |
| GPU and NCCL output (`nvidia-smi`, `all_reduce_perf`, NCCL log lines) | GPU nodes | Follows the NCCL and nccl-tests sources |
| Inbox-stack end-to-end lab runs | The existing ConnectX-5 hosts | Labs were run end to end on DOCA-OFED; the inbox paths (`dcb` instead of `mlnx_qos`) were exercised command by command. IPoIB and UCX were not run on the inbox stack |
| Tier 0 labs on a clean Ubuntu 24.04 VM with the generic kernel | One VM | Verified on WSL2 (five labs) and in Ubuntu 24.04 containers on the hardware hosts (the two Soft-RoCE labs) |

## Labs and toolkit

- Port the seven Tier 0 checks to `lib.sh` (`require` / `met`), so they are graded on required
  measurements like the hardware labs instead of by the functional rule alone.
- An `ibsim`-based lab for the InfiniBand diagnostic tools, for learners without two IB-capable adapters.
- Live Lab over `--live-remote` through a jump host.
- Run `start-academy.bat` on a clean Windows machine (the build path it calls is exercised daily; the
  launcher itself has not been tried on a machine without the toolchain).

## Fabric Simulator

- Adaptive routing or packet spraying on the RoCE fabric.
- An `ibnetdiscover` view and P_Key partition faults on the InfiniBand fabric.
- A browser test for the sandbox's RoCE / InfiniBand switch.

## Testing and accessibility

- Browser tests open every widget page but drive the controls of 14; drive the rest.
- A phone-viewport pass over the mock exam and the progress page.
- A screen-reader pass with NVDA and VoiceOver over the quiz, an exam, a simulator lab and three widgets.
  axe is clean on every page kind in CI, but no screen reader has been used on the app yet. Tune how much
  the hover-driven widget readouts (parallelism map, QP state machine) announce.

## Content

- Storage-fabric labs (NVMe-oF over RDMA) and more design reviews.
- A "read this real capture" series, once more captures can be published.
- Periodic refresh: re-run the link check, and review the vendor-specific lessons (Spectrum-X and Ultra
  Ethernet in module 7, SuperPOD and NVL72 in module 9) when new generations ship.
