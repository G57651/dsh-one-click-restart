/**
 * @dsh-restart/one-click-restart — one-click restart entry for DeepSeek Harness.
 *
 * The plugin runs in the **host** Node process (a child of the Electron main
 * process on desktop, or the single `dsh`/`dsh web` process otherwise). It:
 *
 *   1. Registers a `restart_harness` tool so the model (or any plugin injecting
 *      `tools`) can trigger a restart.
 *   2. Registers a loopback HTTP route on the host `webServer` service
 *      (`GET` hands out the shared token, `POST` performs the restart), so the
 *      client sidebar button — or any same-origin caller holding the token —
 *      can trigger the same restart.
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
import type { Context, Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "one-click-restart";
export declare const inject: string[];
/** Raw `Config` values as the loader accepts them, before schemastery wraps
 * every field into its volatile `{ get() }` reference (the input side of the
 * schema; the parsed output type is {@link Config}). */
export interface ConfigInput {
    appName?: string | null;
    appBundlePath?: string | null;
    relaunchDelayMs?: number | null;
    maxRelaunchAttempts?: number | null;
    restartToken?: string | null;
    enableHttpRoute?: boolean | null;
    requestGracefulExit?: boolean | null;
}
/** Configuration for the one-click restart plugin, as the loader declares it.
 *
 * Every field is schemastery-`volatile()`, so a parsed config holds stable
 * `{ get() }` references rather than plain values; read them through
 * {@link configValue} / {@link readConfig}.
 */
export interface Config {
    /** Name used to identify the app for `open -a`. */
    appName: Volatile<string>;
    /** Optional absolute path to the .app bundle (fallback when `-a` matches nothing). */
    appBundlePath: Volatile<string | undefined>;
    /** Milliseconds to wait after exit before relaunching. */
    relaunchDelayMs: Volatile<number>;
    /** Maximum relaunch attempts before the watchdog gives up. */
    maxRelaunchAttempts: Volatile<number>;
    /** Shared token the client button must present to the HTTP restart route. */
    restartToken: Volatile<string>;
    /** Whether to expose the HTTP restart route for the client button. */
    enableHttpRoute: Volatile<boolean>;
    /** Whether to request a graceful host exit (`ctx.appExit(0)`) before relaunch. */
    requestGracefulExit: Volatile<boolean>;
}
/** Config field values with the volatile references resolved. */
export interface ResolvedConfig {
    appName: string;
    appBundlePath: string | undefined;
    relaunchDelayMs: number;
    maxRelaunchAttempts: number;
    restartToken: string;
    enableHttpRoute: boolean;
    requestGracefulExit: boolean;
}
/** A restart outcome, shared by the tool and HTTP route bodies. */
export interface RestartOutcome {
    watchdogSpawned: boolean;
    gracefulExitRequested: boolean;
    detail: string;
}
/** Schemastery schema; defaults live here so `cordis.yml` can tune without code edits.
 *
 * Every field is `.volatile()`: restart settings (app identity, delay, the
 * shared token, the two switches) are read per operation and may change at
 * runtime, so schemastery hands us a stable `{ get() }` reference instead of a
 * frozen value. {@link readConfig} resolves them once per operation.
 */
export declare const Config: Schema<ConfigInput, Config>;
/**
 * True when this host process is a supervised child of the Electron app.
 * On desktop the restart must quit the whole application (main.js treats an
 * unrequested host death as fatal, and a disposed host process lingers on its
 * parent IPC), so the watchdog owns the quit-and-relaunch.
 */
export declare function isDesktopHost(): boolean;
/**
 * Loopback guard for the restart route. The route is registered as an `exact`
 * WebServer route, and exact routes win over the Connection package's `/api`
 * prefix route — so the request never passes through that package's
 * `isTrustedApiRequest` fence (loopback Host + `sec-fetch-site` rejection).
 * Both checks are re-implemented here, and the canonical loopback literals are
 * accepted; mirrors packages/client/connection/src/api-request-trust.ts and
 * packages/client/connection/src/loopback-hostname.ts.
 */
export declare function isTrustedLoopbackRequest(req: {
    headers: Record<string, string | string[] | undefined>;
}): boolean;
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
export declare function requestGracefulExit(ctx: Context): boolean;
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
export declare function performRestart(ctx: Context, config: ResolvedConfig, overrides?: {
    delayMs?: number;
    deferExit?: boolean;
}): RestartOutcome;
export declare function apply(ctx: Context, config: Config): void;
/** Read-only token handle other host plugins may inject.
 *  Declared here so `inject: ['oneClickRestart.token']` type-checks. */
declare module '@deepseek-ai/cordis' {
    interface Context {
        'oneClickRestart.token'?: {
            get(): string;
        };
    }
}
