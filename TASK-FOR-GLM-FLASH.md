# 修复任务书:v0.2.1 审查问题修复(执行模型:GLM 5.3 flash)

> 工作目录:`D:\cc465\Documents\dsh-one-click-restart`
> 按任务顺序执行。每个任务给出精确锚点(现有代码原文)与目标代码。改完跑对应验收命令,全部通过后停手——**不要做任务书之外的任何改动**。
>
> **禁止修改**:`scripts/build-client.mjs`、`lib/client.js`、`lib/client.js.map`、`src/client/`、`LICENSE`、macOS 相关函数(`mac*`)、`package.json` 的版本号(二审后统一升)。`src/index.ts` 与 `lib/index.js` 是"源码/产物"关系,凡涉及宿主半部的任务(任务 1、2)必须**两处同步改**。

---

## 任务 1(P1):watchdog 跨进程互斥锁

**文件**:`scripts/relaunch.mjs`(仅此文件)

**问题**:并发触发的两个 `--quit-app` watchdog,后一个会把刚拉起的新实例再杀一遍。

**改法**:
1. 文件头部 import 区已有 `import { existsSync, statSync } from 'node:fs'`,改为:
```js
import { existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
```
并新增 `import { tmpdir } from 'node:os'`,以及常量:
```js
/** Cross-process single-flight lock: a second watchdog started while one is
 *  mid-restart must not quit the instance the first one just relaunched. */
const LOCK_FILE = join(tmpdir(), 'dsh-one-click-restart.watchdog.lock')
```
2. 新增函数(放在 `parseArgs` 之后):
```js
/** Acquire the single-flight lock. Returns true when this watchdog may run.
 *  A stale lock (holder gone) is taken over; a live holder means another
 *  watchdog is mid-restart — exit quietly and let it finish. */
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        if (winPidOwnedByAppSync(pid)) {
          console.error(`[one-click-restart] another watchdog (pid ${pid}) is mid-restart; standing down`)
          return false
        }
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'w' })
    return true
  } catch (error) {
    // A lock we cannot read or write must not block a restart.
    console.error(`[one-click-restart] lock check failed (${error.message}); proceeding`)
    return true
  }
}
/** Sync PID-alive check by image — unlike winPidOwnedByApp this does not care
 *  WHICH image runs the pid, only that the holder process still exists. */
function winPidOwnedByAppSync(pid) {
  const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  return /^"[^"]*","(\d+)"/m.test(String(check.stdout ?? ''))
}
```
注意:非 Windows 平台 `tasklist` 不存在,`spawnSync` 会置 `error`,`stdout` 为空 → 函数返回 false → 锁被接管。macOS 上锁近似 best-effort(可接受,macOS 本就单实例场景为主)。如果想让 macOS 更准确,可改用 `process.kill(pid, 0)` 判存活——**二选一,选 `process.kill(pid, 0)` 更简单跨平台**,即把 `winPidOwnedByAppSync` 整个删掉,`acquireLock` 里改用:
```js
let alive = false
try { process.kill(pid, 0); alive = true } catch { alive = false }
if (alive) { …stand down… }
```
(推荐这个简化版;`process.kill(pid, 0)` 对不存在的进程抛 ESRCH,对无权限的进程抛 EPERM——EPERM 也说明进程存在,两种都不该接管锁。)
3. `main()` 开头(`const target = parseArgs(process.argv)` 之前)加:
```js
if (!acquireLock()) process.exit(0)
```
4. `main()` 结束前(所有 `process.exit(0)` 的成功路径,即 `relaunched` 分支内 `process.exit(0)` 之前)加 `try { unlinkSync(LOCK_FILE) } catch {}`。失败路径(重试耗尽 `process.exit(1)`)也加上。

**验收**:
```sh
ELECTRON_RUN_AS_NODE=1 node --check scripts/relaunch.mjs
grep -c "acquireLock" scripts/relaunch.mjs        # >= 3(定义+调用)
grep -c "unlinkSync" scripts/relaunch.mjs         # >= 2
```

---

## 任务 2(P1):路由退出判定与 performRestart 统一(两文件同步)

**文件**:`src/index.ts` 与 `lib/index.js`

**问题**:forked 宿主形态下,HTTP 路由的延迟退出分支 `if (!isDesktopHost())` 误判为 web 路径,会在响应冲刷后请求宿主自行退出,与 watchdog 的整体退出竞争。

**改法(两个文件同样逻辑)**:
1. 在 `isWindowsAppHosted` 函数定义之后新增一个共享判定:
```js
/** Whether the watchdog owns the whole-app quit (desktop shapes): the host
 *  must not request its own exit in this case. */
function exitOwnedByWatchdog() {
  return isDesktopHost() || isWindowsAppHosted()
}
```
(src/index.ts 里写在 `export function isWindowsAppHosted(): boolean { … }` 之后,lib/index.js 同位置。)
2. `performRestart` 中 `const desktop = isDesktopHost() || isWindowsAppHosted()` 改为:
```js
const desktop = exitOwnedByWatchdog()
```
3. 路由 handler 中的 `if (!isDesktopHost()) {` 改为 `if (!exitOwnedByWatchdog()) {`(src/index.ts 约 490 行、lib/index.js 约 371 行,锚点原文:`if (!isDesktopHost()) {`,上下文是 `res.once('finish', requestExitOnce)` 所在分支)。

