# UI 重做计划：主机选择融入 Harness 自身弹窗

> 目标：左侧侧边栏去掉本插件的「远程工作区」图标；「添加工作区」图标点击后**直接弹出
> Harness 自己的目录选择弹窗**，弹窗**最上方**是主机选择（本机 + `~/.ssh/config` 主机），
> 选完主机再选目录。**只改 Harness 自身弹窗内部**，任何其他界面形态（独立面板、页脚弹窗、
> 双弹窗、文本路径输入）都不符合要求。

## 1. 需求拆解与验收

| # | 需求 | 验收 |
|---|---|---|
| R1 | 侧边栏不再出现「远程工作区」独立图标按钮 | 侧边栏只有原生「添加工作区（＋）」；本插件不再注册 `sidebar.footer.action` / `sidebar.panellist` |
| R2 | 点「添加工作区」→ 不再出现菜单，直接弹出弹窗 | 点击后 300ms 内出现 `选择工作区目录` 弹窗，无中间菜单 |
| R3 | 弹窗最上方是主机选择区 | 弹窗内 header 之下、目录区之上，第一个可交互控件是主机选择（本机 + ssh config 主机） |
| R4 | 选完主机再选目录 | 主机=本机 → 列出本机目录；主机=别名 → 列出远端目录（经本插件 daemon realm） |
| R5 | 选目录后确认 → 创建对应工作区 | 本机 → `{path}`；远端 → `{path, transport:'ssh', host}`，落入现有 store，重启不丢 |

## 2. 现状分析（权威代码路径）

### 2.1 现有触发链（侧边栏加号）

`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx`
- `:1288` `{directoryFlowAvailable && <Tooltip ...><button aria-label={t('workspace.add')} onClick={() => requestAddWorkspace()}>` —— 侧边栏加号。
- `:1029` `const wsPickerOpen = shortcutState.addRequested` —— 加号只是把 `addRequested` 置 1。
- `:1308` `<WorkspacePickFlow open={wsPickerOpen} ... addOnly>` —— **先弹菜单**（`WorkspacePicker` 的 popover）。

`packages/client/ui-workspace/src/client/WorkspacePicker.tsx`
- `:126` `addEntries = [..., {id: ADD_WORKSPACE, ...}, ...(verifyRemote ? [{id: ADD_REMOTE_WORKSPACE...}] : [])]` —— 菜单两项。
- `:264` ADD_WORKSPACE → `setFlowOpen(true)` → `:185` 附近 `renderDirectoryFlow(flowOwner)` —— 打开**目录流槽位**。
- `:196-320` `verifyRemotePath` / `addRemoteWorkspace` + `remoteForm`（主机文本框 + 路径文本框 + 验证按钮）—— **旧远程表单**，本次被取代。

### 2.2 Harness 自己的目录弹窗（本次修改主体）

`packages/client/ui-directory-picker-browse/src/client/`
- `flow.ts` —— `BrowseDirectoryFlow(props: DirectoryFlowOwnerProps & BrowseFlowInjected)`：
  把槽位 owner 会话接到 `DirectoryBrowser`（`open/busy/listDirectory/createDirectory/t/onOpen/onClose`）。
- `index.ts:80-95` —— `apply` 把两个目录流槽位
  （`conversation.hero.workspace.directoryFlow`、`sidebar.workspaces.directoryFlow`）
  都注册为 `BrowseDirectoryFlow`。
- `DirectoryBrowser.tsx` —— **弹窗本体**（约 900 行）：`Modal`(`:771`) + `header`(`:818`,
  标题 `browser.title`「选择工作区目录」) + Miller 目录树 + 路径编辑 + 新建文件夹 + 打开/取消。
  目录数据来自注入的 `listDirectory(path?, signal?)`（**只有本地**）。

### 2.3 宿主数据链路（目录数据从哪来）

- `client/ui-workspace/src/client/navigation.ts:329` `listDirectory(path?)` → `ctx.remote.directoryPicker.list`。
- `api/workspace-controller/src/directory-picker.ts:72` `list(path, signal)` → `ctx.directoryPicker` seam
  （`packages/host/directory-picker*`，只管本机）。
