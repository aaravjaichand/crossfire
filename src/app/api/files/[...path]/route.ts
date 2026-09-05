import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataFile } from "@/lib/referee/file-path";

// Serves evidence documents out of the repo's data/ directory and nothing else.
// Containment, including against symlinks pointing out of the tree, lives in
// src/lib/referee/file-path.ts so it can be tested without a running server.

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

const MESSAGES: Record<number, string> = {
  400: "Bad request",
  403: "Forbidden",
  404: "Not found",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path ?? [];
  const resolved = await resolveDataFile(segments);
  if (!resolved.ok) {
    return new Response(MESSAGES[resolved.status], { status: resolved.status });
  }

  let file: Buffer;
  try {
    file = await readFile(resolved.file);
  } catch (error) {
    console.error("[files] reading a contained file failed", { file: resolved.file, error });
    return new Response(MESSAGES[404], { status: 404 });
  }

  const type = CONTENT_TYPES[path.extname(resolved.file).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(file.byteLength),
      "Content-Disposition": `inline; filename="${path.basename(resolved.file)}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
