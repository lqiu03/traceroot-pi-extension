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

// Query-parameter names whose values are credential-like. Matched as a bounded segment
// (delimited by start/end or a - / _ separator) ANYWHERE in the name, not as a whole-name
// allowlist, so vendor-prefixed variants (X-Amz-Signature, my-api-key, request_signature)
// are masked too. The segment boundaries keep benign names that merely contain a keyword
// as a substring (keyword, monkey, design) from being redacted. For a redactor, biasing
// toward over-masking a benign param is far safer than leaking a real secret.
const CREDENTIAL_QUERY_PARAM =
  /(^|[-_])(x[-_]?)?(authorization|api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd|bearer|jwt|auth|credential|signature|sig|key)([-_]|$)/i;

// Redact credentials from a URL for display, so a secret embedded in an endpoint is not
// shown in /traceroot status output, screenshots, log files, or shared terminals. Covers
// both standard locations: userinfo (https://user:secret@host/...) and credential-like
// query parameters (https://host/traces?token=secret). The host/path/other params are
// kept — that is the point of the status line. A value that does not parse as a URL is
// returned unchanged (nothing to redact).
export function redactUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_QUERY_PARAM.test(key)) {
        url.searchParams.set(key, 'REDACTED');
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch {
    return raw;
  }
}
