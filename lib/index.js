import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
export const name = 'one-click-restart';
// `tools` is required for the model entry; `webServer` is probed at runtime
// because the HTTP route is optional. `appExit` is also probed at runtime.
export const inject = ['tools'];
// Hostname forms the loopback guard accepts (mirrors the connection package's
// isLoopbackHostname: 'localhost', the IPv6 loopback, and 127.0.0.0/8).
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** Route path served by the optional HTTP entry. */
const RESTART_ROUTE = '/api/restart-harness';
/** Schemastery schema; defaults live here so `cordis.yml` can tune without code edits.
 *
 * Every field is `.volatile()`: restart settings (app identity, delay, the
 * shared token, the two switches) are read per operation and may change at
 * runtime, so schemastery hands us a stable `{ get() }` reference instead of a
 * frozen value. {@link readConfig} resolves them once per operation.
 */
export const Config = Schema.object({
    appName: Schema.string()
        .default('DeepSeek Harness')
        .description('App name for `open -a <name>` on macOS.')
        .volatile(),
    appBundlePath: Schema.string()
        .description('Optional absolute path to the .app bundle.')
        .volatile(),
    relaunchDelayMs: Schema.number()
        .default(1500)
        .description('Delay in ms between process exit and relaunch.')
        .volatile(),
    maxRelaunchAttempts: Schema.number()
        .default(10)
        .description('How many times the watchdog retries relaunching.')
        .volatile(),
    restartToken: Schema.string()
        .default('')
        .description('Shared secret the HTTP route requires; leave empty to auto-generate one per launch.')
        .volatile(),
    enableHttpRoute: Schema.boolean()
        .default(true)
        .description('Expose the restart route for the client button.')
        .volatile(),
    requestGracefulExit: Schema.boolean()
        .default(true)
        .description('Request a bounded graceful exit (ctx.appExit) before relaunch.')
        .volatile(),
});
const here = dirname(fileURLToPath(import.meta.url));
/** Absolute path to the standalone relaunch watchdog entry (survives process exit). */
const WATCHDOG_SCRIPT = join(here, '..', 'scripts', 'relaunch.mjs');
/** Generated restart token cached across plugin reloads within one host process. */
let processRestartToken;
/** How long to wait before force-exiting after a requested graceful exit. */
const HARD_EXIT_FALLBACK_MS = 6000;
/** Grace period after the reply finishes before the exit is requested. */
const REPLY_DRAIN_DELAY_MS = 400;
/**
 * Read one config field, tolerating both shapes: schemastery wraps every
 * `.volatile()` field in a stable `{ get() }` reference, so the live value is
 * read through the reference; a plain value is returned verbatim, so this also
 * works for a Config built without volatile fields.
 */
function configValue(field) {
    if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
        // cosmokit types get() as returning a VolatileSnapshot<T>; for the plain
        // values this plugin reads (string | number | boolean) the snapshot is T.
        return field.get();
    }
    return field;
}
/**
 * Snapshot every config field into plain values, once per operation. A volatile
 * field is meant to be captured for one operation rather than re-read
 * mid-flight, and a mid-restart loader commit then cannot make the watchdog
 * argv, the exit policy, and the log line disagree.
 */
function readConfig(config) {
    return {
        appName: configValue(config.appName),
        appBundlePath: configValue(config.appBundlePath),
        relaunchDelayMs: configValue(config.relaunchDelayMs),
        maxRelaunchAttempts: configValue(config.maxRelaunchAttempts),
        restartToken: configValue(config.restartToken),
        enableHttpRoute: configValue(config.enableHttpRoute),
        requestGracefulExit: configValue(config.requestGracefulExit),
    };
}
/**
 * True when this host process is a supervised child of the Electron app.
 * On desktop the restart must quit the whole application (main.js treats an
 * unrequested host death as fatal, and a disposed host process lingers on its
 * parent IPC), so the watchdog owns the quit-and-relaunch.
 */
