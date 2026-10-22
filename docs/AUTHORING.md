# Authoring guide

All learning content lives in `content/` as Markdown and YAML. `npm run validate` (in `frontend/`)
checks every file against the rules below; `npm run build` compiles it into JSON for the web app.
IDs are permanent: progress is keyed by them (see [CURRICULUM_PLAN.md](CURRICULUM_PLAN.md)).

## Accuracy rules (non-negotiable)

1. **Technical accuracy first.** The reader is, or wants to become, an engineer who runs AI fabrics.
   Never invent CLI flags, counters, environment variables, sysfs paths or API names. If you are not
   sure an exact syntax exists, describe the concept and say which documentation to check instead.
2. **Hedge what is vendor-, version- or generation-specific.** Write "on ConnectX-7 (check your
   firmware release notes)" rather than presenting one product's default as universal truth.
3. **Sample output is illustrative.** Label command output blocks as illustrative unless they are
   real captures. Never show made-up output as if it were authoritative.
4. **No fake exam questions.** Mock exams and quizzes are original practice material. Never claim
   that a question comes from a real certification exam.
5. **Numbers need context.** For any number (latency, bandwidth, buffer size, port count) say which
   generation or condition it applies to, or present it as an order of magnitude.

## Lessons: `content/modules/<module>/lessons/<lesson-id>.md`

```markdown
---
id: pfc-priority-flow-control          # equals the file name
title: Priority Flow Control (PFC): pausing one class, not the link
module: m06-rocev2-lossless            # must match the directory
level: 3                               # 1 beginner, 2 practitioner, 3 engineer, 4 master
estimated_minutes: 45
objectives:                            # 3-5 measurable outcomes
  - Explain how an 802.1Qbb PAUSE frame stops one priority on one link.
prerequisites: [rocev2-encapsulation]  # lesson IDs (any module); may be empty
quiz: quiz-pfc-priority-flow-control   # always quiz-<id>
widgets: [pfc-ecn-sim]                 # optional, IDs from CURRICULUM_PLAN.md
labs: []                               # optional lab IDs (filled in by the lab author)
tags: [pfc, lossless, 802.1qbb]
further_reading:                       # 2-5 authoritative links (standards, vendor docs, papers)
  - title: IEEE 802.1Qbb Priority-based Flow Control
    url: https://1.ieee802.org/dcb/802-1qbb/
---
```

The body is GitHub-flavoured Markdown with these sections, in this order:

| Section | Content |
|---|---|
| `## Why this matters` | 1-2 short paragraphs: the real-world problem, and what breaks in an AI cluster without this knowledge. |
| `## Concepts` | The core model, built from first principles. Tables and diagrams welcome. |
| `## How it works` | The mechanism in depth: packet formats, state machines, algorithms, timing. Use `###` subsections. |
| `## In practice` | Commands, configuration and (illustrative) output, annotated line by line where useful. |
| `## Common pitfalls` | A bullet list of mistakes and misreadings, each with symptom → cause → fix. |
| `## Key takeaways` | 4-7 bullets a learner should be able to recite. |

Length: roughly 1,800-3,500 words. Level 1 lessons explain everything; Level 4 lessons may assume the
prerequisites but must still be self-contained enough to follow.

### Callouts

```markdown
> [!NOTE]
> Extra detail.

> [!TIP]
> A practical shortcut.

> [!WARNING]
> Something that causes outages or wrong conclusions.

> [!ANALOGY]
> A comparison to classic enterprise/service-provider networking, including where it breaks down.

> [!INTERVIEW]
> A question an interviewer could ask about this topic, and the shape of a strong answer.
```

### Diagrams and widgets

- Mermaid diagrams: a fenced block with language `mermaid`. Keep them small (≤ 15 nodes) and quote
  labels that contain punctuation: `A["Leaf 1 (rail 0)"]`.
- Embed an interactive widget with a fenced block with language `widget` containing only its ID:

  ````markdown
  ```widget
  pfc-ecn-sim
  ```
  ````
- ASCII diagrams in a plain fenced block are fine for packet layouts.
- Diagrams get an accessible name generated from their labels; for a better one add a line
  `accTitle: <one-line description>` right after the diagram type (`flowchart LR`).
- Section headings become search results and deep-link anchors (`?s=<slug>`): keep them descriptive and
  unique within a lesson.

## Quizzes: `content/modules/<module>/quizzes/quiz-<lesson-id>.yaml`

```yaml
id: quiz-pfc-priority-flow-control
title: "Knowledge check: Priority Flow Control"
lesson: pfc-priority-flow-control
pass_pct: 70
questions:                      # 6-8 questions
  - id: q1                      # q1..qN, unique in the file
    type: single                # single | multi | scenario (scenario = single answer, longer prompt)
    prompt: Which field of a PFC frame tells the receiver how long to pause a priority?
    options:                    # 3-5 options; EVERY option has an explanation
      - id: a
        text: One of the eight per-priority time fields (in quanta of 512 bit times).
        correct: true
        explanation: Each priority has its own timer; the class-enable vector says which are valid.
      - id: b
        text: The DSCP field of the IP header.
        explanation: PFC is a MAC control frame; it has no IP header.
    explanation: Optional overall explanation shown after answering.
    tags: [pfc]
```

