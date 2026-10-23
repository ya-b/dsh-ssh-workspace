# AGENTS.md

## 项目

DeepSeek Harness 远程工作区插件（monorepo，`pnpm`）。

核心语义：Web UI 先选机器（本机 + `~/.ssh/config`）、再选目录；该工作区的 fs / 终端 / 命令
**全部在远端执行**。SSH 只是数据管道——断线不中断远端命令，重连自动续取缓冲/终态，
**绝不重放副作用**（opId 幂等门）。计划与证据台账见 `PLAN.md` / `PLAN-UI.md` / `PROGRESS.md`。

## 铁律（必须保持）

1. **`../deepseek-harness` 字节级不可改**（含 dsh helper）。一切新代码只在本仓库内；
   对 harness 的接入一律走 profile/bundle 组合（`~/.dsh/profiles/web/cordis.patch.yml` 的
   `insert`，或 client/module 表机制）。
2. **深路径 import 禁止**：不得 `import '@deepseek-ai/dsh-*/src/*'`；只允许公开发布面
   （`@deepseek-ai/cordis`、`dsh-ssh` 家族、`dsh-workspace` 记录 schema 等）。
3. **不中 helper**：daemon 是唯一远端依赖；helper 只允许作为对照探针出现。
4. **安全面不设限（项目决策，勿擅自恢复）**：ssh 一律走普通默认行为，不强制
   `BatchMode` / `StrictHostKeyChecking` / `ForwardAgent` / `ClearAllForwardings`；远端状态
   目录、socket、状态文件不强制权限；TLS-PSK 流端点使用公开静态 capability（不轮换）。
   恢复任一安全面都必须有用户明确指示。
5. **不盲重发**：断线后唯一合法写路径 = 重连成功后按 opId 查询/提交；重放只能走 opId 幂等门
   （`fs.write`/`fs.edit`/`process.prepare`/`process.start`/`terminal.write`）。
6. **reap 只由三类显式事件触发**：① daemon 关闭 ② 显式 terminate/abandon
   ③ 句柄上限回收（先已完成、后最老运行）；**断线/心跳/租约永不回收**。

## 布局

| 包 | 职责 |
| --- | --- |
| 仓库根（`@dsh-ssh-workspace/bundle`） | 可安装组合包：`cordis.patch.yml` 三行 + 自包含 `lib/{mount,api,index,client}.js` + `dist/daemon.tar.gz`；git 装进 profile 后即生效 |
| `packages/daemon` | 远端常驻 daemon：单文件 bundle `lib/workspaced.js`（Node ≥ 20）；unix socket + TLS-PSK 流端点 + 按偏移重放 `ReplayBuffer`；opId 门 + 终态缓存；`workspace.allow` 动态白名单（落盘 `config.json`，保留最近 64 条） |
| `packages/transport` | 形状兼容 `{request, connectStream, dispose}`：ssh master、按流 `ssh -L` 转发、重连状态机、`DurableStream` 续接、opId 自动注入；**只在真实链路丢失时重试**（首次连接有上限），握手失败即杀 ssh 不留泄漏 |
| `packages/providers` | `DaemonSshConnection` = daemon 版 `ctx.ssh`，官方 `dsh-fs-ssh`/`dsh-subprocess-ssh`/`dsh-sandbox-ssh`/`dsh-bash-sandbox` 原样复用 |
| `packages/mount` | rc.2 根平面路由（Option B，不覆写 `execution-worlds`）：patch `ctx.fs` 按路径、`ctx.subprocess` 按 cwd、`ctx.sandbox` 按 `workspaceRoot`、`terminalController.execution(agent)` 按会话 cwd、`sessionController.agents.createAgent` 按 cwd（跳过本地 `mkdir`）、`WorkspaceRegistry/Entity`（adopt/indexHeader/resolveByPath/attachSession/delete）；daemon 按 (host, dir, 摘要) 幂等投递；侧映射 `${DSH_HOME}/storages/ssh-workspaces.json` |
| `packages/api` | 宿主侧 `SshHostsService`：`~/.ssh/config` 枚举（Include 递归/通配隐藏）、`precheck`、远端 `browse`（走 mount 服务）、`POST /adopt` 收养远端工作区；以 HTTP 路由暴露给浏览器 |
| `packages/ui` | 浏览器半：以 `priority:-1` 占据目录流槽位，复刻「选择工作区目录」弹窗，顶部主机选择条；远端「打开」= `POST /ssh-workspace/adopt` 后按需重命名 `<目录>@<主机名>` |
| `packages/install` | 打包/投递远端归档（bundle + 裁剪 node-pty） |
| `packages/rpc` | 4 字节长度前缀 JSON 帧（64MiB 上限、128 pending）；`RemoteOperationError` / `RpcTransportError` |

## 关键不变量（改代码前先看）

- daemon 响应给官方 provider 的 `process.prepare` 必须**恰好** `{id, streams}`（官方
  `preparedSchema` 是 `.strict()`，多一个字段就解析失败）。
