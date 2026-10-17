# DeepSeek Harness 远程工作区插件 · Agent 代码执行计划

> 目标：Web 界面添加工作区先选机器（本机 + `~/.ssh/config` 远程机器）、再选目录；该工作区的文件读写、terminal、命令全部在远程执行；ssh 只是数据传输管道，断线不影响远程 side-daemon 中的命令执行，重连后自动补取缓冲/终态，绝不重复执行。
>
> **硬约束：`~/repo/deepseek-harness/_0=none`
> 仓库一字节不改（含 dsh helper）。一切新代码 = 本插件工作仓 `~/repo/dsh-ssh-workspace` 下的插件包，通过 profile/bundle 组合注入 harness。_

---

## 1. 决策记录（_MP_ agent 不得推翻，只能报告冲突）

| # | 决策 | 依据 |
|---|---|---|
| D1 | **不自带 helper 不可改但也不可直接复用** | helper 协议 `z.literal(SSH_PROTOCOL_VERSION=2)` + `SshConnection` 无 reattach、无 opId 二次去重；helper 收到 EOF/termination signal/lease 过期 → 完整清理所有托管进程、工具链 tree。「不重发」「断线不中断」靠官方 helper 无路可走 |
| D2 | 插件自建远端 `workspace daemon`（Node 单文件 bundle）；远程须有 Node ≥ 20 | 不用 helper 的前提下，这是保活+可 reattach 的唯一路径；Node 形态最灵活（用户已确认） |
| D3 | 官方 provider 家族 `dsh-fs-ssh / dsh-subprocess-ssh / dsh-sandbox-ssh` 原样复用 | 源码验证其只注入形状`{request, connectStream, dispose}`，不 bound helper 实现。插件实现一个形状兼容的 `Connection`（后端 = daemon RPC），官方 SshFileSystem/SshSubprocessRuntime/SshSandboxProvider 原样工作 |
| D4 | harness 侧 `execution-worlds` 的 `mountRealmProviders` 是 `protected` 扩缝、bundle patch 叠层可换 row | 插件子类化 `WorkspaceRuntimeRegistry`，override `mountRealmProviders` 挂载 D3 家族（后台 = daemon）；`openRealm` 前置硬阻塞按 A4 的三级 bypass 处理（override `openRealm` → override `connectionConfig` → 假-config fallback），用 overlay 替换 `id: execution-worlds` row —— **零源码改动** |
| D5 | ssh **只作为数据传输管道**；helper 与 ssh 生命周期解耦：一切命令由 daemon 在远端本地 spawn；客户端在 ssh 断线后「重建传输 → 按 opId/token 重新 attach」，命令结果从不重发（daemon 按 opId 去重 + 终态缓存） | 用户核心需求原文 |
| D6 | Node 环境检查缺失即给手动安装指引 | 用户选了 node-script 档，非 SEA 打包 |
| D7 | **reap 只由显式事件驱动，禁止心跳/lease 式隐式清扫** | 官方 helper 断连即 lease 清扫 = 与「断线不中断」直接冲突；daemon 的遗留进程回收策略必须显式定义，否则长会话下进程记录无限累积 |
| D8 | **daemon = 官方 helper 服务端的完整重实现** | fs 版本原子语义（`FS_STALE_VERSION`）、helper-owned atomic write、流 id/窗口、management-class 配额全套对齐（对标 ssh 包 `helper-processes.ts` 456 行 + fs 语义）；A1 为全项目最大模块 |
| D9 | **流转发机制 A0 落锤：per-stream `ssh -L`**（2025-10-17 定案，`ssh -D` SOCKS5 放弃） | `process.prepare` 返回远端独立 unix socket + 64hex capability，客户端 `connectStream` 需 TLS-PSK（`PSK-AES256-GCM-SHA384`）。per-stream `-L` 与官方 `SshConnection.establishStream` 同形，复用 master 控制通道；实测 8+ 并发流与断线重连无串流/无 fd 泄漏。`ssh -D` 需自实现 SOCKS5 握手且对 unix socket 目标无额外收益 |

## 2. 全局红线（任何模块都适用）

