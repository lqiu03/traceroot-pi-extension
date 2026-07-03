import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, type TracerootPiConfig } from './config.ts';
import {
  applyProjectLocal,
  PROJECT_LOCAL_FIELDS,
  readProjectLocalConfig,
} from './project-config.ts';

test('applyProjectLocal handles exactly the fields in PROJECT_LOCAL_FIELDS (drift guard)', () => {
  // baselineFor and the apply blocks repeat the field list for type-safe indexing, which
  // TS cannot verify against the constant. This guard fails if the constant and the code
  // drift: every field must be referenced in applyProjectLocal, and no stray field name
  // should be handled that is not in the constant.
  const src = readFileSync(new URL('./project-config.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function applyProjectLocal'));
  for (const field of PROJECT_LOCAL_FIELDS) {
    assert.ok(
      new RegExp(`envProvided\\.has\\('${field}'\\)`).test(body),
      `applyProjectLocal must handle the "${field}" field from PROJECT_LOCAL_FIELDS`,
    );
  }
  // Conversely, every field guarded in applyProjectLocal must be a declared constant.
  const handled = [...body.matchAll(/envProvided\.has\('(\w+)'\)/g)]
    .map((m) => m[1])
    .filter((f): f is string => !!f);
  for (const field of handled) {
    assert.ok(
      (PROJECT_LOCAL_FIELDS as readonly string[]).includes(field),
      `applyProjectLocal handles "${field}" which is not in PROJECT_LOCAL_FIELDS`,
    );
  }
});

test('readProjectLocalConfig refuses to read an untrusted project (self-enforced boundary)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-proj-'));
  try {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), JSON.stringify({ project: 'evil' }));
    // Even though a file is present, an untrusted project must never be read — the
    // module enforces this itself, not only the turn.ts call site.
    assert.equal(readProjectLocalConfig(dir, false).kind, 'missing', 'untrusted: file is not read');
    const trusted = readProjectLocalConfig(dir, true);
    assert.equal(trusted.kind, 'ok');
    assert.deepEqual(trusted.kind === 'ok' ? trusted.config : null, { project: 'evil' });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('readProjectLocalConfig surfaces a malformed trusted file (not silently missing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tr-proj-'));
  try {
    mkdirSync(join(dir, '.pi'));
    writeFileSync(join(dir, '.pi', 'traceroot.json'), '{ oops not json');
    // A trusted file that exists but is unusable must be distinguishable from "no file",
    // so the caller can warn like the global-file path does.
    assert.equal(readProjectLocalConfig(dir, true).kind, 'invalid-json');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('applies allowed project-local fields', () => {
  const config = resolve({});
  const applied = applyProjectLocal(
    config,
    { project: 'my-test-project', projectId: 'uuid-1', showUiIndicator: false },
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied.sort(), ['project', 'projectId', 'showUiIndicator']);
  assert.equal(config.project, 'my-test-project');
  assert.equal(config.projectId, 'uuid-1');
  assert.equal(config.showUiIndicator, false);
});

test('env-provided fields are not overridden by project-local', () => {
  const config = resolve({ project: 'from-env' });
  const applied = applyProjectLocal(
    config,
    { project: 'from-file' },
    new Set<keyof TracerootPiConfig>(['project']),
  );
  assert.deepEqual(applied, []);
  assert.equal(config.project, 'from-env');
});

test('never applies the token from a project-local file', () => {
  const config = resolve({});
  applyProjectLocal(
    config,
    { token: 'leaked-token', project: 'ok' } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.equal(config.token, '');
  assert.equal(config.project, 'ok');
});

test('ignores project-local values whose runtime type does not match the field', () => {
  const config = resolve({});
  const applied = applyProjectLocal(
    config,
    { projectId: 42, debug: 'yes', showUiIndicator: 'true' } as Record<string, unknown>,
    new Set<keyof TracerootPiConfig>(),
  );
  assert.deepEqual(applied, [], 'type-mismatched values are not applied');
  assert.equal(config.projectId, undefined, 'a numeric projectId is rejected');
  assert.equal(config.debug, false, 'a string debug does not turn debug on');
  assert.equal(config.showUiIndicator, true, 'a string showUiIndicator keeps the default');
});

test('applies a well-typed boolean debug from a trusted project-local file', () => {
  const config = resolve({});
  const applied = applyProjectLocal(config, { debug: true }, new Set<keyof TracerootPiConfig>());
  assert.deepEqual(applied, ['debug']);
  assert.equal(config.debug, true);
});

test('a dropped override is restored to baseline on a later apply (no cross-session bleed)', () => {
  // pi reuses one config across sessions. Session 1 in a trusted repo sets debug=true and
  // project via project-local; session 2 (same config) has a file that no longer sets
  // them. Those fields must revert to the env/global baseline, not keep session 1's value.
  const config = resolve({ project: 'global-default' });
  const noEnv = new Set<keyof TracerootPiConfig>();

  applyProjectLocal(config, { debug: true, project: 'repo-a' }, noEnv);
  assert.equal(config.debug, true);
  assert.equal(config.project, 'repo-a');

  const applied = applyProjectLocal(config, {}, noEnv); // session 2: empty file
  assert.deepEqual(applied, [], 'nothing applied from the empty file');
  assert.equal(config.debug, false, 'debug reverts to the baseline (default false)');
  assert.equal(config.project, 'global-default', 'project reverts to the global baseline');
});

test('a re-applied override still wins on the next session', () => {
  // The baseline restore must not clobber a value the CURRENT session does set.
  const config = resolve({ project: 'global-default' });
  const noEnv = new Set<keyof TracerootPiConfig>();
  applyProjectLocal(config, { project: 'repo-a' }, noEnv);
  applyProjectLocal(config, { project: 'repo-b' }, noEnv);
  assert.equal(config.project, 'repo-b', 'the current session-file value wins');
});

test('an empty apply after an override restores the baseline (the no-file next session)', () => {
  // finalizeProjectConfig calls applyProjectLocal with {} when a session has no usable
  // file, precisely so the baseline is restored rather than the prior override sticking.
  const config = resolve({ project: 'global-default' });
  const noEnv = new Set<keyof TracerootPiConfig>();
  applyProjectLocal(config, { project: 'repo-a', debug: true }, noEnv);
  applyProjectLocal(config, {}, noEnv); // no file → empty raw
  assert.equal(config.project, 'global-default');
  assert.equal(config.debug, false);
});