- transport 的重试判定只看 `RpcTransportError` / 已知 socket 错误码 / 管理超时（`TimeoutError`）；
  超时重试仅限可重放操作（`REISSUABLE` 或带 opId），复用同一 opId 且有次数上限；调用方 abort、
  schema/业务错误**不重试**。
- 客户端 `process.prepare` 用与 daemon 相同的 `clientUuid`（由 controlDir+host+workspace 哈希派生）
  重入同一会话；daemon 换代（instanceId 不符）→ `WORKSPACE_PROGRESS_LOST`，不许假装续上。
- 浏览器端 bundle 必须带 `export const inject`（漏了会导致 entry activate 失败，且报错只有
  「failed to load plugins」——先查这个再查别的）。
- 远端 daemon 是多进程常量：`bootstrapCommand` 只在 socket 不存在时 `setsid nohup` 启动；
  bootstrap 前置检查远端 Node ≥ 20（报
  `remote workspace daemon preflight failed: <node> is not a usable Node >= 20`）。
- 自动升级（mount `autoUpgrade`，默认开）：daemon boot 时写 `running.digest`（自身
  bundle sha256，socket 可见前写完，shutdown 时删除）；bootstrap 每次连接对比它与
  已安装 `workspaced.js` 的 sha256，不一致（含旧版 daemon 无该文件）且 `pgrep -P`
  确认无子进程时才 SIGTERM 重启，忙则保留旧版等下次连接；无 `pgrep` 不重启（fail-closed）。

## 构建与测试

```bash
pnpm install                      # 首次；harness vendor/packages 用 link: 目录引用

# 安装产物（改了对应源码必须重建，且重建后重启实例才会生效）
pnpm run build                    # → 根 lib/{mount,api,index,client}.js + dist/daemon.tar.gz
# 等价的单项构建：
cd packages/daemon && pnpm run build      # → lib/workspaced.js
cd packages/mount && pnpm run archive     # → dist/daemon.tar.gz（bundle + node-pty）
cd packages/ui && node build.mjs          # → packages/ui/lib/client.js（默认 id 仍是 ui 包）

# 单测/端到端（需真实 sshd，默认 ssh localhost；daemon 部署在 ~/.dsh-workspace）
node tests/api/machines.test.mjs          # ssh config 枚举 10/10
node tests/daemon/probe-transport.mjs     # 17/17 执行/断线续取/零重复/fs/deadline 重试/失败 start 重放
node tests/daemon/probe-providers.mjs     # 14/14 官方 provider 家族
node tests/daemon/probe-mount.mjs         # 36/36 根平面路由（fs/subprocess/sandbox/终端/会话）+ adopt + 侧映射 + provider fiber 隔离 + 主机恢复回归
node tests/daemon/probe-remote-tools.mjs   # 22/22 remote_* 别名、路径门、提示词、幂等与继承遮蔽
node tests/daemon/probe-resilience.mjs    # 11/11 死亡场景；PROBE_OUTAGE_MS=120000 跑 2 分钟断线
node tests/daemon/probe-upgrade.mjs       # 9/9 自动升级：空闲换新版/忙保留/空闲后补升级
node tests/daemon/check-node-preflight.mjs# 远端 Node 缺失/过旧报错文案
```

- 根 `lib/` 与 `dist/daemon.tar.gz` 是 git 安装用的已提交产物：改源码后必须重建再提交，
  否则 `dsh plugin add <git-url>` 装到的仍是旧代码。
- 类型检查：`cd packages/<pkg> && ../../node_modules/.bin/tsc --noEmit`（daemon 内
  `pnpm run typecheck`）。
- 环境注意：daemon/transport/mount 直接由 Node 运行（strip-only 模式）——**不要用
  TS 参数属性**；单文件构建用 esbuild（`build.mjs`）。
- 后台进程：测试/临时实例用 systemd 瞬态单元 `systemd-run --user --unit <name> --collect ...`
  （普通 `&` 会被杀掉；`setsid nohup` 也可能被工具超时连带清掉）。

## 浏览器验证（临时实例）

```bash
DSH_HOME=/tmp/opencode/dsh-home systemd-run --user --unit dsh-test --collect /home/user/.local/bin/dsh web --no-open --port 3081
```

- 插件装入 profile：`dsh plugin --profile web add 'link:/abs/path/to/dsh-ssh-workspace'`
  （根组合包自带 `cordis.patch.yml` 三行；git 安装见 `INSTALL.md`）。
- 验证路径：侧边栏「添加工作区」→ 菜单「添加工作区…」→ 弹窗顶部选主机 → 选目录 →「打开」；
  会话内发消息即验证远端执行（`pwd` 应回远端目录）。
- 不要动 3080（systemd 用户单元启动的已发布版本）；临时 ssh 别名测试后必须还原
  `~/.ssh/config` 并清理 store 测试条目（`~/.dsh/storages/workspace.json`）。

## 代码风格

- 保持简洁直接；注释只在逻辑复杂、代码本身无法表达时写（本项目模块头注释与关键约束注释
  是例外——它们记录协议约束，必须保留）。
- 修改现有代码时遵循该文件的既有风格。
- 提交用中文或英文说明均可；作者统一 `dev@local`。
