// Agent turns. Opens the session span lazily on the first agent_start (so a
// no-prompt session produces zero spans), then a pi.turn span per agent loop.
import {
  context,
  SpanKind,
  TraceFlags,
  trace,
  type Context,
  type Link,
  type Span,
} from '@opentelemetry/api';
import { endSpan, setAttr } from '../attributes.ts';
import { IO_LIMITS, lastAssistantText } from '../content.ts';
import { safeJsonTruncate } from '../json.ts';
import { sweepTurnScoped } from '../state.ts';
import { applyProjectLocal, readProjectLocalConfig } from '../project-config.ts';
import { persistSessionTrace } from '../fork-link.ts';
import { remoteParentContext } from '../remote-parent.ts';
import { repoSlug, sessionAttributes } from '../attribution.ts';
import { buildTraceUrl } from '../url.ts';
import { setConfigIssue, setStatus, setTraceWidget, STATUS_ACTIVE } from '../ui.ts';
import type { MetadataValue, TracerootPiConfig } from '../config.ts';
import { safeOn } from '../runtime.ts';
import type { Runtime } from '../runtime.ts';
import type { BeforeAgentStartEvent, ExtensionContext, InputEvent } from '../types.ts';
import type { SpanState } from '../state.ts';

function finalizeProjectConfig(rt: Runtime, ctx: ExtensionContext | undefined): void {
  const { state, config, envProvided, debug } = rt;
  if (state.projectFinalized) return;
  state.projectFinalized = true;
  try {
    if (!ctx?.isProjectTrusted?.()) return;
    const raw = readProjectLocalConfig(ctx.cwd ?? process.cwd());
    if (!raw) return;
    const applied = applyProjectLocal(config, raw, envProvided);
    if (applied.length) debug('applied project-local config', applied);
  } catch {
    /* trust check / read failed — keep base config */
  }
}

function sessionLinks(rt: Runtime): Link[] | undefined {
  const { forkLink } = rt.state;
  if (!forkLink) return undefined;
  return [
    {
      context: {
        traceId: forkLink.traceId,
        spanId: forkLink.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      },
    },
  ];
}

function applyAdditionalMetadata(
  span: Span,
  metadata: Record<string, MetadataValue> | undefined,
): void {
  if (!metadata) return;
  for (const key of Object.keys(metadata)) {
    setAttr(span, `traceroot.pi.meta.${key}`, metadata[key]);
  }
}

function applyPendingInput(span: Span, state: SpanState, config: TracerootPiConfig): void {
  const input = state.pendingInput;
  if (!input) return;
  setAttr(span, 'traceroot.pi.input_source', input.source ?? null);
  setAttr(span, 'traceroot.pi.input_streaming_behavior', input.streamingBehavior ?? null);
  setAttr(span, 'traceroot.pi.input_image_count', input.imageCount ?? null);
  // Raw input text can contain anything the user typed; gate it like other payloads.
  if (config.captureFullPayload && input.raw) {
    setAttr(span, 'traceroot.pi.raw_input', safeJsonTruncate(input.raw, IO_LIMITS.turnInput));
  }
  state.pendingInput = null;
}

function surfaceConfigIssue(rt: Runtime, ctx: ExtensionContext | undefined): void {
  if (rt.configIssues.length === 0) return;
  const primary = rt.configIssues.find((issue) => issue.severity === 'error') ?? rt.configIssues[0];
  setConfigIssue(ctx, primary);
}

function openSessionSpan(
  rt: Runtime,
  ctx: ExtensionContext | undefined,
  firstPrompt: string | null,
): void {
  const { tracer, state, config, debug } = rt;
  // Parent context: a reload/resume continuation first, else an env-provided
  // remote parent (subagent nesting). Either keeps this session in an existing
  // trace; otherwise startSpan with no parent begins a fresh root.
  const envParentCtx = remoteParentContext(config.rootSpanId, config.parentSpanId);
  if (!envParentCtx && (config.rootSpanId || config.parentSpanId)) {
    // The subagent-nesting feature failing validation must not be silent: the parent
    // process set the env pair expecting a nested trace, and without this line every
    // child session quietly becomes a fresh root with nothing to explain why.
    debug(
      'PI_ROOT_SPAN_ID/PI_PARENT_SPAN_ID set but rejected (need 32-hex trace id + 16-hex span id); starting a fresh root',
    );
  }
  const parentCtx: Context | undefined =
    (state.resumeFrom && remoteParentContext(state.resumeFrom.traceId, state.resumeFrom.spanId)) ??
    envParentCtx;
  const sessionSpan = tracer.startSpan(
    'pi.session',
    { kind: SpanKind.INTERNAL, links: sessionLinks(rt) },
    parentCtx,
  );
  const cwd = ctx?.cwd ?? process.cwd();
  setAttr(sessionSpan, 'traceroot.pi.start_reason', state.sessionStartReason ?? 'startup');
  // The provider Resource baked in the project known at extension LOAD, but a trusted
  // repo's .pi/traceroot.json is only applied at the first agent_start (which runs
  // finalizeProjectConfig before this). Stamp the effective project on the session
  // span so the documented project-local override actually reaches exported spans;
  // the span attribute supersedes the stale resource attribute downstream.
  setAttr(sessionSpan, 'traceroot.project', config.project);
  // Prompt text is conversation content: gate it (captureContent is the one switch
  // that keeps typed text on-machine) and cap it — a pasted multi-MB log would
  // otherwise ride the span through the batch queue and the OTLP payload uncapped,
  // the only input surface without a limit.
  if (firstPrompt && config.captureContent) {
    setAttr(
      sessionSpan,
      'traceroot.span.input',
      safeJsonTruncate(firstPrompt, IO_LIMITS.turnInput),
    );
  }
  setAttr(sessionSpan, 'traceroot.pi.cwd', cwd);
  const attributes = sessionAttributes(cwd);
  for (const key of Object.keys(attributes)) {
    setAttr(sessionSpan, key, attributes[key]);
  }
  // The repo slug is a git lookup; resolve it off the hot path and attach it to the
  // long-lived session span when it settles, so the first prompt is never blocked on git.
  // repoSlug never rejects, but keep the terminal .catch() so the no-throw guarantee is
  // local here rather than contingent on that invariant (matches session.ts's flush chain).
  void repoSlug(cwd)
    .then((slug) => setAttr(sessionSpan, 'traceroot.pi.repo', slug))
    .catch((error) => debug('repo slug attribution failed', error));
  if (state.forkedFromSessionFile) {
    setAttr(sessionSpan, 'traceroot.pi.forked_from_session', state.forkedFromSessionFile);
  }
  if (config.parentSpanId) setAttr(sessionSpan, 'traceroot.pi.parent_span_id', config.parentSpanId);
  if (config.rootSpanId) setAttr(sessionSpan, 'traceroot.pi.root_span_id', config.rootSpanId);
  applyAdditionalMetadata(sessionSpan, config.additionalMetadata);

  state.sessionSpan = sessionSpan;
  state.sessionCtx = trace.setSpan(context.active(), sessionSpan);
  const sc = sessionSpan.spanContext();
  state.sessionTraceId = sc.traceId;
  try {
    state.sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    state.sessionFile = null;
  }
  // On a reload/resume continuation, keep pointing the persisted file at the
  // original root so repeated reloads stay siblings under it, not a deep chain.
  const persistedRoot = state.resumeFrom ?? { traceId: sc.traceId, spanId: sc.spanId };
  persistSessionTrace(config.stateDir, state.sessionFile, persistedRoot);
  debug('opened session span trace=', sc.traceId, parentCtx ? '(continued)' : '(root)');
}

