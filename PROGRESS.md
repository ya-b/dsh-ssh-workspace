# PROGRESS — dsh-ssh-workspace 实施进度

> 更新于 `A0` 探针 + `A1` daemon + `A2` transport 完成并实测通过之后。
> 实测环境：`ssh localhost`（真实 sshd；daemon 部署在 `~/.dsh-workspace`）。

## 已完成并验证

| 模块 | 状态 | 证据 |
|---|---|---|
| A0 探针 | **通过（核心项）** | `tests/daemon/probe-transport.mjs` 11/11 checks |
| A1 daemon | **通过** | 同上：进程/fs/terminal/opId 去重/replay 全绿 |
| A2 transport | **通过** | 同上：ssh 通道杀死后重连续取终态，零重复执行 |
| A3 provider 薄壳 | **通过** | `tests/daemon/probe-providers.mjs` 13/13 checks |
| A4 realm 注入 | **通过** | `tests/daemon/probe-realm.mjs` 10/10；已装入 web profile |
| B1/B2/B3 | 未开始 | — |
| C1/C2 | 部分（case 1 已覆盖） | probe 的"master kill + 单次执行 + 终态重取" |

### A0 落锤结论

1. **流转发机制（D9）定案：per-stream `ssh -L`**。
   理由：与官方 `SshConnection.establishStream` 完全同形（`ssh -O forward -L <local>:<remote>`），
   复用 master 控制通道，实测在 8+ 并发流与断线重连下无串流、无 fd 泄漏；
   `ssh -D` SOCKS5 需自实现握手且对 unix socket 目标无额外收益，**放弃**。
   安全面与官方一致：`BatchMode=yes`、`StrictHostKeyChecking=yes`、`ForwardAgent=no`、
   `ClearAllForwardings=yes`、socket `0600`、目录 `0700`、每次握手新 PSK。
2. **daemon 生存性**：`setsid nohup node workspaced.js --dir $D </dev/null` 启动；
   `ssh -O exit` 杀死 master 后 daemon 与子进程继续运行（probe 断言 exit=0、marker 只写一次）。
3. **单文件 bundle**：esbuild `--format=esm` + banner `createRequire`；
   构建期把 `createRequire(import.meta.url)("../package.json")`
   （`@deepseek-ai/dsh-llm` 读自身版本）改写为字面量，使 bundle 可脱离源码树部署。
4. **原生依赖**：`node-pty` 是唯一无法内联的依赖（PTY 终端）。
   已实现归档安装：`tar -czf` 打包 `workspaced.js` + `package.json` + 裁剪后的
   `node_modules/node-pty`（只含目标 `prebuilds/<platform>-<arch>`），
   `ssh ... 'tar -xzf - -C $D'` 安装。无 node-pty 时 daemon 其余功能不受影响。
5. **TLS-PSK 就绪**：`PSK-AES256-GCM-SHA384` / TLSv1.2，服务端按 socket 目录白名单 +
   每流 64hex capability；客户端在 preamble 中声明上次已确认字节偏移。

### 协议要点（实现契约，A3/A4 必须遵守）

- daemon 控制面 = `hello / session.reattach / heartbeat / close / fs.* / process.* / terminal.* / executable / sandbox`。
  名称与 `@deepseek-ai/dsh-ssh` 家族 call site 逐一对齐。
- `process.prepare` 响应为 `{id, streams, phase}`，`phase` ∈ `prepared | completed`；
  `completed` 时 `streams` 为空且缓存终态由 `process.done` 返回。
  官方 `preparedSchema` 只取 `{id, streams}`，**不会**因多余字段报错（`.strict()` 只作用于解析对象自身字段，`prepared` 未在 provider 侧解析 —— 仅 `terminal` 流走 `streamEndpointSchema.parse`，故流端点形状保持 `{path,capability}`）。
- daemon→client 流信道（`stdout`/`stderr`/`terminal`）在 TLS 握手后先收一帧
  `{sync: <已确认偏移>}`，再回放 ring buffer（1 MiB/流）并转入 live。
  客户端按 socket 文件名（basename）判断是否需要该 preamble。