- 本插件已提供：`packages/api/src/index.ts` 的 `listMachines()`（`~/.ssh/config` 枚举）、
  `browse(ctx, host, path)`（远端经 `workspaceRuntime.worldForWorkspace` → daemon realm），
  以及浏览器面板 `packages/ui/src/client/index.tsx`（本次**整个移除**）。

### 2.4 结论：为什么只能改 Harness 自身弹窗

- `DirectoryBrowser` 是 `ui-directory-picker-browse` 的**包内私有**模块：`exports["./client"]` 只导出 `apply`
  （`flow.ts` 仅在包内引用），且插件客户端打包纯度门禁止跨包深路径 import。
- 目录流槽位是 `single` 类型：插件可以注册**另一个 occupant** 顶掉 `BrowseDirectoryFlow`，
  但那样弹窗就是插件的复制品（样式/交互要逐像素复刻 900 行 + CSS module），
  且「Harness 自身弹窗」这个要求本身落空。
- 因此正确做法 = **在 Harness 源码内**（`ui-directory-picker-browse` + `ui-workspace`）加主机选择；
  本插件只提供数据能力（`~/.ssh/config` 枚举 + 远端浏览），通过 cordis 服务/注入面接入。
  ⚠️ 这与旧约束「harness 字节级不可改」冲突——**需要用户确认放行**（见 §7）。

## 3. 设计

### 3.1 弹窗结构（自上而下）

```
┌─ 选择工作区目录 ──────────────────────────────────────┐
│ 主机：[本机 (workstation) ▾]     ✓ 可用 / 检测中…          │  ← 新增：弹窗最上方
│ 目录： /home/user ▾（面包屑，可编辑路径）               │
│ ┌──────────────┬──────────────┐                      │
│ │ Miller 左侧  │ Miller 右侧  │  ← 既有目录树        │
│ └──────────────┴──────────────┘                      │
│ 显示隐藏文件   [新建文件夹*]        [取消] [打开]     │
└──────────────────────────────────────────────────────┘
* 仅在主机=本机时显示（远端新建文件夹暂无能力）
```

- 主机选择用**原生 `<select>`**（少量主机，简单直接；不引入新的下拉组件与焦点管理）。
- 主机列表 = `本机` + `listMachines()` 的具名别名；选中即触发 `listDirectory(host, path)` 重扫。
- 打开时默认主机 = `本机`，目录从 `$host.home` 开始（本机用 `uiWorkspace.listDirectory()`；
  远端用各该机 `$HOME`，经 daemon 一次探测并缓存）。
- 远端模式下「新建文件夹」隐藏；面包屑/路径编辑/打开/取消行为不变。

### 3.2 数据通路（新增契约，插件实现）

在 `packages/host/directory-picker/types.ts`（或 `api/remotes` client types）增加：

```ts
export interface SshHostEntry { alias: string | null; label: string; local: boolean; user?: string; hostname?: string; port?: number }
export interface SshHostBrowse { path: string; parent?: string; entries: DirectoryEntry[] }
```

宿主侧 `DirectoryPickerController`（`api/workspace-controller/src/directory-picker.ts`）新增三个方法：
- `hosts(): Promise<SshHostEntry[]>` —— 本机 + 枚举结果；`sshHosts` 服务缺失时只返回本机。
- `list(path: string | undefined, host: string | undefined, signal): Promise<DirectoryListing>`
  —— 已有签名追加 `host` 参数（旧调用 = 本地，保持兼容）。
- `createDirectory` 保持本地 only（host 参数非空即拒绝）。

`host: ''`/`undefined` = 本机；非空 = 别名。远端分支委托给**可选注入服务**：

```ts
// 契约（harness 定义，类型与注册点）
export interface SshHostsService {
  listHosts(): Promise<SshHostEntry[]>
  precheck?(alias: string): Promise<{ status: string; detail: string }>
  browse(alias: string, path: string): Promise<SshHostBrowse>
}
```

