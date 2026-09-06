import type {
  Citation,
  DefenseSource,
  Gap,
  ParsedEvidenceBundle,
  SampleRef,
  SampleType,
} from "./evidence-types";

// audit_exchanges.evidence is jsonb written by the accountant. It is typed as
// EvidenceBundle in the schema, but a column typed in TypeScript is not a
// guarantee about bytes already on disk, so it is validated here rather than
// trusted. Anything malformed is dropped: the turn still renders its prose,
// the evidence panel just has nothing to show.

const SAMPLE_TYPES = new Set<string>(["bank_transaction", "invoice", "dodo_transaction"]);

export function parseEvidenceBundle(value: unknown): ParsedEvidenceBundle | undefined {
  const raw = typeof value === "string" ? safeJsonParse(value) : value;
  if (!isRecord(raw)) return undefined;

  const sample = parseSampleRef(raw.sample);
  if (!sample) return undefined;

  const citations = Array.isArray(raw.citations)
    ? raw.citations.map(parseCitation).filter((c): c is Citation => c !== null)
    : [];
  const gaps = Array.isArray(raw.gaps)
    ? raw.gaps.map(parseGap).filter((g): g is Gap => g !== null)
    : [];

  const bundle: ParsedEvidenceBundle = { sample, citations, gaps };
  if (typeof raw.defense === "string" && raw.defense.trim().length > 0) {
    bundle.defense = raw.defense;
  }
  // Rebuilding the bundle field by field is what keeps a malformed row from
  // reaching the screen, but it also means anything not named here is dropped.
  // defenseSource has to be carried explicitly for that reason.
  const defenseSource = parseDefenseSource(raw.defenseSource);
  if (defenseSource) bundle.defenseSource = defenseSource;
  return bundle;
}

function parseDefenseSource(value: unknown): DefenseSource | null {
  if (!isRecord(value)) return null;
  const { source, reason } = value;
  if (source !== "model" && source !== "fallback") return null;
  // The engine omits `reason` entirely for a model-written defense, so its
  // absence is normal rather than a malformed row.
  return typeof reason === "string" && reason.length > 0 ? { source, reason } : { source };
}

function parseSampleRef(value: unknown): SampleRef | null {
  if (!isRecord(value)) return null;
  const { type, id } = value;
  if (typeof type !== "string" || !SAMPLE_TYPES.has(type)) return null;
  if (!isPositiveInt(id)) return null;
  return { type: type as SampleType, id };
}

function parseCitation(value: unknown): Citation | null {
  if (!isRecord(value)) return null;
  const { table, id, field, value: cited, reason, filePath } = value;
  if (typeof table !== "string" || table.length === 0) return null;
  if (!isPositiveInt(id)) return null;
  if (typeof field !== "string" || typeof reason !== "string") return null;
  const citation: Citation = {
    table,
    id,
    field,
    value: typeof cited === "string" ? cited : String(cited ?? ""),
    reason,
  };
  if (typeof filePath === "string" && filePath.length > 0) citation.filePath = filePath;
  return citation;
}

function parseGap(value: unknown): Gap | null {
  if (!isRecord(value)) return null;
  const { kind, description } = value;
  if (typeof kind !== "string" || typeof description !== "string") return null;
  // GapKind is a closed union, but an unrecognised kind from an older row is
  // still worth showing rather than dropping the whole gap.
  return { kind: kind as Gap["kind"], description };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
