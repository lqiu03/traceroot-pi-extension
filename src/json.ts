// Serialize-and-truncate helper used for tool args/results and optional payloads.
// Never throws: unserializable values (cycles, BigInt, etc.) degrade to a marker.
const ELLIPSIS = '…';

// Slice a string to at most maxChars UTF-16 code units without splitting a surrogate
// pair: if the cut would land between a high and low surrogate (e.g. mid-emoji), drop
// the dangling high surrogate so the result is always well-formed UTF-16 (a lone
// surrogate corrupts the string when encoded for OTLP export).
export function safeSlice(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const lastKept = value.charCodeAt(maxChars - 1);
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}

export function safeJsonTruncate(value: unknown, maxChars: number): string {
  let serialized: string | undefined;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  if (serialized === undefined) return '';
  if (maxChars <= 0) return '';
  return serialized.length > maxChars ? safeSlice(serialized, maxChars) + ELLIPSIS : serialized;
}

// Budget-aware serializer for the LLM hot path. JSON.stringify has no early exit, so
// safeJsonTruncate on a full request payload serializes an entire late-session
// conversation (often megabytes) to keep at most ~16KB — twice per LLM call. Arrays
// and plain objects are emitted element-by-element from the FRONT (truncation keeps
// the head), stopping once the budget is spent; each element is stringified whole, so
// cost is O(budget + one overshooting element) instead of O(total payload).
// The emitted prefix is byte-identical to JSON.stringify's, so when the value fits
// the budget the output matches safeJsonTruncate exactly, and when it does not the
// truncated result is the same head-slice + ellipsis the old code produced.
export function boundedJsonHead(value: unknown, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (typeof value === 'string') return safeJsonTruncate(value, maxChars);
  try {
    if (value !== null && typeof value === 'object') {
      // JSON.stringify calls toJSON on ANY object — arrays included — and unwraps boxed
      // primitives (new Number / new String / new Boolean) to their primitive form. The
      // manual array/object fast-paths below reproduce neither, so anything with a
      // toJSON hook or a boxed-primitive identity must go through the real serializer
      // first; otherwise the "byte-identical to JSON.stringify" guarantee breaks (and a
      // redacting toJSON would be silently bypassed — a privacy concern). These are rare
      // and small, so losing the early-exit here does not matter for the hot path.
      if (
        typeof (value as { toJSON?: unknown }).toJSON === 'function' ||
        value instanceof Number ||
        value instanceof String ||
        value instanceof Boolean
      ) {
        return safeJsonTruncate(value, maxChars);
      }
      if (Array.isArray(value)) {
        let out = '[';
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out += ',';
          out += JSON.stringify(value[i]) ?? 'null'; // undefined/function elements are null, per JSON.stringify
          if (out.length > maxChars) return safeSlice(out, maxChars) + ELLIPSIS;
        }
        out += ']';
        return out.length > maxChars ? safeSlice(out, maxChars) + ELLIPSIS : out;
      }
      const record = value as Record<string, unknown>;
      let out = '{';
      let first = true;
      for (const key of Object.keys(record)) {
        const fieldJson = JSON.stringify(record[key]);
        if (fieldJson === undefined) continue; // functions/undefined are skipped, per JSON.stringify
        if (!first) out += ',';
        first = false;
        out += `${JSON.stringify(key)}:${fieldJson}`;
        if (out.length > maxChars) return safeSlice(out, maxChars) + ELLIPSIS;
      }
      out += '}';
      return out.length > maxChars ? safeSlice(out, maxChars) + ELLIPSIS : out;
    }
    // Primitives (number, boolean, null, undefined) — defer to the real serializer.
    return safeJsonTruncate(value, maxChars);
  } catch {
    return '[unserializable]';
  }
}
