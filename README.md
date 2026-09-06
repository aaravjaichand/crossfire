# Crossfire

Pre-audit substantive testing, run by two agents with a human controller on the
escalations.

An AI **Auditor** samples Northwind Labs' FY2025 books and demands evidence for
each pick. An AI **Accountant** searches invoices, contracts, the bank feed,
Dodo Payments, and the ledger, and answers with cited rows or admits the gap. A
deterministic follow-up policy decides whether the auditor accepts the answer,
pushes back, or escalates. The controller rules only on what escalated. The run
ends as a binder: every procedure, every answer, every citation, a coverage
number, and a fix list ranked by amount.

Syndicate by Maximor, Track 2: Autonomous Office of the CFO.

- Live app: [crossfire-gold.vercel.app](https://crossfire-gold.vercel.app)
- Demo video: _to come_
- Devpost: _to come_

## The loop

```
        auditor ─────────────► accountant ─────────────► policy
   samples the books,        searches the books,      accept / push back /
   asks a cited question     answers with cited rows       escalate
        ▲                                                    │
        │                                                    ▼
     memory ◄──────────────── controller ◄──────────── only escalations
  the next run starts        rules: sufficient / needs more /
  where this one ended     exception (+ remedy) / accept with note
```

**Auditor.** `src/lib/auditor` scores every candidate row for risk, forces in
everything at or above materiality, fills the rest of the sample risk-weighted
from a seeded PRNG, and picks a question template per sample from the procedure
it is testing: three-way match, cutoff, unrecorded liabilities, bank rec,
revenue tie-out, approval control. Same seed and same books produce the same
sample every time. The model only rephrases the chosen question.

**Accountant.** `src/lib/accountant` gathers evidence with plain SQL and
matching code — invoice to contract rate, payment to invoice, ledger line to
source row, Dodo payout to that month's payments less refunds less fees — and
produces citations and gaps. The model writes the paragraph over those rows and
nothing else: `finalizeDefense` throws the model's prose away and falls back to
assembled text if a single claim is uncited.

**Policy.** `src/lib/auditor/policy.ts` reads the evidence bundle, not the
prose, and returns accept, push back with a specific follow-up, or escalate.
It is a table, not a model call, so the same evidence always gets the same
treatment. `src/lib/engine/run.ts` runs it to at most three turns per sample and
escalates early when a re-search comes back with an identical evidence
signature, because a third identical answer tells the controller nothing.

**Controller.** Only escalated samples reach a person. The verdicts are
sufficient, needs more, exception, and accept with note; an exception carries a
remedy (recover cash, post entry, fix control, investigate) and a proposed
adjusting journal entry taken from a fixed table keyed by gap kind. Needs more
sends the sample back to the accountant with a note.

**Memory.** Every ruling that carries judgement is written to `learned_rules`,
so the next run over the same books starts where the last one ended.

### Three screens

| Screen | What it is |
| --- | --- |
| `/` | Runs list and the new-run form: seed, materiality, sample size, cycles |
| `/audit/[runId]` | The referee screen: samples on the left, the auditor/accountant thread in the middle, evidence and the controller's verdict on the right |
| `/audit/[runId]/binder` | The printable binder: cover sheet, one workpaper section per sample, tickmark legend, fix list |

## Running locally

Requires Node 20+, pnpm, and Docker.

```bash
# 1. Postgres in Docker (host port 5433; 5432 is left alone).
#    If a container named crossfire-postgres already exists, just `docker start crossfire-postgres`.
docker run -d --name crossfire-postgres \
  -e POSTGRES_USER=crossfire -e POSTGRES_PASSWORD=crossfire -e POSTGRES_DB=crossfire \
  -p 5433:5432 postgres:16-alpine

# 2. Environment
cp .env.example .env.local
#    Add TENSORMUX_API_KEY to run the agents with the model.
#    Add NEATLOGS_API_KEY to send traces. Both are optional: without them the
#    run uses deterministic prose and sends nothing.

# 3. Install, create the schema, seed the books
pnpm install
pnpm db:push
pnpm seed

# 4. An audit run, start to finish, on the command line
pnpm auditor:run --seed 1

# 5. The app
pnpm dev
```

Then open http://localhost:3000 for the runs list, the run itself at
`/audit/<id>`, its binder at `/audit/<id>/binder`, and
http://localhost:3000/api/health, which returns `{ "ok": true, "db": "ok" }`.

`DATABASE_URL` defaults to `postgres://crossfire:crossfire@localhost:5433/crossfire`.

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm db:push` | Push `src/db/schema.ts` to Postgres with drizzle-kit (no migration files for the hackathon) |
| `pnpm seed` | Regenerate Northwind Labs FY2025: truncates the six data tables, rewrites `data/`, runs the self-check |
| `pnpm seed:check` | Re-run the seed self-check against the current database without reseeding |
| `pnpm auditor:run` | One full run on the CLI: `--seed N --name "..." --materiality DOLLARS --samples N --cycles purchases,cash,revenue,payroll --no-llm` |
| `pnpm accountant` | Defend one sample by hand, e.g. `pnpm accountant invoice:15` |
| `pnpm test:accountant` | Evidence search and citation checks, including all 10 planted issues |
| `pnpm auditor:check` | Sampler, question bank, citation, follow-up policy, and run-atomicity checks |
| `pnpm engine:check` | Drive whole runs through the auditor/accountant engine with the model off: sampling, the follow-up loop, bounded stepping, and the deterministic fallbacks |
| `pnpm memory:check` | Two real runs with a ruling filed between them, model off: the accepted ruling settles its sample on the second pass, and a run never reads its own rules or a fixture's |
| `pnpm engine:latency` | The one check that needs the network: times the two model calls per sample against the real endpoint and reports how often the referee is reading the model rather than the fallback |
| `pnpm referee:check` | Referee data, actions, citations, and the `/api/files` containment checks |
| `pnpm tracing:check` | Neatlogs span tree, clipping, and the guarantee that tracing cannot fail a run |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |

Every suite runs against the database in `DATABASE_URL` and prints `PASS`/`FAIL`
per check with a non-zero exit on failure.

## Seed data

The seed is deterministic (fixed mulberry32 seed, pinned PDF metadata). Running
it twice produces byte-identical files and rows, so `data/` is committed and
other work can rely on it without reseeding.

- 5 vendors, each with a contract PDF in `data/contracts/` and one invoice PDF
  per month in `data/invoices/` (61 invoices including the planted extra).
- ~300 bank transactions: vendor payments (counterparty equals the vendor name
  exactly), 12 monthly Dodo payouts, semi-monthly payroll, and small noise.
  Amounts are signed: positive is money in, negative is money out.
- 437 Dodo Payments rows: 400 customer payments, 20 refunds, 5 disputes,
  12 payouts. Fee is 4% + $0.40 per payment. Each payout equals
  payments − refunds − fees for its month, except for one planted issue.
- Double-entry ledger, one row per line. `source_type` is one of
  `invoice | bank | dodo | payroll | adjustment` and `source_id` is the row id
  in that table (null for adjustments).
- Exactly 10 planted issues, each on a distinct record, listed with table names,
  row ids, references, and amounts in `data/planted_issues.json`. Everything
  else reconciles. Never edit that file by hand; change the seed and rerun.

## What improved across iterations

Two passes over the same books on the hosted database, same inputs both times —
seed 1, materiality $50,000, 25 samples, all four cycles — with the controller
ruling on the first pass's escalations before the second one started:

| | Run 1 | Run 2 |
| --- | --- | --- |
| Samples | 25 | 25 |
| Defended without a person | 19 | 21 |
| Escalated to the controller | 6 | 4 |
| Exceptions | 3 | 3 |
| Resolved by memory | 0 | 2 |
| Coverage | 84% | 88% |

Memory carried two of the controller's accept-with-note rulings forward: the
$28.12 rideshare charge and the $90.00 design retainer, both flagged as
payments to a counterparty with no contract, came back on the second pass and
settled themselves by quoting the ruling and citing its `learned_rules` row
rather than asking the same question again. A third payment of the same kind
got a needs-more instead, telling the accountant to check the September card
statement, and the controller was able to close that one on the second pass —
so the agents alone reached 84% coverage on run 2 against 76% on run 1, and the
person was left with four escalations instead of six.

Coverage in the table is measured after the controller ruled, which is what the
comparison panel on the home page shows. The two numbers move together by
design: an accept-with-note settles the sample it was filed against in the run
it was filed in, and memory settles the matching sample on the next run, so the
improvement memory produces shows up as work a person did not have to repeat
rather than as coverage the first run never reached.

Exceptions are the same three findings both times, because an exception is
deliberately not carried forward — a run marking its own findings resolved would
be worthless. They are a $9,200.00 duplicate payment on HPP-2025-03, a
$2,775.00 overbilling against Stratus Compute's contract rate, and a $99.00 lost
dispute missing from October's Dodo payout, each with a remedy and a proposed
entry in the binder.

## Tracing

Every model call is a span in [Neatlogs](https://neatlogs.com): one span per
sample, one LLM span per call carrying the model, the prompt, the answer, the
duration, and whether the call succeeded. `src/lib/tracing` posts the finished
tree to the documented HTTP ingest endpoint rather than pulling in an SDK that
patches the OpenAI client at import time.

The root span is one *pass* over a run, not the whole run: the app drives a run
in bounded slices so a serverless invocation cannot run out of time mid-sample,
so a 25-sample run is several passes. Every root carries `runId`, which is what
groups them. A traced pass looks like this:

```
Northwind Labs FY2025 — substantive testing  [WORKFLOW]  runId=7
  sample bank_transaction:73                 [AGENT]
    auditor.question                         [LLM]  9.8s  OK
    accountant.defense                       [LLM]  30.0s ERROR (timed out, fell back)
  sample invoice:24                          [AGENT]
    ...
```

Tracing is off unless `NEATLOGS_API_KEY` is set, and it cannot take a run down:
the client never throws, the POST is abandoned after two seconds, and a call
made outside a run is buffered and flushed rather than dropped.
`CROSSFIRE_NO_TRACING=1` turns it off with the key still in the environment.

## Deploying

Vercel plus a hosted Postgres.

- `DATABASE_URL` — use Supabase's **session pooler** URL (port 5432). The
  postgres.js client is created with `prepare: false`, a pool of 10 (wider than
  the eight queries the home page fires at once, so nothing is pipelined onto a
  busy connection), and a 10 second idle timeout so serverless instances hand
  connections back before the pooler's client limit is reached.
- `TENSORMUX_API_KEY` — the model. Without it every run falls back to
  deterministic prose, which still reads correctly and still cites. Calls go
  out at temperature 0 with `reasoning_effort: "none"`, because the model is
  asked to write over rows that are already found, not to think: that takes a
  defense from about seven seconds to about one.
- `NEATLOGS_API_KEY` — tracing. Optional.

Push the schema and the books to the hosted database from your machine
(`DATABASE_URL=<hosted> pnpm db:push && DATABASE_URL=<hosted> pnpm seed`), then
deploy. The evidence PDFs under `data/` are served by `/api/files` at request
time, so `next.config.ts` traces `data/**` into that function's bundle.

## House rules

- Deterministic first, model second. Sampling, search, matching, the follow-up
  policy, and the remedy tables are plain code. The model reads gathered rows
  and writes prose, and every model call has a deterministic fallback.
- Every claim cites a table and a row id. Code enforces it after the model
  writes; the model is never trusted to cite.
- `data/planted_issues.json` and the seed change together or not at all.
