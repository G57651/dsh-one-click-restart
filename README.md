# @dsh-restart/one-click-restart

一键重启 DeepSeek Harness：侧边栏「重启 Harness」按钮 + 模型可调用的 `restart_harness` 工具，在应用退出后由一个**独立守护进程**把它重新拉起。

<!-- 注：本仓库的 lib/ 是随源码一同提交的预构建产物，这样 `dsh plugin add github:...` 才能开箱即用（git 安装不会执行构建脚本）。改动 src/ 后必须重新构建并提交 lib/。 -->

## 安装

**方式一（推荐，一条命令）**——直接装 GitHub 仓库，仓库已含预构建产物：

```sh
dsh plugin --profile <你的 profile> add github:G57651/dsh-one-click-restart
```

**方式二**——下载 [Releases](https://github.com/G57651/dsh-one-click-restart/releases) 里的 `.tgz`：

```sh
dsh plugin --profile <你的 profile> add ./dsh-restart-one-click-restart-0.3.1.tgz
```

装完**重启一次 DSH**。之后侧边栏左下角（Settings 上方）会出现「重启 Harness」。

> 两种方式都**不需要** npm、不需要联网装任何依赖、也不需要你手动批准任何构建脚本（插件没有 `prepare` 钩子）。

## 平台支持（请先读这一段）

| 运行面 | 状态 |
|---|---|
| **macOS 桌面端** | ✅ 已实测：点击 → 应用整体退出 → 自动重新拉起 |
| **Windows 桌面端** | ✅ 已适配：watchdog 的退出/拉起链路在 Windows 11 上以真实 GUI 进程完成自动化验证（优雅 WM_CLOSE 退出、滞留强杀升级、重新拉起、免配置解析）。完整 DSH 桌面链路（按钮 → 重启）欢迎真机反馈 |
| **web / headless**（`dsh web`） | ✅ 已实测（macOS）；Windows headless 见下方配置说明 |
| Linux 桌面端 | ⚠️ **未验证**。会走 web 路径（`ctx.appExit`），但自动化拉起仍是 macOS 的 `open -a`，在 Linux 上不可用 |

- macOS 桌面端：watchdog 用 AppleScript quit 事件优雅退出整个应用，随后以 `open -n`（强制新实例）按 bundle 路径拉起——不再依赖应用名解析，也不怕 LaunchServices 还挂着刚退出的旧注册。退出等待改用 PID 存活轮询（40ms 粒度、进程内 `kill(pid,0)`），quit 事件发出后不再等它的回执而是并行开始轮询，原先「退出后固定等 1 秒」的死时间已取消。watchdog 自身耗时实测中位数 **1754ms → 851ms**（Calculator.app，5/5 成功）。
- **Windows 桌面端**：watchdog 用 `taskkill /IM`（不带 `/F`）向应用窗口发送 WM_CLOSE（等同正常关闭），滞留则按 PID 升级为 `taskkill /F` 强杀，最后经 `cmd /c start` 以与用户双击一致的方式重新拉起应用 exe（窗口正常显示，不会缩进托盘）。零配置可用：桌面宿主有两种形态（utilityProcess / fork 出的 node 子进程，随启动而异），插件都会把当前运行的应用 exe 传给 watchdog。托盘常驻（无窗口）的应用收不到 WM_CLOSE，Windows 宽限默认只有 1 秒即转强杀，点击到进程组替换约 3.4 秒、到窗口恢复约 7.5 秒（含应用自身启动）。
- Windows **headless**（`dsh web`）没有"当前运行的 exe"可依据，watchdog 依次尝试：`appBundlePath` 配置 → `%LOCALAPPDATA%\Programs\<appName>\` 与 Program Files 下的 `<appName>.exe` → 注册表 `App Paths`。都找不到时立即失败并提示设置 `appBundlePath`。
- Windows 上 watchdog 与应用是**同一个 exe 镜像**（宿主是 Electron utility process），所有进程枚举都会排除 watchdog 自身，强杀只按 PID 执行、绝不使用 `taskkill /IM /F`。

## 兼容性

- 声明 `engines.dsh: ^0.2.0-rc.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3`，peer 依赖 `@deepseek-ai/dsh-tools: ^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3`，支持 DSH 0.1.7-rc.x、0.2.0-rc.x 与 0.2.1-rc.x（已在 0.2.1-rc.3 上实测）。
- DSH（0.2.0 起）会主动检查插件声明的 `@deepseek-ai/dsh-*` peer：版本不匹配时，**安装会被直接拒绝或回滚**，已装的插件行会被置为 `disabled`（表现为「插件没生效」而不是报错）。检查由 app-boot 的 `evaluatePluginCompatibility` 执行，它用 `semver.satisfies(runtime, range, { includePrerelease: true })` 比较——预发布版本参与范围匹配，所以 `^0.2.0-rc.1` 能匹配 0.2.1-rc.2。但同样的范围在**不带** `includePrerelease` 的工具里（如 pnpm 默认的 peer 提示）会被判为不满足，因此两个范围都显式写上了 `^0.2.1-rc.2`。
- 这是有意为之：客户端 bundle 依赖宿主的模块表与 sidebar slot 契约，这些都随 DSH 版本变化，而宿主**不对客户端产物做任何版本检查**。宁可让不兼容在安装期报错，也不让它在运行时炸。
- DSH 发布更新的 0.2.x / 0.3.0 时本插件需要再次跟进 peer 范围。届时可用 `dsh plugin --profile <p> allow-version ...` 临时豁免，或等新版本。

## 功能

1. **侧边栏按钮**：向 sidebar 底部的 `sidebar.footer.action` list slot 注入按钮。宽栏为「图标 + 文字」整行，窄栏（56px rail）为圆形图标；重启进行中图标持续旋转、文字带跳动点；失败时停止并显示原因。
2. **`restart_harness` 工具**：模型/agent 可直接调用（可选 `delayMs` 覆盖延迟）。
3. **令牌保护的 HTTP 路由**：`GET /api/restart-harness` 返回当前令牌（同源、限 loopback），`POST /api/restart-harness` 校验 `x-restart-token` 后触发重启。
   - 客户端**不再依赖页面注入**：桌面端窗口的 index 来自应用包内的静态 `dist`，宿主渲染时注入的 `globalThis.__DSH_RESTART_TOKEN__` 到不了那个页面，所以按钮改为先从同源 `GET` 取令牌再 `POST`。注入仍在（Web 端作为一次往返的快路径），页面已有令牌时不再请求。
   - 这条 `exact` 路由会**优先于** Connection 包的 `/api` 前缀路由，因此宿主通用 API 信任栅栏（loopback Host 校验 + 拒绝 `sec-fetch-site: cross-site`）不会作用到它——插件在 handler 内自行做了同样的校验，非 loopback / 跨站请求直接 403。

## 工作原理

Node/Electron 进程无法自己拉起自己，所以重启动作交给一个**独立进程组**里的 watchdog：

- `detached: true` → 子进程自成一个会话，父进程退出不会连带杀死它；
- `stdio: 'ignore'` + `child.unref()` → 不持有父进程的管道与事件循环；
- watchdog 本身只做三件事，**不依赖任何 Harness 服务**。
- 并发触发受跨进程单飞锁保护，进行中的重启不会被打断。

两种运行面的退出策略不同：

- **桌面端**（`process.connected`）：宿主**不自行退出**。Electron main 会把「非请求性的宿主死亡」当致命错误弹恢复对话框，而 dispose 完成的宿主又会因父 IPC 挂着事件循环不自然退出。所以由 watchdog 优雅退出**整个应用**（macOS：AppleScript quit 事件；Windows：`taskkill /IM` 发送 WM_CLOSE）、等它真正消失（滞留则升格强杀）后重新拉起。
- **web / headless**：HTTP 响应冲刷完毕后经 `ctx.appExit(0)` 有界退出，另有硬退出兜底。

进程匹配方式（watchdog 用它判断「应用退干净了没」「拉起来没有」）：

- **macOS**：按完整路径模式 `<appName>.app/Contents/MacOS/<appName>`（pgrep -f），发信号前用 `ps` 复核 PID 归属。
- **Windows**：按镜像名 `<exe 文件名>`（tasklist）。`tasklist`/`taskkill` 输出按 CSV 结构解析，不依赖控制台代码页；每个 PID 强杀前都重新用 `tasklist /FI "PID eq"` 复核镜像名，防 PID 复用误杀。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id` 覆盖：

```yaml
- id: one-click-restart
  name: "@dsh-restart/one-click-restart"
  config:
    appName: "DeepSeek Harness"   # macOS: 应用名/进程匹配前缀;Windows: 兜底镜像名 <appName>.exe
    relaunchDelayMs: 1500          # 退出后到拉起之间的延迟
    maxRelaunchAttempts: 10        # 拉起重试次数
    # quitGraceMs 由 watchdog --quit-grace-ms 控制,最小 500;触发进行中的重复重启会被单飞锁忽略
    requestGracefulExit: true      # web 路径是否走 appExit
    enableHttpRoute: true          # 是否暴露按钮用的 HTTP 路由
    # restartToken: 固定令牌（默认每次启动随机生成）
    # appBundlePath:
    #   macOS:    /Applications/DeepSeek Harness.app
    #             macOS 桌面端默认由宿主 execPath 自动推导(.app 包路径),通常无需设置;
    #             headless(dsh web)无法推导时按提示设置这一项。
    #   Windows:  C:\...\DeepSeek Harness.exe（或其安装文件夹）
    #            Windows 桌面端默认自动使用当前运行的应用 exe,通常无需设置;
    #            headless(dsh web)拉起失败时按提示设置这一项。
```

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| **侧边栏没有按钮** | 装完没重启 DSH；或 profile 的 `cordis.patch.yml` 里该行被 `disabled: true`；或 DSH 版本不兼容（见上）。先确认 `dsh.profile.bundles` 里有 `@dsh-restart/one-click-restart`。 |
| **提示 `failed to import`** | 装到的是没有 `lib/` 的源码。`lib/` 已随仓库提交，若仍发生，检查 `node_modules/@dsh-restart/one-click-restart/lib/index.js` 是否存在。 |
| **按钮变红「重启失败：unauthorized: restart token is stale」** | 页面持有的令牌与宿主当前令牌不一致（宿主重启后）。再点一次即可——按钮会自动丢弃陈旧令牌并重新取。 |
| **按钮变红「无法连接宿主，重启未开始」** | 取令牌的同源 `GET` 都没成功：宿主进程已不在、端口不通、或路由被禁用（`enableHttpRoute: false`）。确认 DSH 正在运行，或检查 profile 配置。 |
| **按钮变红「重启失败：forbidden」** | 请求不是从本机 loopback 同源页面发出的（被反代/远程访问改写了 Host，或 `sec-fetch-site: cross-site`）。此路由按设计只服务本机页面。 |
| **点了只退出、不重新拉起** | 看 `~/Library/Logs/DeepSeek Harness/crash-*.log`。若出现宿主被弹恢复对话框，说明走了非预期路径；macOS 上还需确认 `open -a "DeepSeek Harness"` 能拉起应用（应用名改了需同步 `appName`）。 |
| **Windows：日志出现 "cannot determine what to relaunch on Windows"** | watchdog 找不到要拉起的 exe（常见于 headless）。在配置里把 `appBundlePath` 设为应用 exe 的完整路径（如 `C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe`），或确认应用装在 `%LOCALAPPDATA%\Programs\<appName>\`、Program Files 或注册表 `App Paths` 能找到的位置。 |
| **Windows：报 `--app-path` 指向 .lnk 被拒绝** | 快捷方式拿不到真实镜像名，退出阶段无法可靠判断「退干净没」。请直接指向 exe；指向安装文件夹也可以（会解析其中的 `<文件夹名>.exe`）。 |
| **Windows：管理员权限运行的 DSH 重启失败** | watchdog 继承宿主的令牌；若应用以管理员运行而拉起被 UAC 拦截，请以相同权限层级运行，或检查组策略。 |
| **点了完全没反应** | 应用可能有活跃任务，Harness 自身的退出确认拦下了。 |

## 从源码构建

```sh
pnpm install
pnpm build          # tsc 产出 lib/index.js 与 lib/index.d.ts，esbuild 产出 lib/client.js
```

> 自 v0.1.4 起 `src/index.ts`（宿主半部）与 `lib/` 产物重新同步：`pnpm build` 先跑 `tsc -p tsconfig.build.json` 产出 `lib/index.js` + `lib/index.d.ts`，再跑 `scripts/build-client.mjs` 产出 `lib/client.js`。改宿主半部请改 `src/index.ts` 后重新构建并提交 `lib/`。

`lib/client.js` 是发往浏览器的 closure-factory 产物（`window.__ModuleLoader__.load({ id, factory })`），只外部化 `react` / `react/jsx-runtime` 两个宿主种子模块。**改动 `src/` 后请一并提交 `lib/`**，否则 `github:` 安装拿到的仍是旧代码。

## 目录结构

```
├── package.json          # dsh.bundle（host patch）+ dsh.client（web 声明）+ exports["./client"]
├── cordis.patch.yml      # 贡献给 profile 的 patch layer
├── src/index.ts          # 宿主半部源码（与 lib/ 产物同步）
├── src/client/index.tsx  # 客户端半部：侧边栏按钮
├── scripts/relaunch.mjs  # 独立 watchdog
├── scripts/build-client.mjs
└── lib/                  # 预构建产物（随仓库提交）
```

## 许可

[MIT](./LICENSE)

## 变更记录


### 0.3.1

代码审查修复轮(由 GLM 5.3 Flash 按任务书执行、独立门禁验收、人工二次审查):

- **watchdog 跨进程单飞锁**:并发触发的重复重启不再互相干扰——锁文件(`%TEMP%\dsh-one-click-restart.watchdog.lock`,内容为持有者 PID)保证同一时刻只有一个 watchdog 执行退出/拉起;持有者存活时后来者立即避让(实测 87ms 退出),持有者死亡时陈旧锁被接管,所有退出路径均释放锁。修复"重启进行中再点一次会把刚拉起的实例再杀一遍"的竞态。
- **路由退出判定统一**:HTTP 路由的延迟退出分支改用与 `performRestart` 相同的 `exitOwnedByWatchdog()`(= `isDesktopHost() || isWindowsAppHosted()`),forked 宿主形态下不再误走 web 自退出路径与 watchdog 竞争。
- **补齐类型声明**:`lib/index.d.ts` 补 `isWindowsAppHosted`(运行时已导出而类型缺失)。
- **参数处理**:`--delay 0` 合法(原被静默改为 1500);`--quit-grace-ms` 低于 500 时显式告警后再取默认值。
- **解析加固**:`winAppPids` 把 tasklist 非零退出且无结构化输出视为"未知"而非"无进程"(防误判应用已退出);注册表 `App Paths` 值改按 `REG_SZ` 列头定位(路径值含 `_SZ` 时不再截断);`--app-path` 拒绝 `%` 与 `!`(会被 `cmd /c start` 展开)。
- **README**:补单飞锁与 `quitGraceMs` 说明。

### 0.3.0

**macOS 重启提速：watchdog 自身耗时中位数 1754ms → 851ms（Calculator.app 实测，5/5 成功；同样 6/6 通过 bundle 路径模式）**

取消的三处等待，全部来自「无法更快确认状态」而非真实工作需要：

- **quit 事件不再串行等待回执**：`tell application X to quit` 的 AppleScript 回执要等应用**拆完**才返回（实测约 560ms），旧实现 `await` 它之后才开始轮询退出,等于把这段时间和退出等待串起来。现在发出事件后立刻并行轮询，回执只用于失败告警；`quitGraceMs` 到期强杀的兜底语义不变。
- **退出检测改为进程内 PID 存活轮询**：旧实现每 150ms `spawn` 一次 `pgrep`（每次约 23ms 进程开销）。现在先用 `pgrep` 抓一次 PID 集合，之后用 `process.kill(pid, 0)`（约 0.5µs，ESRCH=已死 / EPERM=仍活）以 **40ms** 粒度轮询；集合清空时再做一次 `pgrep` 全扫，扫到即认领新 PID（退出过程中新生的 helper 也能被抓住）。PID 复用不会制造假活——只会多等一轮，最终仍由全扫裁决。
- **取消退出后固定 1 秒等待**：这段等待原本只为躲 LaunchServices「进程已死但注册还在」的竞态（此时 `open -a` 只会激活尸体、返回 0 却不拉起）。改用 `open -n` 强制新实例后该竞态不再成立，只剩 250ms 收尾沉降；`open -n` 仅在确认应用已消失后使用（否则会开出第二份实例）。
- **拉起目标改为 bundle 路径**：桌面宿主从自身 `execPath`（`<bundle>.app/Contents/MacOS/<exe>`）推导 `.app` 路径并作为 `--app-path` 传给 watchdog，`open` 因此跳过按应用名的 LaunchServices 查找；`appBundlePath` 配置仍优先。web/headless 路径不变（不传 `-n`，应用从未运行过）。
- **拉起验证轮询 200ms → 100ms**。

Windows 代码路径零改动（9 个 `win*` 函数逐字节比对一致）；`quitGraceMs`/`maxRelaunchAttempts`/argv 契约/日志格式均未变。

### 0.2.1

Windows 真机反馈的三项修复:

- **重启提速(~20s → 点击到窗口恢复约 7.5s)**:Windows 上 `taskkill /IM` 的 WM_CLOSE 对托盘常驻应用(无窗口可收)完全无效,原实现仍傻等 15 秒宽限才强杀。现在 Windows 默认宽限 **1 秒**(`--quit-grace-ms`,macOS 仍为 15 秒):WM_CLOSE 要么一秒内生效、要么根本不会生效;desktop 退出模式下触发响应冲刷所需的延迟封顶 200ms(原为完整 `relaunchDelayMs` 1.5s);强杀阶段对全部 PID **并行**复核与终止(原为逐个串行);所有轮询间隔 150ms。退出阶段(点击→进程组替换)实测约 3.4s,其余约 4s 为应用自身启动,插件无法压缩。
- **重启后不再缩在托盘**:改为经 `cmd /c start` 拉起——与用户双击完全同构的进程形态(正常 STARTUPINFO 显示状态、无 Electron 子进程上下文)。原先的裸 detached spawn 会以异常显示状态创建首窗口,应用"隐形"启动只剩托盘图标。拉起环境剥离 `ELECTRON_*` / `CHROME_*` 继承变量(含指向已死父进程的 crashpad 管道)。
- **修复宿主形态判定**(真机发现):Windows 桌面宿主有两种形态——Electron utilityProcess 子进程和 fork 出的 node 模式子进程——哪种形态出现**随启动而异**,原实现依赖的 `process.connected` 在 forked 形态下为 false,导致重启什么都不发生(不传 `--app-path`、不退出)。现在:只要 `process.execPath` 不是裸 node.exe 就传 `--app-path`;desktop 判定增加"父进程镜像名 == 应用 exe"检查(`isWindowsAppHosted`,apply 后首次使用时计算一次),两种形态都正确走 quitApp 路径。

### 0.2.0

**Windows 平台适配**（watchdog 与宿主半部；macOS 行为零变化）：

- **`scripts/relaunch.mjs` 全面跨平台化**，按 `process.platform` 分派,macOS 路径（AppleScript quit / pgrep / ps / `open -a`）原样保留,新增 Windows 实现：
  - **优雅退出**：`taskkill /IM <镜像名>`（不带 `/F`）向应用窗口发送 WM_CLOSE——正常关闭路径,Electron main 走自己的 quit 流程（AppleScript quit 事件的对应物）。无窗口进程（包括 watchdog 自身）会被该命令拒绝而非强杀,因此它伤不到 watchdog。
  - **强杀升级**：宽限期后逐 PID 复核镜像名（`tasklist /FI "PID eq"`,防 PID 复用误杀）再 `taskkill /F /PID`。**从不用 `taskkill /IM /F` / `/T`**。
  - **同镜像自排除**（Windows 特有关键点）：Windows 上 Electron 的 utility process 与主进程是同一个 exe,watchdog 由 `process.execPath` 在 `ELECTRON_RUN_AS_NODE` 下拉起——与应用**共享镜像名**。所有 tasklist 枚举都排除 watchdog 自身 PID,否则「应用退干净了」永远不成立、升级阶段会杀死 watchdog 自己。
  - **重新拉起**：直接 detached spawn 应用 exe（`windowsHide`,`cwd` 设为 exe 目录,剥离 `ELECTRON_RUN_AS_NODE`）。目标解析顺序：`--app-path`（exe 或安装文件夹,拒绝 .lnk）→ `%LOCALAPPDATA%\Programs\<appName>\` 与 Program Files 的 `<appName>.exe` → 注册表 `App Paths`。解析失败立即退出并提示设置 `appBundlePath`,不空耗重试次数。
  - tasklist/taskkill/reg 输出按 CSV 结构解析,不依赖控制台代码页;新增 `--quit-grace-ms` 参数（默认 15000）。
  - `--app-name` 校验补充拒绝反斜杠与冒号（Windows 路径注入面）;`--app-path` 新增绝对路径与引号/控制字符校验。
- **`src/index.ts` 宿主半部**：`spawnWatchdog` 在 Windows 桌面端默认把 `process.execPath`（即应用 exe）作为 `--app-path` 传给 watchdog——桌面端零配置可用;headless 不传（execPath 是 node.exe,拉起它是错的,走上面的解析链）。spawn 增加 `windowsHide: true`,避免 watchdog 闪控制台窗口。工具描述与配置 schema 说明同步。
- **验证**（Windows 11,以真实进程完成,测试脚本用后即弃）：
  1. 完整桌面链路:带窗口的测试应用经 WM_CLOSE 优雅退出（以 `FormClosing` 落盘文件证明非强杀）→ 重新拉起为新 PID,watchdog 退出码 0;镜像名含空格的引号处理正确。
  2. 同镜像自排除:watchdog 与目标同镜像时,tasklist 枚举出 2 个 PID,排除自身后恰为目标。
  3. 免配置解析:exe 置于 `%LOCALAPPDATA%\Programs\Fake Test App\` 时仅凭 `--app-name` 完成解析与拉起。
  4. 不可解析目标 98ms 快速失败,提示设置 `appBundlePath`。
  5. 无窗口应用拒绝 WM_CLOSE → 宽限期后按 PID 强杀 → 拉起成功。
- `lib/` 产物同步。Linux 不在本次范围（README 平台表已注明其自动化拉起仍不可用）。

### 0.1.6

适配 DSH 0.2.1-rc.3（插件行为零变化，仅清单声明与依赖对齐）：

- **`engines.dsh` 补上 `^0.2.1-rc.3`**：范围变为 `^0.2.0-rc.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3`。
- **`@deepseek-ai/dsh-tools` peer 范围同步补上 `^0.2.1-rc.3`**：原范围以 `^0.2.1-rc.2` 结尾，按 semver 默认语义不匹配 rc.3，显式补齐消除歧义。
- **devDependencies 全部对齐 0.2.1-rc.3**：`dsh-client-ui-renderer` / `dsh-client-ui-slots` / `dsh-cmdline` / `dsh-host-webserver` / `dsh-tools` 从 0.2.1-rc.2 升到 0.2.1-rc.3。
- **验证**：`tsc -p tsconfig.build.json` 与 `tsc --noEmit` 通过；`scripts/build-client.mjs` 产出客户端 bundle（外壳与 sourcemap 行偏移修复保持不变）；按宿主真实判定逻辑对 0.2.1-rc.3 / rc.2 / 0.2.0-rc.1 三版本判定全 PASS。

### 0.1.5

- **适配 DSH 0.2.1-rc.2**：devDependencies 全部对齐 0.2.1-rc.2（`@deepseek-ai/cordis` 4.0.5、`dsh-client-ui-renderer` / `dsh-client-ui-slots` / `dsh-cmdline` / `dsh-host-webserver` / `dsh-tools` 均升到 0.2.1-rc.2）。
- **补 `engines.dsh`**：新增 `^0.2.0-rc.1 || ^0.2.1-rc.2`，让宿主在安装前就能判定兼容，而不是仅靠 peer 预检。`@deepseek-ai/dsh-tools` peer 范围同步补上 `^0.2.1-rc.2`——只写 `^0.2.0-rc.1` 时，按 semver 默认语义（不带 `includePrerelease`）判定为**不满足** 0.2.1-rc.2，会让 `pnpm` 等工具报 peer 冲突。
- **修复 Windows 构建脚本**（真实缺陷，两处）：
  - `outputFiles` 的键此前用 `file.path.split('/').pop()` 取文件名——esbuild 在 Windows 上返回反斜杠路径，切分后键是整条路径，`outputs['client.js']` 为 `undefined`，Windows 上构建直接崩。改用 `node:path` 的 `basename()`。
  - `body.padStart(before.length, '\n')` 是**静默无效**的：`padStart` 按总长度补齐，而 bundle body 远长于 6 字符，所以一行都没补，sourcemap 相对 `lib/client.js` 整体偏移 6 行（断点与错误堆栈全部指错位置）。改为 `shiftMap()` 在 map 的 `mappings` 前面补 6 个分号，按行偏移映射；已对照 esbuild 原生 map 验证：行数差正好 6、去掉 6 个前导分号后 `mappings` 与原生逐字符一致。

### 0.1.4

- **修复客户端 bundle 无法加载**（隔离 DSH 0.2.0-rc.2 真机测试发现）：`lib/client.js` 包装行的 `{ value: Module }` 缺少引号——`Module` 在 factory 作用域未定义，浏览器加载客户端入口即抛 `ReferenceError: Module is not defined`，**侧边栏按钮因此从未出现**（宿主报 "web boot: 1 entry did not activate"）。本版把 `src/index.ts` 同步到 lib 的最新实现并重新执行 `pnpm build`，由 `scripts/build-client.mjs` 的正确包装模板产出客户端产物，从构建链上根治。
- **`src/index.ts` 与 `lib/` 重新同步**：此前 src 停留在 0.1.1 语义（无 volatile 配置、无 GET 令牌分支、无回环信任栅栏、仍是旧服务名 `restartHarnessToken`），而 lib 是权威产物。现在 src 是完整的 TS 源（`Volatile` 配置接口、`configValue`/`readConfig` 快照、GET+POST 路由、`isTrustedLoopbackRequest`、裸 IPv6 `::1` Host 修正、`oneClickRestart.token` 命名空间化 provide），`pnpm build`（tsc + esbuild）产出全部 lib/ 产物，类型检查通过，行为经 10 项回归断言验证与 0.1.3 逐项一致。

### 0.1.3（重构版，对外行为与接口不变）

- **`lib/index.d.ts` 与实现对齐**：删除了实现里既未导出也不存在的 `configValue` / `resolveConfig` 导出声明（二者在 `lib/index.js` 中是模块内私有函数）；补上已导出的 `isTrustedLoopbackRequest` 类型声明。此前从类型入口 import 这两个名字会得到运行时 `undefined`。
- **`apply()` 拆分**：工具定义与 HTTP route handler 分别提取为 `createRestartTool` / `createRestartRouteHandler` 工厂（模块内私有），`apply` 只负责装配。GET 返回 apply 期令牌、POST 按快照令牌校验、web 路径经 `finish`/`close` 延迟退出等行为逐行保留。
- 工具名、路由、配置字段、令牌缓存与信任栅栏逻辑零变化；watchdog（`scripts/relaunch.mjs`）与客户端产物（`lib/client.js`）未改动。

### 0.2.0-rc.1（未发版，工作树）

针对 DSH 0.2.0-rc.1 的一轮修复（详见 `audit/restart-fixes.md`）：

- **修掉「按钮 401 unauthorized」根因**：桌面窗口的 index 由应用包内静态 `dist` 提供，宿主 `webserver/index-inject` 的注入行到不了那个页面，`globalThis.__DSH_RESTART_TOKEN__` 恒为 `undefined`。改为客户端先同源 `GET /api/restart-harness` 取令牌再 `POST`；注入保留为 Web 端快路径。`lib/index.js` 的 handler 增加 GET 分支（`{ token }`，`cache-control: no-store`），`Allow` 改为 `GET, POST`。
- **补上被 exact 路由绕过的信任栅栏**：该路由优先于 Connection 包的 `/api` 前缀路由，所以通用栅栏失效；handler 内新增 loopback Host 校验与 `sec-fetch-site: cross-site` 拒绝（不通过 → 403）。
- **客户端不再把网络错误当成功**：取令牌失败时返回失败并给出可操作文案（原来一律 `{ ok: true }`）；只有「已持有令牌、POST 确已发出」后的连接中断才按成功处理。
- **配置字段全部 `.volatile()`**：7 个字段改为 schemastery volatile 引用，读取统一走新的 `configValue` / `readConfig` 快照，HMR 重载后令牌与设置不会钉死在旧值上。
- **服务名命名空间化**：`ctx.provide('restartHarnessToken')` → `'oneClickRestart.token'`（`lib/index.d.ts` 的 module augmentation 同步）。
- **`dsh.client.inject` 补 `@deepseek-ai/dsh-client-ui-renderer`**（`slots` 服务的真实提供者；sidebar 保留）。
- **devDependencies 对齐 0.2.0-rc.1**（原来是 0.1.7-rc.x）。
- **watchdog 加固**：`--app-name` 增加白名单校验（非法值回退默认名并告警）；`killRemaining` 改为先 pgrep 枚举 PID、`ps` 复核归属后再按 PID 发信号，并打印被杀 PID，不再用 `pkill -f` 直接匹配全命令行。

### 0.1.1

- **package.json**：`@deepseek-ai/dsh-tools` peer 范围放宽为 `^0.1.7-rc.1 || ^0.2.0-rc.1`——0.2.0-rc.1 起宿主对 `@deepseek-ai/dsh-*` 命名空间的 peerDependencies 做兼容性预检，旧范围在 0.2.0-rc.1 上会被预检禁用（stderr 报 "disabling profile plugin"）。`tools` 服务名、`defineTool`、`webServer.register(WebRoute)`、`webserver/index-inject` 的 `{kind:'global'}` 行、`ctx.get('appExit')` 在 0.2.0-rc.1 均未变化，此改动仅为通过预检，宿主侧代码零改动。
