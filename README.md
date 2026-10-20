# dsh-ssh-workspace

[English](./README.en.md) | 简体中文

DeepSeek Harness 的远程工作区插件：在 Web UI 里先选机器（本机或 `~/.ssh/config` 中的主机），
再选目录，创建出来的工作区其**文件读写、终端和命令执行全部发生在远端**。

SSH 只是数据管道。远端常驻 `workspace daemon`，客户端断线不会中断远端命令；重连后按偏移
续取输出与终态，写操作经 opId 幂等门，不会重放副作用。

## 环境要求

| 位置 | 要求 |
| --- | --- |
| 宿主 | Node ≥ 20；`dsh` 0.2.1-rc.2；可用的 OpenSSH 客户端；可读的 `~/.ssh/config` |
| 远端 | Linux x64；Node ≥ 20；POSIX `sh`；`tar`；OpenSSH 服务端 |
| 认证 | 密钥或 ssh-agent 等**非交互登录**；不支持交互式密码 |
| SSH | OpenSSH ≥ 8.2（客户端需支持 `ControlMaster` / `-O forward`） |
| 终端 | 归档内含 linux-x64 的 node-pty；其他平台缺少 node-pty 时仅终端不可用，文件与命令正常 |

## 安装

### 从 Git 安装（推荐）

```bash
dsh plugin --profile web add https://github.com/ya-b/dsh-ssh-workspace
```

这条命令会：

1. 把 `@dsh-ssh-workspace/bundle` 安装进 `web` profile；
2. 把该 bundle 追加到 profile 的 `dsh.profile.bundles`；
3. 按包内 `cordis.patch.yml` 装入 `ssh-workspace-mount`、`api-ssh-workspace`、
   `ui-ssh-workspace` 三行。

仓库已提交构建产物 `lib/` 与 `dist/daemon.tar.gz`，所以 Git 安装**不需要**额外构建。

安装后重启实例生效。


### 本地开发安装

```bash
pnpm install
pnpm run build
dsh plugin --profile web add 'link:/abs/path/to/dsh-ssh-workspace'
```

`link:` 安装直接使用 checkout 中的 `lib/` 和 `dist/`。修改源码后重新执行
`pnpm run build`，再重启实例；只改源码不重建不会生效。

## 配置

### SSH 主机

机器列表来自本机 + `~/.ssh/config` 中所有具体的 `Host` 别名（递归跟随 `Include`；
通配符和取反规则会被跳过，因为它们不是具体机器）。普通 OpenSSH 配置全部有效：
`HostName`、`Port`、`User`、`IdentityFile`、`ProxyJump`、`ProxyCommand` 等。

```sshconfig
# ~/.ssh/config
Host devbox
  HostName 192.0.2.10
  User root
  Port 22
  IdentityFile ~/.ssh/id_ed25519

Include ~/.ssh/config.d/*
```

要求 `ssh devbox true` 能在不询问密码的情况下成功（密钥、agent 或 ControlMaster）。
修改 `~/.ssh/config` 后刷新浏览器页面，主机列表会重新枚举。

不想在弹窗中显示某些别名时，用 `api-ssh-workspace` 的 `hiddenHosts` 隐藏：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: api-ssh-workspace
  config:
    hiddenHosts:
      - automation
      - ci-runner
```

### 插件参数

`ssh-workspace-mount` 的可配置项：

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `daemonDir` | `~/.dsh-workspace` | **远端** daemon 状态目录；`~` 由远端 shell 展开 |
| `node` | `node` | **远端** Node 可执行文件；非交互 SSH 的 PATH 常找不到 nvm 的 Node，建议写绝对路径，如 `/usr/local/bin/node` |
| `install` | `true` | 首次使用某主机时投递内置 daemon 归档；按 (host, daemonDir, 归档摘要) 去重 |
| `autoUpgrade` | `true` | 连接时若运行中的 daemon 加载的 bundle 与已安装的 `workspaced.js` 摘要不一致，且无子进程在跑，就自动重启它；忙则保留旧版，下次连接再试 |
| `daemonArchive` | 内置归档 | 覆盖 daemon 归档路径，主要用于开发调试 |
| `requestTimeoutMs` | `30000` | 安装、准入、打开等管理请求的超时 |
| `requestTimeoutRetries` | `5` | 管理超时后对可重放操作（读或带 opId 的写）的额外重试次数；调用方取消不重试 |
| `requestTimeoutRetryBaseMs` | `10000` | 超时重试的首次等待，逐次翻倍（10s → 20s → 40s …），上限 `2147483647` |
| `reconnectBaseMs` | `250` | SSH 链路重连的退避初始值 |
| `reconnectMaxMs` | `15000` | 重连退避上限 |
| `controlDir` | 临时目录 | 本地 SSH ControlMaster socket 目录；不填则使用 `/tmp/dsh-ws-*` |
| `statePath` | `${DSH_HOME:-~/.dsh}/storages/ssh-workspaces.json` | 本地工作区归属侧映射路径 |

`api-ssh-workspace` 的可配置项：

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `probeTimeoutMs` | `8000` | 主机连通性预检的单次超时 |
| `hiddenHosts` | `[]` | 不显示在机器列表中的 SSH 别名 |
| `prefix` | `/ssh-workspace` | HTTP 路由前缀；浏览器半固定使用 `/ssh-workspace`，**不要修改** |

`ui-ssh-workspace` 没有配置项。

覆盖参数时，在 profile 自己的 `cordis.patch.yml` 中按相同 `id` 重述整行配置：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: ssh-workspace-mount
  config:
    daemonDir: '~/.dsh-workspace'
    node: /usr/local/bin/node
    install: true
    requestTimeoutMs: 30000
    requestTimeoutRetries: 5
    requestTimeoutRetryBaseMs: 10000
    reconnectBaseMs: 250
    reconnectMaxMs: 15000
```