Rules: `single`/`scenario` have exactly one correct option, `multi` has at least two. Prefer
scenario questions that test reasoning ("given these counters, what is wrong?") over trivia. At
least two questions per quiz should be `scenario` type from Level 2 on. Options should be plausible
and of similar length; avoid "all of the above". The validator rejects a single-answer question whose
correct option is more than 1.25x the length of the longest distractor: give distractors the same
specificity (a plausible but wrong mechanism) instead of padding the right answer. This also applies
to exam questions and simulator-lab diagnosis questions.

## Mock exams: `content/exams/<exam-id>.yaml`

Same question schema as quizzes plus a `domain` key on each question, and:

```yaml
id: exam-ai-fabric-1
title: "Mock assessment 1: AI fabric engineer"
description: Original practice material, not questions from any real certification.
duration_minutes: 90
pass_pct: 70
domains:                       # IDs used by the questions' `domain` key
  - { id: rdma, title: RDMA and InfiniBand }
questions: [...]
```

## Command reference: `content/commands/<category>.yaml`

```yaml
id: rdma
title: RDMA and rdma-core
description: One sentence.
commands:
  - cmd: ibv_devinfo -v
    platform: linux            # linux | rdma | infiniband | cumulus | sonic | nccl | nvidia | tc
    summary: Show RDMA devices, ports, state, MTU, link layer and capabilities.
    example: |                 # optional; illustrative output, trimmed
      hca_id: mlx5_0
              port:   1
                      state:          PORT_ACTIVE (4)
    notes: What to look at in the output. Optional.
    tags: [rdma, verify]
```

## Glossary: `content/glossary.yaml`

```yaml
terms:
  - term: QP
    expansion: Queue Pair
    definition: The RDMA communication endpoint: a send queue and a receive queue ...
    lesson: verbs-qps-mrs        # optional lesson ID
```

Glossary terms also become flashcards.

## Hands-on labs: `content/labs/handson/<lab-id>.md`

Real exercises on the learner's own machines, shown in the app's **Real HW labs** section. Files the lab
needs (containerlab topologies, scripts) live in `labs/<lab-id>/`, and every lab ships a `check.sh` that
prints `PASS`/`FAIL`/`WARN`/`SKIP` lines (`aina-hw check <id>` turns them into an importable result).

```markdown
---
id: hol-soft-roce-perftest
title: Soft-RoCE: your first RDMA connection without RDMA hardware
kind: handson
level: 2
estimated_minutes: 60
environment: linux-vm          # linux-vm | containerlab | hardware
tier: 0                        # 0 virtual, 1 two RDMA hosts, 2 lossless switch, 3 GPU nodes (content/hardware/hardware.yaml)
fabric: any                    # any | roce | ib
requires: [linux-vm]           # requirement IDs from hardware.yaml
summary: "One sentence for the lab card."
lessons: [rdma-on-linux, perftest-benchmarking]
files: labs/hol-soft-roce-perftest
verified: false                # true only after the lab was run end to end on a reference VM
---
## Goal ... ## Setup ... ## Tasks (### Task 1 ...) ## Verify ... ## Clean up ... ## What you learned
## Going further on real hardware
```

While `verified` is false the app shows a status banner on the lab. Scripts must pass `bash -n` (CI
enforces it) and should pass ShellCheck.

### Real hardware labs (tier 1-3)

Use `environment: hardware`, declare `changes_config: true|false`, and use these sections in order:
`## Goal`, `## Before you start`, `## Tasks` (`### Task N: ...`), `## Verify`, `## Restore`,
`## What you learned` (optional `## Going further`). The compiler enforces all of it.

- Write commands with **`{{NAME}}` placeholders** (SHELL_CASE names from `content/hardware/hardware.yaml`,
  for example `ib_write_bw -d {{A_RDMA_DEV}} -x {{GID_INDEX}} {{B_IP}}`). The app fills them from the
  learner's lab profile; unknown names fail validation. New variables need a default in `hardware.yaml`,
  `labs/hw-toolkit/lib.sh` and `lab.env.example` (a unit test keeps the three in sync).
- `check.sh` sources `../hw-toolkit/lib.sh`, calls `aina_load_env`, runs on host A and reaches B/C with
  `on_host`/`start_server`. Read-only unless the lab changes settings; then ship save/restore scripts that
  keep state under `aina_state_dir <lab>`. Wrap remote servers in `timeout` and use your own 186xx ports.
- Guides live in `content/hardware/guides/<id>.md` (front matter: `id`, `title`, `order`, `summary`) and
  may use the same placeholders.

## Simulator labs

`content/labs/sim/<lab-id>.yaml` defines a break/fix ticket in the browser Fabric Simulator. The
schema is documented in [SIMULATOR.md](SIMULATOR.md).
