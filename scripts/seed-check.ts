/**
 * pnpm seed:check
 *
 * Re-runs the seed self-check against the current database without reseeding.
 */
import "./lib/env";
import { sql } from "../src/db";
import { printChecks, runChecks } from "./lib/check";

runChecks()
  .then(async (results) => {
    const ok = printChecks(results);
    await sql.end();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await sql.end().catch(() => {});
    process.exit(1);
  });
