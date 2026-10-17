# 安装到一个 dsh profile

插件把 profile 里的 `execution-worlds` 行替换成 daemon 版实现。cordis 的 patch 条目
**不能改行的 `name`**（那是校验而非覆写），因此做法是 `disabled` 原行 + 用同一个 id `insert` 本插件。

## 1. 构建产物

```bash
# daemon bundle（远端要跑的字节）
cd packages/daemon && pnpm run build        # → lib/workspaced.js

# 远端归档（bundle + 裁剪后的 node-pty，约 450 KiB）
cd ../realm && pnpm run archive             # → dist/daemon.tar.gz

# 浏览器半的 bundle（CJS 工厂，供 __ModuleLoader__ 装载）
cd ../ui && node build.mjs                  # → lib/client.js
```

改动 `packages/daemon` 或 `packages/ui/src/client` 后必须重新构建对应产物并**重启实例**
（归档摘要变化会在下次首次使用时重新投递，但已运行的 daemon 需要重启才会换代码）。

## 2. 装入 profile

```bash
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/realm'
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/api'
dsh plugin --profile web add 'link:/path/to/dsh-ssh-workspace/packages/ui'
```

## 3. 覆写 profile 层

追加到 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- id: execution-worlds
  disabled: true
- insert:
    - id: execution-worlds
      name: '@dsh-ssh-workspace/realm'
      config:
        daemonDir: '~/.dsh-workspace'   # 远端状态目录；~ 由远端 shell 展开
        node: /usr/bin/node             # 远端 node 绝对路径（>= 20）
        install: true                   # 首次使用时投递 daemon 归档
    - id: api-ssh-workspace
      name: '@dsh-ssh-workspace/api'
    - id: ui-ssh-workspace
      name: '@dsh-ssh-workspace/ui'
```

校验组合结果并重启：

```bash
dsh --profile web --dump-config | grep -A6 execution-worlds
```

## 4. 设置项

被替换的行仍共享 `execution-worlds` 设置命名空间，Plugins 页可继续编辑：
`daemonDir`、`node`、`install`、`reconnectBaseMs`、`reconnectMaxMs`、`controlDir`、
`requestTimeoutMs`、`maxFrameBytes`、`maxPending`。页面上仍显示的 helper 类字段
（`helper`、`helperHash`、`launchKind`、`bootstrapPath`、`bootstrapHash`、`leaseMs`）
会被接受并忽略。

## 5. 回滚

删掉上面三个 patch 条目（`execution-worlds` 回到官方 helper 实现），再
`dsh plugin --profile web remove @dsh-ssh-workspace/{realm,api,ui}`。

## 备注：白名单

daemon 的 `config.json` 里 `roots` 是允许作为工作区打开的目录。客户端在打开某个目录前会先
发 `workspace.allow`，daemon 落盘保存（保留最近 64 条）。socket 权限 `0600`、属主即该用户，
而该用户本就能通过 daemon 执行任意命令，因此这是防误操作的护栏而非安全边界。
