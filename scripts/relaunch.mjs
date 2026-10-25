#!/usr/bin/env node
/**
 * Detached relaunch watchdog for @dsh-restart/one-click-restart.
 *
 * Runs as an independent process (spawned with `detached: true` by the host
 * plugin). Two modes:
 *
 *   - Default: after `--delay` ms, relaunch the app (retrying up to
 *     `--attempts`). Used on web/headless, where the harness process exits
 *     itself via `ctx.appExit`.
 *
 *   - `--quit-app` (desktop): the harness host is a child of the Electron
 *     app, and Electron treats an unrequested host death as fatal (recovery
 *     dialog) while a disposed host process lingers on its parent IPC. So the
 *     watchdog owns the whole restart: gracefully quit the app (macOS: the
 *     AppleScript quit event; Windows: WM_CLOSE via `taskkill /IM`), wait for
 *     it to disappear, escalate to force-kill if it lingers, then relaunch.
 *     The host process simply dies with the app — no host-side exit is
 *     requested in this mode.
 *
 * Platform notes:
 *
 *   - macOS relaunches via `open -a <name>` (or the .app bundle path) and
 *     matches processes by the full-path pattern `<name>.app/Contents/MacOS/<name>`.
 *
 *   - Windows relaunches by re-spawning the app executable directly and
 *     matches processes by image name. On Windows the Electron utility
 *     process (this plugin's host) runs from the SAME executable as the main
 *     app, so the watchdog — spawned from `process.execPath` under
 *     `ELECTRON_RUN_AS_NODE` — always shares the app's image name: every
 *     enumeration below excludes the watchdog's own PID, or "app gone" checks
 *     would never pass and the escalation would kill the watchdog itself.
 *
 * Invocation:
 *   node relaunch.mjs --app-name "DeepSeek Harness"
 *                     [--app-path "/Applications/DeepSeek Harness.app"     (macOS)
 *                      | --app-path "C:\...\DeepSeek Harness.exe"]          (Windows)
 *                     [--delay 1500] [--attempts 10] [--quit-app]
 *                     [--quit-grace-ms] (default: 1000 on Windows, 15000 elsewhere)
 *
 * On Windows `--app-path` falls back, in order, to the standard per-user and
 * machine install locations and the registry `App Paths` key for
 * `<appName>.exe`; if none resolves, the watchdog exits with a remediation
 * message (set `appBundlePath` in the plugin config).
 *
 * No parent signal is relied upon: the watchdog is fully detached and keeps
 * running after the Electron main process and the host Node process have both
 * terminated.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const IS_WIN = process.platform === 'win32'

/**
 * How long to wait for the app to disappear after the quit request.
 * Windows defaults short: WM_CLOSE either quits the app within a second
 * (windowed Electron quit path) or never lands at all (tray-resident apps
 * have no window to close) — a long grace would only delay the inevitable
 * force-kill. macOS keeps the longer default.
 */
const QUIT_GRACE_MS = IS_WIN ? 1000 : 15000
/** Grace period after the force-kill pass before giving up on it. */
const KILL_GRACE_MS = 5000
const POLL_INTERVAL_MS = 150

/**
 * App names are interpolated into a pgrep/pkill `-f` pattern and into an
 * AppleScript `tell application` statement on macOS, and into Windows image
 * names, filesystem paths and registry keys on Windows, so an unvalidated
 * value is a pattern-injection and a script/path-injection vector. Restrict
 * to a conservative character set, reject anything that could change pattern
 * semantics or the script, and reject a leading dash (which a command would
 * read as an option). Backslash and colon are rejected on every platform:
 * they are path separators / drive-letter syntax on Windows and add nothing
 * on macOS.
 */
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]*$/

