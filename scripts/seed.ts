/**
 * pnpm seed
 *
 * Deterministic seed for Northwind Labs FY2025. Truncates the six data tables,
 * wipes data/contracts and data/invoices, regenerates everything from a fixed
 * PRNG seed, writes data/planted_issues.json, then runs the self-check.
 * No LLM calls, no network. Running it twice yields byte-identical output.
 */
import "./lib/env";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql as pgsql } from "drizzle-orm";
import { db, schema, sql } from "../src/db";
import { generate } from "./lib/generate";
import { renderPdf } from "./lib/pdf";
import { cents } from "./lib/util";
import { runChecks, printChecks } from "./lib/check";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");

async function main() {
  const t0 = Date.now();
  console.log("Generating Northwind Labs FY2025...");
  const g = generate();

  // 1. Files
  for (const dir of ["contracts", "invoices"]) {
    await rm(path.join(DATA, dir), { recursive: true, force: true });
    await mkdir(path.join(DATA, dir), { recursive: true });
  }
  for (const pdf of g.pdfs) {
    const bytes = await renderPdf(pdf.lines);
    await writeFile(path.join(ROOT, pdf.path), bytes);
  }
  console.log(`Wrote ${g.pdfs.length} PDFs.`);

  // 2. Database
  await db.transaction(async (tx) => {
    // Only the six data tables. The four placeholder tables are left alone.
    await tx.execute(pgsql`
      truncate table
        ledger_entries, dodo_transactions, bank_transactions,
        invoices, contracts, vendors
      restart identity cascade
    `);

    await tx.insert(schema.vendors).values(
      g.vendors.map((v) => ({ id: v.id, name: v.name, contractId: null })),
    );
    await tx.insert(schema.contracts).values(
      g.contracts.map((c) => ({
        id: c.id,
        vendorId: c.vendorId,
        filePath: c.filePath,
        monthlyRate: cents(c.monthlyRate),
        effectiveFrom: c.effectiveFrom,
        effectiveTo: c.effectiveTo,
        termsText: c.termsText,
      })),
    );
    // Back-fill vendors.contract_id now that contracts exist (no FK, by design).
    for (const c of g.contracts) {
      await tx
        .update(schema.vendors)
        .set({ contractId: c.id })
        .where(pgsql`${schema.vendors.id} = ${c.vendorId}`);
    }

    await insertChunked(
      tx,
      schema.invoices,
      g.invoices.map((i) => ({
        id: i.id,
        vendorId: i.vendorId,
        invoiceNumber: i.invoiceNumber,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        amount: cents(i.amount),
        status: i.status,
        approvedBy: i.approvedBy,
        filePath: i.filePath,
      })),
    );
    await insertChunked(
      tx,
      schema.bankTransactions,
      g.bank.map((b) => ({
        id: b.id,
        date: b.date,
        description: b.description,
        amount: cents(b.amount),
        counterparty: b.counterparty,
        reference: b.reference,
      })),
    );
    await insertChunked(
      tx,
      schema.dodoTransactions,
      g.dodo.map((d) => ({
        id: d.id,
        type: d.type,
        date: d.date,
        amount: cents(d.amount),
        customerId: d.customerId,
        reference: d.reference,
      })),
    );
    await insertChunked(
      tx,
      schema.ledgerEntries,
      g.ledger.map((l) => ({
        id: l.id,
        date: l.date,
        account: l.account,
        debit: cents(l.debit),
        credit: cents(l.credit),
        memo: l.memo,
        sourceType: l.sourceType,
        sourceId: l.sourceId,
      })),
    );

    // We inserted explicit ids, so move each serial sequence past them.
    for (const table of [
      "vendors",
      "contracts",
      "invoices",
      "bank_transactions",
      "dodo_transactions",
      "ledger_entries",
    ]) {
      await tx.execute(
        pgsql`select setval(pg_get_serial_sequence(${table}, 'id'), coalesce((select max(id) from ${pgsql.identifier(table)}), 1))`,
      );
    }
  });

  // 3. Manifest
  const manifest = {
    company: "Northwind Labs, Inc.",
    fiscal_year: 2025,
    seed: 20250906,
    note: "Exactly 10 planted issues, each on a distinct record. Everything else reconciles. Do not edit by hand; regenerate with `pnpm seed`.",
    issues: g.planted,
  };
  await writeFile(
    path.join(DATA, "planted_issues.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  console.log(
    `Inserted: vendors ${g.vendors.length}, contracts ${g.contracts.length}, invoices ${g.invoices.length}, ` +
      `bank_transactions ${g.bank.length}, dodo_transactions ${g.dodo.length}, ledger_entries ${g.ledger.length}.`,
  );
  console.log(`Seed done in ${Date.now() - t0} ms.\n`);

  // 4. Self-check
  const results = await runChecks();
  const ok = printChecks(results);
  await sql.end();
  process.exit(ok ? 0 : 1);
}

async function insertChunked<T extends Parameters<typeof db.insert>[0]>(
  tx: Pick<typeof db, "insert">,
  table: T,
  rows: Parameters<ReturnType<typeof db.insert<T>>["values"]>[0] & unknown[],
) {
  const size = 500;
  for (let i = 0; i < rows.length; i += size) {
    await tx.insert(table).values(rows.slice(i, i + size));
  }
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});
