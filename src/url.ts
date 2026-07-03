// Build a deep link to a trace in the Traceroot web UI.
//
// The UI route is /projects/{projectId}/traces?traceId={traceId}, where projectId
// is the project UUID (not the human-readable project name). When the UUID is not
// configured we cannot construct a correct link, so we return null and the caller
// surfaces the trace id as plain text instead of a wrong URL.
import { isProjectUuid } from './hex.ts';
import type { TracerootPiConfig } from './config.ts';

// A non-UUID projectId — e.g. a human-readable name mistakenly put in
// TRACEROOT_PROJECT_ID — would build a UI link that 404s, so treat it as "no usable
// projectId" and return null (config.ts separately warns the user about the format).
export function buildTraceUrl(config: TracerootPiConfig, traceId: string | null): string | null {
  if (!traceId || !isProjectUuid(config.projectId)) return null;
  const base = config.uiUrl.replace(/\/+$/, '');
  // Encode the dynamic segments so an unusual projectId/traceId cannot break the URL
  // (or, on the Windows launch path, inject shell metacharacters into cmd.exe).
  return `${base}/projects/${encodeURIComponent(config.projectId)}/traces?traceId=${encodeURIComponent(traceId)}`;
}

// Strip any userinfo (user:pass@) from a URL for display, so a credential embedded in
// an endpoint (e.g. TRACEROOT_OTLP_ENDPOINT=https://user:secret@host/...) is not shown
// in /traceroot status output, screenshots, or shared terminals. The host/path is kept
// — that is the point of the status line. A value that does not parse as a URL is
// returned unchanged (nothing to redact).
export function redactUrlUserinfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}
