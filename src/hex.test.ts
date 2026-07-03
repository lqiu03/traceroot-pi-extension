import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProjectUuid, isSpanId, isTraceId } from './hex.ts';

test('isProjectUuid accepts 8-4-4-4-12 hex (any case), rejects everything else', () => {
  assert.equal(isProjectUuid('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isProjectUuid('123E4567-E89B-12D3-A456-426614174000'), true, 'uppercase ok');
  assert.equal(isProjectUuid('my-project'), false, 'human-readable name');
  assert.equal(isProjectUuid('123e4567e89b12d3a456426614174000'), false, 'no hyphens');
  assert.equal(isProjectUuid('123e4567-e89b-12d3-a456-42661417400'), false, 'too short');
  assert.equal(isProjectUuid(''), false);
  assert.equal(isProjectUuid(undefined), false);
  assert.equal(isProjectUuid(null), false);
});

test('isTraceId accepts 32 lowercase hex chars only', () => {
  assert.equal(isTraceId('a'.repeat(32)), true);
  assert.equal(isTraceId('0123456789abcdef0123456789abcdef'), true);
  assert.equal(isTraceId('A'.repeat(32)), false); // uppercase
  assert.equal(isTraceId('a'.repeat(31)), false); // too short
  assert.equal(isTraceId('a'.repeat(33)), false); // too long
  assert.equal(isTraceId('g'.repeat(32)), false); // non-hex
  assert.equal(isTraceId(undefined), false);
  assert.equal(isTraceId(null), false);
});

test('isSpanId accepts 16 lowercase hex chars only', () => {
  assert.equal(isSpanId('b'.repeat(16)), true);
  assert.equal(isSpanId('b'.repeat(15)), false);
  assert.equal(isSpanId('b'.repeat(17)), false);
  assert.equal(isSpanId('B'.repeat(16)), false);
  assert.equal(isSpanId(''), false);
});

test('rejects the all-zero "invalid" sentinel ids (W3C Trace Context)', () => {
  assert.equal(isTraceId('0'.repeat(32)), false, 'all-zero trace id is invalid');
  assert.equal(isSpanId('0'.repeat(16)), false, 'all-zero span id is invalid');
  // A single non-zero hex digit makes it valid again.
  assert.equal(isTraceId('0'.repeat(31) + '1'), true);
  assert.equal(isSpanId('1' + '0'.repeat(15)), true);
});
