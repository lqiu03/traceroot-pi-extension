// Tool spans, parallel-safe. Keyed by toolCallId (never a single "current tool"),
// parented under the active LLM span. pi runs tools concurrently and their
// start/end events interleave, so position-based tracking would orphan spans.
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { endSpan, setAttr } from '../attributes.ts';
import { safeJsonTruncate } from '../json.ts';
import { IO_LIMITS, renderToolResult } from '../content.ts';
import { formatToolSpanName } from '../span-name.ts';
import { activeParentCtx } from '../state.ts';
import { safeOn } from '../runtime.ts';
import type { Runtime } from '../runtime.ts';
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from '../types.ts';

// A short, single-line error message for a failed tool's span status. Pulls from a
// string result or a result object's error/message field; falls back to a generic
// "<tool> failed". Callers pass this only when content capture is enabled.
function toolErrorText(result: unknown, toolName: string): string {
  if (typeof result === 'string' && result.trim()) return result.slice(0, 256);
  if (result && typeof result === 'object') {
    const record = result as { error?: unknown; message?: unknown };
    const candidate =
      typeof record.error === 'string'
        ? record.error
        : typeof record.message === 'string'
          ? record.message
          : undefined;
    if (candidate && candidate.trim()) return candidate.slice(0, 256);
  }
  return `${toolName} failed`;
}

export function registerTool(rt: Runtime): void {
  const { state, config } = rt;

  safeOn(rt, 'tool_execution_start', async (raw) => {
    if (state.sessionDisabled) return;
    const event = raw as ToolExecutionStartEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    if (state.toolSpans.has(toolCallId)) return; // never double-open the same call

    const toolName = event?.toolName ?? 'unknown';
    // No open session/turn/LLM span means agent_start has not (re)opened the session
    // yet — starting a span with an undefined parent would emit a detached single-span
    // root trace. Skip, honoring activeParentCtx's "caller skips" contract the same
    // way llm.ts does for turn_start.
    const parentCtx = activeParentCtx(state);
    if (!parentCtx) {
      rt.debug('tool_execution_start with no session/turn context; skipping tool span');
      return;
    }
    // The span NAME is always exported, so its command/path suffix must respect the
    // same gate as tool arguments: with captureToolIo off, a descriptive name would
    // still ship the first 60 chars of every shell command (enough for a pasted
    // Authorization header) despite the user's explicit opt-out.
    const span = rt.tracer.startSpan(
      config.captureToolIo ? formatToolSpanName(toolName, event?.args) : toolName,
      { kind: SpanKind.INTERNAL },
      parentCtx,
    );
    setAttr(span, 'gen_ai.tool.name', toolName);
    setAttr(span, 'gen_ai.tool.call.id', toolCallId);
    // Tool arguments routinely carry file paths, file contents, and shell commands.
    // Capture the (truncated) Input panel only when tool-IO capture is enabled; the
    // span still records the tool name, id, and (on end) error state and duration.
    if (config.captureToolIo) {
      setAttr(
        span,
        'gen_ai.tool.call.arguments',
        safeJsonTruncate(event?.args, IO_LIMITS.toolArgs),
      );
    }

    state.toolSpans.set(toolCallId, { span, startTime: Date.now(), toolName });
    rt.debug('opened tool span', toolName, toolCallId);
  });

  safeOn(rt, 'tool_execution_end', async (raw) => {
    const event = raw as ToolExecutionEndEvent;
    const toolCallId = event?.toolCallId;
    if (!toolCallId) return;
    const entry = state.toolSpans.get(toolCallId);
    if (!entry) return; // end without a matching start — ignore rather than orphan

    // Delete the entry up front so a throw below cannot leave it in the map to be
    // force-closed and mislabeled tool_incomplete by a later sweep. All span writes
    // are best-effort and must never crash pi.
    state.toolSpans.delete(toolCallId);
    try {
      // Tool results can carry file contents and command output; gate the Output panel
      // behind tool-IO capture. Error state and duration below are always recorded.
      if (config.captureToolIo) {
        setAttr(
          entry.span,
          'gen_ai.tool.call.result',
          renderToolResult(event?.result, IO_LIMITS.toolResult),
        );
      }
      const isError = event?.isError === true;
      setAttr(entry.span, 'traceroot.pi.tool_is_error', isError);
      setAttr(entry.span, 'traceroot.pi.tool_duration_ms', Date.now() - entry.startTime);
      if (isError) {
        // Surface tool failures as a queryable OTel error status, not only a boolean.
        // Keep the message generic when content capture is off so it cannot leak result
        // text (file contents, command output) through the status message.
        const message = config.captureToolIo
          ? toolErrorText(event?.result, entry.toolName)
          : `${entry.toolName} failed`;
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message });
      }
    } catch {
      /* best-effort */
    } finally {
      endSpan(entry.span);
    }
    rt.debug('closed tool span', entry.toolName, toolCallId);
  });
}
