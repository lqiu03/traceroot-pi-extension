import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from './config.ts';
import { buildTraceUrl, redactUrlCredentials } from './url.ts';

test('redactUrlCredentials strips credentials but keeps host and path', () => {
  assert.equal(
    redactUrlCredentials('https://user:s3cret@collector.internal/v1/traces'),
    'https://collector.internal/v1/traces',
  );
  assert.equal(redactUrlCredentials('https://token@host/x'), 'https://host/x');
  // No userinfo: returned unchanged (no spurious rewriting).
  assert.equal(
    redactUrlCredentials('https://app.traceroot.ai/api/v1/public/traces'),
    'https://app.traceroot.ai/api/v1/public/traces',
  );
  // Non-URL value: nothing to redact, returned as-is.
  assert.equal(redactUrlCredentials('not a url'), 'not a url');
});

test('redactUrlCredentials does not leak the password anywhere in its output', () => {
  const out = redactUrlCredentials('https://admin:hunter2@10.0.0.5:4318/v1/traces');
  assert.ok(!out.includes('hunter2'), 'password absent');
  assert.ok(!out.includes('admin'), 'username absent');
  assert.match(out, /10\.0\.0\.5:4318\/v1\/traces/, 'host and path preserved for troubleshooting');
});

test('redactUrlCredentials strips a password even when there is no username', () => {
  // A `:secret@host` form (empty username) must still be redacted — a naive
  // `if (!url.username)` guard would leak it.
  const out = redactUrlCredentials('https://:s3cret@collector.internal/x');
  assert.ok(!out.includes('s3cret'), 'password absent');
  assert.equal(out, 'https://collector.internal/x');
});

test('redactUrlCredentials masks credential-like query parameters, keeps benign ones', () => {
  // Some collectors accept a token via the query string; masking only userinfo would
  // still leak it in status output / the debug log.
  for (const key of ['token', 'api_key', 'apikey', 'access_token', 'x-api-key', 'secret', 'key']) {
    const out = redactUrlCredentials(`https://host/traces?${key}=SECRET123&project=p`);
    assert.ok(!out.includes('SECRET123'), `${key} value is masked`);
    assert.match(out, /project=p/, 'a non-credential param is preserved');
    assert.match(out, new RegExp(`${key}=REDACTED`, 'i'), `${key} shape is kept`);
  }
  // A URL with neither userinfo nor credential params is returned unchanged.
  assert.equal(
    redactUrlCredentials('https://host/traces?traceId=abc'),
    'https://host/traces?traceId=abc',
  );
});

test('redactUrlCredentials masks vendor-prefixed credential params but not benign look-alikes', () => {
  // Prefixed / vendor-specific variants must still be masked (a segment-bounded match),
  // or a real presigned-URL secret leaks in status output or the debug log.
  for (const key of [
    'X-Amz-Signature',
    'X-Amz-Credential',
    'my-api-key',
    'request_signature',
    'x-api-key',
  ]) {
    const out = redactUrlCredentials(`https://host/p?${key}=SECRET123&keep=1`);
    assert.ok(!out.includes('SECRET123'), `${key} value is masked`);
    assert.match(out, /keep=1/, 'a benign param is preserved');
  }
  // Benign names that merely contain a keyword as an UNBOUNDED substring must not be
  // redacted — the segment boundaries prevent that false positive.
  for (const key of ['keyword', 'monkey', 'design']) {
    const out = redactUrlCredentials(`https://host/p?${key}=hello`);
    assert.match(out, new RegExp(`${key}=hello`), `${key} is not a false positive`);
  }
});

const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('builds a deep link when a UUID projectId and traceId are present', () => {
  const config = resolve({ projectId: UUID, uiUrl: 'http://localhost:3000' });
  assert.equal(
    buildTraceUrl(config, 'abc123'),
    `http://localhost:3000/projects/${UUID}/traces?traceId=abc123`,
  );
});

test('trims trailing slashes from the UI base', () => {
  const config = resolve({ projectId: UUID, uiUrl: 'https://app.traceroot.ai/' });
  assert.equal(
    buildTraceUrl(config, 't'),
    `https://app.traceroot.ai/projects/${UUID}/traces?traceId=t`,
  );
});

test('returns null without a projectId (no fabricated URL)', () => {
  const config = resolve({ uiUrl: 'http://localhost:3000' });
  assert.equal(buildTraceUrl(config, 'abc123'), null);
});

test('returns null when projectId is not a UUID (avoids a link that 404s)', () => {
  // A human-readable project name mistakenly set in TRACEROOT_PROJECT_ID must not build
  // a broken deep link — the caller falls back to showing the trace id as plain text.
  for (const notUuid of ['my-project', 'p', '123', '123e4567e89b12d3a456426614174000']) {
    const config = resolve({ projectId: notUuid, uiUrl: 'http://localhost:3000' });
    assert.equal(buildTraceUrl(config, 'abc123'), null, `non-UUID rejected: ${notUuid}`);
  }
  // Uppercase hex is still a valid UUID shape.
  const upper = resolve({ projectId: UUID.toUpperCase(), uiUrl: 'http://localhost:3000' });
  assert.ok(buildTraceUrl(upper, 't'), 'uppercase UUID is accepted');
});

test('returns null without a traceId', () => {
  const config = resolve({ projectId: UUID });
  assert.equal(buildTraceUrl(config, null), null);
});

test('encodes a free-form traceId (no raw shell metacharacters reach the URL)', () => {
  // projectId is now UUID-validated, so the injection surface is the still-free-form
  // traceId; it must be percent-encoded.
  const config = resolve({ projectId: UUID, uiUrl: 'http://localhost:3000' });
  const url = buildTraceUrl(config, 'x y&z');
  assert.ok(url);
  assert.ok(!/[&<>"|^\s]/.test(url), 'the built URL contains no raw shell metacharacters');
  assert.match(url, /\?traceId=x%20y%26z$/);
});
