# dsh-ssh-workspace

DeepSeek Harness 远程工作区插件。`PLAN.md` 为完整计划。

## 布局

- `packages/daemon` — 远端 workspace daemon（Node ≥ 20 单文件 bundle `workspaced.js`）
- `packages/transport` — 形状兼容 `{request, connectStream, dispose}` 的客户端连接 + ssh 转发 + 重连状态机
- `packages/providers` — 官方 `dsh-fs-ssh / dsh-subprocess-ssh / dsh-sandbox-ssh` 复用薄壳
- `packages/realm` — `WorkspaceRuntimeRegistry` 子类 + verifier
- `packages/api` — `~/.ssh/config` 机器枚举/precheck + 远端目录浏览
- `packages/ui` — 添加工作区两步流（client face）
- `packages/plugin` — host 插件装配面（cordis provide + API 装配）
- `profile/` — profile 叠层说明与产物（README、升级指南）

## 快速接入

见 `profile/README.md`。
