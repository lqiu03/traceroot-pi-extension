# @traceroot-ai/pi-extension

[![npm](https://img.shields.io/npm/v/@traceroot-ai/pi-extension)](https://www.npmjs.com/package/@traceroot-ai/pi-extension)
[![CI](https://github.com/traceroot-ai/traceroot-pi-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/traceroot-ai/traceroot-pi-extension/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

TraceRoot extension for [pi](https://github.com/earendil-works/pi-coding-agent).
Automatically traces pi sessions, turns, LLM calls, and tool executions to
[TraceRoot](https://traceroot.ai) as OpenTelemetry spans.

## What gets traced

- **Session spans** — one root span per pi session that produces at least one
  turn; zero-prompt sessions emit nothing. The first prompt is the session's
  Input, the last assistant response its Output, and the span carries source
  attribution (cwd, workspace, git repo, hostname, username, OS).
- **Turn spans** — one span per user prompt / agent run, with the prompt and
  final assistant text as Input/Output.
- **LLM spans** — one span per model round-trip: token usage (including cache
  reads and writes), per-call cost, finish reason, thinking level, rate-limit
  headers, and context-window usage. Failed or aborted responses are marked as
  span errors.
- **Tool spans** — one span per tool execution, parallel-safe and named
  descriptively (`bash: npm test`, `read: app.py`), with arguments, result
  preview, error state, and duration.
- **Compaction spans** — one span per context compaction, with tokens before.

Trace shape:

```
pi.session
├── pi.turn                       (one per prompt)
│   ├── {provider}/{model}        (LLM span: tokens, cost, finish reason)
│   │   ├── read: app.py
│   │   └── bash: npm test        (parallel-safe; keyed by tool call id)
│   └── {provider}/{model}        (second round-trip after tool results)
│       └── write: notes.md
└── pi.compaction
```

## Install

```bash
pi install npm:@traceroot-ai/pi-extension
```

From a clone of this repo:

```bash
pi install .
```

## Quick start

Tracing is **opt-in**: the extension registers no listeners and emits no spans
unless enabled.

### TraceRoot Cloud

```bash
TRACEROOT_ENABLED=true \
TRACEROOT_API_KEY=<your-token> \
pi
```

### Self-hosted / local TraceRoot

```bash
TRACEROOT_ENABLED=true \
TRACEROOT_LOCAL_MODE=true \
TRACEROOT_API_KEY=<local-token> \
TRACEROOT_PROJECT_ID=<project-uuid> \
pi
```

`TRACEROOT_LOCAL_MODE=true` points the exporter at `http://localhost:8000` and
the trace-link UI at `http://localhost:3000`. `TRACEROOT_PROJECT_ID` (the
project UUID) is only needed for the clickable trace URL in the TUI.

While tracing is active, the TUI shows a status indicator and a trace-URL
widget. Run `/traceroot status` at any time to see the resolved configuration
and the active trace.

## Configuration

Precedence, lowest to highest: built-in defaults, `~/.pi/agent/traceroot.json`,
then environment variables. A project-local `.pi/traceroot.json` is also merged,
but only when the project is trusted and only for presentation fields (`project`,
`projectId`, `showUiIndicator`, `debug`) — never the token or endpoint.

Example `~/.pi/agent/traceroot.json`:

```json
{
  "enabled": true,
  "token": "<your-token>",
  "project": "my-project",
  "projectId": "<project-uuid>",
  "debug": false
}
```

The file accepts the settings from the table below as camelCase keys
(`TRACEROOT_ENABLED` → `enabled`, `TRACEROOT_API_KEY` → `token`,
`TRACEROOT_HOST_URL` → `apiUrl`, `TRACEROOT_CAPTURE_TOOL_IO` → `captureToolIo`,
and so on).

| Environment variable                                     | Default                                    | Description                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRACEROOT_ENABLED` (alias `TRACEROOT_PI_ENABLED`)       | `false`                                    | Master opt-in. No spans unless `true`.                                                                                                                                                                             |
| `TRACEROOT_API_KEY` (alias `TRACEROOT_TOKEN`)            | —                                          | Traceroot access token (Bearer). Required.                                                                                                                                                                         |
| `TRACEROOT_LOCAL_MODE`                                   | `false`                                    | Use localhost defaults for endpoint and UI.                                                                                                                                                                        |
| `TRACEROOT_HOST_URL` (alias `TRACEROOT_API_URL`)         | `https://app.traceroot.ai`                 | Ingest API base.                                                                                                                                                                                                   |
| `TRACEROOT_OTLP_ENDPOINT`                                | `<api>/api/v1/public/traces`               | Explicit OTLP endpoint override.                                                                                                                                                                                   |
| `TRACEROOT_UI_URL`                                       | `https://app.traceroot.ai`                 | Web UI base for trace links.                                                                                                                                                                                       |
| `TRACEROOT_PROJECT`                                      | `pi`                                       | Project label.                                                                                                                                                                                                     |
| `TRACEROOT_PROJECT_ID`                                   | —                                          | Project UUID, used to build trace URLs.                                                                                                                                                                            |
| `TRACEROOT_SERVICE_NAME`                                 | `pi-agent`                                 | OTel `service.name`.                                                                                                                                                                                               |
| `TRACEROOT_ENVIRONMENT`                                  | `development`                              | Deployment environment.                                                                                                                                                                                            |
| `TRACEROOT_GITHUB_OWNER` / `_REPO_NAME` / `_COMMIT_HASH` | —                                          | Optional source attribution.                                                                                                                                                                                       |
| `TRACEROOT_CAPTURE_FULL_PAYLOAD`                         | `false`                                    | Capture full LLM request payloads **and** the request-message Input panel (`traceroot.span.input`). Off by default: LLM spans then record only `request_message_count`, not conversation content. May contain PII. |
| `TRACEROOT_CAPTURE_TOOL_IO`                              | `true`                                     | Capture tool-call arguments and results (truncated) on tool spans. Set `false` to record only the tool name, error state, and duration.                                                                            |
| `TRACEROOT_SHOW_UI`                                      | `true`                                     | Show the TUI status indicator and trace-URL widget.                                                                                                                                                                |
| `TRACEROOT_PI_DEBUG`                                     | `false`                                    | Log span lifecycle to stderr, and to a debug log under the state dir.                                                                                                                                              |
| `TRACEROOT_LOG_FILE`                                     | —                                          | Write the JSON-lines debug log to this file instead.                                                                                                                                                               |
| `TRACEROOT_STATE_DIR`                                    | `~/.pi/agent/state/traceroot-pi-extension` | Where session-continuity state (reload/resume/fork) and the default debug log live.                                                                                                                                |
| `TRACEROOT_ADDITIONAL_METADATA`                          | —                                          | JSON object of extra key/values added to the session span.                                                                                                                                                         |
| `PI_PARENT_SPAN_ID` / `PI_ROOT_SPAN_ID`                  | —                                          | Nest this session under a remote parent (subagent tracing); 16-hex span / 32-hex trace.                                                                                                                            |

## The `/traceroot` command

In the TUI, `/traceroot <subcommand>`:

- `status` — print the resolved config (enabled, project, endpoint), session
  state, and the active trace URL
- `open` — open the active trace in your browser
- `flush` — force-flush pending spans
- `disable` / `enable` — turn tracing off/on for the current session

## Session continuity & nesting

- **Reload / resume** continue the same trace: new spans are parented under the
  session's persisted root, so a hot-reload or a resumed session stays one trace.
- **Fork** links the new session's trace back to the session it branched from.
- **Subagent nesting**: set `PI_PARENT_SPAN_ID` / `PI_ROOT_SPAN_ID` to nest a
  child run under a parent trace. Ids must be well-formed (16-hex span, 32-hex
  trace); malformed values are ignored and a fresh root is started.

## What lands in TraceRoot

LLM spans use the OpenTelemetry GenAI semantic conventions:

- `gen_ai.system`, `gen_ai.request.model`, `gen_ai.request.thinking_level`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_write_input_tokens`
- `traceroot.pi.total_tokens`, `traceroot.pi.cost_total`, `traceroot.pi.finish_reason`
- `traceroot.pi.request_message_count`, `http.status_code`,
  `traceroot.pi.context_tokens`, `traceroot.pi.context_percentage`

Tool spans: `gen_ai.tool.name`, `gen_ai.tool.call.id`,
`gen_ai.tool.call.arguments` (truncated), `gen_ai.tool.call.result` (truncated),
`traceroot.pi.tool_is_error`, `traceroot.pi.tool_duration_ms`.

LLM spans also capture rate-limit headers when present:
`traceroot.pi.x_ratelimit_*` and `traceroot.pi.retry_after`.

Session spans carry source attribution: `traceroot.pi.cwd`,
`traceroot.pi.workspace`, `traceroot.pi.repo` (git origin slug),
`traceroot.pi.hostname`, `traceroot.pi.username`, `traceroot.pi.os`,
`traceroot.pi.extension_version`, plus any `traceroot.pi.meta.*` from
`TRACEROOT_ADDITIONAL_METADATA`.

Turn spans carry input-event metadata: `traceroot.pi.input_source`,
`traceroot.pi.input_image_count`, `traceroot.pi.input_streaming_behavior`.

Session, turn, LLM, and tool spans populate TraceRoot's Input/Output panels, so
prompts, responses, tool arguments, and tool results are readable directly in
the trace view.

## Reliability

Tracing never crashes pi. Setup failures are caught and the extension returns
quietly. Spans are batched and exported in the background; at every session end,
pending spans are force-flushed with a bounded timeout, and a failed flush
prints a stderr warning instead of failing silently. On quit, provider shutdown
is time-bounded as well, so a hung exporter can never stall pi's exit. Open
spans are closed in reverse nesting order on the way out.

## Troubleshooting

**No traces appearing?**
Confirm `TRACEROOT_ENABLED=true` and a valid `TRACEROOT_API_KEY` are set. Run
`/traceroot status` to see the resolved endpoint and whether the session is
active, and `/traceroot flush` to force pending spans out. Configuration
problems (bad URLs, missing token, boolean typos) are reported at startup as
stderr warnings and a TUI notice. For a full record, set
`TRACEROOT_PI_DEBUG=true` or `TRACEROOT_LOG_FILE=<path>` (JSON lines).

**Traces going to the wrong place?**
Check `TRACEROOT_LOCAL_MODE` and `TRACEROOT_HOST_URL` — `/traceroot status`
prints the exporter endpoint actually in use.

**Extension not loading?**
Reinstall (`pi install npm:@traceroot-ai/pi-extension`) and confirm the package
is listed in `~/.pi/agent/settings.json`. Load and setup failures are printed
as warnings on stderr and never crash pi.

## Requirements

- Node.js >= 22.19
- pi coding agent (installed peer)

## Development

```bash
pnpm install
pnpm check          # version sync + typecheck + tests
pnpm format:check
```

## License

Apache-2.0
