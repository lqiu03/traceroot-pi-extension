// Project-local configuration (.pi/traceroot.json), applied only when the project
// is trusted. For security this layer can only set non-sensitive, presentation-level
// fields — never the token, endpoint, or service identity. Environment variables
// still win over it.
import { join } from 'node:path';
import {
  readJsonConfigResult,
  type JsonConfigResult,
  type RawConfig,
  type TracerootPiConfig,
} from './config.ts';

// Fields a trusted project-local file is permitted to override.
const PROJECT_LOCAL_FIELDS = ['project', 'projectId', 'showUiIndicator', 'debug'] as const;
type ProjectLocalField = (typeof PROJECT_LOCAL_FIELDS)[number];
type ProjectLocalBaseline = Pick<TracerootPiConfig, ProjectLocalField>;

// The env/global baseline of the overridable fields, snapshotted once per config object.
// pi reuses one config across sessions in a process, and applyProjectLocal is the only
// mutator of these four fields, so the config holds the baseline the first time it is
// called. Keyed by the config object (WeakMap) so a session whose project-local file
// drops a key restores the baseline instead of inheriting a prior session's override.
const baselines = new WeakMap<TracerootPiConfig, ProjectLocalBaseline>();

function baselineFor(config: TracerootPiConfig): ProjectLocalBaseline {
  let base = baselines.get(config);
  if (!base) {
    base = {
      project: config.project,
      projectId: config.projectId,
      showUiIndicator: config.showUiIndicator,
      debug: config.debug,
    };
    baselines.set(config, base);
  }
  return base;
}

// The trust decision is a REQUIRED argument, so the boundary this module documents is
// enforced here rather than resting on call-site discipline: an untrusted workspace's
// .pi/traceroot.json is never even read (returns 'missing'). Returns the discriminated
// result so the caller can diagnose a malformed trusted file like the global one, rather
// than dropping it silently. A future caller cannot forget the check.
export function readProjectLocalConfig(cwd: string, isTrusted: boolean): JsonConfigResult {
  if (!isTrusted) return { kind: 'missing' };
  return readJsonConfigResult(join(cwd, '.pi', 'traceroot.json'));
}

// Mutates config in place with allowed project-local fields that env did not set.
// Returns the list of applied field names (for debug logging).
export function applyProjectLocal(
  config: TracerootPiConfig,
  raw: RawConfig,
  envProvided: Set<keyof TracerootPiConfig>,
): ProjectLocalField[] {
  const applied: ProjectLocalField[] = [];
  const base = baselineFor(config);
  // For each overridable field that env did not set: apply the project-local value when
  // present and correctly typed, otherwise RESTORE the baseline. Restoring (rather than
  // leaving the field untouched) is what prevents a prior session's override from
  // sticking when a later session's file drops the key or supplies a malformed value.
  // Env-set fields are left alone entirely — env always wins.
  if (!envProvided.has('project')) {
    if (typeof raw.project === 'string') {
      config.project = raw.project;
      applied.push('project');
    } else {
      config.project = base.project;
    }
  }
  if (!envProvided.has('projectId')) {
    if (typeof raw.projectId === 'string') {
      config.projectId = raw.projectId;
      applied.push('projectId');
    } else {
      config.projectId = base.projectId;
    }
  }
  if (!envProvided.has('showUiIndicator')) {
    if (typeof raw.showUiIndicator === 'boolean') {
      config.showUiIndicator = raw.showUiIndicator;
      applied.push('showUiIndicator');
    } else {
      config.showUiIndicator = base.showUiIndicator;
    }
  }
  if (!envProvided.has('debug')) {
    if (typeof raw.debug === 'boolean') {
      config.debug = raw.debug;
      applied.push('debug');
    } else {
      config.debug = base.debug;
    }
  }
  return applied;
}