同一 `id` 的 `config` 会整体替换 bundle 中的配置，未写的字段使用 schema 默认值，
建议把需要的项写全。若 profile 的 patch 文件还是空数组 `[]`，用条目替换它，而不是
直接追加到 `[]` 后面。

### 远端 daemon

首次在某个 (主机, `daemonDir`) 上打开目录时，插件会通过 SSH 把归档解压到远端
`daemonDir`，并执行远端 Node 版本检查。之后：

- daemon 状态在远端 `~/.dsh-workspace`：`sock`、`pid`、`lock`、`running.digest`、
  `config.json`、`streams/`、`daemon.log`；
- `config.json` 的 `roots` 是允许作为工作区打开的目录白名单，由客户端在打开前写入，
  保留最近 64 条；
- daemon 已运行时不重复启动；客户端断线、心跳或租约变化都不会回收远端进程；
- daemon 启动时把自己的 bundle 摘要写进 `running.digest`；连接时若与已安装的
  `workspaced.js` 不一致，且它没有子进程在跑，bootstrap 会优雅重启它以运行新代码
  （`autoUpgrade: false` 可关闭）；旧版本 daemon 没有该文件，首次连接时同样会被升级；
- 远端 Node 缺失或过旧会在建连阶段报
  `remote workspace daemon preflight failed: <node> is not a usable Node >= 20`。

## 使用

1. 打开 Web UI，侧边栏「添加工作区（＋）」→「添加工作区…」。
2. 在弹窗顶部的**主机**下拉中选择本机或某个 SSH 主机。
3. 选择目录（可「上级」回溯、开关隐藏文件），点「打开」。
4. 远端工作区默认命名为 `<目录名>@<主机别名>`；会话中的 `pwd`、文件读写、终端和命令
   均在远端执行。

## 升级与卸载

升级 bundle：

```bash
dsh plugin --profile web update @dsh-ssh-workspace/bundle
# 或重新安装并锁定提交
dsh plugin --profile web add 'https://github.com/ya-b/dsh-ssh-workspace#<sha>'
```

重启 dsh 实例后新代码生效。远端已运行的 daemon 不会自动换代码；必要时杀掉远端 daemon
进程，让下一次使用重新投递并启动：

```bash
ssh <host> 'kill "$(cat ~/.dsh-workspace/pid)" 2>/dev/null || true'
```

卸载：

```bash
dsh plugin --profile web remove @dsh-ssh-workspace/bundle
```

卸载只移除依赖、bundle 选择和它带来的三行 patch，不会删除本地侧映射或远端
`~/.dsh-workspace`。需要彻底清理时，先停掉远端 daemon，再删除数据：

```bash
rm -f "${DSH_HOME:-$HOME/.dsh}/storages/ssh-workspaces.json"
ssh <host> 'kill "$(cat ~/.dsh-workspace/pid)" 2>/dev/null || true; rm -rf ~/.dsh-workspace'
```

## 故障排除

| 现象 | 处理 |
| --- | --- |
| 弹窗里没有远端主机 | 确认是具体 `Host` 别名而非通配符；刷新页面；检查 `~/.ssh/config` 与 `Include` |
| 预检显示 `needs-credentials` | `ssh <alias> true` 必须无需交互即可成功；配置密钥或启动 agent |
| 报 Node 版本/路径错误 | 把 `node` 配成远端绝对路径，例如 `/usr/local/bin/node`；确认 `node -v` ≥ 20 |
| 终端打不开，但文件和命令正常 | 归档只带 Linux x64/arm64 的 node-pty；远端是其他平台/架构时不匹配，文件与命令不受影响 |
| 安装后没有出现菜单 | `dsh --profile web --dump-config` 检查三行 patch；重启 dsh 实例 |
| 升级后行为仍旧 | 重启 dsh 实例；远端 daemon 也要重启才会加载新归档 |

## 开发

```bash
pnpm install
pnpm run build        # → lib/{mount,api,index,client}.js + dist/daemon.tar.gz

node tests/api/machines.test.mjs
node tests/daemon/probe-transport.mjs
node tests/daemon/probe-providers.mjs
node tests/daemon/probe-mount.mjs
node tests/daemon/probe-resilience.mjs
```

`lib/` 与 `dist/daemon.tar.gz` 是 Git 安装使用的已提交产物：改源码后必须重建并提交。
更细的构建、回滚与运维说明见 [`INSTALL.md`](./INSTALL.md)，实现计划和证据台账见
[`PLAN.md`](./PLAN.md) 与 [`PROGRESS.md`](./PROGRESS.md)。
