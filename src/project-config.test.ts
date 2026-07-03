import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, type TracerootPiConfig } from './config.ts';
import { applyProjectLocal, readProjectLocalConfig } from './project-config.ts';

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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
