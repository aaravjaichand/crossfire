# Crossfire

Hackathon entry for Syndicate by Maximor, Track 2: Autonomous Office of the CFO. Solo builder. Deadline Sunday September 6, 2026, 6:00 PM EDT.

## What it is
A web app where an AI Auditor agent samples transactions from a fictional company's books and demands evidence, an AI Accountant agent searches invoices, contracts, bank feed, Dodo Payments data, and the ledger to produce cited proof or admit a gap, and a human referee approves, redirects, or concedes each exchange. Output: an audit binder, a coverage score, and a ranked fix list. Across repeated runs the Accountant learns from referee redirects and coverage improves.

## Judging rubric
AO usage 25, technical reliability 25, track fit and real-world value 25, demo and usability 15, innovation 10. Reliability and human review matter more than cleverness.

## Stack
Next.js 15 App Router, TypeScript, Tailwind, pnpm, Postgres with Drizzle ORM. LLM calls go through the OpenAI SDK with baseURL https://api.tensormux.com/v1 and model glm-4-7-flash, key in TENSORMUX_API_KEY. Neatlogs for tracing. Vercel for deploy.

## Rules
- Deterministic first, LLM second. Search and matching are plain code; the model only reads documents and writes explanations.
- Every agent claim must cite a document and row id. No uncited assertions.
- Seed data is deterministic. Never change /data/planted_issues.json without updating the seed.
- Commit messages short and plain. No AI attribution or session links.
- Small PRs with a clear finish line. Run the seed and the app before opening a PR.
