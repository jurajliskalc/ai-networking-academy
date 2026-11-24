# Changelog

Notable changes to AI Networking Academy. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
Lesson, quiz, lab and widget IDs are a compatibility promise: learner progress is keyed by them, so
renaming or removing one is a breaking change.

## [Unreleased]

### Changed
- Figures are drawn by the academy's own compiler and renderer in place of Mermaid: laid out at build time
  (ELK, orthogonal routing), drawn in the colour scheme, with motion where a figure shows a flow and
  step-by-step playback for sequence diagrams. The content of the 84 figures is unchanged.
- The "Interview angle" callouts are removed from the lessons.
- The five-minute tour is a highlights page in pictures; every reference is labelled by kind of source.

### Fixed
- With the OS "reduce motion" setting on, every flowchart was drawn collapsed and unreadable.

## [1.0.0] - 2026-11-24

First public release. Full notes: [docs/releases/v1.0.0.md](docs/releases/v1.0.0.md).

### Curriculum
- 76 lessons in 13 modules (Beginner to Master), 568 quiz questions, 3 timed mock exams (156 questions).
- 45 interactive visualizations, 165 annotated commands, a 241-term glossary with spaced-repetition
  flashcards, site-wide search, progress tracking that stays in the browser.
- 312 references to 186 distinct documents, each labelled by kind of source.

### Fabric Simulator
- A deterministic in-browser model of a 32-GPU rail-optimized RoCE cluster, with an InfiniBand variant
  and a shell that speaks real tool syntax.
- 22 simulator labs with injected faults, graded on the state of the fabric; every lab is replayed by the
  test suite.

### Hands-on and hardware labs
- 22 hands-on labs in four tiers (one VM, two RDMA hosts, a lossless switch, GPU nodes), each graded by a
  `check.sh` that declares the measurements it requires.
- `aina-hw` toolkit: inventory over SSH, resumable lab checks, a read-only local agent, live port counters
  and a fabric health review.

### Verification
- Host commands and output compared with two ConnectX-5 hosts: RoCE on the inbox RDMA stack and on
  NVIDIA DOCA-OFED, InfiniBand on DOCA-OFED. Recorded in `docs/HARDWARE_VERIFICATION.md`.
- 19 of the 22 hands-on labs run end to end and marked verified.
- CI: content validation, unit tests, browser tests with accessibility checks, shell syntax checks and
  toolkit tests. A test keeps every count in the docs equal to the source tree.

### Known limitations
- `hw-06`, `hw-07` and `hw-08` need a lossless switch or GPU nodes and are not verified.
- Switch CLIs, switched-fabric behaviour, 400G and optical-module output and GPU/NCCL output are
  source-backed and labelled illustrative, not verified on hardware.
- The simulator is a teaching model, not a performance predictor.

[1.0.0]: https://github.com/jurajliskalc/ai-networking-academy/releases/tag/v1.0.0
