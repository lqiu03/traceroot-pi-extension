// Persist a session's root SpanContext so a later forked session can link back to
// it (P2-F). Keyed by the session file's basename under the configured state dir.
// All operations are best-effort; failure degrades to "no link", never an error.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isSpanId, isTraceId } from './hex.ts';

export interface PersistedTrace {
  traceId: string;
  spanId: string;
}

// Key by a hash of the FULL session-file path, not just its basename: two sessions with
// the same filename in different directories would otherwise collide and cross-link.
function fileFor(stateDir: string, sessionFile: string): string {
  const key = createHash('sha256').update(sessionFile).digest('hex').slice(0, 32);
  return join(stateDir, `${key}.json`);
}

// A continuity entry is only useful while its session file can still be reloaded or
// forked; anything this old is a dead key (one file per session, written forever).
const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Dirs already pruned by this process — pruning is once per process, not per session.
// Module-level by design (like attribution.ts's repoSlugCache): it caches work, not
// span state.
const prunedDirs = new Set<string>();

// Delete continuity entries whose mtime is older than the cutoff, plus stale .tmp
// leftovers from crashed atomic writes. Async and best-effort: a raced unlink (another
// pi process pruning the same dir) or a missing dir must never surface.
export async function pruneStaleSessionTraces(
  stateDir: string,
  maxAgeMs: number = PRUNE_MAX_AGE_MS,
): Promise<void> {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await readdir(stateDir)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const file = join(stateDir, name);
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) await unlink(file);
      } catch {
        /* raced with another process — best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

export function persistSessionTrace(
  stateDir: string,
  sessionFile: string | null,
  trace: PersistedTrace,
): void {
  try {
    if (!sessionFile) return;
    mkdirSync(stateDir, { recursive: true });
    // Write atomically (temp file + rename) so a concurrently-forking session never
    // reads a half-written file.
    const target = fileFor(stateDir, sessionFile);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(trace), 'utf8');
    renameSync(tmp, target);
    // Opportunistic GC off the hot path: without it the state dir accrues one tiny
    // file per session for the lifetime of the install.
    if (!prunedDirs.has(stateDir)) {
      prunedDirs.add(stateDir);
      void pruneStaleSessionTraces(stateDir);
    }
  } catch {
    /* best-effort */
  }
}

export function readSessionTrace(
  stateDir: string,
  sessionFile: string | null,
): PersistedTrace | null {
  try {
    if (!sessionFile) return null;
    const file = fileFor(stateDir, sessionFile);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // The file is untrusted on read-back: only accept well-formed OTel ids,
    // else a corrupt id would yield an invalid Link/parent SpanContext.
    if (parsed && isTraceId(parsed.traceId) && isSpanId(parsed.spanId)) {
      return { traceId: parsed.traceId, spanId: parsed.spanId };
    }
    return null;
  } catch {
    return null;
  }
}
