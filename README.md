# dsh-ssh-workspace

DeepSeek Harness 的远程工作区插件：Web UI 里先选机器、再选目录，加出来的工作区其
**文件读写、终端、命令执行全部发生在远端**。`PLAN.md` 是完整计划，`PROGRESS.md` 是逐项证据台账。

**SSH 只是数据管道。** 远端常驻 `workspace daemon`，客户端断线不影响远端命令；
重连后自动拉取缓冲与终态，**绝不重放副作用**（opId 幂等门）。

## 布局

| 包 | 职责 |
| --- | --- |
| `packages/daemon` | 远端 workspace daemon：单文件 bundle `lib/workspaced.js`（Node ≥ 20），unix socket + TLS-PSK 流端点 + 重放缓冲 |
| `packages/transport` | 形状兼容 `{request, connectStream, dispose}` 的连接：ssh master、按流 `ssh -L` 转发、重连状态机、opId 自动注入 |
| `packages/providers` | 把 `ctx.ssh` 换成 daemon 版，官方 `dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` / `dsh-bash-sandbox` 原样复用 |
| `packages/mount` | 根平面路由（rc.2 定案）：patch `ctx.fs`/`ctx.subprocess`/`ctx.sandbox` + terminal/session 控制器 + `WorkspaceRegistry/Entity`，把远端工作区的操作派发到所属主机的 daemon providers；daemon 投递 + 侧映射 `ssh-workspaces.json` |
| `packages/api` | 宿主侧只读路由：`/ssh-workspace/machines`、`/precheck`、`/browse`（复用连接层准入）、`POST /adopt` |
| `packages/ui` | 浏览器侧面板：机器列表 → 目录浏览 → 添加工作区（`sidebar.panellist` + `sidebar.footer.action` 弹窗） |
| `packages/install` | 打包/投递远端归档（bundle + 裁剪 node-pty） |
| `packages/rpc` | 长度前缀 JSON 帧 + 类型化错误 |

## 快速接入

见 `INSTALL.md`（构建归档 → 装入 profile → 追加 `ssh-workspace-mount` 等三行 patch → 重启）。

## 使用（浏览器）

侧边栏「添加工作区（＋）」→ 菜单「添加工作区…」→ **「选择工作区目录」弹窗**，
弹窗**最上方**是主机选择：

1. **选机器** — 下拉 = 本机 + `~/.ssh/config` 全部具名主机（含 `Include` 递归）。
   选定后自动做一次非交互登录探测：
   `usable` / `needs-credentials` / `unreachable` / `unknown`（徽标显示在弹窗顶部）。
2. **选目录** — 本机走宿主浏览；远端目录由插件的 daemon 连接列出（与会话完全相同），
   可「上级」回溯，「显示隐藏文件」开关可用。
3. **打开** — 本机：走 Harness 原生目录流语义（创建后自动开始会话）；
   远端：直接创建 SSH 工作区（该弹窗承载 host，无法转交 owner），随后所有
   fs/终端/命令都在那台机器上执行。

说明（方案 B：Harness 源码零改动）：
- Harness 自带的「添加远程工作区…」菜单项与文本表单弹窗保留（插件无法隐藏），
  与本弹窗并存；两边的结果等价（都写入同一工作区 store）。
- 弹窗由插件以 `priority: -1` 注册进目录流槽位，视觉与交互复刻官方
  「选择工作区目录」弹窗（`@deepseek-ai/dsh-client-ui-primitives` 的 Modal/Button）。

## 兼容矩阵

| 项 | 要求 |
| --- | --- |
| 远端 Node | ≥ 20（daemon 为 ESM bundle，使用 `createRequire` 兼容 node-pty 的原生依赖） |
| 远端 OpenSSH 客户端/服务端 | ≥ 8.2（`ssh -O forward`、`ControlMaster`） |
| 远端 shell | POSIX `sh`（bootstrap 只用 `mkdir/chmod/rm/test/kill/setsid/nohup`） |
| 远端平台 | linux（node-pty 预编译按平台裁剪；darwin 需自备 node-pty） |
| 宿主 | Node ≥ 20；已装 `ssh`；`~/.ssh/config` 可读 |
| 认证 | 非交互登录（密钥 / agent / ControlMaster）；不支持交互式密码 |

## 恢复与运维

| 情况 | 行为 |
| --- | --- |
| 网络抖动 / SSH 主连接被杀 | transport 自动重连，按已确认字节偏移续播 stdout/stderr/终端；远端进程继续运行 |
| 客户端进程重启 | 新连接用同一 `clientUuid` 重入同一会话，`fs.*`/`process.*` 终态照常可查 |
| daemon 被强杀（SIGKILL） | 下次 bootstrap 检测到「socket 在、pid 已死」会清理残留并重启；客户端若声明了旧 instanceId 会收到 `WORKSPACE_PROGRESS_LOST`（明确告知进度不可续，而不是假装续上） |
| daemon 重启后 | 白名单从 `config.json` 恢复（含用户曾添加的目录，保留最近 64 条） |
| 远端缺少 node-pty | 一切正常，只有终端不可用 |

## 运行一个带完整 UI 的实例

插件只依赖已发布包（`dsh` 0.2.1-rc.2 及其 `@deepseek-ai/*` 组件），**不需要任何 harness
源码改动**。用一个独立 `DSH_HOME` 起临时实例即可验证，不打扰 3080 的常驻服务：

```bash
DSH_HOME=/tmp/dsh-ssh-test dsh web --no-open --port 3081
```

本机 3080 端口的常驻服务由 systemd 用户单元启动；宿主侧代码变更后需要
`systemctl --user restart dsh-web.service` 才会生效（UI bundle 实时读盘、无需重启）。

## 验证

```bash
# 每个探针都可独立运行；依赖真实 sshd（默认 ssh localhost）
node tests/daemon/probe-transport.mjs    # 11/11 执行、断线续取终态、零重复、fs
node tests/daemon/probe-providers.mjs    # 13/13 官方 provider 家族原样工作
node tests/daemon/probe-mount.mjs        # 28/28 根平面路由（fs/subprocess/sandbox/终端/会话）+ adopt + 侧映射
node tests/api/machines.test.mjs          # 10/10 ssh config 枚举（通配隐藏、Include 递归、顺序）
node tests/daemon/probe-resilience.mjs   # 11/11 死亡场景（终端断线续播、换代、回收顺序、大文件 opId 重放、200 次观测）
PROBE_OUTAGE_MS=120000 node tests/daemon/probe-resilience.mjs   # 同上，断线 2 分钟
node tests/daemon/check-node-preflight.mjs                      # 远端 Node 缺失/过旧的报错文案
node tests/daemon/bench-resolve.mjs      # 往返延迟抽样（fs.resolve ≈ 4ms/op）
```

浏览器端的端到端证据（验证 → 添加 → 会话内远端执行）记录在 `PROGRESS.md`。
