/**
 * pnpm referee:check-files
 *
 * Containment checks for what /api/files will serve. A real PDF from data/
 * must still resolve; lexical traversal must be rejected without touching the
 * filesystem; and a symlink planted inside data/ pointing outside the tree
 * must be rejected too, which the old string-prefix check could not see.
 *
 * The symlink is created in data/ and removed again in a finally block.
 */
import "./load-env";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DATA_DIR, resolveDataFile, resolveLexically } from "./file-path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function firstPdf(): Promise<string[] | null> {
  for (const dir of ["invoices", "contracts"]) {
    try {
      const entries = await readdir(path.join(DATA_DIR, dir));
      const pdf = entries.find((e) => e.toLowerCase().endsWith(".pdf"));
      if (pdf) return [dir, pdf];
    } catch {
      // directory not generated yet
    }
  }
  return null;
}

async function main() {
  // ---- a real document still serves ----
  const pdf = await firstPdf();
  check("data/ contains a generated PDF to serve", Boolean(pdf), pdf ? pdf.join("/") : "run pnpm seed");
  if (pdf) {
    const ok = await resolveDataFile(pdf);
    check(`/api/files/${pdf.join("/")} resolves`, ok.ok, ok.ok ? ok.file.replace(DATA_DIR, "data") : ok.reason);
  }

  // ---- lexical traversal, rejected before any filesystem call ----
  const lexicalCases: { name: string; segments: string[]; status: number }[] = [
    { name: "..", segments: ["..", "package.json"], status: 403 },
    { name: "nested ..", segments: ["invoices", "..", "..", "package.json"], status: 403 },
    { name: "encoded separator in a segment", segments: ["invoices/../../package.json"], status: 403 },
    { name: "backslash separator", segments: ["invoices\\..\\..\\package.json"], status: 403 },
    { name: "absolute path", segments: ["/etc/passwd"], status: 403 },
    { name: "lone dot", segments: ["."], status: 403 },
    { name: "empty segment", segments: [""], status: 400 },
    { name: "null byte", segments: ["invoices\0.pdf"], status: 400 },
    { name: "no path at all", segments: [], status: 400 },
  ];
  for (const c of lexicalCases) {
    const result = resolveLexically(c.segments);
    check(
      `lexical: ${c.name} is rejected with ${c.status}`,
      !result.ok && result.status === c.status,
      result.ok ? "accepted" : `${result.status} ${result.reason}`,
    );
    const full = await resolveDataFile(c.segments);
    check(`  and the full resolver agrees`, !full.ok && full.status === c.status, full.ok ? "accepted" : String(full.status));
  }

  // ---- symlink escape, invisible to any string comparison ----
  const outside = await mkdtemp(path.join(tmpdir(), "crossfire-files-check-"));
  const secretName = "outside-secret.txt";
  await writeFile(path.join(outside, secretName), "this file is not in data/\n");

  const linkDir = path.join(DATA_DIR, "referee-files-check");
  const escapeLink = path.join(linkDir, "escape.txt");
  const dirLink = path.join(DATA_DIR, "referee-files-check-dir");
  try {
    await rm(linkDir, { recursive: true, force: true });
    await rm(dirLink, { recursive: true, force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(linkDir, { recursive: true }));
    await symlink(path.join(outside, secretName), escapeLink);
    await symlink(outside, dirLink);

    const viaFileLink = await resolveDataFile(["referee-files-check", "escape.txt"]);
    check(
      "a symlinked file inside data/ pointing outside is rejected with 403",
      !viaFileLink.ok && viaFileLink.status === 403,
      viaFileLink.ok ? `served ${viaFileLink.file}` : `${viaFileLink.status} ${viaFileLink.reason}`,
    );
    check(
      "the lexical check alone would have allowed it, which is why realpath is needed",
      resolveLexically(["referee-files-check", "escape.txt"]).ok,
    );

    const viaDirLink = await resolveDataFile(["referee-files-check-dir", secretName]);
    check(
      "a symlinked directory inside data/ pointing outside is rejected with 403",
      !viaDirLink.ok && viaDirLink.status === 403,
      viaDirLink.ok ? `served ${viaDirLink.file}` : `${viaDirLink.status} ${viaDirLink.reason}`,
    );

    // A symlink that stays inside data/ is fine.
    if (pdf) {
      const insideLink = path.join(linkDir, "inside.pdf");
      await symlink(path.join(DATA_DIR, pdf[0], pdf[1]), insideLink);
      const viaInside = await resolveDataFile(["referee-files-check", "inside.pdf"]);
      check("a symlink that stays inside data/ still resolves", viaInside.ok, viaInside.ok ? "" : viaInside.reason);
    }
  } finally {
    await rm(linkDir, { recursive: true, force: true });
    await rm(dirLink, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  // ---- a directory is not a file ----
  const dir = await resolveDataFile(["invoices"]);
  check("a directory is not served", !dir.ok && dir.status === 404, dir.ok ? "served" : `${dir.status} ${dir.reason}`);

  const missing = await resolveDataFile(["invoices", "does-not-exist.pdf"]);
  check("a missing file is a 404", !missing.ok && missing.status === 404, missing.ok ? "served" : String(missing.status));
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll referee file-route checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
