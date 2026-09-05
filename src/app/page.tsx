import { count } from "drizzle-orm";
import { db, schema } from "@/db";

export const dynamic = "force-dynamic";

const TABLES = [
  ["vendors", schema.vendors],
  ["contracts", schema.contracts],
  ["invoices", schema.invoices],
  ["bank_transactions", schema.bankTransactions],
  ["dodo_transactions", schema.dodoTransactions],
  ["ledger_entries", schema.ledgerEntries],
  ["audit_samples", schema.auditSamples],
  ["audit_exchanges", schema.auditExchanges],
  ["referee_decisions", schema.refereeDecisions],
  ["learned_rules", schema.learnedRules],
] as const;

export default async function Home() {
  const rows = await Promise.all(
    TABLES.map(async ([name, table]) => {
      const [row] = await db.select({ n: count() }).from(table);
      return { name, n: row?.n ?? 0 };
    }),
  );

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Crossfire</h1>
      <p className="mt-2 text-sm opacity-70">
        Foundation placeholder. Row counts per table, read live from Postgres.
      </p>
      <table className="mt-6 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 pr-4 font-medium">Table</th>
            <th className="py-2 text-right font-medium">Rows</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-black/10 dark:border-white/10">
              <td className="py-2 pr-4 font-mono">{r.name}</td>
              <td className="py-2 text-right font-mono tabular-nums">{r.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-6 text-sm">
        Health check:{" "}
        <a className="underline" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
