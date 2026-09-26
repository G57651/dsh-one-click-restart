/**
 * @dsh-restart/one-click-restart — one-click restart entry for DeepSeek Harness.
 *
 * The plugin runs in the **host** Node process (a child of the Electron main
 * process on desktop, or the single `dsh`/`dsh web` process otherwise). It:
 *
 *   1. Registers a `restart_harness` tool so the model (or any plugin injecting
 *      `tools`) can trigger a restart.
 *   2. Registers a loopback HTTP route `POST /api/restart-harness` on the host
 *      `webServer` service, so the client sidebar button (or any same-origin
 *      caller holding the shared token) can trigger the same restart.
 *   3. Spawns a **detached watchdog** (scripts/relaunch.mjs) that survives this
 *      process and handles the relaunch — on desktop it gracefully quits the
 *      whole application first (AppleScript quit event) and relaunches once it
 *      is gone; on web the host exits itself via `ctx.appExit` and the watchdog
 *      relaunches.
 *   4. If the launcher provided `ctx.appExit` (the bounded exit request from
 *      `@deepseek-ai/dsh-cmdline`), requests a graceful `exit(0)` so the current
 *      instance actually quits before the watchdog relaunches it.
 *
 * No host/main.js modification is required: the relaunch is performed by the
 * OS launcher (`open`), orthogonal to the Electron lifecycle.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'one-click-restart'
// `tools` is required for the model entry; `webServer` is probed at runtime
// because the HTTP route is optional. `appExit` is also probed at runtime.
export const inject = ['tools']

/** Configuration for the one-click restart plugin. */
export interface Config {
  /** Name used to identify the app for `open -a`. */
  appName: string
  /** Optional absolute path to the .app bundle (fallback when `-a` matches nothing). */
  appBundlePath?: string
  /** Milliseconds to wait after exit before relaunching. */
  relaunchDelayMs: number
  /** Maximum relaunch attempts before the watchdog gives up. */
  maxRelaunchAttempts: number
  /** Shared token the client button must present to the HTTP restart route. */
  restartToken: string
  /** Whether to expose the HTTP restart route for the client button. */
  enableHttpRoute: boolean
  /** Whether to request a graceful host exit (`ctx.appExit(0)`) before relaunch. */
  requestGracefulExit: boolean
}

/** Schemastery schema; defaults live here so `cordis.yml` can tune without code edits. */
export const Config: Schema<Config> = Schema.object({
  appName: Schema.string()
    .default('DeepSeek Harness')
    .description('App name for `open -a <name>` on macOS.'),
  appBundlePath: Schema.string()
    .description('Optional absolute path to the .app bundle.'),
  relaunchDelayMs: Schema.number()
    .default(1500)
    .description('Delay in ms between process exit and relaunch.'),
  maxRelaunchAttempts: Schema.number()
    .default(10)
    .description('How many times the watchdog retries relaunching.'),
  restartToken: Schema.string()
    .default('')
    .description('Shared secret the HTTP route requires; leave empty to auto-generate one per launch.'),
  enableHttpRoute: Schema.boolean()
    .default(true)
    .description('Expose POST /api/restart-harness for the client button.'),
  requestGracefulExit: Schema.boolean()
    .default(true)
    .description('Request a bounded graceful exit (ctx.appExit) before relaunch.'),
})

const here = dirname(fileURLToPath(import.meta.url))

/** A restart outcome, shared by the tool and HTTP route bodies. */
export interface RestartOutcome {
  watchdogSpawned: boolean
  gracefulExitRequested: boolean
  detail: string
}

/** Absolute path to the standalone relaunch watchdog entry (survives process exit). */
const WATCHDOG_SCRIPT = join(here, '..', 'scripts', 'relaunch.mjs')

/** Generated restart token cached across plugin reloads within one host process. */
let processRestartToken: string | undefined

/** How long to wait before force-exiting after a requested graceful exit. */
const HARD_EXIT_FALLBACK_MS = 6000

/** Grace period after the reply finishes before the exit is requested. */
const REPLY_DRAIN_DELAY_MS = 400

/**
 * True when this host process is a supervised child of the Electron app.
 * On desktop the restart must quit the whole application (main.js treats an
 * unrequested host death as fatal, and a disposed host process lingers on its
 * parent IPC), so the watchdog owns the quit-and-relaunch.
 */
