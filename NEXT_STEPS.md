# Next steps

Ordered by value. See IMPLEMENTATION_STATUS.md for what is done and how it was verified.

1. **Publish (when ready).** The repository `jurajliskalc/ai-networking-academy` exists, is private, and CI
   is green. To publish the site: `gh workflow enable pages.yml`, enable Pages (Settings → Pages → Source:
   GitHub Actions), run the workflow, then restore the Pages badge and the "Open the academy" link in
   README.md. A Pages site is public even while the repository stays private.
2. **Tier 0 labs: done.** All seven are verified (five on WSL2, the two RDMA labs on the hardware lab hosts in
   Ubuntu 24.04 containers). Still worthwhile: one run of all seven on a clean Ubuntu 24.04 VM with the
   generic kernel, outside containers.
3. **Run the Real HW labs on hardware.** Lab hosts exist: two ConnectX-5 VPI hosts back to back (ESXi VMs
   on Dell R640, PCI passthrough, Ubuntu 26.04, DOCA-OFED 3.4; `ssh r640-a` / `r640-b`). Done: every command
   form and sample output in the content checked against these hosts on the inbox and DOCA stacks
   (`docs/HARDWARE_VERIFICATION.md`), `setup-rdma-host.sh` and `aina-hw collect-all` run, parsers tested
   against real captures. hw-01 to hw-05 and hw-09 are run end to end and verified (see `labs/README.md`); port 2 of both
   cards now runs InfiniBand (`mlx5_1`, DOCA OpenSM via `start-sm.sh`), port 1 RoCE. Next: hw-06 needs a
   lossless switch and hw-07/hw-08 GPU nodes. The `hw-*` scripts and the toolkit are ShellCheck clean (0.11, no warnings), and every check now verifies the
   tools it needs on the other hosts too (`need_cmd_on`). Still open, all needing other hardware: 400G-specific
   strings (mlxlink Speed/FEC), optical-module `ethtool -m` lines; Tier 2 needs a Cumulus or SONiC switch,
   Tier 3 GPU nodes.
4. **Browser tests: widened.** 13 widgets are now driven (expectations from their exported math), plus the
   free-play Fabric Simulator page and `?run=` links, hardware-lab result import (the real ConnectX-5
   report, check result files, pasted output) and a 390 px phone viewport (every widget page included).
   Still open: drive the remaining widgets, and a phone pass over the mock exam and the progress page.
5. **Screen reader pass**: axe is clean, but walk the quiz, exam, a simulator lab and three widgets with
   NVDA (Windows) and VoiceOver (macOS/iOS); tune live-region chattiness on hover-driven widget readouts
   (ParallelismMap, QpStateMachine). (An axe check on every page kind already runs in `npm run e2e`.)
6. **More simulator scenarios**: done for ECN off with PFC on, PFC watchdog trips, cross-rail traffic
   over the spines and an InfiniBand variant (sim-14 to sim-18), low ECMP entropy with per-flow uplink
   hashing (sim-19), SM failover with master and standby SMs (sim-20) and a leaf cut off from the SM while
   a spine is down (sim-21); the sandbox page switches between RoCE and InfiniBand. Ideas left: adaptive
   routing or packet spraying on the RoCE fabric, an `ibnetdiscover` view, partition (P_Key) problems, and
   a browser test for the sandbox's fabric switch.
7. **InfiniBand hands-on alternative**: there is no software InfiniBand, so consider an `ibsim`-based
   lab for the diagnostic tools.
8. **Content depth**: storage-fabric labs (NVMe-oF over RDMA), more design reviews, and a "read this
   real capture" series once real captures (with permission) are available.
9. **Periodic refresh**: re-run the link check and review vendor-specific lessons (m07 Spectrum-X and
   UEC, m09 SuperPOD and NVL72) when new generations ship.
