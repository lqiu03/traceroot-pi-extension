// Guarded attribute setters. OpenTelemetry accepts primitive attribute values or
// homogeneous arrays of them, but this extension only ever emits scalars, so these
// helpers intentionally accept just string | number | boolean: they drop null/undefined
// and never pass objects or arrays to setAttribute (which the SDK would silently drop or
// warn about). If an array attribute is ever needed, widen AttrValue and handle arrays
// in setAttr/addEvent rather than bypassing these helpers.
import type { Span } from '@opentelemetry/api';

export type AttrValue = string | number | boolean;

export function setAttr(span: Span, key: string, value: AttrValue | null | undefined): void {
  if (value === null || value === undefined) return;
  span.setAttribute(key, value);
}

// Best-effort span end. Ending a span must never throw into pi, so any error is
// swallowed. The guarded-span-op sibling of setAttr — use it everywhere a span is
// closed so the try/catch around .end() lives in exactly one place.
export function endSpan(span: Span): void {
  try {
    span.end();
  } catch {
    /* best-effort: ending a span must never crash pi */
  }
}

// Add a timestamped span event with a guarded primitive attribute bag.
export function addEvent(
  span: Span,
  name: string,
  attrs: Record<string, AttrValue | null | undefined>,
): void {
  const clean: Record<string, AttrValue> = {};
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v !== null && v !== undefined) clean[key] = v;
  }
  span.addEvent(name, clean);
}