**验收**:
```sh
ELECTRON_RUN_AS_NODE=1 node --check lib/index.js
grep -n "exitOwnedByWatchdog" src/index.ts lib/index.js   # 每文件 >= 3 处(定义+2 调用)
grep -n "isDesktopHost() || isWindowsAppHosted" src/index.ts lib/index.js   # 只剩函数定义内部一处……注意:定义内部用的是 isDesktopHost() || isWindowsAppHosted(),performRestart 那处应已消失
```
(第二条 grep 的期望:每个文件中 `||` 组合只出现在 `exitOwnedByWatchdog` 定义体内。)

---

## 任务 3(P1):补 `lib/index.d.ts` 缺失声明

**文件**:`lib/index.d.ts`(仅此文件)

**锚点**:`export declare function isDesktopHost(): boolean;`

**改法**:在其后新增(与 lib/index.js:129 的运行时导出对应):
```ts
export declare function isWindowsAppHosted(): boolean;
```

**验收**:`grep -c "isWindowsAppHosted" lib/index.d.ts` → `1`。

---

## 任务 4(P2):参数钳制修正

**文件**:`scripts/relaunch.mjs`

**改法**:
1. `parseArgs` 内 `if (!Number.isFinite(out.quitGraceMs) || out.quitGraceMs < 500) out.quitGraceMs = QUIT_GRACE_MS` 改为(加日志):
```js
if (!Number.isFinite(out.quitGraceMs) || out.quitGraceMs < 500) {
  console.error(`[one-click-restart] --quit-grace-ms must be >= 500; using default ${QUIT_GRACE_MS}`)
  out.quitGraceMs = QUIT_GRACE_MS
}
```
2. `main()` 内 `const delay = Number.isFinite(target.delay) && target.delay > 0 ? target.delay : 1500` 改为 `>= 0`:
```js
const delay = Number.isFinite(target.delay) && target.delay >= 0 ? target.delay : 1500
```

**验收**:`node --check` 通过;`grep -n "delay >= 0" scripts/relaunch.mjs` 命中 1 处。

---

## 任务 5(P2):`winAppPids` 非零退出防误判

**文件**:`scripts/relaunch.mjs`

**锚点**:`function winAppPids(image) {` 内的 `if (check.error) return null`

**改法**:
```js
if (check.error) return null
if (check.status !== 0) {
  // tasklist exits non-zero on real failures; an empty output then means
  // "unknown", not "no processes" — a wrong [] would read as "app gone".
  return /^"[^"]*","(\d+)"/m.test(String(check.stdout ?? '')) ? parsePids(check.stdout) : null
}
```
其中把现有的解析循环抽成本地 `parsePids`(或将现有循环体搬进 `parsePids`),保证原有正常路径行为不变(注意:无匹配时 tasklist 在当前系统实测退出码 0,不受影响)。

**验收**:`node --check` 通过;人为构造非零退出不可行,靠 code review。

---

## 任务 6(P2):注册表值解析修正

**文件**:`scripts/relaunch.mjs`

**锚点**:`const value = line.slice(line.lastIndexOf('_SZ') + 3).trim().replace(/^"|"$/g, '')`

**改法**(用列头定位,REG_SZ 在行内只出现一次,路径值再含 "_SZ" 也不会截错):
```js
const value = line.slice(line.indexOf('REG_SZ') + 'REG_SZ'.length).trim().replace(/^"|"$/g, '')
```

**验收**:`node --check` 通过。

---

## 任务 7(P2):`validateAppPath` 拒绝 cmd 元字符

**文件**:`scripts/relaunch.mjs`

**锚点**:`function validateAppPath(value) {` 内的 `if (/["\u0000-\u001f\u007f]/.test(value)) return false`

**改法**(增加 `%` 与 `!`;它们会被 `cmd /c start` 展开导致路径错乱,拒绝比静默错路径好):
```js
if (/["%!\u0000-\u001f\u007f]/.test(value)) return false
```

**验收**:`node --check` 通过;`grep -n '%!' scripts/relaunch.mjs` 命中。

---

## 任务 8(P3,可选——时间紧可跳过):README 补充

**文件**:`README.md` 配置节

在 `maxRelaunchAttempts` 行后加一行注释:
```yaml
    # quitGraceMs 由 watchdog --quit-grace-ms 控制,最小 500;触发进行中的重复重启会被单飞锁忽略
```
同时在"工作原理"节 watchdog 职责列表里补一句:"并发触发受跨进程单飞锁保护,进行中的重启不会被打断"。

---

## 全部完成后的总验收

```sh
ELECTRON_RUN_AS_NODE=1 node --check scripts/relaunch.mjs
ELECTRON_RUN_AS_NODE=1 node --check lib/index.js
grep -c "exitOwnedByWatchdog" src/index.ts lib/index.js     # 各 >= 3
grep -c "isWindowsAppHosted" lib/index.d.ts                  # = 1
grep -c "acquireLock" scripts/relaunch.mjs                   # >= 3
git diff --stat                                              # 预期只动:scripts/relaunch.mjs, src/index.ts, lib/index.js, lib/index.d.ts, README.md
```
不要提交 git、不要部署到 `C:\Users\cc465\.dsh\...`(部署和真机回归由二审负责)。完成后输出改动摘要清单。