由本插件 `packages/api` 实现并注册（`ctx.provide('sshHosts', service)`），复用现有
`listMachines` / `precheck` / `browse` 代码；HTTP 路由 `GET /ssh-workspace/*`
**整体删除**（改为服务调用），避免两条通路漂移。

### 3.3 客户端改动

1. `ui-workspace/src/client/navigation.ts`
   - `UiWorkspace` 增加 `listHosts(): Promise<SshHostEntry[]>` 与 `listDirectory(path?, host?, signal?)`。
   - 删除或保留旧 `remote.*` 相关？—— 保留 `create`（弹窗确认直接调 `workspaces.create`）。
2. `ui-directory-picker-browse/src/client/flow.ts`
   - `BrowseFlowInjected` 增加 `listHosts` / `listDirectory(path, host, signal)` / `t` 不变。
3. `ui-directory-picker-browse/src/client/DirectoryBrowser.tsx`
   - props 增加 `hosts?: SshHostEntry[]`、`host?: string|null`、`onHostChange`、`listHosts`。
   - `header` 上方插入主机行（`<label>主机 <select>` + 状态徽标），按 3.1 布局。
   - `listDirectory` 调用改为 `listDirectory(path, hostForFetch, signal)`；`host` 变化时重置
     浏览状态并加载新主机 home。
   - `newFolder` 在远端主机下隐藏。
4. `ui-workspace/src/client/WorkspaceBrowser.tsx`
   - 加号点击改为**直接开流**：新增 `openAddFlow()`（`setFlowOpen(true)` 语义，
     复用 `shortcutControls` 的 `addRequested` 或新 state），不再经 `WorkspacePickFlow` 菜单。
   - `WorkspacePickFlow` 的 `addOnly` 菜单路径删除（sidebar 不再用菜单）；
     hero 的 `WorkspacePicker` 保留菜单，但「添加远程工作区…」item 改为**打开同一目录流**
     （删除旧 remoteForm 弹窗与 `remoteHost/remotePath/verifyRemotePath` 状态）。
5. `DirectoryFlowOwnerProps`（`ui-workspace/src/client/contract/slots.ts`）
   - `onPicked(path: string, host?: string | null)`：追加可选参数；sidebar owner 组装
     `createWorkspace({path, ...(host ? {transport:'ssh', host}: {})})`。
   - 保持向后兼容（hero 的 owner 忽略 host 参数）。
6. 本插件 `packages/ui` —— **删除**侧边栏/页脚/主列注册（`sidebar.footer.action`、
   `sidebar.panellist`、`main`），保留 `dsh.client` 声明为空壳或整个包从 profile 移除。

## 4. 改动清单（文件级）

### Harness 源码（新 diff，单独提交，便于审阅/回滚）

| 文件 | 改动 |
|---|---|
| `packages/host/directory-picker/types.ts` | + `SshHostEntry` / `SshHostBrowse` / `SshHostsService` 类型 |
| `packages/api/workspace-controller/src/directory-picker.ts` | + `hosts()`；`list()` 追加 `host` 参数；远端分支调 `ctx.get('sshHosts')` |
| `packages/api/workspace-controller/src/types.ts` | 转发新类型（生成面） |
| `packages/client/ui-workspace/src/client/navigation.ts` | `UiWorkspace` + `listHosts` / `listDirectory(host)` |
| `packages/client/ui-workspace/src/client/contract/slots.ts` | `onPicked` 追加可选 host |
| `packages/client/ui-workspace/src/client/WorkspacePicker.tsx` | 删除 remoteForm；ADD_REMOTE_WORKSPACE → 打开目录流 |
| `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` | 加号直接开流；onPicked 透传 host |
| `packages/client/ui-directory-picker-browse/src/client/flow.ts` | injected + hosts/host-aware list |
| `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx` | 弹窗顶部主机选择条 + host-aware 浏览 + 远端隐藏新建 |
| `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.module.css` | 主机行样式 |
| `packages/client/ui-workspace/src/client/locales.ts` | + 主机/本机/检测中/远端 文案（zh/en） |
| （测试）`packages/api/workspace-controller/tests/directory-picker.host.spec.ts` | + hosts/远程 list 用例 |

