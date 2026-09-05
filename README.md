# Crossfire

Syndicate by Maximor hackathon, Track 2: Autonomous Office of the CFO.

An AI auditor interrogates a company's books, an AI accountant defends them with cited evidence, and a human referees.

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

# 3. Install, create the schema, seed the books
pnpm install
pnpm db:push
pnpm seed

# 4. Run the app
pnpm dev
```

Then open http://localhost:3000 (row counts for every table) and
http://localhost:3000/api/health (returns `{ "ok": true, "db": "ok" }`).

`DATABASE_URL` defaults to `postgres://crossfire:crossfire@localhost:5433/crossfire`.

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm db:push` | Push `src/db/schema.ts` to Postgres with drizzle-kit (no migration files for the hackathon) |
| `pnpm seed` | Regenerate Northwind Labs FY2025: truncates the six data tables, rewrites `data/`, runs the self-check |
| `pnpm seed:check` | Re-run the self-check against the current database without reseeding |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |

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
