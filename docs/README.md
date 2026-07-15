# Pitt Stop OS — Documentation

This directory contains Product Requirements Documents (PRDs), architecture notes, and design decisions for every module of Pitt Stop OS.

---

## Product Requirements Documents (PRDs)

| Module | Name | Status | PRD |
|--------|------|--------|-----|
| 1 | Dealer Vehicle Entry | Active | Planned |
| 2 | Retail AI Estimator | In Development | [MODULE-02-Retail-Estimator.md](./MODULE-02-Retail-Estimator.md) |
| 3 | QuickBooks Integration | Planned | — |
| 4 | Production Board | Planned | — |
| 5 | Quality Control | Planned | — |
| 6 | CRM | Planned | — |
| 7 | Scheduling | Planned | — |
| 8 | Reporting | Planned | — |
| 9 | Finance | Planned | — |
| 10 | AI Learning Engine | Planned | — |

---

## Platform Documentation

- **Architecture Overview** — Planned
- **Database Schema Reference** — Planned
- **API Conventions** — Planned
- **AI Provider Layer** — Planned
- **Deployment Runbook** — Planned

---

## How to Use This Directory

Each PRD is the authoritative specification for its module. Before writing any code for a new module, the PRD must exist and be approved. Implementation decisions that deviate from the PRD must be documented either as an update to the PRD or in a `DECISIONS.md` note within the relevant module folder.

PRD status definitions:
- **Planned** — Module is on the roadmap; no PRD written yet
- **Draft** — PRD written, pending approval
- **Approved** — PRD approved; implementation may begin
- **Active** — Module is in production; PRD reflects current state
- **Archived** — Module deprecated or superseded
