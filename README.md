# @dsh-restart/one-click-restart

一键重启 DeepSeek Harness 插件：侧边栏「重启」按钮 + 模型可调用的 `restart_harness` 工具，在 Harness 退出后通过**独立守护进程（watchdog）**将其重新拉起。

## 功能

1. **侧边栏按钮（Web 客户端插件）**：向 sidebar 底部的 `sidebar.footer.action` list slot 注入「重启 Harness」按钮，点击后 `POST /api/restart-harness` 触发重启；宽栏显示图标+文字，窄栏（56px rail）显示圆形图标，带 pending/失败反馈。
2. **一键重启入口（Tool）**：注册 `restart_harness` 工具，模型/agent 可直接调用触发重启。
3. **退出后仍能重启（Watchdog）**：插件在触发重启时，先 `spawn` 一个**完全 detach 的守护进程**（`scripts/relaunch.mjs`），该进程不依赖 Harness 的生命周期——即使 Electron main 进程与 host Node 进程都已退出，它也会在延迟后通过 macOS 的 `open -a "DeepSeek Harness"` 重新拉起应用，并按配置重试。
4. **优雅退出（可选）**：若启动器提供了有界退出请求（`ctx.appExit`，来自 `@deepseek-ai/dsh-cmdline`），插件会先请求 `exit(0)`，让当前实例真正退出后再由 watchdog 拉起。

## 为什么能「退出后仍重启」

Node / Electron 进程退出后无法自己拉起自己。本插件把「重启动作」交给一个**独立进程组**里的看门狗负责：

- `detached: true` → 子进程进入自己的进程组，父进程退出时不会被连带杀死；
- `stdio: 'ignore'` + `child.unref()` → 子进程不持有父进程的管道/事件循环引用，父进程可立即退出；
- watchdog 脚本只有「(桌面端：优雅退出应用 → 等待进程消失，滞留则升格 SIGTERM/SIGKILL)→ `open -a` → 重试」几步，不依赖任何 Harness 服务。

因此重启语义**完全在 Harness 进程之外**完成，无需修改宿主 `main.js` / `app.relaunch()`。

## 两种运行面的退出策略

- **桌面端**（`process.connected`，宿主是 Electron 主进程的受管子进程）：宿主**不**自行退出——main.js 会把"非请求性的宿主死亡"当作致命错误弹恢复对话框，而已完成 dispose 的宿主进程又会因父 IPC/stdio 挂着事件循环不自然退出。此时由 watchdog 用 AppleScript quit 事件优雅退出**整个应用**、等它消失后 `open -a` 重新拉起；宿主与页面随应用一起自然结束。
- **web / headless**（单进程 `dsh web`）：HTTP 响应冲刷完毕（`finish` 事件 + 400ms 对端读取缓冲）后经 `ctx.appExit(0)` 有界退出；另有 6 秒硬退出兜底，防止事件循环滞留。

## 目录结构

```
dsh-one-click-restart/
├── package.json           # dsh.bundle（host patch）+ dsh.client（web 客户端声明）+ exports["./client"]
├── cordis.patch.yml       # bundle 贡献的 patch layer（按包名引用插件）
├── tsconfig.json          # typecheck（含 src/client，DOM + react-jsx）
├── tsconfig.build.json    # host 半部 tsc emit（排除 src/client）
├── README.md
├── scripts/
│   ├── relaunch.mjs       # 独立守护进程：退出后拉起应用
│   └── build-client.mjs   # esbuild 构建 lib/client.js（closure-factory 包装）
└── src/
    ├── index.ts           # 宿主插件：restart_harness 工具 + HTTP route + 令牌注入
    └── client/index.tsx   # 客户端插件：sidebar.footer.action 按钮
```

## 构建

```sh
pnpm install
pnpm build          # tsc（host 半部 lib/index.js）+ esbuild（客户端 lib/client.js）
pnpm typecheck      # 全量类型检查
pnpm build:client   # 只重建客户端 bundle
```