export function isDesktopHost(): boolean {
  return process.connected === true
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
function spawnWatchdog(config: Config, options?: { quitApp?: boolean }): void {
  const argv = [
    WATCHDOG_SCRIPT,
    '--app-name', config.appName,
    '--delay', String(config.relaunchDelayMs),
    '--attempts', String(config.maxRelaunchAttempts),
    ...(config.appBundlePath ? ['--app-path', config.appBundlePath] : []),
    ...(options?.quitApp === true ? ['--quit-app'] : []),
  ]
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    // On desktop process.execPath is the Electron binary; without this the
    // "node" script would boot a second GUI app instead of the watchdog.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  // Detach from our event loop; the child lives on in its own process group.
  child.unref()
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
export function requestGracefulExit(ctx: Context): boolean {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) return false
  queueMicrotask(() => appExit(0))
  setTimeout(() => process.exit(0), HARD_EXIT_FALLBACK_MS)
  return true
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
 */
export function performRestart(
  ctx: Context,
  config: Config,
  overrides?: { delayMs?: number; deferExit?: boolean },
): RestartOutcome {
  const delayMs =
    overrides?.delayMs !== undefined ? overrides.delayMs : config.relaunchDelayMs
  const policy: Config = { ...config, relaunchDelayMs: Math.max(0, delayMs) }
  const desktop = isDesktopHost()

  // 1. Spawn the detached watchdog first — it must survive our own exit.
  spawnWatchdog(policy, { quitApp: desktop })

  // 2. Exit policy (see above).
  const shouldGraceful =
    !desktop && config.requestGracefulExit && overrides?.deferExit !== true
      ? requestGracefulExit(ctx)
      : false

  const detail = desktop
    ? `Restart scheduled: the watchdog will quit and relaunch "${policy.appName}".`
    : shouldGraceful
      ? `Restart scheduled: watchdog will relaunch "${policy.appName}" after this instance exits (graceful exit requested).`
      : overrides?.deferExit === true
        ? `Restart scheduled: watchdog will relaunch "${policy.appName}" after this instance exits (exit requested after the reply flushes).`
        : `Relaunch scheduled: watchdog will relaunch "${policy.appName}" after this instance exits (no graceful-exit service available).`

  return { watchdogSpawned: true, gracefulExitRequested: shouldGraceful, detail }
}

export function apply(ctx: Context, config: Config): void {
  // Schemastery stores a function default verbatim (its clone() passes
  // functions through), so the token is resolved here: a config value wins,
  // an empty default generates a fresh per-launch secret. The generated value
  // is cached per process so an HMR reload keeps serving the token the
  // already-loaded page holds.
  const restartToken = config.restartToken || (processRestartToken ??= randomBytes(16).toString('hex'))

  // ---- Model-callable tool entry (the primary "one-click" entry). ----
  ctx.tools.register(
    defineTool({
      name: 'restart_harness',
      description:
        'Restart the DeepSeek Harness application. Spawns a detached watchdog that ' +
        'relaunches the app after the current instance exits, then requests a graceful ' +
        'exit of the current process. On macOS this relaunches via `open -a`; the watchdog ' +
        'retries until the app is back up or a configured attempt limit is reached.',
      parameters: {
        delayMs: {
          type: 'number',
          description:
            'Optional override (ms) to wait after exit before relaunching. Defaults to the configured delay.',
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
        exec.signal.throwIfAborted()
        const result = performRestart(ctx, config, {
          delayMs: typeof args.delayMs === 'number' ? args.delayMs : undefined,
        })
        return {
          watchdogSpawned: result.watchdogSpawned,
          gracefulExitRequested: result.gracefulExitRequested,
          detail: result.detail,
        }
      },
    }),
  )

  // ---- Optional loopback HTTP route for the client sidebar button. ----
  // The webserver entry mounts later than this bundle (its apply awaits the
  // cmdline/startup services), so a one-shot `ctx.get('webServer')` probe at
  // apply time loses the race and the route would never exist. `ctx.inject`
  // runs the callback whenever the service arrives (and unloads it again if
  // the service goes away); a deployment with no webServer (headless) simply
  // leaves the wait pending, which keeps no process alive.
  if (config.enableHttpRoute) {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer: WebServer | undefined = webCtx.get('webServer')
      if (webServer === undefined) return

      // Hand the shared token to the page so the client button can authorize
      // its restart call. `webserver/index-inject` is emitted by the host on
      // every index render (and collected for the desktop boot IPC); the
      // `global` row lands a value on `globalThis` for the browser bundle.
      webCtx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__DSH_RESTART_TOKEN__', value: restartToken })
      })

      // The disposer removes the route; attached to this child fiber, so it
      // also runs when the webServer service is lost or this plugin unloads
      // (a re-registered identical route would otherwise throw as duplicate).
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/restart-harness',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Allow', 'POST')
            res.end('method not allowed')
            return
          }
          if (req.headers['x-restart-token'] !== restartToken) {
            res.statusCode = 401
            res.end('unauthorized')
            return
          }
          const result = performRestart(ctx, config, { deferExit: true })
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
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
            let exitRequested = false
            const requestExitOnce = () => {
              if (exitRequested) return
              exitRequested = true
              setTimeout(() => requestGracefulExit(ctx), REPLY_DRAIN_DELAY_MS)
            }
            res.once('finish', requestExitOnce)
            res.once('close', requestExitOnce)
          }
          res.end(
            JSON.stringify({
              ok: true,
              watchdogSpawned: result.watchdogSpawned,
              gracefulExitRequested: result.gracefulExitRequested,
            }),
            'utf8',
          )
        },
      }), 'one-click-restart: /api/restart-harness route')
      ctx.logger(name).info('one-click-restart: restart HTTP route ready (POST /api/restart-harness)')
    })
  }

  ctx.logger(name).info(
    'one-click-restart ready (app=%s, delayMs=%d, http=%s)',
    config.appName,
    config.relaunchDelayMs,
    config.enableHttpRoute,
  )

  // Expose the restart token to other host plugins that may want to build
  // their own entry (read-only; no side effects).
  ctx.provide('restartHarnessToken', { get: () => restartToken })
}

/** Read-only token handle other host plugins may inject.
 *  Declared here so `inject: ['restartHarnessToken']` type-checks. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    restartHarnessToken?: { get(): string }
  }
}
