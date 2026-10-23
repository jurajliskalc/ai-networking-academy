# Next steps

Ordered by value. See IMPLEMENTATION_STATUS.md for what is done and how it was verified.

1. **Publish (when ready).** The repository `jurajliskalc/ai-networking-academy` exists, is private, and CI
   is green. To publish the site: `gh workflow enable pages.yml`, enable Pages (Settings → Pages → Source:
   GitHub Actions), run the workflow, then restore the Pages badge and the "Open the academy" link in
   README.md. A Pages site is public even while the repository stays private.
2. **Finish the Tier 0 lab runs.** Five labs were run end to end and verified on Ubuntu 24.04 under WSL2
   (see `labs/README.md`, Verification record). Still open: `hol-soft-roce-perftest` and the real two-VM
   capture of `hol-rocev2-wireshark` need a VM with Ubuntu's generic kernel (`rdma_rxe`); WSL2 lacks it, the R640 lab hosts (item 3) have it.
   Ideally also repeat the five verified labs once on a clean Ubuntu 24.04 VM (generic kernel).
3. **Run the Real HW labs on hardware.** Lab hosts exist: two ConnectX-5 VPI hosts back to back (ESXi VMs
   on Dell R640, PCI passthrough, Ubuntu 26.04, DOCA-OFED 3.4; `ssh r640-a` / `r640-b`). Done: every command
   form and sample output in the content checked against these hosts on the inbox and DOCA stacks
   (`docs/HARDWARE_VERIFICATION.md`), `setup-rdma-host.sh` and `aina-hw collect-all` run, parsers tested
   against real captures. Next: run each `hw-*` check (hw-01 to hw-05 on this pair), flip `verified: true`
   per lab and record versions. Then switch the ConnectX-5 ports to InfiniBand (`mlxconfig LINK_TYPE_P1/2=1`)
   to verify the IB-mode output (ibstat on IB, sminfo, iblinkinfo, perfquery, opensm, ibnetdiscover) and
   hw-09: this needs Secure Boot off in both VMs, because kernel lockdown blocks MFT's NV-config access.
   Still open: ShellCheck on `labs/hw-*`; checks verify tools only on host A; 400G-specific strings
   (mlxlink Speed/FEC), optical-module `ethtool -m` lines; Tier 2 needs a Cumulus or SONiC switch, Tier 3
   GPU nodes.
4. **Widen the browser tests** (`frontend/e2e/`, Playwright; the core flows are covered): every widget page
   already renders in a test; drive the interactions of more widgets (only the MTU checker and number-field
   editing are driven), the free-play Fabric Simulator page and `?run=` links, the hardware-lab result
   import, and a phone-width viewport.
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