function validateAppName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  // No path separators, control characters or glob/regex metacharacters.
  if (/[/\\:\u0000-\u001f\u007f*?[\]{}|$\^`'"!;&<>]/.test(value)) return false
  return APP_NAME_RE.test(value)
}

function validateAppPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false
  if (!isAbsolute(value)) return false
  // Quotes and control characters could break the command lines this value
  // ends up in (tasklist/taskkill filters, CreateProcess).
  if (/["\u0000-\u001f\u007f]/.test(value)) return false
  return true
}

function parseArgs(argv) {
  const out = { appName: 'DeepSeek Harness', appPath: '', delay: 1500, attempts: 10, quitApp: false, quitGraceMs: QUIT_GRACE_MS }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--app-name': out.appName = next() ?? out.appName; break
      case '--app-path': out.appPath = next() ?? out.appPath; break
      case '--delay': out.delay = Number(next() ?? out.delay); break
      case '--attempts': out.attempts = Number(next() ?? out.attempts); break
      case '--quit-app': out.quitApp = true; break
      case '--quit-grace-ms': out.quitGraceMs = Number(next() ?? out.quitGraceMs); break
      default: break
    }
  }
  if (!validateAppName(out.appName)) {
    console.error(`[one-click-restart] refusing unsafe --app-name ${JSON.stringify(out.appName)}; falling back to "DeepSeek Harness"`)
    out.appName = 'DeepSeek Harness'
  }
  if (out.appPath !== '' && !validateAppPath(out.appPath)) {
    console.error(`[one-click-restart] refusing unsafe --app-path ${JSON.stringify(out.appPath)}; ignoring it`)
    out.appPath = ''
  }
  if (!Number.isFinite(out.quitGraceMs) || out.quitGraceMs < 500) out.quitGraceMs = QUIT_GRACE_MS
  return out
}

// ---------------------------------------------------------------------------
// macOS / POSIX implementations (unchanged behavior).
// ---------------------------------------------------------------------------

/** Process-command pattern matching the app's main (and its host child). */
function macProcessPattern(appName) {
  return `${appName}.app/Contents/MacOS/${appName}`
}

/** PID list of the app's processes matching the pattern, or null on pgrep error. */
function macAppPids(appName) {
  const check = spawnSync('/usr/bin/pgrep', ['-f', macProcessPattern(appName)], { encoding: 'utf8' })
  // pgrep exits 1 when nothing matched; anything else is a real failure.
  if (check.status !== 0 && check.status !== 1) return null
  return String(check.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9]+$/.test(line))
}

/** Whether any process of the app is still alive. */
function macAppRunning(appName) {
  return (macAppPids(appName) ?? []).length > 0
}

/**
 * Whether a PID's current command line still matches the app pattern. PIDs are
 * recycled, so a PID taken from pgrep a moment ago may already belong to an
 * unrelated process by the time the signal is sent; `ps` re-reads the live
 * command line and we refuse to signal anything that stopped matching.
 */
function macPidOwnedByApp(pid, pattern) {
  const check = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (check.status !== 0) return false
  const command = String(check.stdout ?? '').trim()
  return command.includes(pattern)
}

/**
 * Kill the app's remaining processes: SIGTERM first, SIGKILL after 5s.
 *
 * Targets are enumerated first (pgrep) and each PID is verified to still
 * belong to the app before it is signalled. `pkill -f` matches the *whole*
 * command line of every process, so a stale or over-broad pattern can select
 * unrelated processes; signalling by PID lets us log exactly what is killed
 * and skip a PID whose command line no longer matches.
 */
function macKillRemaining(appName) {
  const pattern = macProcessPattern(appName)
  const pids = macAppPids(appName) ?? []
  if (pids.length === 0) return true
  console.error(`[one-click-restart] killing ${pids.length} process(es) matching ${JSON.stringify(pattern)}: ${pids.join(', ')}`)
  for (const pid of pids) {
    if (!macPidOwnedByApp(pid, pattern)) {
      console.error(`[one-click-restart] pid ${pid} no longer matches the app; skipping`)
      continue
    }
    spawnSync('/bin/kill', ['-TERM', pid])
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!macAppRunning(appName)) return true
    // Synchronous pause: this whole path only runs once, detached.
    spawnSync('/bin/sleep', ['0.2'])
  }
  for (const pid of macAppPids(appName) ?? []) {
    if (!macPidOwnedByApp(pid, pattern)) continue
    console.error(`[one-click-restart] escalating to SIGKILL for pid ${pid}`)
    spawnSync('/bin/kill', ['-9', pid])
  }
  return !macAppRunning(appName)
}

/** Ask the app to quit through its quit Apple Event (a normal, clean quit). */
function macQuitApp(appName) {
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

/** Launch the app via `open`, returning the command's exit code. */
function macRelaunch(target) {
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

// ---------------------------------------------------------------------------
// Windows implementations.
//
// On Windows the watchdog runs from the app's own executable (the host spawns
// it as `<app>.exe relaunch.mjs ...` under ELECTRON_RUN_AS_NODE), so it shares
// the app's image name with every Electron process. Every enumeration returns
// PIDs of the image EXCLUDING our own; the force-kill pass works per verified
// PID. Never use `taskkill /IM /F` or `taskkill /T`: those would match and
// kill the watchdog itself.
// ---------------------------------------------------------------------------

/** The image name (e.g. "DeepSeek Harness.exe") all Windows probes match on. */
function winImageName(exePath, appName) {
  if (exePath) return basename(exePath)
  return appName.toLowerCase().endsWith('.exe') ? appName : `${appName}.exe`
}

/**
 * PIDs of every process running the app's image, excluding the watchdog's
 * own PID, or null when tasklist failed outright. tasklist prints CSV rows
 * (`"image.exe","1234","Console","1","12,345 K"`); parsing is structural
 * (quoted image + numeric PID), independent of the console codepage.
 */
function winAppPids(image) {
  const check = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  if (check.error) return null
  const pids = []
  for (const line of String(check.stdout ?? '').split(/\r?\n/)) {
    const row = /^"[^"]*","(\d+)"/.exec(line)
    if (row) pids.push(Number(row[1]))
  }
  return pids.filter((pid) => pid !== process.pid)
}

/** Whether any process of the app (other than the watchdog itself) is alive. */
function winAppRunning(image) {
  return (winAppPids(image) ?? []).length > 0
}

/** Whether a PID currently runs the app's image (guards against PID reuse). */
async function winPidOwnedByApp(pid, image) {
  return new Promise((resolve) => {
    const check = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    check.stdout.on('data', (chunk) => { out += chunk })
    check.on('error', () => resolve(false))
    check.on('close', () => {
      for (const line of out.split(/\r?\n/)) {
        const row = /^"([^"]*)","(\d+)"/.exec(line)
        if (row && Number(row[2]) === pid) return resolve(row[1].toLowerCase() === image.toLowerCase())
      }
      resolve(false)
    })
  })
}

/** Fire `taskkill /F /PID` and resolve when the command has been issued. */
function winForceKill(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}

/**
 * Force-kill the app's remaining processes (the SIGKILL equivalent): each PID
 * is re-verified against the image before `taskkill /F /PID`. Verifications
 * and kills run concurrently — the whole pass costs about one tasklist
 * round-trip instead of one per process. Returns once no verified app process
 * remains (or after the grace period expires).
 */
async function winKillRemaining(image) {
  const pids = winAppPids(image) ?? []
  if (pids.length === 0) return true
  console.error(`[one-click-restart] killing ${pids.length} process(es) of "${image}": ${pids.join(', ')}`)
  await Promise.all(pids.map(async (pid) => {
    if (!(await winPidOwnedByApp(pid, image))) {
      console.error(`[one-click-restart] pid ${pid} no longer matches the app; skipping`)
      return
    }
    await winForceKill(pid)
  }))
  const deadline = Date.now() + KILL_GRACE_MS
  while (Date.now() < deadline) {
    if (!winAppRunning(image)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return !winAppRunning(image)
}

/**
 * Quit the app politely: `taskkill /IM` without `/F` posts WM_CLOSE to the
 * windows of the matching processes — Electron's main window then runs its
 * normal close path (the analog of the macOS AppleScript quit event).
 *
 * Window-less matches — including this watchdog, which shares the image —
 * are refused ("can only be terminated forcefully") without being killed, so
 * this call cannot take the watchdog down. Its exit code therefore says
 * nothing about whether the APP agreed to quit; `waitForExit` is the
 * authority and escalates to the force-kill pass below if it lingers.
 */
function winQuitApp(image) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/IM', image], { stdio: 'ignore' })
    child.on('error', (error) => {
      console.error(`[one-click-restart] quit failed: ${error.message}`)
      resolve(false)
    })
    child.on('close', () => resolve(true))
  })
}

/**
 * Resolve what to relaunch on Windows, once, before any quit/relaunch work:
 *
 *   1. `--app-path`: the app's .exe; a directory is accepted and resolves to
 *      `<dir>/<dir-basename>.exe` (the standard layout of an Electron install).
 *      A .lnk shortcut is rejected: the quit phase must enumerate by the real
 *      image name, which a shortcut cannot tell us.
 *   2. Otherwise the standard install locations for `<appName>.exe`
 *      (per-user first, so no elevation is needed).
 *   3. Otherwise the registry `App Paths` key for `<appName>.exe`.
 *
 * Returns `{ exe }` or null (the caller exits with a remediation message).
 */
function winResolveExe(target) {
  if (target.appPath) {
    let p = target.appPath
    if (/\.lnk$/i.test(p)) {
      console.error(`[one-click-restart] --app-path points to a shortcut (.lnk); pass the .exe directly (e.g. "...\\${target.appName}.exe")`)
      return null
    }
    if (existsSync(p) && statSync(p).isDirectory()) {
      const inner = join(p, `${basename(p).replace(/\.exe$/i, '')}.exe`)
      if (existsSync(inner)) {
        p = inner
      } else {
        console.error(`[one-click-restart] --app-path is a directory without "${basename(inner)}"; pass the .exe directly`)
        return null
      }
    }
    if (!existsSync(p)) {
      console.error(`[one-click-restart] --app-path does not exist: ${p}`)
      return null
    }
    return { exe: p }
  }

  const image = winImageName(null, target.appName)
  const roots = []
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs', target.appName))
  if (process.env['ProgramFiles']) roots.push(join(process.env['ProgramFiles'], target.appName))
  if (process.env['ProgramFiles(x86)']) roots.push(join(process.env['ProgramFiles(x86)'], target.appName))
  for (const root of roots) {
    const candidate = join(root, image)
    if (existsSync(candidate)) return { exe: candidate }
  }

  for (const hive of ['HKLM\\SOFTWARE', 'HKCU\\SOFTWARE']) {
    const key = `${hive}\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${image}`
    const query = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8' })
    if (query.error || query.status !== 0) continue
    const line = String(query.stdout ?? '')
      .split(/\r?\n/)
      .find((l) => l.includes('_SZ'))
    if (line === undefined) continue
    const value = line.slice(line.lastIndexOf('_SZ') + 3).trim().replace(/^"|"$/g, '')
    if (value && existsSync(value)) return { exe: value }
  }
  return null
}

/** Launch the app by re-spawning its executable, returning an exit code. */
function winRelaunch(target) {
  const exe = target.win.exe
  // Relaunch through `start` so the new process is created exactly like a
  // user double-click — a normal STARTUPINFO show state and no Electron
  // child-process context. A bare detached spawn differs in both: Chromium
  // applies the inherited show state to its first window (a wrong one leaves
  // the app invisible in the tray), and the host's child-process environment
  // must not leak into the fresh instance. The `start` console itself is
  // hidden; the app is GUI-subsystem and needs no console anyway.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    // The host runs the watchdog as an Electron child: strip its node-mode
    // vars and the dead parent's crashpad pipe before handing the environment
    // to the relaunched app.
    if (/^(ELECTRON_|CHROME_)/i.test(key)) delete env[key]
  }
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '', exe], {
      stdio: 'ignore',
      env,
      windowsHide: true,
      cwd: dirname(exe),
    })
    child.on('error', (error) => {
      console.error(`[one-click-restart] relaunch failed: ${error.message}`)
      resolve(1)
    })
    // `start` returns as soon as it has handed the launch off; its exit code
    // is all we observe (waitForLaunch verifies the process appeared).
    child.on('close', (code) => resolve(code ?? 0))
  })
}

// ---------------------------------------------------------------------------
// Shared flow.
// ---------------------------------------------------------------------------

/** Whether any process of the app is still alive. */
function appRunning(target) {
  return IS_WIN ? winAppRunning(target.win.image) : macAppRunning(target.appName)
}

/** Wait until the app (and its lingering host child) is fully gone. */
async function waitForExit(target) {
  const termDeadline = Date.now() + target.quitGraceMs
  while (Date.now() < termDeadline) {
    if (!appRunning(target)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  console.error(`[one-click-restart] app still running after quit grace period; escalating`)
  return IS_WIN ? winKillRemaining(target.win.image) : macKillRemaining(target.appName)
}

/** Poll until the app process appears after a relaunch; false on timeout. */
async function waitForLaunch(target, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (appRunning(target)) return true
    await sleep(200)
  }
  return false
}

async function main() {
  const target = parseArgs(process.argv)
  const delay = Number.isFinite(target.delay) && target.delay > 0 ? target.delay : 1500
  const attempts = Number.isFinite(target.attempts) && target.attempts > 0 ? target.attempts : 10

  if (IS_WIN) {
    // Resolve the relaunch target once: a failed resolution is a static
    // config error, not a transient one — burn no retries on it.
    const resolved = winResolveExe(target)
    if (resolved === null) {
      console.error(
        `[one-click-restart] cannot determine what to relaunch on Windows; set appBundlePath ` +
        `to the full path of "${winImageName(null, target.appName)}" (or its install folder) in the plugin config`,
      )
      process.exit(1)
    }
    target.win = { exe: resolved.exe, image: winImageName(resolved.exe, target.appName) }
  }

  // Give the exiting app time to finish tearing down before relaunching —
  // that is what the delay is for on the web path, where the host exits
  // itself. In desktop quit mode the relaunch happens only after the quit
  // anyway, so a full delay would just postpone it; cap it at the settle
  // time the triggering reply needs to flush to the client.
  await sleep(target.quitApp ? Math.min(delay, 200) : delay)

  if (target.quitApp) {
    // Desktop mode: the app is still running and must be quit first. The
    // host's own reply already reached the page, so a short, quiet quit is
    // safe here.
    const quitOk = IS_WIN ? await winQuitApp(target.win.image) : await macQuitApp(target.appName)
    const gone = await waitForExit(target)
    if (!gone) {
      console.error(`[one-click-restart] could not quit "${target.appName}"; relaunching anyway`)
    } else if (!quitOk) {
      console.error(`[one-click-restart] quit request errored, but the app is gone`)
    }
    if (!IS_WIN) {
      // The process can be dead while LaunchServices still lists the app as
      // running; an immediate `open -a` then merely "activates" the corpse
      // and returns 0 without launching anything. Let it unregister first.
      await sleep(1000)
    }
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const code = IS_WIN ? await winRelaunch(target) : await macRelaunch(target)
    // A zero exit code is not proof anything launched (macOS has the
    // activation race above; Windows spawn errors surface asynchronously) —
    // verify the process actually appeared.
    const appeared = await waitForLaunch(target)
    if (code === 0 && appeared) {
      console.log(`[one-click-restart] relaunched "${target.appName}" (attempt ${attempt})`)
      process.exit(0)
    }
    console.error(
      `[one-click-restart] relaunch attempt ${attempt}/${attempts} failed (launch ${code}, appeared ${appeared}); retrying in 1s`,
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
