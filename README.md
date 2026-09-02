# gh-watch

> DeepSeek Harness (DSH) 的 GitHub PR / issue 变更监视插件。
> 检测 PR 与 issue 的变更并自动拉起对话通知 AI —— **插件自身不做审查、不回帖**，只负责「发现并通知」，把判断权留给 AI 与用户。

## 它解决什么问题

在多 AI 独立协作的场景里，经常需要让某个 AI 关注某些 GitHub 仓库的 PR 与 issue 是否有新动态（新建、新 push、新评论 / review、合并、关闭、重开等）。gh-watch 在后台轮询这些仓库，一旦检测到变更，就把一条变更通知注入对应 AI 的对话，让 AI 知道并决定下一步——而不需要人工反复去刷 GitHub。

设计上刻意保持了「监视与行动」的分离：

- **检测**：轮询 GitHub REST API，diff 游标快照，识别变更类型。
- **通知**：把变更摘要推送到调用方对话（`current`）或新开对话（`new`）。
- **不越界**：插件从不代表用户去评论、合并或回帖。

## 特性

- 每个会话（每个 AI）**独立配置**自己的监视器：仓库列表、轮询间隔、通知模式、推送目标各自独立。
- 一次轮询覆盖 PR 与 issue（issue 自动排除 `pull_request` 项，GR 与 issue 不会互相污染）。
- 变更类型识别：`新建` / `新push` / `新评论` / `评论变化` / `已合并` / `已关闭` / `重新打开` / `有更新` / `主动查询`。
- 首次监视某仓库时只建立基线快照，**不推送存量清单**，避免对历史海量数据刷屏。
- 轮询间隔钳制到至少 1 分钟；轮询失败时按 `2x→4x→8x` 指数退避推后下一次轮询，直至某次轮询完全成功后清零，降低撞 GitHub 限流的风险。
- 状态持久化到 `$DSH_HOME/gh-watch/state.json`，重启后恢复游标。

## 运行机制

```
[AI 调用 gh_watch_configure]  →  注册监视器 (repos / interval / mode / target)
                                          │
                                        每个会话独立 watcher
                                          │  timer 每 60s 触发 tick()
                                          ▼
                          pollWatcher：对每个 repo 拉 pulls + issues
                                          │
                             首次？──────是──→ 建立基线游标，不推送
                                          │
                                         否
                                          ▼
                       diff 快照 → 检测到变更 → dispatch → 注入对话
                                                        ├─ current：回到调用方对话
                                                        └─ new：新开对话
```

- 每个会话一个 watcher，互不干扰。
- `timer.interval(tick, 60_000)` 全局 60 秒驱动一次调度；每个 watcher 按自己的 `nextPollAt`（= 上次轮询 + intervalMin 分钟）判断是否到期。
- 失败重试采用指数退避：连续失败逐级推后 `min(2^failCount, 8)` 倍间隔，仅在某次轮询**完全成功**（所有分仓都拉取成功）后才清零 failCount。

## 安装与挂载

作为 DSH 用户插件，通过 `cordis.patch.yml` 把插件插入 profile 的 layer 栈：

```yaml
# cordis.patch.yml
- insert:
    - id: gh-watch
      name: 'gh-watch'
      config: {}
```

安装依赖：

```bash
npm install
# 或 pnpm install
```

需要网络访问 `api.github.com`。推荐配置只读 PAT（`GH_TOKEN`），否则匿名访问限流 60 次 / 小时。Token 可通过环境变量 `GH_TOKEN` / `GITHUB_TOKEN`，或 DSH `credentials` 中 `GH_TOKEN`。

## 工具（Tools）

插件向会话上下文注册 4 个工具：

| 工具 | 作用 |
| --- | --- |
| `gh_watch_configure` | 配置本会话监视器：repos、intervalMin、notifyMode、pushTarget |
| `gh_watch_status` | 查询本会话监视器当前配置与跟踪状态（只读） |
| `gh_watch_act` | 主动拉取某个 PR/issue 的最新状态并注入通知 |
| `gh_watch_stop` | 停止本会话监视器，删除配置 |

### gh_watch_configure 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repos` | string[] | **必填** | 仓库列表，格式 `owner/repo` |
| `intervalMin` | number | 10 | 轮询间隔（分钟），钳制 ≥1 |
| `notifyMode` | `inform` \| `auto` | inform | `inform`=只告知更新；`auto`=通知并请 AI 自动检查 |
| `pushTarget` | `current` \| `new` | current | `current`=回调用方对话（推荐）；`new`=新开一个对话 |

### gh_watch_act 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `repo` | string | **必填** | 仓库 `owner/repo` |
| `id` | number | **必填** | PR 或 issue 编号 |
| `kind` | `pull` \| `issue` | pull | 类型 |
| `target` | `current` \| `new` | current | 通知目标 |

## 目录结构

```
gh-watch/
├── lib/index.js         # 插件主入口：export { name, inject, apply }
├── package.json         # 包定义：main = lib/index.js, type = module
├── cordis.patch.yml     # DSH bundle patch：把插件插入 profile layer 栈
├── README.md            # 本文档
├── LICENSE              # MIT
└── .gitignore
```

## 开发与测试

插件入口约定为 CommonJS-style Cordis 插件对象导出 `{ name, inject, apply }`：

```js
// lib/index.js
export const name = 'gh-watch'
export const inject = ['tools', 'timer', 'agents', 'credentials']
export function apply(ctx, config) { /* ... */ }
```

冒烟测试（确认可导入且导出约定成员）：

```bash
node --input-type=module -e "
import { name, inject, apply } from './lib/index.js';
if (name !== 'gh-watch') throw new Error('name mismatch');
if (!Array.isArray(inject) || !('apply' in { apply })) throw new Error('export mismatch');
console.log('smoke ok', { name, inject });
"
```

> 依赖 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-credentials` 需在安装后可用，否则 `lib/index.js` 无法导入。

## 持久化状态

运行时状态（不入库）：

- `$DSH_HOME/gh-watch/state.json` —— watchers 配置与每仓库游标快照。
- `$DSH_HOME/gh-watch/undelivered.log` —— 通知派发失败时记录的未送达文本。

## License

[MIT](./LICENSE)