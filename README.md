# @dsh-restart/one-click-restart

一键重启 DeepSeek Harness 插件：侧边栏「重启」按钮 + 模型可调用的 `restart_harness` 工具，在 Harness 退出后通过**独立守护进程（watchdog）**将其重新拉起。无需修改宿主 `main.js`、不依赖 `app.relaunch()`。

## 功能

1. **侧边栏按钮（Web 客户端插件）**：向 `sidebar.footer.action` 注入「重启 Harness」按钮，点击触发重启；宽栏显示图标+文字，窄栏（56px rail）显示圆形图标，带 pending / 失败反馈。
2. **模型可调用工具**：注册 `restart_harness` 工具，模型 / agent 可直接调用（可传 `delayMs`）。
3. **退出后仍能重启（Watchdog）**：触发时先 `spawn` 一个完全 detach 的守护进程，即使 Electron main 与 host Node 进程都已退出，也会延迟后通过 `open -a "DeepSeek Harness"` 重新拉起，并按配置重试。
4. **优雅退出（可选）**：若启动器提供有界退出请求（`ctx.appExit`），先请求 `exit(0)` 让当前实例真正退出后再由 watchdog 拉起。

## 为什么能「退出后仍重启」

Node / Electron 进程退出后无法自己拉起自己，本插件把「重启动作」交给**独立进程组**里的看门狗：

- `detached: true` → 子进程有自己的进程组，父进程退出不被连带杀死；
- `stdio: 'ignore'` + `child.unref()` → 不持有父进程的管道 / 事件循环引用，父进程可立即退出；
- watchdog 脚本只有「（桌面端：优雅退出应用 → 等待进程消失，滞留则升格 SIGTERM/SIGKILL）→ `open -a` → 重试」几步，不依赖任何 Harness 服务。

## 安装

**CLI 从 GitHub 安装（推荐）**

```sh
dsh plugin --profile desktop add github:G57651/dsh-one-click-restart
```

**Web UI**：Plugins 页 → Git 填 `github:G57651/dsh-one-click-restart`；或下载 Release / `pnpm pack` 产出的 tarball（`dsh-restart-one-click-restart-0.1.0.tgz`）后：

```sh
dsh plugin --profile desktop add dsh-restart-one-click-restart-0.1.0.tgz
```

**克隆后本地安装与构建**

```sh
git clone https://github.com/G57651/dsh-one-click-restart.git
cd dsh-one-click-restart
pnpm install && pnpm build     # tsc（host 半）+ esbuild（客户端 lib/client.js）
dsh plugin --profile desktop add ./
```

> 发布 tarball 与 GitHub 源码都自带构建产物，直接安装即可；仅在自行改动源码时才需要 `pnpm build`。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖本插件行的 `config`：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `appName` | `DeepSeek Harness` | `open -a <name>` 使用的应用名 |
| `appBundlePath` | — | 可选 .app 绝对路径（当 `-a` 匹配不到时回退用 `open <path>`） |
| `relaunchDelayMs` | `1500` | 退出后到重新拉起之间的延迟（ms） |
| `maxRelaunchAttempts` | `10` | watchdog 拉起重试次数 |
| `restartToken` | 随机 32 位 hex | HTTP 路由共享令牌（显式设置可固定；随机值按进程缓存，HMR 重载不变） |
| `enableHttpRoute` | `true` | 是否暴露 `POST /api/restart-harness` |
| `requestGracefulExit` | `true` | 是否在拉起前请求 `ctx.appExit(0)` 优雅退出 |

```yaml
- id: one-click-restart
  name: "@dsh-restart/one-click-restart"
  config:
    appName: "DeepSeek Harness"
    relaunchDelayMs: 1500
    maxRelaunchAttempts: 10
```

## 触发方式

- **侧边栏按钮**：点击 sidebar 底部的「重启 Harness」。
- **模型 / agent**：调用工具 `restart_harness`。
- **HTTP**：`POST /api/restart-harness`，头带 `x-restart-token: <token>`。

## 实现说明

- **两种运行面的退出策略**：桌面端（宿主是 Electron 受管子进程）宿主**不**自行退出——main.js 会把「非请求性的宿主死亡」当致命错误弹恢复对话框，因此由 watchdog 用 AppleScript quit 优雅退出**整个应用**、等它消失后 `open -a` 重新拉起；web / headless（单进程 `dsh web`）则在 HTTP 响应冲刷完毕后经 `ctx.appExit(0)` 有界退出，另有 6 秒硬退出兜底。
- **HTTP 路由与令牌注入**：`enableHttpRoute` 时在 `webserver/index-inject` 事件中把令牌注入页面（web 走 index.html head；桌面端走 `DESKTOP_IPC.boot` injections 表，都在客户端 bundle 执行前落地），并注册 loopback 路由，校验 `x-restart-token` 后触发；路由 disposer 挂子 fiber，webServer 消失 / 插件卸载时自动注销。
- **客户端接入**：`dsh.client { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-sidebar"] }` + `exports["./client"]`；`ctx.slots.inject('sidebar.footer.action', ...)` 贡献按钮，随插件卸载自动清理。401 提示重载页面，网络错误可点击重试。
- **依赖归属**：`peerDependencies`（与宿主共享实例）`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`；`devDependencies` 供类型检查与构建（esbuild、react、@types/* 等）。
- **安全**：路由仅 loopback + 共享令牌鉴权（`randomBytes(16)` 生成，可显式 pin）；不修改宿主 `main.js`、不添加 IPC 通道、无联网上报。
