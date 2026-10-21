# Implementation status

As of 2026-10-22. "Verified" means checked by an automated test or by running it; everything else is
stated as what it is.

## Platform

| Area | Status | Evidence |
|---|---|---|
| Content compiler and validator | Done | `npm run validate` prints `Content OK`. It enforces IDs, required sections and keys, quiz option rules (correct-count, explanations), string types, cross-references, widget IDs and table cell counts. |
| Static SPA (16 routes) | Done | `npm run build` passes `tsc` (strict) and Vite. All 197 routes render in headless Chrome without uncaught errors (crawl on 2026-10-22). |
| All 74 mermaid diagrams render | Done | Same headless crawl; no `data-mermaid-error` fallbacks. |
| Progress store (localStorage, export/import, SM-2, streaks) | Done | `tests/progress.test.ts` |
| Fabric Simulator engine + shell | Done | `tests/sim-labs.test.ts`: healthy baseline, every lab broken before and fixed after its `fix` replay, key symptoms (MTU black hole, PFC mismatch, PCIe cap, socket fallback, NVUE staging, pipes). 54 tests pass. |
| 9 widgets | Done | Type-checked, and rendered in light and dark mode in headless Chrome. Interactions checked by reading the code and the widget authors' headless runs; not exercised by automated UI tests. |
| Responsive layout | Done | Checked at 500 px (the narrowest width headless Chrome allows) and 1440 px. |
| CI (validate, test, build, `bash -n`) and Pages deploy workflows | Written | Will run on the first push; not yet executed on GitHub. |
| Windows launcher (`start-academy.bat` + `scripts/start.ps1`) | Written | The build path it runs (`npm run build`, `vite preview`) is used daily during development; the batch file itself has not been double-clicked on a clean machine. |

## Content

| Item | Count | Review |
|---|---|---|
| Lessons | 70 (13 modules, ~165k words) | Written, then independently reviewed per module group; about 30 technical fixes applied during review. |
| Quiz questions | 520 | Reviewed together with their lessons. |
| Mock exams | 3 (140 questions) | Reviewed. Near-duplicate questions across exams were rewritten; some topic overlap remains on purpose. |
| Simulator labs | 14 | Test-verified against the simulator model (see above). |
| Hands-on labs | 7 | `bash -n` and ShellCheck clean, YAML parses, capture fallback decoded with tshark. **Not yet executed end to end on a Linux VM** (`verified: false`). |
| Commands / glossary | 155 / 213 | Validated for structure; reviewed for accuracy. |
| Further-reading links | 154 unique URLs | Checked with curl on 2026-10-22. Three dead NVIDIA links were fixed. ACM DL and doi.org return 403 to scripts (bot protection), not dead links. |

## Correctness verification (second pass, 2026-10-22)

| Check | Method | Result |
|---|---|---|
| Source-based fact-check | Every checkable claim (numbers, CLI flags, counters, env vars, spec facts, attributions) extracted per module and checked against primary sources: RFCs, IEEE material, docs.kernel.org, rdma-core/perftest/NCCL/nccl-tests/OpenSM/pciutils/iproute2 source, NVIDIA docs and RAs, original papers. All arithmetic recomputed. | About 2,400 claims checked; about 100 corrections applied (each with a source). Examples: perftest MB/s is MiB; NVIDIA retired the standalone InfiniBand Professional exam; NVUE adaptive-routing syntax changed in Cumulus 5.15; lspci prints `(downgraded)` only, not `(ok)`; SONiC `config pfcwd start` syntax; a DCTCP/ECN bug in the ECN hands-on lab. |
| Blind answer-key audit | All 674 quiz, exam and lab-diagnosis questions re-answered by independent solvers who could not see the key, with options shuffled and re-lettered. | 673/674 agree with the key; the single mismatch was adjudicated as a solver error. Questions that depended on unstated context were rewritten to be self-contained, and two bandwidth questions now state the counting convention. |
| Answer-position bias | Found by the first audit round: authors listed the correct option first. | Options are now shuffled deterministically per attempt in quizzes, exams and lab diagnoses (unit-tested; correct-answer positions over 451 single-answer questions: 116/124/98/113). |
| Simulator realism | Simulated tool output compared with tool source (perftest, mstflint, NCCL, kernel). | NCCL warning texts, socket fallback behaviour, mlxlink fields and BER values corrected. |

What this does not cover: text a source could not confirm is hedged or labelled illustrative, and the
hands-on labs are still not executed on a VM.

## Known limitations

* The simulator is a teaching model: absolute numbers and output formats are modelled on real tools but
  are not captures of any specific product or release.
* Exam and quiz content reflects public information as of 2026; vendor product details change quickly.
* No automated browser interaction tests yet (see NEXT_STEPS.md).
