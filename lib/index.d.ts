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
 *      process and waits for the application to fully terminate, then relaunches
 *      it via `open -a <AppName>` (macOS) — the guarantee "restart even after
 *      the harness has exited".
 *   4. If the launcher provided `ctx.appExit` (the bounded exit request from
 *      `@deepseek-ai/dsh-cmdline`), requests a graceful `exit(0)` so the current
 *      instance actually quits before the watchdog relaunches it.
 *
 * No host/main.js modification is required: the relaunch is performed by the
 * OS launcher (`open`), orthogonal to the Electron lifecycle.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "one-click-restart";
export declare const inject: string[];
/** Configuration for the one-click restart plugin. */
export interface Config {
    /** Name used to identify the app for `open -a`. */
    appName: string;
    /** Optional absolute path to the .app bundle (fallback when `-a` matches nothing). */
    appBundlePath?: string;
    /** Milliseconds to wait after exit before relaunching. */
    relaunchDelayMs: number;
    /** Maximum relaunch attempts before the watchdog gives up. */
    maxRelaunchAttempts: number;
    /** Shared token the client button must present to the HTTP restart route. */
    restartToken: string;
    /** Whether to expose the HTTP restart route for the client button. */
    enableHttpRoute: boolean;
    /** Whether to request a graceful host exit (`ctx.appExit(0)`) before relaunch. */
    requestGracefulExit: boolean;
}
/** Schemastery schema; defaults live here so `cordis.yml` can tune without code edits. */
export declare const Config: Schema<Config>;
/** A restart outcome, shared by the tool and HTTP route bodies. */
export interface RestartOutcome {
    watchdogSpawned: boolean;
    gracefulExitRequested: boolean;
    detail: string;
}
/**
 * True when this host process is a supervised child of the Electron app.
 * On desktop the restart must quit the whole application (main.js treats an
 * unrequested host death as fatal, and a disposed host process lingers on its
 * parent IPC), so the watchdog owns the quit-and-relaunch.
 */
export declare function isDesktopHost(): boolean;
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
 */
export declare function performRestart(ctx: Context, config: Config, overrides?: {
    delayMs?: number;
    deferExit?: boolean;
}): RestartOutcome;
export declare function apply(ctx: Context, config: Config): void;
/** Read-only token handle other host plugins may inject.
 *  Declared here so `inject: ['restartHarnessToken']` type-checks. */
declare module '@deepseek-ai/cordis' {
    interface Context {
        restartHarnessToken?: {
            get(): string;
        };
    }
}
