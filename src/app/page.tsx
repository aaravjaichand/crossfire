import Link from "next/link";
import { count } from "drizzle-orm";
import { db, schema } from "@/db";
import { recentRuns, type RunSummary } from "@/lib/referee/runs";

export const dynamic = "force-dynamic";

const BOOKS = [
  ["Vendors", schema.vendors],
  ["Contracts", schema.contracts],
  ["Invoices", schema.invoices],
  ["Bank transactions", schema.bankTransactions],
  ["Dodo transactions", schema.dodoTransactions],
  ["Ledger entries", schema.ledgerEntries],
] as const;

export default async function Home() {
  const [runs, books] = await Promise.all([
    recentRuns(20),
    Promise.all(
      BOOKS.map(async ([name, table]) => {
        const [row] = await db.select({ n: count() }).from(table);
        return { name, n: row?.n ?? 0 };
      }),
    ),
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-7">
        <header className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">Audit runs</h1>
            <p className="mt-1 text-[12.5px] text-ink-2">
              Northwind Labs, FY2025. Each run samples the books, asks for evidence, and waits
              for your call on every gap.
            </p>
          </div>
          <Link href="/audit/mock" className="btn">
            Open walkthrough
          </Link>
        </header>

        <section className="mt-6">
          {runs.length === 0 ? <EmptyRuns /> : <RunsTable runs={runs} />}
        </section>

        <section className="mt-10">
          <h2 className="text-[13px] font-medium">The books</h2>
          <p className="mt-0.5 text-[12px] text-ink-3">
            Seeded deterministically. Ten planted issues, everything else reconciles.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-8 sm:grid-cols-3">
            {books.map((b) => (
              <div
                key={b.name}
                className="flex items-baseline justify-between border-b border-line py-2"
              >
                <dt className="text-[12.5px] text-ink-2">{b.name}</dt>
                <dd className="font-mono text-[12.5px] num">{b.n.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}

function RunsTable({ runs }: { runs: RunSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-ink text-left text-[11.5px] text-ink-2">
            <th className="py-2 pr-4 font-medium">Run</th>
            <th className="py-2 pr-4 font-medium">Created</th>
            <th className="py-2 pr-4 text-right font-medium">Samples</th>
            <th className="py-2 pr-4 text-right font-medium">Defended</th>
            <th className="py-2 pr-4 text-right font-medium">Gaps</th>
            <th className="py-2 pr-4 text-right font-medium">Conceded</th>
            <th className="py-2 pr-4 text-right font-medium">Open</th>
            <th className="w-44 py-2 font-medium">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const percent = run.total === 0 ? 0 : Math.round((run.defended / run.total) * 100);
            return (
              <tr key={run.id} className="border-b border-line hover:bg-paper-2">
                <td className="py-2.5 pr-4">
                  <Link href={`/audit/${run.id}`} className="flex items-baseline gap-2">
                    <span className="font-mono text-[11.5px] text-ink-3 num">{run.id}</span>
                    <span className="font-medium underline-offset-2 hover:underline">
                      {run.name}
                    </span>
                  </Link>
                </td>
                <td className="py-2.5 pr-4 font-mono text-[11.5px] text-ink-2 num">
                  {formatDate(run.createdAt)}
                </td>
                <Num value={run.total} />
                <Num value={run.defended} />
                <Num value={run.gap} />
                <Num value={run.conceded} />
                <Num value={run.open} muted />
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                      <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="font-mono text-[11.5px] num">{percent}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Num({ value, muted }: { value: number; muted?: boolean }) {
  return (
    <td className={`py-2.5 pr-4 text-right font-mono num ${muted ? "text-ink-3" : ""}`}>
      {value}
    </td>
  );
}

function EmptyRuns() {
  return (
    <div className="rounded-[4px] border border-line px-5 py-6">
      <p className="text-[13px] font-medium">No audit runs yet</p>
      <p className="mt-1 text-[12.5px] text-ink-2">
        Create one from the repo root, then it appears here and in the sidebar.
      </p>
      <pre className="mt-3 inline-block rounded-[4px] bg-paper-2 px-3 py-2 font-mono text-[12px]">
        pnpm auditor:run --seed 7 --name &quot;First pass&quot;
      </pre>
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}
