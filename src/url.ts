// Build a deep link to a trace in the Traceroot web UI.
//
// The UI route is /projects/{projectId}/traces?traceId={traceId}, where projectId
// is the project UUID (not the human-readable project name). When the UUID is not
// configured we cannot construct a correct link, so we return null and the caller
// surfaces the trace id as plain text instead of a wrong URL.
import type { TracerootPiConfig } from './config.ts';

// The UI route embeds the project UUID (8-4-4-4-12 hex, any version/variant,
// case-insensitive). A non-UUID projectId — e.g. a human-readable name mistakenly put
// in TRACEROOT_PROJECT_ID — would build a link that 404s, so we treat it as "no usable
// projectId" and return null, matching the documented contract.
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildTraceUrl(config: TracerootPiConfig, traceId: string | null): string | null {
  if (!traceId || !config.projectId || !PROJECT_UUID.test(config.projectId)) return null;
  const base = config.uiUrl.replace(/\/+$/, '');
  // Encode the dynamic segments so an unusual projectId/traceId cannot break the URL
  // (or, on the Windows launch path, inject shell metacharacters into cmd.exe).
  return `${base}/projects/${encodeURIComponent(config.projectId)}/traces?traceId=${encodeURIComponent(traceId)}`;
}