### 本插件（`dsh-ssh-workspace`）

| 文件 | 改动 |
|---|---|
| `packages/api/src/index.ts` | HTTP 路由改为 `SshHostsService`（`listHosts/precheck/browse`）并注册为 `ctx.sshHosts`；删除 `/ssh-workspace/*` |
| `packages/api/package.json` / `tsconfig` | 对齐 harness 侧新类型依赖 |
| `packages/ui/src/client/index.tsx` | 删除（面板、页脚按钮全部移除） |
| `packages/ui/build.mjs` / `package.json` | 随包移除（`dsh.client` 声明取消） |
| `tests/api/machines.test.mjs` | 改为直接测 Service；删除 curl 断言 |
| `README.md` / `INSTALL.md` / `PROGRESS.md` | 更新为新入口描述 |

## 5. 实施顺序

1. **契约先行**：harness `types.ts` + 目录服务 `hosts()/list(host)` + `SshHostsService` 声明
   （此时远端分支返回「not mounted」错误，UI 可先跑本地）。
2. **插件侧**：`packages/api` 实现并注册 `sshHosts`；跑 `machines.test.mjs`。
3. **服务接线**：`directory-picker.ts` 远端分支调用 `sshHosts`；host 单测。
4. **客户端数据面**：`navigation.ts` + `flow.ts` + `slots.ts`（onPicked host）。
5. **弹窗 UI**：`DirectoryBrowser` 主机条 + host-aware 浏览 + 远端隐藏新建；浏览器手测本机/远端。
6. **入口改造**：`WorkspaceBrowser` 加号直开弹窗；删 `WorkspacePicker` remoteForm；
   hero 菜单项改名/收敛。删除插件 UI 包与 HTTP 路由。
7. **回归**：现有 4 个 daemon 探针 + 新增目录服务单测 + 全量浏览器 e2e。

## 6. 测试与验收步骤

- 单测：`directory-picker.host.spec.ts`（hosts 枚举、本地 list 兼容、远程 list 委托、
  createDirectory(远程) 拒绝）；`machines.test.mjs` 保持 10/10（改为服务面）。
- 探针回归：`probe-transport 11/11`、`probe-providers 13/13`、`probe-realm 12/12`、
  `probe-resilience 11/11`（无协议改动，预期全绿）。
- 浏览器 e2e（本地构建实例）：
  1. 侧边栏无「远程工作区」图标；加号存在。
  2. 点加号 → **无菜单**，直接出现「选择工作区目录」弹窗。
  3. 弹窗最上方是主机下拉：默认「本机(workstation)」，含 `localhost` 与 `192.0.2.*`。
  4. 选本机 → 目录树为本地；选 `localhost` → 目录树为远端（与 `~` 一致），新建文件夹消失。
  5. 选目录 →「打开」→ 工作区落库：本机 `{path}` / 远端 `{path, transport:'ssh', host}`。
  6. 重启实例 → 新工作区仍在侧边栏；选出工作区后会话内 bash 父进程 = 远端 `workspaced.js`。
- 回归红线：harness diff 仅限上表列出的文件；本插件不再有 HTTP 路由；安全面不变。

## 7. 决策点（需确认）

1. **是否放行修改 Harness 源码**：本方案必须改 `ui-directory-picker-browse` / `ui-workspace` /
   `api/workspace-controller` / `host/directory-picker`（约 10 个文件）。旧约束是「harness
   字节级不可改」，两者冲突。若**不放行**，则只能走插件复制弹窗（方案 B，不符合 R3 的
   「Harness 自身弹窗」表述，需要用户重新确认）。
2. **旧「添加远程工作区…」菜单项**：收敛为「打开同一个弹窗」还是**直接删除**（只留加号入口）？
   默认：收敛，保留 hero 菜单入口。
3. **远端「新建文件夹」**：本次不做（daemon 无 mkdir 语义），隐藏按钮；是否后续补 fs.mkdir？
