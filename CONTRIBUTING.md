# Contributing

Corrections are the most valuable contribution. If something is wrong, outdated or only true for one
vendor or generation, please open an issue with the **Technical error in content** template, ideally with
a source: a standard, vendor documentation, a paper, or a real capture.

## Local setup

Node.js 20 or newer. On Windows, `start-academy.bat` fetches a portable Node.js into `.tools/` if you have
none.

```bash
cd frontend
npm ci
npm run dev          # http://localhost:8740, rebuilds content on start
```

Where things live is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the content compiler
(`frontend/scripts/build-content.mjs`), the Fabric Simulator (`frontend/src/sim/`), the hardware toolkit
(`labs/hw-toolkit/`), the app (`frontend/src/`) and the tests (`frontend/tests/`, `frontend/e2e/`).

## Changing content

Content changes need no code: lessons, quizzes, labs and exams are Markdown and YAML under `content/`.
Read [docs/AUTHORING.md](docs/AUTHORING.md) first; simulator labs are described in
[docs/SIMULATOR.md](docs/SIMULATOR.md).

## Before you open a pull request

```bash
cd frontend
npm run validate     # content rules (must print "Content OK")
npm test             # unit tests, every simulator lab replayed, counts in the docs
npm run build        # type check + production build
npm run e2e          # browser tests against the build (uses your installed Google Chrome)
cd ..
for f in labs/**/*.sh scripts/*.sh; do bash -n "$f"; done      # bash with globstar
python3 -m unittest discover -s labs/hw-toolkit/tests          # Linux
```

CI runs the same steps. If you add a lesson, lab, question, widget or command, `npm test` will tell you
which counts in the docs to update (`npm run stats` prints the current ones).

## Rules

* **Accuracy first, with a source.** No invented flags, counters, environment variables or APIs. A
  technical fact needs a primary source: the standard or RFC, the tool's source code, vendor documentation,
  the original paper, or a capture from real hardware. Hedge vendor- and version-specific statements and
  label sample output as illustrative.
* **Verified means it was run.** `[!VERIFIED]` callouts and `real` capture tags are only for behaviour and
  output observed on the hardware and software they name (see
  [docs/HARDWARE_VERIFICATION.md](docs/HARDWARE_VERIFICATION.md)). If you verified something on other
  hardware, say exactly which adapter, firmware, OS and driver stack, and include the capture. One
  observation is an observation, not vendor behaviour in general. A hands-on lab stays `verified: false`
  until it has been run end to end and its `check.sh` passed.
* **No serial numbers or real identifiers in captures.** Replace GUID and MAC bytes with placeholders and
  leave out adapter and cable serial numbers.
* **IDs are permanent**: learner progress is keyed by them. Rename titles, never IDs.
* **Original material only.** Do not paste vendor documentation or real exam questions.
* Every simulator lab must pass `tests/sim-labs.test.ts`; every hands-on lab ships a `check.sh` that
  passes `bash -n`.

## AI-assisted contributions

This project is itself built with AI coding agents, so AI-assisted contributions are welcome under the
same rule the project applies to its own: generated output is untrusted until it is verified. Check every
technical claim against a primary source before you submit, run the checks above, and say in the pull
request what you verified and how. Do not describe an AI review as a human review. The agents' working
rules are in [CLAUDE.md](CLAUDE.md).

## License

Code is licensed under PolyForm Noncommercial 1.0.0 and content under CC BY-NC-SA 4.0 (see
[LICENSE](LICENSE)). By contributing you agree to license your contribution under the same terms, and
you grant the copyright holder the right to also license it under other terms, including commercial
licenses.
