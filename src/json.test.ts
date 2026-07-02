import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedJsonHead, safeJsonTruncate, safeSlice } from './json.ts';

test('returns short strings unchanged', () => {
  assert.equal(safeJsonTruncate('hello', 2048), 'hello');
});

// U+20000 is a supplementary-plane CJK ideograph: in UTF-16 it is a surrogate pair
// (two code units), which is what these tests exercise. Any astral character works;
// a non-emoji one is used deliberately.
const ASTRAL = '\u{20000}';

test('safeSlice does not split a surrogate pair at the truncation boundary', () => {
  // "ab" + an astral character (a surrogate pair, 2 code units). Cutting at 3 would
  // land between the high and low surrogate; safeSlice must drop the dangling high one.
  const value = `ab${ASTRAL}`;
  const sliced = safeSlice(value, 3);
  assert.equal(sliced, 'ab', 'the half character is dropped, not left as a lone surrogate');
  assert.ok(!/[\uD800-\uDBFF]$/.test(sliced), 'no trailing lone high surrogate');
});

test('safeSlice keeps a whole surrogate pair when it fits', () => {
  const value = `a${ASTRAL}b`;
  assert.equal(safeSlice(value, 3), `a${ASTRAL}`);
});

test('safeJsonTruncate never emits a trailing lone surrogate', () => {
  const value = 'x'.repeat(2047) + ASTRAL; // the surrogate pair starts at index 2047
  const out = safeJsonTruncate(value, 2048);
  assert.ok(
    !/[\uD800-\uDBFF]…?$/.test(out.replace(/…$/, '')),
    'no lone surrogate before the ellipsis',
  );
});

test('stringifies objects', () => {
  assert.equal(safeJsonTruncate({ a: 1 }, 2048), '{"a":1}');
});

test('truncates and appends an ellipsis when over the limit', () => {
  const out = safeJsonTruncate('abcdef', 3);
  assert.equal(out, 'abc…');
});

test('returns empty string for undefined', () => {
  assert.equal(safeJsonTruncate(undefined, 2048), '');
});

test('returns a marker for unserializable values (cycles)', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(safeJsonTruncate(cyclic, 2048), '[unserializable]');
});

test('returns empty string when maxChars is zero', () => {
  assert.equal(safeJsonTruncate('abc', 0), '');
});

// ---------------------------------------------------------------------------
// boundedJsonHead — early-exit serializer for the LLM hot path
// ---------------------------------------------------------------------------

test('boundedJsonHead matches JSON.stringify exactly when the value fits the budget', () => {
  // Byte-identical output is the contract that makes this a pure optimization: the
  // exported attribute must not change because the serializer did.
  const samples: unknown[] = [
    { model: 'gpt-4o', input: [{ role: 'user', content: 'hi' }], tools: [] },
    [1, 'two', null, true, { nested: { deep: [3] } }],
    [{ role: 'user', content: `unicode ${'\u{20000}'} text` }],
    { emptyObj: {}, emptyArr: [], zero: 0, negative: -1.5 },
    { withUndefined: undefined, fn: () => {}, kept: 'yes' },
    [undefined, () => {}, 'kept'],
    { date: new Date(0) }, // toJSON on a nested value
    'plain string',
    42,
    null,
    true,
  ];
  for (const value of samples) {
    assert.equal(
      boundedJsonHead(value, 1_000_000),
      // A plain string input mirrors safeJsonTruncate (raw text), not JSON quoting.
      typeof value === 'string' ? value : JSON.stringify(value),
      `mismatch for ${JSON.stringify(value) ?? typeof value}`,
    );
  }
});

test('boundedJsonHead truncation equals the head-slice of the full serialization', () => {
  const conversation = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `message number ${i} with some padding text `.repeat(5),
  }));
  const budget = 512;
  const full = JSON.stringify(conversation);
  assert.equal(
    boundedJsonHead(conversation, budget),
    safeSlice(full, budget) + '…',
    'same head-slice + ellipsis the old full-serialize path produced',
  );
});

test('boundedJsonHead stops serializing near the budget instead of walking the whole array', () => {
  // A poisoned element far past the budget: the old path (full JSON.stringify) would
  // throw on it and degrade the WHOLE attribute to "[unserializable]"; the bounded
  // path never reaches it. This doubles as proof the tail is not being serialized.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const value = [
    ...Array.from({ length: 50 }, (_, i) => ({ index: i, text: 'x'.repeat(64) })),
    cyclic, // far beyond the 512-char budget
  ];
  const out = boundedJsonHead(value, 512);
  assert.ok(out.endsWith('…'), 'truncated');
  assert.ok(out.startsWith('[{"index":0'), 'head content preserved');
});

test('boundedJsonHead degrades to the marker when the poison is inside the budget', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(boundedJsonHead([cyclic], 512), '[unserializable]');
});

test('boundedJsonHead honors toJSON on the top-level value', () => {
  const value = { toJSON: () => ({ replaced: true }) };
  assert.equal(boundedJsonHead(value, 1000), JSON.stringify(value));
});

test('boundedJsonHead unwraps boxed primitives like JSON.stringify does', () => {
  // Boxed primitives are objects with no toJSON, so the manual object path would emit
  // {} or {"0":"x"}; JSON.stringify unwraps them to their primitive form. Byte-identity
  // requires routing them through the real serializer.
  const cases: unknown[] = [new Number(1), new Boolean(false), new String('secret')];
  for (const value of cases) {
    assert.equal(boundedJsonHead(value, 1000), JSON.stringify(value), `boxed ${typeof value}`);
  }
  assert.equal(boundedJsonHead(new Number(1), 1000), '1');
  assert.equal(boundedJsonHead(new String('x'), 1000), '"x"');
  assert.equal(boundedJsonHead(new Boolean(false), 1000), 'false');
});

test('boundedJsonHead respects a custom toJSON on an array (redaction is not bypassed)', () => {
  // JSON.stringify calls toJSON on arrays too. If the array fast-path ran first, a
  // redacting toJSON would be silently ignored — the value would leak in full.
  const redacted = [1, 2, 3] as number[] & { toJSON?: () => string };
  redacted.toJSON = () => '[REDACTED]';
  assert.equal(boundedJsonHead(redacted, 1000), JSON.stringify(redacted));
  assert.equal(boundedJsonHead(redacted, 1000), '"[REDACTED]"');
});

test('boundedJsonHead returns empty string when maxChars is zero', () => {
  assert.equal(boundedJsonHead({ a: 1 }, 0), '');
});
