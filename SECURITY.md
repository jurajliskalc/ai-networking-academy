# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/jurajliskalc/ai-networking-academy/security/advisories/new)
for this repository, not in a public issue. Say what is affected, how to reproduce it and what an attacker
gains.

Errors in the learning content are not security issues: use the **Technical error in content** issue
template for those.

## What is in scope

| Part | What it does | What to look for |
|---|---|---|
| The web app | A static site. It has no backend and no accounts; progress and the lab profile stay in the browser's `localStorage`. The published site reports each page load to a visit counter and shows the count it returns ([what is sent](docs/ARCHITECTURE.md#outside-requests)) | Script injection through content or imported files (progress exports, `aina-hw` reports and check results, pasted check output), and anything that makes the app send learner data to another host |
| `aina-hw serve` | A local HTTP agent that serves inventory and check results to the browser. It binds to 127.0.0.1 by default, answers only read requests, checks the `Host` header and an origin allow-list, and is meant to be reached through an SSH tunnel | Anything that lets a web page or another host read data it should not, or makes the agent change the system |
| `aina-hw collect` and the lab scripts | Run on your own lab hosts, some with `sudo`. They change NIC, QoS and kernel settings and ship restore scripts | Command injection through `lab.env` values or host output, and changes that are not restored |

The lab scripts are written for disposable lab machines. Read
[the safety guide](content/hardware/guides/safety.md) before running them, and do not run them on
production systems.

## Supported versions

Fixes are made on `main` and released as the next version. Older releases are not patched.