export function isDesktopHost() {
    return process.connected === true;
}
/**
 * Loopback guard for the restart route. The route is registered as an `exact`
 * WebServer route, and exact routes win over the Connection package's `/api`
 * prefix route — so the request never passes through that package's
 * `isTrustedApiRequest` fence (loopback Host + `sec-fetch-site` rejection).
 * Both checks are re-implemented here, and the canonical loopback literals are
 * accepted; mirrors packages/client/connection/src/api-request-trust.ts and
 * packages/client/connection/src/loopback-hostname.ts.
 */
export function isTrustedLoopbackRequest(req) {
    // A browser marks a genuine cross-site request; reject it outright.
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const hostHeader = req.headers.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (typeof host !== 'string' || host === '')
        return false;
    // Strip the optional `:port` suffix; `[::1]:8080` keeps its brackets, and
    // a bare IPv6 literal keeps every colon instead of being split at the
    // first one (the set above lists '::1' as an accepted form).
    const authority = host.startsWith('[')
        ? host.slice(0, host.indexOf(']') + 1)
        : host.includes('::')
            ? host
            : host.split(':')[0];
    return LOOPBACK_HOSTNAMES.has(authority.toLowerCase());
}
/**
 * Spawn a fully-detached watchdog that relaunches the app after this process
 * (and the Electron main process) has exited — or, with `quitApp` (desktop),
 * that quits the running application first and then relaunches it.
 *
 * Detachment details matter:
 *   - `detached: true` puts the child in its own process group/session so it is
 *     not killed when the parent (host) exits.
 *   - `stdio: 'ignore'` severs the pipes so the child never blocks on a closed fd.
 *   - `child.unref()` lets the current event loop exit without waiting for the child.
 * The watchdog carries the app identity + policy through argv, not env, so no
 * secret/state leaks and it survives independently.
 */
