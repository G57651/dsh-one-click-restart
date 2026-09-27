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
dsh plugin --profile <你的 profile> add ./dsh-restart-one-click-restart-0.1.0.tgz
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

- 依赖 `@deepseek-ai/dsh-tools: ^0.1.7-rc.1`，即**只支持 DSH 0.1.7-rc.x**。
- DSH 会主动检查插件声明的 `@deepseek-ai/dsh-*` peer：版本不匹配时，**安装会被直接拒绝或回滚**，已装的插件行会被置为 `disabled`（表现为「插件没生效」而不是报错）。
- 这是有意为之：客户端 bundle 依赖宿主的模块表与 sidebar slot 契约，这些都随 DSH 版本变化，而宿主**不对客户端产物做任何版本检查**。宁可让不兼容在安装期报错，也不让它在运行时炸。
- DSH 发布 0.2.0 时本插件需要跟进更新。届时请用 `dsh plugin --profile <p> allow-version ...` 临时豁免，或等新版本。

## 功能

1. **侧边栏按钮**：向 sidebar 底部的 `sidebar.footer.action` list slot 注入按钮。宽栏为「图标 + 文字」整行，窄栏（56px rail）为圆形图标；重启进行中图标持续旋转、文字带跳动点；失败时停止并显示原因。
2. **`restart_harness` 工具**：模型/agent 可直接调用（可选 `delayMs` 覆盖延迟）。
3. **令牌保护的 HTTP 路由**：`POST /api/restart-harness`，校验 `x-restart-token`。令牌由宿主在启动时注入页面，浏览器侧读取 `globalThis.__DSH_RESTART_TOKEN__`。

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
| **按钮变红「重启失败：unauthorized」** | 页面持有的令牌与宿主当前令牌不一致（HMR 重载或宿主重启后）。刷新页面即可。 |
| **点了只退出、不重新拉起** | 看 `~/Library/Logs/DeepSeek Harness/crash-*.log`。若出现宿主被弹恢复对话框，说明走了非预期路径；macOS 上还需确认 `open -a "DeepSeek Harness"` 能拉起应用（应用名改了需同步 `appName`）。 |
| **点了完全没反应** | 应用可能有活跃任务，Harness 自身的退出确认拦下了。 |

## 从源码构建

```sh
pnpm install
pnpm build          # tsc 产出 lib/index.js，esbuild 产出 lib/client.js
```

`lib/client.js` 是发往浏览器的 closure-factory 产物（`window.__ModuleLoader__.load({ id, factory })`），只外部化 `react` / `react/jsx-runtime` 两个宿主种子模块。**改动 `src/` 后请一并提交 `lib/`**，否则 `github:` 安装拿到的仍是旧代码。

## 目录结构

```
├── package.json          # dsh.bundle（host patch）+ dsh.client（web 声明）+ exports["./client"]
├── cordis.patch.yml      # 贡献给 profile 的 patch layer
├── src/index.ts          # 宿主半部：工具、路由、令牌、退出策略
├── src/client/index.tsx  # 客户端半部：侧边栏按钮
├── scripts/relaunch.mjs  # 独立 watchdog
├── scripts/build-client.mjs
└── lib/                  # 预构建产物（随仓库提交）
```

## 许可

[MIT](./LICENSE)
