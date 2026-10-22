# Next steps

Ordered by value. See IMPLEMENTATION_STATUS.md for what is done and how it was verified.

1. **Publish.** Create the GitHub repository `jurajliskalc/ai-networking-academy`, push `main`, enable
   Pages (Settings → Pages → Source: GitHub Actions), and confirm both workflows go green.
2. **Finish the Tier 0 lab runs.** Five labs were run end to end and verified on Ubuntu 24.04 under WSL2
   (see `labs/README.md`, Verification record). Still open: `hol-soft-roce-perftest` and the real two-VM
   capture of `hol-rocev2-wireshark` need a VM with Ubuntu's generic kernel (`rdma_rxe`); WSL2 lacks it.
   Ideally also repeat the five verified labs once on a clean Ubuntu 24.04 VM (generic kernel).
3. **Run the Real HW labs on hardware**, Tier 1 first (two ConnectX hosts back to back): `setup-rdma-host.sh`,
   `aina-hw collect-all` against real NICs (check the `mlnx_qos`/`dcb`/`rdma -j` parsers against real
   output and extend the tests with those captures), then each `hw-*` check. Flip `verified: true` per lab
   and record NIC, firmware, driver stack and switch OS versions. Tier 2 needs a Cumulus or SONiC switch,
   Tier 3 GPU nodes. Known gaps to close while doing so: run ShellCheck on `labs/hw-*` (not available
   locally); checks verify tools only on host A, so a missing `ib_write_bw` on B/C shows up as a test
   failure rather than a clear missing-tool FAIL; confirm `ethtool -m` works unprivileged on older
   ethtool (hw-05) and that `show_gids`/`nv show interface <port> qos roce counters` exist on the
   versions used.
4. **Widen the browser tests** (`frontend/e2e/`, Playwright; the core flows are covered): drive more
   widgets than the MTU checker, the free-play Fabric Simulator page and `?run=` links, the hardware-lab
   result import, and a phone-width viewport. Confirm the e2e CI step goes green on the first push.
5. **Screen reader pass**: axe is clean, but walk the quiz, exam, a simulator lab and three widgets with
   NVDA (Windows) and VoiceOver (macOS/iOS); tune live-region chattiness on hover-driven widget readouts
   (ParallelismMap, QpStateMachine). (An axe check on every page kind already runs in `npm run e2e`.)
6. **More simulator scenarios**: done for ECN off with PFC on, PFC watchdog trips, cross-rail traffic
   over the spines and an InfiniBand variant (sim-14 to sim-18). Still open: ECMP polarization / low
   UDP source-port entropy (needs per-flow uplink hashing in the model), an IB-variant toggle in the
   sandbox page, and more IB labs (SM failover, a down spine leaving leaves unreachable).
7. **InfiniBand hands-on alternative**: there is no software InfiniBand, so consider an `ibsim`-based
   lab for the diagnostic tools.
8. **Content depth**: storage-fabric labs (NVMe-oF over RDMA), more design reviews, and a "read this
   real capture" series once real captures (with permission) are available.
9. **Periodic refresh**: re-run the link check and review vendor-specific lessons (m07 Spectrum-X and
   UEC, m09 SuperPOD and NVL72) when new generations ship.
