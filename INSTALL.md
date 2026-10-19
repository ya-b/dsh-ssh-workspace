# 安装到一个 dsh profile

插件走「根平面路由」：不动 profile 里的任何官方行，只 `insert` 三行自有插件
（`ssh-workspace-mount` + api + ui）。cordis 的 patch 条目不能改行的 `name`，
`insert` 只允许新增，这正好满足本方案——官方 `execution-worlds` 与 helper 全保持原样。

## 1. 构建产物

```bash
# daemon bundle（远端要跑的字节）
cd packages/daemon && pnpm run build        # → lib/workspaced.js

# 远端归档（bundle + 裁剪后的 node-pty，约 0.4 MiB）
cd ../mount && pnpm run archive             # → dist/daemon.tar.gz

# 浏览器半的 bundle（CJS 工厂，供 __ModuleLoader__ 装载）
cd ../ui && node build.mjs                  # → lib/client.js
```

改动 `packages/daemon` 或 `packages/ui/src/client` 后必须重新构建对应产物并**重启实例**
（归档摘要变化会在下次首次使用时重新投递，但已运行的 daemon 需要重启才会换代码）。

## 2. 装入 profile

```bash
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/mount'
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/api'
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/ui'
```

## 3. 追加 profile 层

追加到 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: ssh-workspace-mount
      name: '@dsh-ssh-workspace/mount'
      config:
        daemonDir: '~/.dsh-workspace'   # 远端状态目录；~ 由远端 shell 展开
        node: node                      # 远端 node（>= 20；绝对路径更稳）
        install: true                   # 首次使用时投递 daemon 归档
    - id: api-ssh-workspace
      name: '@dsh-ssh-workspace/api'
    - id: ui-ssh-workspace
      name: '@dsh-ssh-workspace/ui'
```

校验组合结果并重启：

```bash
dsh --profile web --dump-config | grep -A8 ssh-workspace-mount
```

## 4. 设置项

`ssh-workspace-mount` 行的 config：`daemonDir`、`node`、`install`、`requestTimeoutMs`、
`reconnectBaseMs`、`reconnectMaxMs`、`controlDir`、`daemonArchive`、`maxFrameBytes`、
`maxPending`、`statePath`（侧映射 JSON，默认 `${DSH_HOME:-~/.dsh}/storages/ssh-workspaces.json`）。

## 5. 回滚

删掉上面三个 patch 条目，再
`dsh plugin --profile web remove @dsh-ssh-workspace/{mount,api,ui}`。

## 升级

插件的三类产物各自独立演进，升级时按需重建：

```bash
cd packages/daemon && pnpm run build && cd ../mount && pnpm run archive   # 远端代码变了
cd ../ui && node build.mjs                                                # 浏览器半变了
node tests/daemon/probe-mount.mjs                                         # 回归
```

远端 daemon 的替换时机：新归档的**摘要**变化后，下一次首次使用该 (host, daemonDir) 时会
重新投递；但**正在运行的 daemon 进程不会自动换代码**——需要重启它（
`kill "$(cat ~/.dsh-workspace/pid)"` 后删掉 `sock`/`pid`/`lock`，或直接让它在下一次
bootstrap 时自愈），随后客户端按 `clientUuid` 重入会话。

远端 Node 版本不足或路径错误时，bootstrap 会在建连阶段直接报
`remote workspace daemon preflight failed: <node> is not a usable Node >= 20`。

## 备注：白名单

daemon 的 `config.json` 里 `roots` 是允许作为工作区打开的目录。客户端在打开某个目录前会先
发 `workspace.allow`，daemon 落盘保存（保留最近 64 条）。daemon 不设权限/认证边界
（socket、状态目录无强制权限），白名单只是防误操作的护栏。
