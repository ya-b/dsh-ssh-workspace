# 安装到一个 dsh profile

仓库根本身就是可安装的组合包 `@dsh-ssh-workspace/bundle`：它声明
`dsh.bundle.patch`，并携带预构建的 host 入口、浏览器 bundle 和 daemon 归档。
插件走「根平面路由」：不动 profile 里的任何官方行，只 `insert` 三行自有插件
（`ssh-workspace-mount` + api + ui）。cordis 的 patch 条目不能改行的 `name`，
`insert` 只允许新增，这正好满足本方案——官方 `execution-worlds` 与 helper 全保持原样。

## 1. 从 Git 安装（推荐）

```bash
dsh plugin --profile web add https://github.com/ya-b/dsh-ssh-workspace
```

安装会把 `@dsh-ssh-workspace/bundle` 追加进 profile 的 `dsh.profile.bundles`，
随后按包内 `cordis.patch.yml` 装入三行。CLI 安装后需重启实例才会加载新插件：

```bash
dsh --profile web --dump-config | grep -A8 ssh-workspace-mount
```

仓库已提交 `lib/` 与 `dist/daemon.tar.gz`，因此 git 安装**不需要** `prepare`
构建脚本，也不需要在 profile 的 `pnpm-workspace.yaml` 里批准 `allowBuilds`。
首次连远端主机时，归档会按摘要投递到远端 `~/.dsh-workspace`。

Web 侧也可以在「插件」页安装同一个 URL，安装完成会立即生效（无需重启）。

## 2. 本地开发安装

```bash
pnpm install
pnpm run build          # → lib/{mount,api,index,client}.js + dist/daemon.tar.gz

dsh plugin --profile web add 'link:/abs/path/to/dsh-ssh-workspace'
```

`link:` 安装直接使用该 checkout 的 `lib/`、`dist/`；修改源码后重新执行
`pnpm run build` 并重启实例。`packages/daemon` 或浏览器半改动时尤其注意：
构建产物不重新生成，运行中的代码不会变。

## 3. 构建产物

```bash
pnpm run build
```

等价于：

1. esbuild 把 `packages/mount`（含 transport/providers/install/rpc）和
   `packages/api` 打成自包含 ESM：`lib/mount.js`、`lib/api.js`；
2. 构建 `packages/daemon/lib/workspaced.js`，再生成
   `packages/mount/dist/daemon.tar.gz` 并复制到根 `dist/`;
3. 用同一份 UI 源码生成浏览器 bundle `lib/client.js`（模块 id 为
   `@dsh-ssh-workspace/bundle`）。

`packages/ui` 单独构建时仍可用 `node build.mjs`，产物写到 `packages/ui/lib/client.js`。

## 4. 设置项

`ssh-workspace-mount` 行的 config：`daemonDir`、`node`、`install`、`requestTimeoutMs`、
`reconnectBaseMs`、`reconnectMaxMs`、`controlDir`、`daemonArchive`、`maxFrameBytes`、
`maxPending`、`statePath`（侧映射 JSON，默认 `${DSH_HOME:-~/.dsh}/storages/ssh-workspaces.json`）。

组合包默认 `daemonDir: '~/.dsh-workspace'`、`node: node`、`install: true`。要覆盖时，
在 profile 自己的 `cordis.patch.yml` 用相同 id 重述整行 config（后应用的层整行覆盖）。

## 5. 升级

```bash
# Git 安装
dsh plugin --profile web update @dsh-ssh-workspace/bundle
# 或重新 add 并锁定提交
dsh plugin --profile web add 'https://github.com/ya-b/dsh-ssh-workspace#<sha>'

# 本地 link 安装
git pull && pnpm install && pnpm run build
```

远端 daemon 的替换时机：新归档的**摘要**变化后，下一次首次使用该 (host, daemonDir) 时会
重新投递；但**正在运行的 daemon 进程不会自动换代码**——需要重启它（
`kill "$(cat ~/.dsh-workspace/pid)"` 后删掉 `sock`/`pid`/`lock`，或直接让它在下一次
bootstrap 时自愈），随后客户端按 `clientUuid` 重入会话。

远端 Node 版本不足或路径错误时，bootstrap 会在建连阶段直接报
`remote workspace daemon preflight failed: <node> is not a usable Node >= 20`。

## 6. 回滚

```bash
dsh plugin --profile web remove @dsh-ssh-workspace/bundle
```

只删除依赖与 `dsh.profile.bundles` 中的选择；不会动 profile 自己写的 patch 行。

## 备注：白名单

daemon 的 `config.json` 里 `roots` 是允许作为工作区打开的目录。客户端在打开某个目录前会先
发 `workspace.allow`，daemon 落盘保存（保留最近 64 条）。daemon 不设权限/认证边界
（socket、状态目录无强制权限），白名单只是防误操作的护栏。
