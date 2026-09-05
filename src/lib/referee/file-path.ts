import { realpath, stat } from "node:fs/promises";
import path from "node:path";

// Resolves a request path under data/ and refuses anything that leaves it.
//
// Two containment checks, because one is not enough. The lexical check runs
// first and rejects "..", absolute segments, and embedded separators without
// touching the filesystem. It cannot see a symlink: data/foo.pdf may be a link
// to /etc/passwd, and every string operation on that path stays inside data/.
// So the resolved path is then passed through realpath and checked again
// against the realpath of data/ itself, which is the containment that holds.

export const DATA_DIR = path.resolve(process.cwd(), "data");

export type ResolvedFile =
  | { ok: true; file: string }
  | { ok: false; status: 400 | 403 | 404; reason: string };

export async function resolveDataFile(segments: string[]): Promise<ResolvedFile> {
  const lexical = resolveLexically(segments);
  if (!lexical.ok) return lexical;

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(DATA_DIR);
  } catch {
    return { ok: false, status: 404, reason: "the data directory is not present" };
  }
  try {
    realTarget = await realpath(lexical.file);
  } catch {
    // Missing file, a broken symlink, or a path component that is not a
    // directory. None of them distinguishable to a caller.
    return { ok: false, status: 404, reason: "no such file" };
  }

  if (!contains(realRoot, realTarget)) {
    return { ok: false, status: 403, reason: "the path resolves outside data/" };
  }

  const info = await stat(realTarget);
  if (!info.isFile()) return { ok: false, status: 404, reason: "not a regular file" };

  return { ok: true, file: realTarget };
}

/** The filesystem-free half: rejects traversal by inspecting the segments. */
export function resolveLexically(segments: string[]): ResolvedFile {
  if (segments.length === 0) return { ok: false, status: 400, reason: "no path given" };

  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, status: 400, reason: "empty path segment" };
    if (segment.includes("\0")) return { ok: false, status: 400, reason: "null byte in path" };
    if (segment === "." || segment === "..") {
      return { ok: false, status: 403, reason: "traversal segment" };
    }
    if (segment.includes("/") || segment.includes("\\")) {
      return { ok: false, status: 403, reason: "separator inside a path segment" };
    }
    if (path.isAbsolute(segment)) return { ok: false, status: 403, reason: "absolute path segment" };
  }

  const target = path.resolve(DATA_DIR, ...segments);
  if (!contains(DATA_DIR, target)) {
    return { ok: false, status: 403, reason: "the path resolves outside data/" };
  }
  return { ok: true, file: target };
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}