- opId 幂等门：`fs.write` / `fs.edit` / `process.prepare` / `process.start` / `terminal.write`。
  **transport 会在缺省时自动注入 opId**，因此官方 provider 不改一行即获得幂等重放。
- 显式 reap（D7）：① daemon 关闭；② 显式 `process.terminate`（`abandon=true` 连带丢弃缓存）；
  ③ `process.prepare` 前的上限回收（先淘汰终态缓存，再按最老运行态 SIGTERM）。
  断线**不**触发任何回收；已终态记录在 `completed` 缓存中可无限次查询。

## 未完成 / 下一步

### A4 realm（`packages/realm`）——已完成并已装入 `~/.dsh/profiles/web`
- `RemoteWorkspaceRegistry extends WorkspaceRuntimeRegistry`，只覆盖 `mountRealmProviders`：
  官方 `fs/subprocess/sandbox/shell` 家族 + `DaemonSshConnection` 挂进 realm 隔离链；
  路由、realm 缓存、`workspaceRemoteVerifier` 全部沿用上游实现。
- **实测约束（重要）**：realm 是从插件 fiber 里 `ctx.plugin(carrier) + isolate(5 个名字)` 建的，
  而 cordis 的服务解析走“提供者 fiber 的 store 链”。宿主平面的 `sandboxPolicy` 因此**无法**被
  realm 内的 fiber 直接读到（`SandboxBashExecutor` 构造时读 `ctx.sandboxPolicy` 会抛
  `cannot get property ... without inject`）。`isolate+provide` / `provide` / `accessor` 都不行
  （前者撞 root store 的 symbol 键，后者报 already declared as service）。
  **可行解**：`realmCtx.extend({ sandboxPolicy, sessionProjections })` —— `extend` 的 meta 是
  自有属性，代理 `get` 先命中 `Reflect.has`，于是 realm 内解析与宿主一致；注册与释放仍发生在
  realm 的 fiber 上。见 `bridgeHostServices`。
- `packages/realm/dist/daemon.tar.gz`（bundle + 裁剪后的 node-pty，451 KiB）由
  `pnpm run archive` 生成；realm 在宿主首次使用时按 (host, daemonDir, 归档摘要) 幂等安装。
- 冒烟：`tests/daemon/probe-realm.mjs` 10/10（含 remote verifier 的 canonicalPath / status）。
- `daemonDir` 支持 `~/...`：由远端 shell 展开（`daemonDirExpr`，只放行 `[A-Za-z0-9._/-]`）。

### 已装入本机 web profile（可回滚）
- `dsh plugin --profile web add link:.../packages/realm`；`cordis.patch.yml` 里
  `disabled: true` 官方 `execution-worlds` 行 + `insert` 本插件同名行。
- `dsh --profile web --dump-config` 确认：`execution-worlds` 只剩本插件那一行。
- web 服务已用新 profile 重启（PID 2394 已终止，改为 `setsid nohup dsh web --no-open --port 3080`），
  启动日志无告警/错误。原始 patch/package.json 备份在 profile 目录（`*.bak*`）。

### 为何浏览器里还看不到“添加远程工作区”
`ui-workspace` 的该菜单项受 `verifyRemote !== undefined` 门控，`verifyRemote` 来自
`@deepseek-ai/dsh-api-remotes/client` 的 host 侧 remote。**该 host/client remote 还没实现**
（= 待办 B1/B2/B3），所以当前 UI 只提供本地目录选择；这是预期状态，不是故障。

### A3 providers（`packages/providers`）——已完成
- `DaemonSshConnection extends Service`（注册为 `ctx.ssh`），surface = `{ready, request, connectStream, dispose}`；
  官方 `SshFileSystem` / `SshSubprocessRuntime` / `SshSandboxProvider` / `SandboxBashExecutor` 原样挂载。
- **实测约束（重要）**：provider 会用官方 `preparedSchema`（`.strict()`）解析 `process.prepare` 响应，
  因此响应**必须**恰好为 `{id, streams}`；任何附加字段都会解析失败。
  已终态 reservation 以 `{id, streams:{}}` 应答，`process.start` / `process.done` 从缓存返回——
  provider 的空流循环自然退化为"无流可连"。
