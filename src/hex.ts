// Validate OpenTelemetry id strings: lowercase hex, 32 chars for a trace id and
// 16 for a span id. Used wherever an id read from an untrusted source (persisted
// file, env var) is turned into a SpanContext.
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
// All-zero is the W3C Trace Context "invalid" sentinel for both ids; reject it so it can
// never be turned into a parent SpanContext.
const ALL_ZERO = /^0+$/;

export function isTraceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && TRACE_ID.test(value) && !ALL_ZERO.test(value);
}

export function isSpanId(value: string | null | undefined): value is string {
  return typeof value === 'string' && SPAN_ID.test(value) && !ALL_ZERO.test(value);
}

// A project UUID (8-4-4-4-12 hex, any version/variant, case-insensitive). The trace-URL
// route embeds it; a non-UUID projectId builds a link that 404s, so both url.ts (skip
// the link) and config.ts (warn the user) share this check.
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProjectUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && PROJECT_UUID.test(value);
}
