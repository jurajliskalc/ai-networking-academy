# Next steps

Ordered by value. See IMPLEMENTATION_STATUS.md for what is done and how it was verified.

1. **Publish.** Create the GitHub repository `jurajliskalc/ai-networking-academy`, push `main`, enable
   Pages (Settings → Pages → Source: GitHub Actions), and confirm both workflows go green.
2. **Run the hands-on labs end to end** on a clean Ubuntu 24.04 VM (4 vCPU, 8 GB). Fix whatever breaks
   (the riskiest parts are the FRR image tag, containerlab privileges and Soft-RoCE behaviour per kernel),
   then flip `verified: true` per lab and record the kernel/containerlab/FRR versions in `labs/README.md`.
3. **Browser interaction tests** (Playwright): quiz flow, exam timer and submit, a simulator lab solved
   through the UI, progress export/import.
4. **More simulator scenarios**: ECN disabled with PFC on (pause storms), PFC watchdog trips, a
   cross-rail traffic case that uses the spines, InfiniBand mode (`ibstat`, `perfquery`, SM issues).
5. **InfiniBand hands-on alternative**: there is no software InfiniBand, so consider an `ibsim`-based
   lab for the diagnostic tools.
6. **Content depth**: storage-fabric labs (NVMe-oF over RDMA), more design reviews, and a "read this
   real capture" series once real captures (with permission) are available.
7. **Periodic refresh**: re-run the link check and review vendor-specific lessons (m07 Spectrum-X and
   UEC, m09 SuperPOD and NVL72) when new generations ship.
