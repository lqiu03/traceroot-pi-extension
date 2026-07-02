// Optional JSON-lines debug log to a file, for diagnosing tracing in environments
// where stderr is not visible. Best-effort: any failure is swallowed so logging
// never affects the pi session. A no-op logger is returned when no path is set.
//
// Writes are buffered and flushed asynchronously (fs/promises appendFile), so a
// configured log file adds no blocking syscalls to pi's interactive event loop —
// the previous per-call appendFileSync cost an open/write/close on every traced
// event. Lines queued in the same tick share one append. The tail of the buffer can
// be lost on an abrupt process kill; the log is diagnostic and best-effort by design.
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileLogger {
  log(level: string, message: string, data?: unknown): void;
  /** Resolves once every line accepted so far is on disk (or dropped on a dead sink). */
  flush(): Promise<void>;
}

const NOOP: FileLogger = { log() {}, async flush() {} };

export function createFileLogger(filePath: string | undefined): FileLogger {
  if (!filePath) return NOOP;
  let prepared = false;
  let broken = false;
  let queue: string[] = [];
  let pending = Promise.resolve();
  let scheduled = false;

  // One-time sync setup (once per logger, not per event): create the directory and
  // enforce owner-only permissions — the debug log can contain workspace paths, the
  // repo slug, and model/id data, so it must not be group/world readable. The open
  // mode only applies when the file is freshly CREATED; a pre-existing log would keep
  // its old (possibly broad) permissions, hence the explicit chmod. On win32 these
  // modes only toggle the read-only attribute (ACLs govern access); the default log
  // location under the user profile inherits user-scoped ACLs.
  const prepare = (): boolean => {
    if (prepared) return !broken;
    prepared = true;
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      closeSync(openSync(filePath, 'a', 0o600));
      chmodSync(filePath, 0o600);
    } catch {
      broken = true; // unwritable path: degrade to a no-op, logging is best-effort
    }
    return !broken;
  };

  const drain = async (): Promise<void> => {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    try {
      await appendFile(filePath, batch.join(''), { encoding: 'utf8', mode: 0o600 });
    } catch {
      broken = true; // the sink died (e.g. dir removed); stop accepting lines
    }
  };

  return {
    log(level, message, data) {
      if (broken || !prepare()) return;
      try {
        const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, data });
        queue.push(`${line}\n`);
        if (!scheduled) {
          scheduled = true;
          pending = pending.then(drain);
        }
      } catch {
        /* logging is best-effort and must never affect the session */
      }
    },
    async flush() {
      await pending;
    },
  };
}
