// P2-G — the /traceroot command: status | open | flush | disable | enable.
// All UI output goes through ctx.ui.notify; spawning a browser is guarded by mode.
import { spawn } from 'node:child_process';
import { flushWithTimeout, type FlushOutcome } from './session.ts';
import { beginNewSession } from '../state.ts';
import { buildTraceUrl, redactUrlCredentials } from '../url.ts';
import { isProjectUuid } from '../hex.ts';
import { clearWidget, setStatus, STATUS_ACTIVE, STATUS_INACTIVE } from '../ui.ts';
import type { Runtime } from '../runtime.ts';
import type { CommandContext } from '../types.ts';

// The user-facing notification for each flush outcome. A timeout is the interesting
// case: the user typically runs /traceroot flush precisely when the endpoint is
// suspect, so the message must distinguish "hung" from "rejected".
export function flushNotification(outcome: FlushOutcome): {
  message: string;
  level: 'info' | 'error';
} {
  if (outcome === 'flushed') return { message: 'Traceroot: flushed.', level: 'info' };
  if (outcome === 'timeout') {
    return {
      message: 'Traceroot: flush timed out; the endpoint may be unreachable.',
      level: 'error',
    };
  }
  return { message: 'Traceroot: flush failed.', level: 'error' };
}

// Only hand the launcher a well-formed http(s) URL with no characters cmd.exe would
// interpret as shell operators on the Windows `start` path. Defense in depth on top of
// the URL-encoding in buildTraceUrl — the URL we build is already clean, but a launch
// must never become a command-injection vector regardless of where the URL came from.
export function isLaunchableUrl(url: string): boolean {
  // Reject cmd.exe metacharacters, including `%` (cmd expands `%VAR%` in the `/c start`
  // line). A well-formed trace URL never contains any of these.
  if (/[&|<>^"%\s]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// The launcher command + args for opening a URL on the given platform. Windows
// must go through cmd.exe because `start` is a cmd builtin, not an executable on
// PATH; the empty "" is start's title argument so the URL is not swallowed as a
// window title. Returns null on unsupported platforms.
export function browserLaunch(
  osPlatform: string,
  url: string,
): { command: string; args: string[] } | null {
  if (osPlatform === 'darwin') return { command: 'open', args: [url] };
  if (osPlatform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (osPlatform === 'linux') return { command: 'xdg-open', args: [url] };
  return null;
}

// Resolves true only once the child actually spawns. A missing launcher reports
// ENOENT asynchronously via the child's 'error' event (spawn does not throw for
// it), so we listen for it and degrade to false instead of letting it surface as
// an uncaught exception that would crash the host.
function openInBrowser(url: string): Promise<boolean> {
  if (!isLaunchableUrl(url)) return Promise.resolve(false);
  const launch = browserLaunch(process.platform, url);
  if (!launch) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export function registerCommand(rt: Runtime): void {
  const { pi, state, config, provider } = rt;
  if (typeof pi.registerCommand !== 'function') return;

  pi.registerCommand('traceroot', {
    description: 'Traceroot tracing: status | open | flush | disable | enable',
    handler: async (args: string, ctx: CommandContext) => {
      // The command handler runs inside pi's dispatch, which does not catch a rejected
      // handler — an escaped error would become an unhandled rejection in the host.
      // Contain it like the event handlers (safeOn) do.
      try {
        const sub = (args ?? '').trim().split(/\s+/)[0] || 'status';
        const url = buildTraceUrl(config, state.sessionTraceId);

        switch (sub) {
          case 'status': {
            const lines = [
              `enabled=${config.enabled}`,
              `project=${config.project}`,
              // Redact any embedded credentials; the host/path stays visible for
              // troubleshooting.
              `endpoint=${redactUrlCredentials(config.otlpEndpoint)}`,
              state.sessionDisabled ? 'session=disabled' : 'session=active',
              url
                ? `trace=${url}`
                : state.sessionTraceId
                  ? `traceId=${state.sessionTraceId}`
                  : 'trace=none yet',
            ];
            ctx.ui.notify(`Traceroot — ${lines.join('  |  ')}`, 'info');
            return;
          }
          case 'open': {
            if (!url) {
              // Distinguish "set but malformed" from "unset" — telling a user to set a
              // variable they already set (just not as a UUID) sends them the wrong way.
              const badProjectId = config.projectId && !isProjectUuid(config.projectId);
              ctx.ui.notify(
                badProjectId
                  ? 'Traceroot: TRACEROOT_PROJECT_ID is set but is not a valid UUID; no trace URL.'
                  : 'Traceroot: no trace URL yet (set TRACEROOT_PROJECT_ID and run a prompt).',
                'warning',
              );
              return;
            }
            if (ctx.mode !== 'tui') {
              ctx.ui.notify(`Traceroot trace: ${url}`, 'info');
              return;
            }
            ctx.ui.notify(
              (await openInBrowser(url)) ? `Opening ${url}` : `Traceroot trace: ${url}`,
              'info',
            );
            return;
          }
          case 'flush': {
            if (state.providerShutdown) {
              ctx.ui.notify(
                'Traceroot: tracing has shut down for this session; nothing to flush.',
                'warning',
              );
              return;
            }
            // Bounded like every other flush site: an unbounded forceFlush against a hung
            // endpoint wedges this command for the exporter's full internal deadline.
            const outcome = await flushWithTimeout(provider);
            const note = flushNotification(outcome);
            ctx.ui.notify(note.message, note.level);
            return;
          }
          case 'disable': {
            // Finalize the in-flight tree now, then stop opening spans. Re-enabling
            // starts a fresh session span (and a fresh trace) on the next prompt — the
            // same begin-fresh-session step session_start runs.
            beginNewSession(state, 'disabled');
            state.sessionDisabled = true;
            setStatus(ctx, config, STATUS_INACTIVE);
            // The trace-URL widget advertises a trace that will receive no more spans;
            // leaving it up directly contradicts the "disabled" notice below.
            clearWidget(ctx);
            ctx.ui.notify('Traceroot: tracing disabled for this session.', 'info');
            return;
          }
          case 'enable': {
            state.sessionDisabled = false;
            setStatus(ctx, config, STATUS_ACTIVE);
            ctx.ui.notify('Traceroot: tracing enabled for this session.', 'info');
            return;
          }
          default:
            ctx.ui.notify(
              'Traceroot: usage — /traceroot [status|open|flush|disable|enable]',
              'info',
            );
        }
      } catch (err) {
        // A user explicitly invoked this command, so — unlike a background event handler
        // — surface a failure to them, not only to the debug log.
        try {
          ctx.ui.notify('Traceroot: the command failed unexpectedly.', 'error');
        } catch {
          /* ui unavailable in this mode */
        }
        // Guard rt.debug too: a command handler is registered via pi.registerCommand, not
        // through safeOn, so it has no outer backstop — a throwing debug sink here would
        // escape into the host. safeOn wraps rt.debug for exactly this reason; match it.
        try {
          rt.debug('command /traceroot threw', err);
        } catch {
          /* logging the failure must not itself crash the host */
        }
      }
    },
  });
}