function spawnWatchdog(config, options) {
    const argv = [
        WATCHDOG_SCRIPT,
        '--app-name', config.appName,
        '--delay', String(config.relaunchDelayMs),
        '--attempts', String(config.maxRelaunchAttempts),
        ...(config.appBundlePath ? ['--app-path', config.appBundlePath] : []),
        ...(options?.quitApp === true ? ['--quit-app'] : []),
    ];
    const child = spawn(process.execPath, argv, {
        detached: true,
        stdio: 'ignore',
        // On desktop process.execPath is the Electron binary; without this the
        // "node" script would boot a second GUI app instead of the watchdog.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    // Detach from our event loop; the child lives on in its own process group.
    child.unref();
}
/**
 * Request the launcher's bounded graceful exit (`ctx.appExit(0)`), probed
 * live at call time. Returns whether a bounded exit was actually requested.
 *
 * A completed dispose only sets `process.exitCode`; the process then exits
 * when its event loop drains — which a supervised host (parent IPC, stdio
 * pipes) may never do. The hard-exit fallback below only fires if the
 * launcher's own shutdown (including its force-exit timer) has not ended the
 * process by then.
 */
export function requestGracefulExit(ctx) {
    const appExit = ctx.get('appExit');
    if (appExit === undefined)
        return false;
    queueMicrotask(() => appExit(0));
    setTimeout(() => process.exit(0), HARD_EXIT_FALLBACK_MS);
    return true;
}
/**
 * Perform the restart: spawn the surviving watchdog, then request a bounded
 * graceful exit when the launcher provided one. Safe to call from the tool or
 * the HTTP route.
 *
 * Desktop (`process.connected`): no host-side exit at all — the watchdog
 * gracefully quits the whole application (a clean quit Apple Event) and
 * relaunches it once it is gone; this process dies with the app. Exiting the
 * host alone would either hang on its parent IPC or surface Electron's fatal
 * recovery dialog.
 *
 * Web/headless: the single harness process exits itself via `ctx.appExit`.
 * Pass `deferExit: true` to skip the exit request — the HTTP handler flushes
 * its reply first and then calls {@link requestGracefulExit} from the
 * response's `finish` event; exiting on a microtask races the socket write
 * and the browser reports "Failed to fetch" even though the restart is
 * underway.
 *
 * `config` is a plain value snapshot (see {@link readConfig}), not the raw
 * schema output whose volatile fields are `{ get() }` references.
 */
export function performRestart(ctx, config, overrides) {
    const delayMs = overrides?.delayMs !== undefined ? overrides.delayMs : config.relaunchDelayMs;
    const policy = { ...config, relaunchDelayMs: Math.max(0, delayMs) };
    const desktop = isDesktopHost();
    // 1. Spawn the detached watchdog first — it must survive our own exit.
    spawnWatchdog(policy, { quitApp: desktop });
    // 2. Exit policy (see above).
    const shouldGraceful = !desktop && config.requestGracefulExit && overrides?.deferExit !== true
        ? requestGracefulExit(ctx)
        : false;
    const detail = desktop
        ? `Restart scheduled: the watchdog will quit and relaunch "${policy.appName}".`
        : shouldGraceful
            ? `Restart scheduled: watchdog will relaunch "${policy.appName}" after this instance exits (graceful exit requested).`
            : overrides?.deferExit === true
                ? `Restart scheduled: watchdog will relaunch "${policy.appName}" after this instance exits (exit requested after the reply flushes).`
                : `Relaunch scheduled: watchdog will relaunch "${policy.appName}" after this instance exits (no graceful-exit service available).`;
    return { watchdogSpawned: true, gracefulExitRequested: shouldGraceful, detail };
}
/**
 * The `restart_harness` tool body — the primary "one-click" entry. Extracted
 * from `apply` so the three concerns (tool / HTTP route / token wiring) read
 * separately; behavior is unchanged.
 */
function createRestartTool({ ctx, snapshot }) {
    return defineTool({
        name: 'restart_harness',
        description: 'Restart the DeepSeek Harness application. Spawns a detached watchdog that ' +
            'relaunches the app after the current instance exits, then requests a graceful ' +
            'exit of the current process. On macOS this relaunches via `open -a`; the watchdog ' +
            'retries until the app is back up or a configured attempt limit is reached.',
        parameters: {
            delayMs: {
                type: 'number',
                description: 'Optional override (ms) to wait after exit before relaunching. Defaults to the configured delay.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    watchdogSpawned: {
                        type: 'boolean',
                        required: true,
                        description: 'Whether the detached relaunch watchdog was spawned.',
                    },
                    gracefulExitRequested: {
                        type: 'boolean',
                        required: true,
                        description: 'Whether a bounded graceful exit was requested from the launcher.',
                    },
                    detail: {
                        type: 'string',
                        required: true,
                        description: 'Human-readable summary of what will happen next.',
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.detail }],
        },
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const result = performRestart(ctx, snapshot(), {
                delayMs: typeof args.delayMs === 'number' ? args.delayMs : undefined,
            });
            return {
                watchdogSpawned: result.watchdogSpawned,
                gracefulExitRequested: result.gracefulExitRequested,
                detail: result.detail,
            };
        },
    });
}
/**
 * The HTTP handler behind the optional loopback route. Extracted from `apply`
 * (same behavior, one concern per function):
 *
 *   GET  — hands the apply-time token to a same-origin loopback page.
 *   POST — validates `x-restart-token` against the live snapshot, then restarts
 *          with `deferExit`; on web the exit is requested from the response's
 *          `finish` event so the reply flushes first.
 *
 * This exact route shadows the Connection package's `/api` prefix route, so the
 * host's API trust fence never runs on it — the loopback/cross-site fence is
 * re-checked here (see {@link isTrustedLoopbackRequest}).
 */
