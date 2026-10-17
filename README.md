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
| `packages/realm` | `WorkspaceRuntimeRegistry` 子类（drop-in 替换 `execution-worlds` 行）+ daemon 安装 + 宿主服务桥接 |
| `packages/api` | 宿主侧只读路由：`/ssh-workspace/machines`、`/precheck`、`/browse`（复用连接层准入） |
| `packages/ui` | 浏览器侧面板：机器列表 → 目录浏览 → 添加工作区（`sidebar.panellist` + `sidebar.footer.action` 弹窗） |
| `packages/install` | 打包/投递远端归档（bundle + 裁剪 node-pty） |
| `packages/rpc` | 长度前缀 JSON 帧 + 类型化错误 |

## 快速接入

见 `INSTALL.md`（构建归档 → 装入 profile → 覆写 `execution-worlds` 行 → 重启）。

## 使用（浏览器）

侧边栏底部 **🌐**（或面板列表里的「远程工作区」）：

1. **选机器** — 本机 + `~/.ssh/config` 全部具名主机（含 `Include` 递归），或直接输入
   别名（例如 `localhost`）。点选后自动做一次 `BatchMode` 非交互登录探测：
   `usable` / `needs-credentials` / `unreachable` / `unknown`。
2. **选目录** — 远端目录由 daemon 列出（与会话完全相同的 realm），可「上级」回溯。
3. **添加** — 该目录成为 SSH 工作区，随后所有 fs/终端/命令都在那台机器上执行。

原生入口同样可用：工作区菜单 →「添加远程工作区…」→ 选 SSH → 填别名与路径 → 验证 → 添加。

## 兼容矩阵

| 项 | 要求 |
| --- | --- |
| 远端 Node | ≥ 20（daemon 为 ESM bundle，使用 `createRequire` 兼容 node-pty 的原生依赖） |
| 远端 OpenSSH 客户端/服务端 | ≥ 8.2（`ssh -O forward`、`ControlMaster`、`ClearAllForwardings`） |
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

原生「添加远程工作区…」入口与 `verifyRemote` 客户端通路在**本地 harness 构建**里
（`~/repo/deepseek-harness` 工作树中的未发布改动）。因此：

```bash
# 一次性构建（宿主半 + 客户端半 + 前端）
cd ~/repo/deepseek-harness && pnpm build:lib && pnpm build:web

# 启动（本插件的面板与入口都在）
DSH_HOME=~/.dsh node apps/cli/lib/bin.js web --no-open --port 3081
```

本机 3080 端口的常驻服务由 systemd 用户单元启动的是**已发布版本**的 `dsh`，
它不含上面的 harness 改动，因此那个实例只有本插件提供的 🌐 面板本身可用
（面板依赖的宿主路由与本插件同装即可），原生「添加远程工作区…」入口不会出现。

## 验证

```bash
# 每个探针都可独立运行；依赖真实 sshd（默认 ssh localhost）
node tests/daemon/probe-transport.mjs    # 11/11 执行、断线续取终态、零重复、fs
node tests/daemon/probe-providers.mjs    # 13/13 官方 provider 家族原样工作
node tests/daemon/probe-realm.mjs        # 10/10 execution-worlds 路由与 verifier
node tests/api/machines.test.mjs          # 10/10 ssh config 枚举（通配隐藏、Include 递归、顺序）
node tests/daemon/probe-resilience.mjs   # 11/11 死亡场景（终端断线续播、换代、回收顺序、大文件 opId 重放、200 次观测）
PROBE_OUTAGE_MS=120000 node tests/daemon/probe-resilience.mjs   # 同上，断线 2 分钟
node tests/daemon/check-node-preflight.mjs                      # 远端 Node 缺失/过旧的报错文案
node tests/daemon/bench-resolve.mjs      # 往返延迟抽样（fs.resolve ≈ 4ms/op）
```

浏览器端的端到端证据（验证 → 添加 → 会话内远端执行）记录在 `PROGRESS.md`。
