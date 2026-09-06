import { count } from "drizzle-orm";
import { db, schema } from "@/db";
import { HomeFraming } from "@/app/_components/home-framing";
import { EmptyRuns, RunsTable } from "@/app/_components/home-runs";
import { NewRunForm } from "@/app/_components/new-run-form";
import { RunComparisonPanel } from "@/app/_components/run-comparison";
import { memoryResolvedIds } from "@/lib/accountant/memory";
import { compareLatestRuns } from "@/lib/engine/comparison";
import { recentRuns } from "@/lib/referee/runs";

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
  const runsPromise = recentRuns(20);
  const [runs, byMemory, comparison, books] = await Promise.all([
    runsPromise,
    // Which of the latest run's samples a remembered ruling settled. It needs
    // that run's id, so it follows the runs read, but it overlaps the
    // comparison and the book counts rather than queueing behind them.
    runsPromise.then((rs) => (rs[0] ? memoryResolvedIds(String(rs[0].id)) : new Set<string>())),
    // Null until there are two settled runs drawn from the same inputs.
    compareLatestRuns(),
    Promise.all(
      BOOKS.map(async ([name, table]) => {
        const [row] = await db.select({ n: count() }).from(table);
        return { name, n: row?.n ?? 0 };
      }),
    ),
  ]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      {/* The left inset follows the shell's floating sidebar button, the way the
          run and binder headers do, so the title never sits under it. */}
      <div className="mx-auto max-w-5xl pb-12 pl-[max(2rem,var(--shell-header-left,1rem))] pr-8 pt-7">
        <HomeFraming latest={runs[0] ?? null} byMemory={byMemory.size} comparison={comparison} />

        {comparison ? (
          <section className="mt-8">
            <RunComparisonPanel comparison={comparison} />
          </section>
        ) : null}

        <section className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-[20rem]">
              <h2 className="text-[13px] font-medium">Audit runs</h2>
              <p className="mt-0.5 max-w-[64ch] text-[12px] text-ink-3">
                Newest first. Seed, materiality, sample size, and cycles fix the sample, so the
                same inputs draw the same items every time.
              </p>
            </div>
            {/* Closed, the form is one button and sits on the heading's line;
                open, it is a card and takes the full row beneath. */}
            <div className="ml-auto min-w-0 has-[form]:basis-full">
              <NewRunForm />
            </div>
          </div>
          <div className="mt-3">{runs.length === 0 ? <EmptyRuns /> : <RunsTable runs={runs} />}</div>
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
