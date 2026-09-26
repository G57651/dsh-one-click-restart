#!/usr/bin/env node
/**
 * Detached relaunch watchdog for @dsh-restart/one-click-restart.
 *
 * Runs as an independent process (spawned with `detached: true` by the host
 * plugin). Two modes:
 *
 *   - Default: after `--delay` ms, relaunch the app via `open -a <name>`
 *     (retrying up to `--attempts`). Used on web/headless, where the harness
 *     process exits itself via `ctx.appExit`.
 *
 *   - `--quit-app` (desktop): the harness host is a child of the Electron
 *     app, and Electron treats an unrequested host death as fatal (recovery
 *     dialog) while a disposed host process lingers on its parent IPC. So the
 *     watchdog owns the whole restart: gracefully quit the app (AppleScript
 *     quit event), wait for it to disappear, escalate to SIGTERM/SIGKILL if it
 *     lingers, then relaunch via `open -a`. The host process simply dies with
 *     the app — no host-side exit is requested in this mode.
 *
 * Invocation:
 *   node relaunch.mjs --app-name "DeepSeek Harness"
 *                     [--app-path "/Applications/DeepSeek Harness.app"]
 *                     [--delay 1500] [--attempts 10] [--quit-app]
 *
 * No parent signal is relied upon: the watchdog is fully detached and keeps
 * running after the Electron main process and the host Node process have both
 * terminated.
 */
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/** How long to wait for the app to disappear after the quit request. */
const QUIT_GRACE_MS = 15000
/** Grace periods before escalating the kill, and between kill steps. */
const ESCALATE_TERM_AFTER_MS = QUIT_GRACE_MS
const ESCALATE_KILL_AFTER_MS = ESCALATE_TERM_AFTER_MS + 5000
const POLL_INTERVAL_MS = 300

function parseArgs(argv) {
  const out = { appName: 'DeepSeek Harness', appPath: '', delay: 1500, attempts: 10, quitApp: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--app-name': out.appName = next() ?? out.appName; break
      case '--app-path': out.appPath = next() ?? out.appPath; break
      case '--delay': out.delay = Number(next() ?? out.delay); break
      case '--attempts': out.attempts = Number(next() ?? out.attempts); break
      case '--quit-app': out.quitApp = true; break
      default: break
    }
  }
  return out
}

/** Process-command pattern matching the app's main (and its host child). */
function processPattern(appName) {
  return `${appName}.app/Contents/MacOS/${appName}`
}

/** Whether any process of the app is still alive. */
function appRunning(appName) {
  const check = spawnSync('/usr/bin/pgrep', ['-f', processPattern(appName)])
  return check.status === 0
}

/** Kill the app's remaining processes: SIGTERM first, SIGKILL after 5s. */
function killRemaining(appName) {
  const pattern = processPattern(appName)
  spawnSync('/usr/bin/pkill', ['-f', pattern])
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!appRunning(appName)) return true
    // Synchronous pause: this whole path only runs once, detached.
    spawnSync('/bin/sleep', ['0.2'])
  }
  spawnSync('/usr/bin/pkill', ['-9', '-f', pattern])
  return !appRunning(appName)
}

/** Ask the app to quit through its quit Apple Event (a normal, clean quit). */
function quitApp(appName) {
  const script = `tell application ${JSON.stringify(appName)} to quit`
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' })
    child.on('error', (error) => {
      console.error(`[one-click-restart] quit failed: ${error.message}`)
      resolve(false)
    })
    child.on('close', (code) => resolve(code === 0))
  })
}

/** Wait until the app (and its lingering host child) is fully gone. */
async function waitForExit(appName) {
  const termDeadline = Date.now() + ESCALATE_TERM_AFTER_MS
  while (Date.now() < termDeadline) {
    if (!appRunning(appName)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  console.error(`[one-click-restart] app still running after quit grace period; escalating`)
  return killRemaining(appName)
}

/** Launch the app via `open`, returning the command's exit code. */
function relaunch(target) {
  const args = target.appPath ? [target.appPath] : ['-a', target.appName]
  // `open` propagates the calling environment into the launched app. This
  // watchdog itself may run under ELECTRON_RUN_AS_NODE=1 (the host spawns it
  // with the Electron binary as node) — inherited, that variable makes the
  // relaunched GUI app start in node mode and exit immediately, which reads
  // as "the app never came back". Strip Electron's node-mode vars.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore', env })
    child.on('error', (error) => {
      console.error(`[one-click-restart] open failed: ${error.message}`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/** Poll until the app process appears after an `open`; false on timeout. */
async function waitForLaunch(appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (appRunning(appName)) return true
    await sleep(200)
  }
  return false
}

async function main() {
  const target = parseArgs(process.argv)
  const delay = Number.isFinite(target.delay) && target.delay > 0 ? target.delay : 1500
  const attempts = Number.isFinite(target.attempts) && target.attempts > 0 ? target.attempts : 10

  // Give the exiting app time to finish tearing down before relaunching.
  await sleep(delay)

  if (target.quitApp) {
    // Desktop mode: the app is still running and must be quit first. The
    // host's own reply already reached the page, so a short, quiet quit is
    // safe here.
    const quitOk = await quitApp(target.appName)
    const gone = await waitForExit(target.appName)
    if (!gone) {
      console.error(`[one-click-restart] could not quit "${target.appName}"; relaunching anyway`)
    } else if (!quitOk) {
      console.error(`[one-click-restart] quit request errored, but the app is gone`)
    }
    // The process can be dead while LaunchServices still lists the app as
    // running; an immediate `open -a` then merely "activates" the corpse and
    // returns 0 without launching anything. Let it unregister first.
    await sleep(1000)
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const code = await relaunch(target)
    // `open` returning 0 is not proof anything launched (the activation race
    // above); verify the process actually appeared.
    const appeared = await waitForLaunch(target.appName)
    if (code === 0 && appeared) {
      console.log(`[one-click-restart] relaunched "${target.appName}" (attempt ${attempt})`)
      process.exit(0)
    }
    console.error(
      `[one-click-restart] relaunch attempt ${attempt}/${attempts} failed (open ${code}, appeared ${appeared}); retrying in 1s`,
    )
    await sleep(1000)
  }

  console.error(`[one-click-restart] could not relaunch "${target.appName}" after ${attempts} attempts`)
  process.exit(1)
}

main().catch((error) => {
  console.error('[one-click-restart] watchdog crashed:', error)
  process.exit(1)
})
