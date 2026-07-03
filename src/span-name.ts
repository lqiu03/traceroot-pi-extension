// Build a scannable span name for a tool call: "<tool>: <file>" when an argument
// names a path, "bash: <command>" for shell calls, else just the tool name. Keeps
// a trace waterfall readable without expanding each span. Pure (no OTel import).
import { win32 } from 'node:path';
import { safeSlice } from './json.ts';

// win32.basename treats BOTH `/` and `\` as separators, so a Windows-style path in a
// tool argument (e.g. C:\Users\alice\secret.py) is reduced to its filename rather than
// leaking the full path — including the username — into the exported span name. POSIX
// basename would treat `\` as a literal character and leak the whole string.
const basename = win32.basename;

const MAX_BASH_NAME = 60;

export function formatToolSpanName(toolName: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const pathLike = a.path ?? a.file ?? a.filePath ?? a.file_path ?? a.filename ?? a.target;
    if (typeof pathLike === 'string' && pathLike) return `${toolName}: ${basename(pathLike)}`;
    if (toolName === 'bash' && typeof a.command === 'string' && a.command) {
      const cmd = a.command.replace(/\s+/g, ' ').trim();
      // safeSlice, not slice: this becomes the exported span NAME, and cutting mid
      // surrogate pair (e.g. an emoji at the 60-char boundary) would leave a lone
      // surrogate that corrupts the UTF-8 an OTLP/proto collector requires.
      return `bash: ${cmd.length > MAX_BASH_NAME ? `${safeSlice(cmd, MAX_BASH_NAME)}…` : cmd}`;
    }
  }
  return toolName;
}