export function registerTurn(rt: Runtime): void {
  const { state, config } = rt;

  safeOn(rt, 'before_agent_start', async (raw) => {
    const event = raw as BeforeAgentStartEvent;
    state.pendingPrompt = typeof event?.prompt === 'string' ? event.prompt : null;
  });

  // Buffer pi "input" event metadata; applied to the next turn span on agent_start.
  safeOn(rt, 'input', async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as InputEvent;
    state.pendingInput = {
      source: typeof event?.source === 'string' ? event.source : undefined,
      streamingBehavior:
        typeof event?.streamingBehavior === 'string' ? event.streamingBehavior : undefined,
      imageCount: Array.isArray(event?.images) ? event.images.length : undefined,
      // Gate at capture time, not just at apply time: with the flag off a large pasted
      // input would otherwise sit in memory until the next agent_start for no purpose.
      raw: config.captureFullPayload && typeof event?.text === 'string' ? event.text : undefined,
    };
  });

  safeOn(rt, 'agent_start', async (_raw, rawCtx) => {
    // Consume the buffered prompt up front so it never sticks to a later loop
    // (e.g. when this loop is skipped because tracing is disabled).
    const prompt = state.pendingPrompt;
    state.pendingPrompt = null;
    if (state.sessionDisabled) return;
    const ctx = rawCtx as ExtensionContext;
    finalizeProjectConfig(rt, ctx);

    if (!state.sessionSpan) openSessionSpan(rt, ctx, prompt);

    // Defensive: a previous agent loop that never emitted agent_end would leave
    // turn-scoped spans open. Close them before starting a new loop, marked
    // incomplete (this close means the loop was aborted), and consume the aborted
    // turn's index so the next turn does not export a duplicate turn_index.
    if (state.turnSpan) {
      sweepTurnScoped(state);
      setAttr(state.turnSpan, 'traceroot.pi.turn_incomplete', true);
      endSpan(state.turnSpan);
      state.turnSpan = null;
      state.turnCtx = null;
      state.promptIndex += 1;
    }

    setStatus(ctx, config, STATUS_ACTIVE);
    surfaceConfigIssue(rt, ctx);
    const url = buildTraceUrl(config, state.sessionTraceId);
    setTraceWidget(ctx, config, url, state.sessionTraceId);

    const turnSpan = rt.tracer.startSpan(
      'pi.turn',
      { kind: SpanKind.INTERNAL },
      state.sessionCtx ?? undefined,
    );
    setAttr(turnSpan, 'traceroot.pi.turn_index', state.promptIndex);
    // The user prompt is the turn's Input panel — content-gated and capped like the
    // session's first prompt above.
    if (prompt && config.captureContent) {
      setAttr(turnSpan, 'traceroot.span.input', safeJsonTruncate(prompt, IO_LIMITS.turnInput));
    }
    applyPendingInput(turnSpan, state, config);
    state.turnSpan = turnSpan;
    state.turnCtx = trace.setSpan(context.active(), turnSpan);
    rt.debug('opened turn span', state.promptIndex);
  });

  safeOn(rt, 'agent_end', async (raw) => {
    // Close any LLM/tool spans an aborted turn left open, then the turn span.
    sweepTurnScoped(state);
    const turnSpan = state.turnSpan;
    if (!turnSpan) return;
    // Clear references before writing output and ending the span, so the turn span is
    // never left half-closed in state.
    state.turnSpan = null;
    state.turnCtx = null;
    state.promptIndex += 1;
    // The final assistant message is the turn's Output panel (conversation content —
    // gated with the other Input/Output surfaces).
    const output = config.captureContent
      ? lastAssistantText((raw as { messages?: unknown })?.messages, IO_LIMITS.turnOutput)
      : '';
    if (output) setAttr(turnSpan, 'traceroot.span.output', output);
    endSpan(turnSpan);
    rt.debug('closed turn span');
  });
}