function createRestartRouteHandler({ ctx, restartToken, snapshot }) {
    return (req, res) => {
        if (!isTrustedLoopbackRequest(req)) {
            res.statusCode = 403;
            res.end('forbidden');
            return;
        }
        if (req.method === 'GET') {
            // Fast path only: hand the token to a page the host renders itself.
            // `webserver/index-inject` is emitted on every index render and the
            // `global` row lands a value on `globalThis` for the browser bundle.
            // The desktop window loads its index from the app bundle's static
            // dist, where the row never appears — that is why the client also
            // fetches the token over GET on the same route.
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify({ token: restartToken }), 'utf8');
            return;
        }
        if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Allow', 'GET, POST');
            res.end('method not allowed');
            return;
        }
        // Compare against the live token: a configured token may have
        // been committed since apply.
        if (req.headers['x-restart-token'] !== snapshot().restartToken) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
        }
        const result = performRestart(ctx, snapshot(), { deferExit: true });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        if (!isDesktopHost()) {
            // Web: flush the reply and give the client a moment to read it
            // before tearing anything down — exiting immediately after
            // `finish` can reset the socket mid-read (the client then sees a
            // network error instead of the 200). The exit must also hook the
            // response's `finish`/`close` events, NOT an `res.end` callback:
            // the composition wraps responses in the npm `compression`
            // middleware, whose `end(chunk, encoding)` override silently
            // drops a callback argument. (Desktop skips this: the watchdog
            // quits the whole app after a delay, and this process dies with
            // it.)
            let exitRequested = false;
            const requestExitOnce = () => {
                if (exitRequested)
                    return;
                exitRequested = true;
                setTimeout(() => requestGracefulExit(ctx), REPLY_DRAIN_DELAY_MS);
            };
            res.once('finish', requestExitOnce);
            res.once('close', requestExitOnce);
        }
        res.end(JSON.stringify({
            ok: true,
            watchdogSpawned: result.watchdogSpawned,
            gracefulExitRequested: result.gracefulExitRequested,
        }), 'utf8');
    };
}
export function apply(ctx, config) {
    // Every config field is volatile (a stable `{ get() }` reference). Three
    // consequences shape this function:
    //   - plain values are resolved once per operation, so the tool body and the
    //     HTTP handler never touch a reference mid-flight;
    //   - the generated token is cached per process, so an HMR reload keeps
    //     serving the token an already-loaded page fetched;
    //   - `enableHttpRoute` is captured at apply time — toggling it takes a
    //     plugin reload, which is also what re-registers the route.
    const initial = readConfig(config);
    const restartToken = initial.restartToken || (processRestartToken ??= randomBytes(16).toString('hex'));
    /** Snapshot the live config again, for one tool call or HTTP request. */
    const snapshot = () => {
        const values = readConfig(config);
        return { ...values, restartToken: values.restartToken || restartToken };
    };
    // ---- Model-callable tool entry (the primary "one-click" entry). ----
    ctx.tools.register(createRestartTool({ ctx, snapshot }));
    // ---- Optional loopback HTTP route for the client sidebar button. ----
    // The webserver entry mounts later than this bundle (its apply awaits the
    // cmdline/startup services), so a one-shot `ctx.get('webServer')` probe at
    // apply time loses the race and the route would never exist. `ctx.inject`
    // runs the callback whenever the service arrives (and unloads it again if
    // the service goes away); a deployment with no webServer (headless) simply
    // leaves the wait pending, which keeps no process alive.
    if (initial.enableHttpRoute) {
        ctx.inject(['webServer'], (webCtx) => {
            const webServer = webCtx.get('webServer');
            if (webServer === undefined)
                return;
            webCtx.on('webserver/index-inject', (table) => {
                table.push({ kind: 'global', name: '__DSH_RESTART_TOKEN__', value: restartToken });
            });
            // The disposer removes the route; attached to this child fiber, so it
            // also runs when the webServer service is lost or this plugin unloads
            // (a re-registered identical route would otherwise throw as duplicate).
            webCtx.effect(() => webServer.register({
                kind: 'exact',
                path: RESTART_ROUTE,
                handler: createRestartRouteHandler({ ctx, restartToken, snapshot }),
            }), 'one-click-restart: /api/restart-harness route');
            ctx.logger(name).info('one-click-restart: restart HTTP route ready (GET token, POST restart on /api/restart-harness)');
        });
    }
    ctx.logger(name).info('one-click-restart ready (app=%s, delayMs=%d, http=%s)', initial.appName, initial.relaunchDelayMs, initial.enableHttpRoute);
    // Expose the token to other host plugins that may want to build their own
    // entry (read-only; no side effects). The name is namespaced with the
    // package id so it cannot collide with another plugin's service.
    ctx.provide('oneClickRestart.token', { get: () => snapshot().restartToken });
}
