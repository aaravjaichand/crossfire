import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// Serves evidence documents out of the repo's data/ directory and nothing else.
const DATA_DIR = path.resolve(process.cwd(), "data");

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path ?? [];
  if (segments.length === 0 || segments.some((s) => s.includes("\0"))) {
    return new Response("Bad request", { status: 400 });
  }

  const target = path.resolve(DATA_DIR, ...segments);
  // path.resolve collapses "..", so any escape attempt lands outside DATA_DIR.
  if (target !== DATA_DIR && !target.startsWith(DATA_DIR + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  let file: Buffer;
  try {
    const info = await stat(target);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    file = await readFile(target);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(file.byteLength),
      "Content-Disposition": `inline; filename="${path.basename(target)}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
