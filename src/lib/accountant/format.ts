import { formatSampleId } from "./sample";
import type { EvidenceBundle } from "./types";

/** Human-readable bundle for the CLI and for pasting into a PR or a binder. */
export function formatBundle(bundle: EvidenceBundle): string {
  const out: string[] = [];
  out.push(`Sample ${formatSampleId(bundle.sample)}`);
  out.push("=".repeat(`Sample ${formatSampleId(bundle.sample)}`.length));
  out.push("");

  out.push(`Citations (${bundle.citations.length})`);
  if (bundle.citations.length === 0) {
    out.push("  none");
  }
  for (const c of bundle.citations) {
    out.push(`  [${c.table}#${c.id}] ${c.field} = ${c.value}`);
    out.push(`      ${c.reason}`);
    if (c.filePath) out.push(`      file: ${c.filePath}`);
  }
  out.push("");

  out.push(`Gaps (${bundle.gaps.length})`);
  if (bundle.gaps.length === 0) {
    out.push("  none - this sample reconciles");
  }
  for (const g of bundle.gaps) {
    out.push(`  ${g.kind}`);
    out.push(`      ${g.description}`);
  }

  if (bundle.defense) {
    out.push("");
    out.push("Defense");
    out.push(...wrap(bundle.defense, 96).map((line) => `  ${line}`));
  }
  return out.join("\n");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + word.length + 1 > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}
