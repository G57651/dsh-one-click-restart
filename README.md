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
dsh plugin --profile <你的 profile> add ./dsh-restart-one-click-restart-0.1.1.tgz
```

装完**重启一次 DSH**。之后侧边栏左下角（Settings 上方）会出现「重启 Harness」。

> 两种方式都**不需要** npm、不需要联网装任何依赖、也不需要你手动批准任何构建脚本（插件没有 `prepare` 钩子）。

## 平台支持（请先读这一段）

| 运行面 | 状态 |
|---|---|
| **macOS 桌面端** | ✅ 已实测：点击 → 应用整体退出 → 自动重新拉起 |
| **web / headless**（`dsh web`） | ✅ 已实测：点击 → 进程退出 → watchdog 拉起 |
| Windows / Linux 桌面端 | ⚠️ **未验证**。代码路径会走 web 那条（`ctx.appExit`），但没有人在这些系统的 Electron 壳上跑过。按钮应当出现，重启行为未经验证 |

桌面端的自动化重启依赖 macOS 的 `open` / AppleScript quit 事件，因此**本质上只在 macOS 上做自动化**；其他系统的桌面端会退化为「宿主自己退出 + `open` 拉起」。

## 兼容性

- 依赖 `@deepseek-ai/dsh-tools: ^0.1.7-rc.1 || ^0.2.0-rc.1`，支持 DSH 0.1.7-rc.x 与 0.2.0-rc.x。
- DSH（0.2.0 起）会主动检查插件声明的 `@deepseek-ai/dsh-*` peer：版本不匹配时，**安装会被直接拒绝或回滚**，已装的插件行会被置为 `disabled`（表现为「插件没生效」而不是报错）。
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

两种运行面的退出策略不同：

- **桌面端**（`process.connected`）：宿主**不自行退出**。Electron main 会把「非请求性的宿主死亡」当致命错误弹恢复对话框，而 dispose 完成的宿主又会因父 IPC 挂着事件循环不自然退出。所以由 watchdog 用 AppleScript quit 事件优雅退出**整个应用**、等它真正消失（滞留则升格 SIGTERM/SIGKILL）后 `open -a` 拉起。
- **web / headless**：HTTP 响应冲刷完毕后经 `ctx.appExit(0)` 有界退出，另有硬退出兜底。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id` 覆盖：

```yaml
- id: one-click-restart
  name: "@dsh-restart/one-click-restart"
  config:
    appName: "DeepSeek Harness"   # open -a 用的应用名
    relaunchDelayMs: 1500          # 退出后到拉起之间的延迟
    maxRelaunchAttempts: 10        # 拉起重试次数
    requestGracefulExit: true      # web 路径是否走 appExit
    enableHttpRoute: true          # 是否暴露按钮用的 HTTP 路由
    # restartToken: 固定令牌（默认每次启动随机生成）
    # appBundlePath: /Applications/DeepSeek Harness.app
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
