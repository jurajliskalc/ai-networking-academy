<div align="center">

# AI Networking Academy

**From noob to master in AI cluster networking.**
RDMA · InfiniBand · RoCEv2 · lossless Ethernet · NCCL · rail-optimized fabrics · troubleshooting

[![CI](https://github.com/jurajliskalc/ai-networking-academy/actions/workflows/ci.yml/badge.svg)](https://github.com/jurajliskalc/ai-networking-academy/actions/workflows/ci.yml)
[![Pages](https://github.com/jurajliskalc/ai-networking-academy/actions/workflows/pages.yml/badge.svg)](https://jurajliskalc.github.io/ai-networking-academy/)
![Lessons](https://img.shields.io/badge/lessons-70-4ade80)
![Questions](https://img.shields.io/badge/questions-660-22d3ee)
![Labs](https://img.shields.io/badge/labs-21-fbbf24)
![License](https://img.shields.io/badge/code-MIT-blue) ![License](https://img.shields.io/badge/content-CC%20BY--SA%204.0-lightgrey)

**[▶ Open the academy](https://jurajliskalc.github.io/ai-networking-academy/)** · runs entirely in your browser, no account, no backend

<img src="docs/screenshots/dashboard.png" alt="Dashboard" width="900" />

</div>

## Why this exists

Training a frontier model is a distributed systems problem in which the network decides how fast
thousands of GPUs can work together. One mis-set PFC priority, a marginal optic or a stale NCCL variable
can cost a third of a cluster's throughput while every dashboard stays green.

The knowledge needed to prevent that is scattered across IEEE standards, InfiniBand specifications,
vendor manuals, SIGCOMM papers and tribal knowledge. This academy puts it in one place as a structured,
hands-on curriculum. It starts at "what is an Ethernet frame" and ends at designing and debugging a
1,024-GPU fabric.

## What's inside

| | |
|---|---|
| **70 lessons** in 13 modules, ~165,000 words | Four levels: Noob → Practitioner → Engineer → Master. Every lesson follows the same structure: *Why this matters → Concepts → How it works → In practice → Common pitfalls → Key takeaways*. Lessons include callouts for network engineers (ANALOGY) and interview prep (INTERVIEW). |
| **520 quiz questions** | Each lesson ends with a quiz, mostly scenario questions ("given these counters, what is wrong?"). **Every option is explained**, including the wrong ones. |
| **14 Fabric Simulator labs** | Break/fix incident tickets in a browser-simulated 32-GPU rail-optimized RoCE cluster. You investigate with real tool syntax (`ethtool -S`, `mlnx_qos`, `show_gids`, `ib_write_bw`, `all_reduce_perf`, NVUE), commit a diagnosis, apply a fix, and the lab grades the fabric state. |
| **7 hands-on Linux labs** | Real work on your own VM: Soft-RoCE and perftest, RoCEv2 packet captures, a containerlab BGP-unnumbered Clos, ECMP entropy, ECN/DCTCP congestion, EVPN-VXLAN. Each lab has a `check.sh`. |
| **9 interactive visualizations** | RoCEv2 packet anatomy, ring vs tree all-reduce, PFC/ECN/DCQCN queue dynamics, ECMP collisions vs adaptive routing, fabric sizer, QP state machine, PCIe topology explorer, parallelism-to-network map, IB credits vs PFC. |
| **3 timed mock exams** (140 questions) | Fundamentals, engineer and master level, scored by domain. Original practice material, not real certification questions. |
| **Reference** | 155 annotated commands (Linux, rdma-core, perftest, InfiniBand, NVIDIA tools, NCCL, Cumulus NVUE, SONiC) and a 213-term glossary that also drives **SM-2 spaced-repetition flashcards**. |
| **Progress tracking** | A lesson counts as mastered only when it is read *and* its quiz is passed. Streaks, an activity heatmap, weak-spot review, and exam domain profiles. Everything stays in your browser, with export and import. |

### The curriculum

| # | Module | Level |
|---|---|---|
| 0 | Networking foundations for AI engineers | Noob |
| 1 | Why AI needs a different network | Noob |
| 2 | Inside the GPU server: PCIe, NUMA, NICs/DPUs, GPUDirect, NVLink | Practitioner |
| 3 | Data center fabric fundamentals: Clos, ECMP, BGP, EVPN-VXLAN | Practitioner |
| 4 | RDMA fundamentals: verbs, QPs, transports, perftest | Practitioner |
| 5 | InfiniBand: SM, routing, credits and VLs, SHARP, diagnostics | Engineer |
| 6 | RoCEv2 and lossless Ethernet: PFC, headroom, ECN/DCQCN, QoS, storms | Engineer |
| 7 | Load balancing and congestion: entropy, adaptive routing, Spectrum-X, Ultra Ethernet | Engineer |
| 8 | Collective communication and NCCL | Engineer |
| 9 | AI cluster design: rail-optimized topologies, SuperPOD, sizing, optics, NVL72 | Master |
| 10 | Operations: telemetry, gNMI, burn-in, automation, UFM/NetQ | Master |
| 11 | Troubleshooting mastery: methodology, BER/FEC, lossless misconfigs, stragglers, case studies | Master |
| 12 | Capstone (a 1,024-GPU fabric design), interview prep, exam strategy | Master |

The full lesson map is in [docs/CURRICULUM_PLAN.md](docs/CURRICULUM_PLAN.md).

## The Fabric Simulator

<img src="docs/screenshots/simulator.png" alt="Fabric Simulator running nccl-tests and NVUE" width="900" />

A deterministic model of 4 nodes × 8 GPUs, 8 × 400G RoCE NICs per node, 8 rail leaves and 2 spines. It
reproduces the symptoms that real faults produce: which counters move, which tests fail and roughly how
much bandwidth is lost. One example is a PFC priority mismatch, where `ib_write_bw` runs at line rate
while the collective runs at a third of normal speed. Faults include MTU black holes, PFC and trust
misconfigurations, lost switch QoS, marginal optics, PCIe downtraining, GID index errors and NCCL
configuration drift.

Every lab is checked by the test suite: it must fail its checks before the documented fix and pass all
of them after the fix is replayed. The model and its limits are documented in
[docs/SIMULATOR.md](docs/SIMULATOR.md).

<table><tr>
<td><img src="docs/screenshots/lesson.png" alt="Lesson in dark mode" /></td>
<td><img src="docs/screenshots/lab.png" alt="P1 incident lab" /></td>
</tr><tr>
<td><img src="docs/screenshots/ecmp.png" alt="ECMP collision visualization" /></td>
<td><img src="docs/screenshots/sizer.png" alt="Fabric sizer" /></td>
</tr></table>

## Run it locally

**Windows:** double-click **`start-academy.bat`**. On first run it fetches a portable, checksum-verified
Node.js into `.tools/`, builds the site, and opens http://127.0.0.1:8740. Nothing is installed system-wide.

**Linux / macOS** (Node.js 20+):

```bash
./scripts/start.sh            # build if needed, serve on http://127.0.0.1:8740
```

**Development:**

```bash
cd frontend
npm ci
npm run dev        # hot reload
npm run validate   # content rules: IDs, structure, quiz rules, cross-references, tables
npm test           # unit tests + every simulator lab replayed
npm run build      # type check + production build into frontend/dist
```

The hands-on labs need an Ubuntu 24.04 VM; see [labs/README.md](labs/README.md).

## How it is built

A static single-page app (React 19, TypeScript, Vite, Tailwind CSS v4) with no backend. All learning
content is plain Markdown and YAML under [`content/`](content), validated and compiled to JSON at build
time. GitHub Actions validates, tests and builds every push, and deploys `main` to GitHub Pages. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
content/      lessons, quizzes, labs, exams, commands, glossary (Markdown + YAML)
frontend/     React app, content compiler, Fabric Simulator, tests
labs/         files for the hands-on labs (containerlab topologies, FRR configs, check.sh)
docs/         architecture, authoring guide, simulator, curriculum plan
```

## Accuracy policy

Content is written for engineers who will act on it, so accuracy comes first:

* No invented CLI flags, counters, environment variables or APIs.
* Vendor- and generation-specific facts are hedged and point to the authoritative documentation.
* Sample command output is labelled illustrative unless it is a real capture.
* Every lesson, quiz and exam was reviewed twice after it was written: once by expert read-through and once by a source-based fact-check of about 2,400 claims, plus a blind re-answering of all 674 questions with shuffled options. The hands-on labs are
  syntax-checked (`bash -n`, ShellCheck) but are marked `verified: false` until they have been run end to
  end on a reference VM.

Found an error? Please [open an issue](https://github.com/jurajliskalc/ai-networking-academy/issues/new?template=content-error.md)
with a source. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Code: MIT. Learning content: CC BY-SA 4.0. See [LICENSE](LICENSE). This is an independent, unofficial
study resource. Product names belong to their owners, and nothing here is endorsed by any vendor or
certification body.