客户端 bundle 的产物格式是宿主 `dsh-client-modules` 约定的 **closure-factory**：`window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 的 `require` 从模块表解析外部依赖（本插件只外部化 `react` / `react/jsx-runtime` 两个平台种子模块）。`scripts/build-client.mjs` 用 esbuild 产出 CJS 体积后按该格式包装，不依赖 monorepo 内部工具链。

## 配置（cordis.yml / cordis.patch.yml）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `appName` | `DeepSeek Harness` | `open -a <name>` 使用的应用名 |
| `appBundlePath` | — | 可选 .app 绝对路径（当 `-a` 匹配不到时回退用 `open <path>`） |
| `relaunchDelayMs` | `1500` | 退出后到重新拉起之间的延迟（ms） |
| `maxRelaunchAttempts` | `10` | watchdog 拉起重试次数 |
| `restartToken` | 随机 32 位 hex | HTTP 路由共享令牌（显式设置可固定；随机值按进程缓存，HMR 重载不变） |
| `enableHttpRoute` | `true` | 是否暴露 `POST /api/restart-harness`（供客户端按钮调用） |
| `requestGracefulExit` | `true` | 是否在拉起前请求 `ctx.appExit(0)` 优雅退出 |

示例（profile 的 `cordis.patch.yml`）：

```yaml
- id: one-click-restart
  name: "@dsh-restart/one-click-restart"
  config:
    appName: "DeepSeek Harness"
    relaunchDelayMs: 1500
    maxRelaunchAttempts: 10
```

## 安装

```sh
# 从本地目录安装到 profile
dsh plugin --profile desktop add ./dsh-one-click-restart

# 查看生效的配置层
dsh --profile desktop --dump-config | grep -A3 one-click-restart
```

## 触发方式

- **侧边栏按钮**：点击 sidebar 底部的「重启 Harness」（见下节）。
- **模型/agent**：调用工具 `restart_harness`（可传 `delayMs` 覆盖默认延迟）。
- **HTTP**：`POST /api/restart-harness`，头带 `x-restart-token: <token>`。

## HTTP 路由与令牌注入

当 `enableHttpRoute` 为真时，插件通过 `ctx.inject(['webServer'], ...)` 等待宿主的 `webServer` 服务就绪后（webserver 条目挂载晚于本 bundle，apply 时一次性探测会输掉时序竞争）：

1. 在 `webserver/index-inject` 事件中注入 `globalThis.__DSH_RESTART_TOKEN__ = <token>`，把令牌交给页面（web 走 index.html head 注入；桌面端走 `DESKTOP_IPC.boot` 的 injections 表，两条路径都在客户端 bundle 执行前落地）；
2. 注册 loopback 路由 `POST /api/restart-harness`，校验 `x-restart-token` 后触发重启。路由 disposer 挂在子 fiber 上：webServer 服务消失/插件卸载时自动注销，不会留下重复路由。

## 侧边栏按钮（Web 客户端半部）

package.json 的 `dsh.client` 声明（`platform: "web"`, `inject: ["@deepseek-ai/dsh-client-ui-sidebar"]`）+ `exports["./client"]` 指向构建产物 `lib/client.js`。宿主的 `dsh-client-modules` 扫描 loader 条目时解析该声明，把 bundle 组进浏览器启动图（`/plugins/<pkg>/client.js`）。

客户端入口 `src/client/index.tsx`：

- `export const inject = ['slots']`（slots 服务由 UI renderer 壳提供）；
- `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id: 'one-click-restart', order: 50 }, RestartButton))`——向 sidebar 壳声明的 list slot 贡献按钮，随插件卸载自动清理；
- 点击时 `fetch('/api/restart-harness', { method: 'POST', headers: { 'x-restart-token': globalThis.__DSH_RESTART_TOKEN__ } })`；401 提示重载页面，网络错误可点击重试（此时进程未退出）。

修改 `src/client/index.tsx` 后运行 `pnpm build:client` 并重启/刷新页面即可生效（客户端产物不进 `/plugins` 路由前不会出现在页面上）。

## 依赖归属

- `peerDependencies`（与宿主共享实例）：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。
- `devDependencies`（类型检查 + 测试）：同上 + `@deepseek-ai/dsh-cmdline`（`AppExit` 类型）、`@deepseek-ai/dsh-host-webserver`（`WebServer` 类型）、`@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-renderer`（客户端 slot 类型）、`react` / `@types/react`、`esbuild`（客户端 bundle 构建）。

## 安全

- HTTP 路由仅 loopback（`webServer` 默认 host `127.0.0.1`）+ 共享令牌鉴权；令牌通过 `randomBytes(16)` 生成，可显式 pin。
- 不修改宿主 `main.js`、不添加 IPC 通道、不开启任何联网上报。
