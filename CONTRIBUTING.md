# Contributing

Corrections are the most valuable contribution. If something is wrong, outdated or only true for one
vendor or generation, please open an issue with the **Technical error in content** template, ideally with
a source: a standard, vendor documentation, a paper, or a real capture.

## Workflow

```bash
cd frontend
npm ci
npm run dev          # http://localhost:8740, rebuilds content on start
npm run validate     # content rules (must print "Content OK")
npm test             # progress logic + every simulator lab
npm run build        # type check + production build
```

Content changes need no code: lessons, quizzes, labs and exams are Markdown and YAML under `content/`.
Read [docs/AUTHORING.md](docs/AUTHORING.md) first; simulator labs are described in
[docs/SIMULATOR.md](docs/SIMULATOR.md).

## Rules

* **Accuracy first.** No invented flags, counters, environment variables or APIs. Hedge vendor- and
  version-specific statements and label sample output as illustrative.
* **IDs are permanent**: learner progress is keyed by them. Rename titles, never IDs.
* **Original material only.** Do not paste vendor documentation or real exam questions.
* Every simulator lab must pass `tests/sim-labs.test.ts`; every hands-on lab ships a `check.sh` that
  passes `bash -n`.

Code is MIT licensed and content is CC BY-SA 4.0 (see [LICENSE](LICENSE)). By contributing you agree
to license your contribution under the same terms.