- **实测约束（重要）**：transport 的 `request` 重试必须只在真实断线（`RpcTransportError`）时发生；
  早期把 zod 解析错误也当作断线重试，造成 20s 静默 SSH 重连循环、真实错误被吞。
  现已改为按类型判定（`isTransportLoss`）。
- 已知待补：`fs.stream` 的迭代器不可跨连接续传（断线时结构化失败，非静默重试）。

### A4 realm（`packages/realm`）
- `RemoteWorkspaceRegistry extends WorkspaceRuntimeRegistry`：
  - override `mountRealmProviders`（protected，可行）
  - override `connectionConfig`（private，编译期可见但需 `as any` 或子类方法名遮蔽）返回形状合法 SshConfig；
    实测该路径只需非空字符串+正则通过，永不真正拉起 helper。
  - realm 继承 host 平面 `sandboxPolicy`（`REALM_NAMES` 不含它）—— 待实测确认。
- `RemoteWorkspaceVerifier`：daemon 可达 + workspace 在 daemon 白名单 + Node 版本检查。
- profile 叠层：`profile/cordis.patch.yml` override `- id: execution-worlds` row 指向插件子类，
  并在 profile `package.json` 声明
  `@deepseek-ai/dsh-host-execution-worlds`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh`、
  `dsh-bash-sandbox` 依赖（用户层 resolve）。

### 浏览器端到端验证（已完成，2026-10-17）
本地 harness 构建（`pnpm build:lib` + `pnpm build:web`，均 EXIT=0）后，用本地 CLI 启动实例
（`node apps/cli/lib/bin.js web --no-open --port 3081`，`DSH_HOME=~/.dsh`），在浏览器中实测：

1. 侧边栏「添加工作区」菜单出现 **「添加远程工作区…」**（门控 `verifyRemote !== undefined` 通过，
   说明本插件的 `workspaceRemoteVerifier` 已挂载）。
2. 选择 SSH → 填 `localhost` + `/home/user/dsh-ws-probe` → 点「验证」→ 界面显示
   **「已验证：/home/user/dsh-ws-probe」**（链路：客户端 → `workspace.verifyRemote` →
   host `ctx.get('workspaceRemoteVerifier')` → 本插件 realm → daemon 校验）。
3. 点「添加远程工作区」→ 工作区落库为
   `{"path":"/home/user/dsh-ws-probe","transport":{"kind":"ssh","host":"localhost"}}`
   （`~/.dsh/storages/workspace.json`，UUID 77fdd1fb）。
4. 将该工作区选为新会话的执行世界，让 agent 调用 bash 工具打印自身进程树，返回：
   `第二行是它的父进程 cmdline：/usr/bin/node /home/user/.dsh-workspace/workspaced.js --dir /home/user/.dsh-workspace`
   —— 会话内的命令确实由**远端 workspace daemon** 派生执行，而非宿主本地进程。

即 D1「Web UI 选机器→选目录→该工作区的 fs/terminal/命令全部在远端执行」的主链路已打通。

### B 段（host API + 连接健壮性）——已完成并实测
新增 `packages/api`（`@dsh-ssh-workspace/api`），在 `ctx.webServer` 上挂三条只读路由，
每条都复用 `ctx.connection.admit(req)` 做与 RPC 同级的准入：

| 路由 | 作用 |
| --- | --- |
| `GET /ssh-workspace/machines` | 本机（hostname）+ `~/.ssh/config` 全部具名主机（支持 `Include` 递归，过滤 `*`/`?`/`!`），附 `ssh -G` 得到的 user/hostname/port |
| `GET /ssh-workspace/precheck?host=` | `BatchMode` 非交互登录探测 → `usable` / `needs-credentials` / `unreachable` / `unknown` |
| `GET /ssh-workspace/browse?host=&path=` | 目录浏览；远端走 `workspaceRuntime.worldForWorkspace`，即**与会话完全相同的 realm**（daemon 执行 fs.list），本地走宿主 fs |

实测（curl + cookie）：machines 返回本机与 6 台 SSH 主机；未带 cookie 返回 **401**；
precheck(localhost)=usable；browse 本地/远端均 200。

### 本轮修掉的两个真实缺陷（都已验证）
1. **realm 打开会被"白名单拒绝"永久重试**：daemon 的 `roots` 白名单是启动期配置，
   先前 `/home/user` 不在其中，`hello` 返回 `WORKSPACE_NOT_ALLOWED`；而 transport 的
   `connectLoop` 当时对**任何**错误都无限重试，且每次都泄漏一组 ssh master+bridge
   （一度累积 240 个进程），HTTP 请求因此永不返回。
   - daemon：新增 `workspace.allow {path}`（hello 之前可用），把目录加入白名单并**持久化**
     到 `config.json`（保留最近 64 条）。socket 为 0600、属主即该用户，而该用户本就能通过
     daemon 执行任意命令，所以这是防误操作的护栏，不是安全边界。
   - transport：`connectLoop` 只在**真实链路丢失**时重试；从未建立过的会话有上限
     （6 次）后把真实原因抛给调用方；握手失败即 `SIGKILL` 掉该 ssh，不再泄漏。
   - `bootstrapCommand`：socket 存在但 pid 已死时先清理残留（崩溃后可自愈）。
2. 修复后：远端 browse 从"永久挂起"变为 **HTTP 200 / 1.5s**。

回归：`probe-transport` 11/11、`probe-providers` 13/13、`probe-realm` 10/10 全绿。

### 客户端半（`packages/ui`）——机制已验证
`@dsh-ssh-workspace/ui` 通过 `exports["./client"]` + `dsh.client` 声明被宿主自动纳入
客户端 boot graph；已用一个最小 bundle 实测：宿主启动无告警，浏览器侧 `apply` 执行、
DOM 探针出现，卸载时正确回收。即浏览器半的加载通路可用（构建产物需满足
`window.__ModuleLoader__.load({id,factory})` 的 CJS 工厂约定）。

### B1 机器枚举（`packages/api`）
- `listHosts()`：递归 `Include`、具名 `Host`、过滤 `*`/`!`、不做 `Match` 展开。
- `precheck(alias)`：`ssh -G` 为唯一权威 + `BatchMode` 短超时探测 → `usable/needs-credentials/unreachable`。
- 本机永远第一位。

### B2 远端目录浏览
- 复用官方 `directory-picker` row（bundle/web-app 已存在，支持 overlay pin）；
  不可行时自写 daemon `fs.list` 通路（daemon 已具备 `fs.list`）。

### B3 添加工作区两步流 UI
- `packages/ui`（client face）：选机器 → 远端目录树 → `ctx.workspaceRegistry.create({transport:'ssh',host,path})`。
- daemon 未装时给手动安装指引 + 重新检测；保留官方手输 alias 通路。

### C1 场景补齐
- 已有：case 1（kill master → 重连取终态 → 单次执行）。
- 待补：case 2（terminal 断 30s 续播，daemon 侧已具备 replay，需端到端断言）、
  case 3（大文件写中断）、case 4（daemon 换代 → `WORKSPACE_PROGRESS_LOST`）、case 5（reap 顺序）。

### C2 收尾
- `profile/README.md`（接入步骤）、升级指南、兼容矩阵（Node ≥ 20 / OpenSSH ≥ 8.2）、
  SIGKILL 重建指南、压力测试（5000 opId、断线 3m、同 opId 重复提交）。

## 运行方式

```bash
# daemon 单测/端到端探针（真实 ssh localhost）
cd packages/daemon && pnpm run build
node ../../tests/daemon/probe-transport.mjs

# 手工 daemon 探针（无 ssh）
node ../../tests/daemon/probe-manual.mjs /tmp/dsh-ws-test/dsh-workspace
```

## 已知限制

- `packages/api` / `packages/ui` / `packages/providers` / `packages/realm` 目前是空占位包。
- daemon 的多 workspace sandbox 语义已按会话解析 `workspaceRoot`（`canonicalPolicy` 使用调用方传入的 policy），
  但白名单目前是 daemon 级 `config.json` 的 `roots`；B1/B3 接入后需按工作区动态下发/校验。
- node-pty 归档约 6 MiB（含裁剪后 linux-x64 预编译二进制）；其它平台需在本地准备对应 node-pty。