1. **harness 仓库与运行时 = 不可见不可改**：插件代码里 `import` 只允许公开发布面（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-ssh` 家族 package、`dsh-workspace` 记录 schema、`dsh-host` 等）；**import 任何 `packages/*` 的深路径（`@deepseek-ai/dsh-*/src/*`）都视为跑偏**，除 bundle/组合文件自身的 patch 叠层。
2. **不中 helper**：任何设计/代码路径不得「require dsh helper 安装且 RSA client 只能通过 helper 通信」；daemon 是唯一远端依赖；helper 仅在插件探针中作为对照。
3. **不放宽安全面**：BatchMode、严格 host-key、无 agent forwarding、私有 socket 目录 `0700`/socket `0600`、每次 TLS 握手新 PSK.
4. **不盲发写命令**：ssh 断线后唯一合法的人工写路径 =「重连成功后按 opId 向 daemon 查询/submit」；python/其它语言缓存里不得有「任意重发送」的聚类动能 — 重放只能通过 opId 幂等门。
5. **复用优先**：daemon 侧 fs/进程/terminal 的上层接口能复用官方家族（`SshFileSystem` 等）就复用，不自己写一分。
6. **文档/生成物**：新写任何 harness 包都会破坏「meta-lessness 约束」 — 本计划无此要求；插件包自带 README + 升级指南 + profile patch 使用说明。

---

## 3. 模块拆解与执行顺序

> 本仓 layout（`~/repo/dsh-ssh-workspace`，pnpm workspace）：
> `packages/daemon/`（远端 daemon，单文件 bundle 产物 + 源码）
> `packages/transport/`（客户端传输：形状兼容 Connection + ssh forward + 重连状态机）
> `packages/providers/`（薄壳：复用官方 fs-ssh/subprocess-ssh/sandbox-ssh，注入形状兼容 ctx）
> `packages/realm/`（WorkspaceRuntimeRegistry 子类 + verifier 语义）
> `packages/api/`+`packages/ui/`（添加工作区 UX、机器枚举、远端目录浏览的 Web 面）
> `profile/`（cordis.patch 叠层 + bundle 文件，不 prime harness 源码）

依赖链 A(执行主干 daemon→transport/providers/realm) → B(web UX) → C(收口)。
**执行顺序：A0 探针 → A1 daemon → A2 传输 → A3 provider 适配 → A4 realm 注入 → B1 机器枚举 → B2 远端目录 → B3 ui 两步流 → C1 乱序持久 reconnect 致死案例 → C2 收口**。每模块未过「完成自检」不得开始下一个模块。

（名称缩写排查：`name`/`wait`/`release`/`argv` 全与官方 provider 家族 `SshFileSystem/SshSubprocessRuntime/SshSandboxProvider` 已 freezing 的接入面保持一致，插件侧不另起新词，是交换的平面 vocab.）

> **实施状态（2025-10-17）**：A0 核心项 + A1 + A2 已完成并通过真实 `ssh localhost` 端到端验证
> （`tests/daemon/probe-transport.mjs`，11/11）。A3/A4/B1/B2/B3/C1/C2 未开始，
> 详情、实测结论与下一步见 [`PROGRESS.md`](./PROGRESS.md)。

### 模块 A0 · probe 探针（最先做，全项目最大架构风险在这里落锤）

- **目的**：验证「完全不动 harness 仓库」下所有注入点可用；任一项失败→叫停报告，不写后续代码。
- **验证清单**（每条出一个可执行证据脚本/单测）：
  1. profile 组合：写 plugin 自带 `cordis.patch.yml`（copy `bundle/web-app` 骨架 + override `- id: execution-worlds` row → 指向插件子类），`dsh --profile <custom>` 启动成功，web 可见。**同时验证**：插件 profile 根 `package.json` 已把 `@deepseek-ai/dsh-host-execution-worlds`、`@deepseek-ai/dsh-fs-ssh / dsh-subprocess-ssh / dsh-sandbox-ssh` 及 SandboxBashExecutor 所在包声明为 profile 依赖并在用户层 resolve——官方包只有装进 profile 的 node_modules 才能被子类 import。
  2. `WorkspaceRuntimeRegistry` 子类 override `mountRealmProviders`：外部包 import 官方包可行，SSH realm 路径改为 daemon-realm 后会话可跑通一次 bash。**同时验证**：① `openRealm`/`connectionConfig` 旁路（见 A4：`connectionConfig` 在 helper 字段非空校验失败时直接抛错，`openRealm` 先于 `mountRealmProviders` 执行）；② realm 上下文继承 host 平面的 `sandboxPolicy` service（REALM_NAMES 不隔离 sandboxPolicy，需实测确认）。
  3. 会话→workspace 关联：`ctx.workspaceRegistry.create({transport:'ssh',host,path})` 创建成功，`workspaceRemoteVerifier` 替换为插件版（直接向 daemon 校验）→ `WorkspacePicker` 远端路径分支可用。**同时验证**：子类连 `execution-worlds` row 的 Config schema 形状兼容（可加字段不可改名），否则 `ui-settings-execution-worlds` 的 settings UI 读不到配置。
  4. daemon 生存性验证：`setsid`+双重 fork 产生 daemon；断开 ssh master/通道/转发后 daemon 存活；SIGKILL master 不杀 daemon。
  5. **流转发机制落锤（A2 最大未定项，D9）**：`process.prepare` 返回远端独立 unix socket path + 64hex capability；客户端 `connectStream` 对转发出的本地 socket 做 TLS-PSK（`PSK-AES256-GCM-SHA384`、TLSv1.2，对齐 `stream-security.ts`）。两条候选实测二选一：① per-stream 动态 `ssh -L`（实现最简，测延迟/抖动/fd 占用）；② 单条 `ssh -D` SOCKS5 动态转发（开销低，Node 侧需自实现 SOCKS5 握手）。**定案结论回写 A2 与 D9；不得在 A2 里再保两套。**
- **红线**：发现的任何 harness 不可注入点 → 列出→停；**不 smuggle**: 不 spawn 任何 dsh helper；`validators` = plugin 内部。
- **完成自检**：5 条证据脚本全绿（① 官方包经 profile 依赖可被子类 import；② `openRealm`/`connectionConfig` 旁路生效；③ realm 继承 host 平面 `sandboxPolicy` 且 settings Config 形状兼容；④ daemon 生存性；⑤ 流转发 TLS-PSK 就绪、断 master 重连后 capability 仍可用），每条带 daemon 终态可复现命令。

### 模块 A1 · workspace daemon（远端，Node 单文件 bundle）

- **包**：`packages/daemon`；bundle 后 `workspaced.js`（esbuild single file；本地 `pnpm build` 产出，随插件分发/或 scp 拷贝）
- **形态**：
  - Unix socket `~/.dsh-workspace/sock`（`0600`），pid+lock 文件防二号（daemon per host，多 workspace 共享），启动写入 boot token（`daemonInstanceId = uuid+pid+bootid`）。
  - **RPC 协议（与 D3 接入面同形，名称照搬；调用点逐 method 对齐 fs-ssh / subprocess-ssh / sandbox-ssh 的实际 call site）**：
    - fs：`fs.resolve/stat/lstat/list/readText/stream/next/streamClose/readBytes/readRange/write/edit`（`fs.streamClose` 属协议 management class、与 heartbeat 同级配额；`fs.readRange` 供大文件分片读）
    - process：`process.prepare/start/done/wait/terminate`
    - terminal：`terminal.environment/resize/write/inspect/activity/signal`（`activity`/`signal` 是 subprocess-ssh 在用的 call site，照搬）
    - 其他：`executable`；`sandbox`（官方 `SshSandboxProvider.confine` 实际调用 `sandbox` RPC，返回 `{argv, enforcement, denialSignatures, runnerFailureRules}`）；`heartbeat`/`close`（SshRpcPeer 常驻帧）
    - **payload schema 逐字段对齐 `@deepseek-ai/dsh-ssh/schemas` 导出的 zod（含 `target.targetKey` 语义与流 id 形状）**
    - **工作量口径（D8）**：daemon = 官方 helper 服务端的完整重实现——fs 版本原子语义（`FS_STALE_VERSION`）、helper-owned atomic write、流 id/窗口、management-class 配额全套对齐。**A1 是全项目最大模块，不是薄壳**，风险与工时预估都按此口径。
  - **多 workspace 的 sandbox 语义**：daemon per host 但每个 session 的 `sandboxPolicy.workspaceRoot` 不同（指向各自 workspace path）——`sandbox` RPC 必须按会话解析 workspaceRoot，不得用 daemon 全局单值；A1 自检补一条多 workspace 并发不同 root 的用例。
  - **durable 语义**：
    - 每条命令自带客户端 `opId`（128bit 随机）；map<opId,processRecord>；重复 opId → 已运行→返回当前态；已终态→返回缓存终态（含 exit code、signal、`truncated` 标记）；**绝不重新 spawn**。
    - ssh 传输断裂对 daemon = 客户端 socket 关闭；**记录但不清扫进程（D7）**。
    - **reap 策略（显式，D7）**：进程/记录只由三类显式事件回收，禁止任何心跳超时式清扫：① daemon 重启（世代换代，调用方收「进度丢失」）；② 客户端重连后显式 `process.terminate` / abandon 请求；③ outstanding 进程数超上限（对标 `SSH_MAX_PROCESS_HANDLES=128`，插件配置可放大）时回收——先淘汰已终态缓存记录，后按最老优先回收运行态进程（先 SIGTERM 再 SIGKILL）。
  - 环形缓冲：每流 ring buffer `1MiB`；断线期间 stdout/stderr 持续累计，溢出置 `truncated`。
  - `session.reattach`（携带 client.uuid token）：返回待恢复 streams 坐标 + 推补交换 keys。
  - fs 变更通知（watcher → plugin 转官方 `workspace-files/changes`）：scope 于 workspace path 之下。
- **红线**：daemon **不在 file-tree 之外写**；不做 plugin workspace path 白名单以外的任何进程/命令执行（拒绝）；sandbox 语义沿用 D3 的 provider 接口对。
- **完成自检**：单测 daemon — opId 二次提交不重复 spawn 而能取终态；断连后进程到终态再重连取结果；3 MiB 输出 → `truncated` 语义正确；`session.reattach` PTY 环形回放正确；EPERM socket 别人打不开；**多 workspace 并发不同 `workspaceRoot` 的 sandbox RPC 逐会话解析正确；断线遗留进程不受任何心跳影响存活，直到三类显式 reap 事件之一**。

### 模块 A2 · 客户端 transport（形状兼容 `Connection` + 重连状态机）

- **包**：`packages/transport`
- **形态**：
  - `RemoteWorkspaceConnection`：对外形状 = `{request(), connectStream(), dispose(), status 事件}`（与 D3 对齐）；对内 = 底层 `ssh -M -S ctl -fN`（复用与 dsh-ssh 同款 argv 模式，非 node_module import）生成 master + `-L localsock:~/.dsh-workspace/sock` 数据面转发。
  - **流转发：按 A0.5/D9 定案实现，仅保一套**（per-stream `ssh -L` 或 `ssh -D` SOCKS5 + Node 侧隧道握手）；每个 stream 本地 socket 接上后即做 TLS-PSK 握手（capability 为 PSK），失败即 destroy 不复用。
  - 状态机 `ready → disconnected → reconnecting(指数退避) → ready`；ssh master argv 含 `-o ExitOnForwardFailure=yes -o ServerAliveInterval`，转发起后探测本地 socket 真正就绪再置 `ready`；重连后首先 `session.reattach`（带 reconnectToken = daemonInstanceId + client uuid），token 失配 → 结构化错误（详见 A4）。
  - `request()`：
    - 写路径+opId 幂等 → 重发到 reconnect 后（A1 去重门把关）；
    - **中转缓存：current socket 正在写但未有终态的 fs/process opId 由 reconnect 后去查询实现取**，不重发
  - TLS PSK 每次握手重新协商；`connectStream(endpoint)` 校验 `endpoint.path` 前缀（安全同形）
  - connectionToken 有效性：Transport `remote` = daemon 高水位确认 `bootId + epoch` 失配 → `workspace/optionRetired` 产出「execute unknown / progress lost」结构化错误，**绝不堆积重试**
- **红线**：不 import `@deepseek-ai/dsh-ssh` src；仅参照其 argv/文本流安全模式；任何未意料的错误一律结构化上抛，不吞错。
- **完成自检**：重启 ssh master；断重态下 request 不挂死；`disconnected → ready` 完成；token 失配 → 清晰 error kind；**per-stream 转发在 ≥8 并发进程下无 fd 泄漏/无串流（capability 错配即拒绝）**。

### 模块 A3 · provider 家族复用薄壳

- **包**：`packages/providers`
- **内容**：mountRealmProviders 需要同时注入的 `fs/subprocess/sandbox/shell`
  - `SshFileSystem`(dsh-fs-ssh)、`SshSubprocessRuntime`(dsh-subprocess-ssh)、`SshSandboxProvider`(dsh-sandbox-ssh) 直接可复用（依赖 = 简单 `{request,connectStream,dispose}` shape；daemon side 提供 helper RPC 同形）；`sandbox` shell 执行器对接 dsh 的 `SandboxBashExecutor` —— 插件端确认+适配 `sandboxPolicy` 与 daemon 的 permission 语义
  - **适配面工作**：`SshSubprocessRuntime` 用到 `executable`、`terminal.environment/activity/signal` — daemon 补齐；`SshFileSystem` 用到 `fs.readRange`、`fs.streamClose`（management 配额）— daemon 补齐；`SshSandboxProvider` 的 sandbox 语义（环境变量注入等）daemon 补齐
- **红线**：不改官方包的一字节；不 fork 源码；只写注入壳。
- **完成自检**：三个家族 provider 在 daemon realm 上等价于官方 harness local 语义同名请求快照测试；**daemon RPC payload 与 `@deepseek-ai/dsh-ssh/schemas` 导出 zod 的逐字段 schema snapshot 对照**全绿（流 id、`targetKey`、prepare 各 stream 形状、management-class 请求配额行为一致）。

### 模块 A4 · realm 注入（execution-worlds 子类）

- **包**：`packages/realm`
- **内容**：
  - `RemoteWorkspaceRegistry extends WorkspaceRuntimeRegistry`：override `mountRealmProviders` → 注入 A2Conn + A3 家族（取代官方 dsh-ssh 家族）。**同时处理 `openRealm` 前置硬阻塞**：`openRealm`（private，prototype 方法，TS privacy 仅编译期）先于 `mountRealmProviders` 调用 `this.connectionConfig(host, path)`，后者在 helper/helperHash/launchKind/node 校验失败时抛错，realm 根本建不起来。按三级 bypass（A0.2 实证确定采用哪级）：
    - **①a 首选：override `connectionConfig`**（同为 prototype private，行数最小）——返回一个形状合法的 SshConfig（校验只查非空/_regex，永不真正拉起 helper），`openRealm` 本体不动、不复制 realm 组装逻辑。
    - **①b 次选：override `openRealm`** 完整复位（语义最干净，但要复制 realm ctx/isolate/dispose 约 20 行；若官方后续改动 `openRealm` 内部，此副本有漂移风险）。
    - **② fallback：插件 patch `config` 预置假值**（`helper:'/nonexistent'`、`node:'/nonexistent'` 等——永不真正拉起 helper）。仅当 ①a/①b 实测均不可行时采用。
  - 子类 Config 必须**形状兼容**官方 `WorkspaceRuntimeRegistry.Config`（原字段名不可改名/删除，只能 superset 追加），否则 `execution-worlds` row 替换后 `ui-settings-execution-worlds` settings UI 失效。
  - realm 需要的 `sandboxPolicy` service：确认从 host 平面继承（REALM_NAMES 不含它）；若继承不通，在 `mountRealmProviders` 显式装入官方 `dsh-sandbox-policy`。
  - `RemoteWorkspaceVerifier`：`transport:'ssh'` 的验证 = daemon 可达 + workspace path 属于 daemon 白名单 + Node 环境检查，产出 `invalid-remote {reason}`
  - 断线期间 `worldForWorkspace` 尽快返回现有 realm（reconnect 由 A2 状态机决定，report 层面不报失联）
- **红线**：不 override harness 任何方法以外的新公开面。
- **完成自检**：construct 子类 mount 后「一 session 完整跑 fs 写+bash+terminal」全绿；settings UI 在 row 替换后仍能读写 deployment config。

### 模块 B1 · 机器枚举（`~/.ssh/config`）

- **包**：`packages/api`（plugin own RPC namespace via profile composition）
- **契约**：`listHosts()` — 递归 `Include`、顶层具名 `Host` 别名（过滤 `*`/`!`）；**不做 Match 展开，候选列表仅来自具名 Host**；`precheck(alias)`: `ssh -G` 为**唯一权威**（自动解析 Include/Match 最终生效值）+ `BatchMode` 短超时探测 → `usable/needs-credentials/unreachable`；候选与 `ssh -G` 结论不一致时以 `ssh -G` 为准并在 UI 标注；本机永远第一位。
- **红线**：`ssh-config` 只读不建连、不写回任何 ssh 文件。
- **完成自检**：解析（Include/多 alias/通配/坏文件）单测；precheck 三态单测（注：`needs-credentials` 与 `unreachable` 的区分以 BatchMode 探测的 stderr 特征为准，此为 best-effort，UI 允许两者都给「补凭据/重试」引导）。

### 模块 B2 · 远端目录浏览

- **包**：`packages/api`
- **契约**：优先复用官方 `directory-picker`（bundle/web-app 已有 `id: directory-picker` row，支持 overlay pin 至 `-native`/`-browse`）挂到 daemon 通路；不可行再自写远端 listing RPC → 复用 A2 transport 到 daemon：`fs.list`（目录 only、名字序、`hidden` 标记 — 形状与官方 `directory-picker` 一致）；daemon 未安装时可识别错误态。
- **红线**：不写操作（若无官方 create 专属接口，ext 先不 ship）；连接复用与 A4 同一 client pool，不每目录一条 ssh。
- **完成自检**：listing 正常/空目录/无权限/daemon 未装四态。

### 模块 B3 · 添加工作区两步流 UI

- **包**：`packages/ui`（用 patch 叠层替换 `ui-workspace` 的添加行 —— 不改 harness；**若替换 harness UI 不可行**（验证在 A0.1/A0.3 内），则改成新增插件自带 UI 面板 + 保持官方 picker 手输 alias 通路为 fallback）
- **契约**：1️⃣ 选机器：本机+`listHosts()` 结果+precheck 徽标 → 2️⃣ 选目录：远端目录树（复用官方 browse 样式）+ `verifiedPath` → 提交到 `ctx.workspaceRegistry.create({transport:'ssh',host,path})`
  - daemon 未安装时 → 手动安装指引 + 重新检测按钮；不写回；per-machine 独立，precheck 失败可换机器，不卡死。
- **红线**：本仓 `ui-workspace` 原始 remote alias 手输通路**保留**；「新建子目录」如官方 browse 契约未明示则不 ship。
- **完成自检**：两步流创建/预检失败态/创建后重启 workspace 仍存（`transport: ssh`）。

### 模块 C1 · 断线与幂等的致死场景测试（执行后面收尾）

- **场景矩阵**：
  1. kill ssh master 中断长时命令 → daemon 完成 → 重连 → 完整 exit code + 缓冲 stdout + **不重复执行**（daemon fs.read + 端口 probe 双证）
  2. terminal 打开后 ssh 断 30s → 重连 → PTY 回放自断点续播，无重启动
  3. fs 大文件 write 中断 ssh → 重连 → 单写 (serialize) 无 damage/不重复
  4. daemon 重启（`daemonInstanceId` 换代） → 现有连接 structurally 拒绝 → session 明确「进度丢失」提示
  5. **reap 生效性**：断线遗留进程在无 heartbeat 下存活直到终态；仅三类显式 reap 事件（daemon 重启 / 显式 terminate / outstanding 超上限）触发回收；回收顺序 = 终态缓存淘汰 → 最老运行态 SIGTERM→SIGKILL
- **完成自检**：case 1/2/3/4/5 自动化，per case fixture 中断点；case 5 含 outstanding 上限触发的回收顺序断言。

### 模块 C2 · 收尾

- profile README（`dsh --profile` 一次性接入），升级指南，兼容矩阵（Node ≥20、OpenSSH ≥ 8.2 多路复用 Unix socket forwarding、`ssh -D`/`-L` 候选定案说明），SIGKILL 重建指南。
- 压力极限：5000-opId-outstanding `process.start` 挤压（触发 reap 上限路径）；断线 3m 后恢复取终态；同一 opId repeated re-submit。
- 需要时补 documentation snapshot。

---

## 4. 全局验收（完成定义）

1. Web「添加工作区」两步流：本机置顶 + `~/.ssh/config` 具名 host（通配隐藏）+ precheck 徽标，远端目录树选定 → `transport: ssh` 创建并重启不丢。
2. 会话内 fs/搜索/bash/terminal 全部作用于远端（host 侧 `ctx.fs` 零副作用）。
3. ssh 断线任何时长：daemon 原地继续执行且**无任何心跳式清扫**；重连后 agent **不重发命令**即拿到完整 exit code 与（环形缓冲内的）过程输出，terminal 自断点续播；**远端无第二个进程**。
4. daemon 重启/丢失 → 明确「进度丢失」错误，不挂死；绝不窥 helper。
5. 全局红线复核：harness 仓库 diff = 0；无 import `@deepseek-ai/dsh-*/src/*`；BatchMode/StrictHostKey/不 agent-forward/socket 权限不变；无盲重发；reap 仅由三类显式事件触发。
