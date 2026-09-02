import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'gh-watch'

export const inject = ['tools', 'timer', 'agents', 'credentials']

const TICK_MS = 60_000
const STATE_DIR = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'gh-watch')
  : path.join(os.homedir(), '.dsh', 'gh-watch')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const UNDELIVERED_FILE = path.join(STATE_DIR, 'undelivered.log')

const DEFAULTS = {
  intervalMin: 10,
  notifyMode: 'inform',
  pushTarget: 'current',
  newPreset: 'standard',
}

// gh-watch host plugin.
//
// What it does: per-session (per-AI) GitHub watchers. An AI calls
// gh_watch_configure to register repos + poll interval + notify mode +
// push target. A shared ticker polls the GitHub REST API, diffs against a
// per-repo cursor, and pushes change notifications into the owner's own
// conversation ("current") or a freshly created conversation ("new").
//
// The plugin itself never reviews or posts back — it only detects and
// notifies, so the AI (and the user) stay in control.

async function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(await fs.readFile(file, 'utf8')) }
  } catch {
    return fallback
  }
}

export function apply(ctx, config) {
  const { tools, timer, agents, credentials } = ctx

  // ---------- durable state ----------
  // state.watchers: { [sessionId]: { repos, intervalMin, notifyMode, pushTarget, newPreset, nextPollAt, cursor } }
  // cursor: { [repo]: { [kind#number]: snapshot } }
  let state = { watchers: {} }
  let loaded = false
  async function ensureLoaded() {
    if (loaded) return
    state = await readJson(STATE_FILE, { watchers: {} })
    if (!state.watchers) state.watchers = {}
    loaded = true
  }
  let persistChain = Promise.resolve()
  function persist() {
    persistChain = persistChain.then(async () => {
      try {
        await fs.mkdir(STATE_DIR, { recursive: true })
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2))
      } catch (e) {
        console.error('[gh-watch] persist:', e.message)
      }
    })
    return persistChain
  }
  async function logUndelivered(text) {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true })
      await fs.appendFile(UNDELIVERED_FILE, `\n--- ${new Date().toISOString()} ---\n${text}\n`)
    } catch (e) {
      console.error('[gh-watch] undelivered log:', e.message)
    }
  }

  // ---------- GitHub client ----------
  async function gh(pathname) {
    let token
    try {
      token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    } catch { /* env may be restricted */ }
    if (!token) {
      try {
        const r = await credentials.resolve(credentialRef('GH_TOKEN'))
        token = r && r.value
      } catch { /* credentials optional */ }
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-gh-watch',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    let res
    try {
      res = await fetch('https://api.github.com' + pathname, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('GitHub 请求超时（15s）')
      throw e
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub ${res.status} ${res.statusText}: ${body.slice(0, 160)}`)
    }
    return res.json()
  }

  function repoOf(repo) {
    return String(repo || '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\.git$/, '')
      .trim()
  }

  // ---------- change detection ----------
  function snapshotOf(kind, item) {
    const s = { state: item.state, updated: item.updated_at }
    s.comments = item.comments ?? 0
    if (kind === 'pull') {
      s.head = item.head && item.head.sha
      s.merged = !!item.merged_at
      s.reviewComments = item.review_comments ?? 0
    }
    return s
  }

  function classify(prev, cur, kind) {
    if (!prev) return '新建'
    if (cur.state !== prev.state) {
      if (kind === 'pull' && cur.merged) return '已合并'
      return cur.state === 'open' ? '重新打开' : '已关闭'
    }
    if (kind === 'pull' && cur.head && prev.head && cur.head !== prev.head) return '新push'
    const dc = (cur.comments ?? 0) - (prev.comments ?? 0)
    const dr = (cur.reviewComments ?? 0) - (prev.reviewComments ?? 0)
    // 按增减区分评论数量变化：增加=新评论；减少=评论被删除或变化。
    if (dc > 0 || dr > 0) return '新评论'
    if (dc < 0 || dr < 0) return '评论变化'
    return '有更新'
  }

  function buildNotification(w, c) {
    const it = c.item
    const tag = c.kind === 'pull' ? 'PR' : 'issue'
    const title = (it.title || '').trim()
    const lines = [
      `[变更通知] ${c.repo} ${tag}#${it.number} — ${c.type}`,
      `- 标题: ${title}`,
      `- 状态: ${it.state}`,
      `- 更新时间: ${it.updated_at}`,
      `- 创建者: ${it.user && it.user.login ? it.user.login : 'unknown'}`,
    ]
    if (c.kind === 'pull' && it.head) {
      lines.push(`- 最新 commit: ${(it.head.sha || '').slice(0, 7)} ${it.head.ref || ''}`)
    }
    if (c.type === '新push') {
      lines.push('- 本次为新 push，建议你（AI）按用户要求用 gh_watch_act 或你自己的工具拉取 diff 详情。')
    }
    if (w.notifyMode === 'auto') {
      lines.push('')
      lines.push('请自动检查这份更新：分析变更内容、给出判断，并把结论告诉用户。')
    }
    lines.push('')
    lines.push('（本条由 gh-watch 插件自动推送。需要调整可用 gh_watch_configure / gh_watch_stop。）')
    return lines.join('\n')
  }

  // ---------- dispatch ----------
  async function dispatch(ownerSessionId, w, change) {
    const text = buildNotification(w, change)
    const content = [{ type: 'text', text }]
    const useNew = w.pushTarget === 'new'
    try {
      if (useNew) {
        const newId = randomUUID()
        const presets = ctx.get('agentPresets')
        let setup
        let agentPreset
        if (presets) {
          try {
            const resolved = await presets.resolve(w.newPreset || DEFAULTS.newPreset)
            agentPreset = resolved.id
            setup = async (agentCtx) => {
              await presets.mount(agentCtx, resolved.id)
            }
          } catch (e) {
            console.error('[gh-watch] preset resolve:', e.message)
          }
        }
        const handle = await agents.create({
          sessionId: newId,
          meta: { cwd: process.cwd(), agentPreset },
          setup,
        })
        handle.agent.followup({ content })
        console.log(`[gh-watch] notified new session ${newId}`)
      } else {
        let agent = agents.get(ownerSessionId)
        if (!agent) {
          const h = await agents.resume({ resumeSessionId: ownerSessionId })
          agent = h.agent
        }
        agent.followup({ content })
        console.log(`[gh-watch] notified session ${ownerSessionId}`)
      }
    } catch (e) {
      console.error(`[gh-watch] dispatch -> ${ownerSessionId} (${useNew ? 'new' : 'current'}):`, e.message)
      await logUndelivered(text)
    }
  }

  // ---------- polling ----------
  async function pollWatcher(sessionId, w) {
    const changes = []
    let hadFail = false
    for (const rawRepo of w.repos || []) {
      const repo = repoOf(rawRepo)
      if (!repo) continue
      let pulls = []
      let issues = []
      try {
        pulls = await gh(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`)
        issues = await gh(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50`)
      } catch (e) {
        console.error(`[gh-watch] fetch ${repo}:`, e.message)
        hadFail = true
        // 指数退避：连续失败则逐级推后（2x→4x→8x），避免撞限流/风暴。
        w.failCount = (w.failCount || 0) + 1
        const backoff = Math.min(Math.pow(2, w.failCount), 8)
        w.nextPollAt = Date.now() + (w.intervalMin || DEFAULTS.intervalMin) * 60_000 * backoff
        continue
      }
      issues = issues.filter((i) => !i.pull_request)
      w.cursor = w.cursor || {}
      // 首次监视该仓库：只建立基线快照，不推送存量清单。
      const firstPoll = !w.cursor[repo]
      const cur = (w.cursor[repo] = w.cursor[repo] || {})
      // 本轮窗口内出现的 key 集合，用于对掉出窗口的旧条目做淘汰。
      const seenKeys = new Set()
      for (const p of pulls) {
        const k = 'PR#' + p.number
        seenKeys.add(k)
        const now = snapshotOf('pull', p)
        const prev = cur[k]
        if (!firstPoll && JSON.stringify(prev) !== JSON.stringify(now)) {
          changes.push({ kind: 'pull', repo, item: p, type: classify(prev, now, 'pull') })
        }
        cur[k] = now
      }
      for (const i of issues) {
        const k = 'issue#' + i.number
        seenKeys.add(k)
        const now = snapshotOf('issue', i)
        const prev = cur[k]
        if (!firstPoll && JSON.stringify(prev) !== JSON.stringify(now)) {
          changes.push({ kind: 'issue', repo, item: i, type: classify(prev, now, 'issue') })
        }
        cur[k] = now
      }
      // 淘汰：仅保留本轮 50 窗口内出现的 key，移除已掉出窗口的旧条目，避免 cursor 无限膨胀。
      for (const k of Object.keys(cur)) {
        if (!seenKeys.has(k)) delete cur[k]
      }
    }
    for (const c of changes) {
      await dispatch(sessionId, w, c)
    }
    // failCount 仅在『完全成功的轮询』时清零；本轮任一分仓失败则保留，下次继续 2x→4x→8x 退避。
    if (!hadFail && w.failCount) w.failCount = 0
    return changes.length
  }

  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await ensureLoaded()
      const now = Date.now()
      const entries = Object.entries(state.watchers || {})
      for (const [sid, w] of entries) {
        const due = !w.nextPollAt || now >= w.nextPollAt
        if (!due) continue
        w.nextPollAt = now + (w.intervalMin || DEFAULTS.intervalMin) * 60_000
        try {
          const n = await pollWatcher(sid, w)
          if (n) console.log(`[gh-watch] poll ${sid}: ${n} change(s)`)
        } catch (e) {
          console.error(`[gh-watch] poll ${sid}:`, e.message)
        }
      }
      if (entries.length) await persist()
    } catch (e) {
      console.error('[gh-watch] tick:', e.message)
    } finally {
      ticking = false
    }
  }

  // ---------- tools ----------
  const toolConfigure = defineTool({
    name: 'gh_watch_configure',
    description:
      '配置本会话的 GitHub 变更监视器：设置要监视的仓库（owner/repo）、轮询间隔、通知模式与推送目标。配置后插件在后台轮询这些仓库的 PR 与 issue 全部变更（新建/新push/新评论/新review/合并/关闭/重开等），检测到时自动拉起对话通知 AI：pushTarget=current 通知回调用本工具的原对话，pushTarget=new 新开一个对话。插件自身不审查、不回帖。',
    parameters: {
      repos: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要监视的仓库列表，格式 owner/repo，例如 ["owner/repo"]。',
      },
      intervalMin: {
        type: 'number',
        description: '轮询间隔（分钟），默认 10。',
      },
      notifyMode: {
        type: 'string',
        enum: ['inform', 'auto'],
        description: 'inform=只告知更新；auto=通知并请 AI 自动检查。默认 inform。',
      },
      pushTarget: {
        type: 'string',
        enum: ['current', 'new'],
        description: 'current=通知到调用本工具的原对话（推荐）；new=新开一个对话。默认 current。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }]
      },
    },
    async execute(args, exec) {
      await ensureLoaded()
      const sessionId = exec.agent && exec.agent.id
      if (!sessionId) return { ok: false, message: '无法识别调用方会话，拒绝配置。' }
      const w = (state.watchers[sessionId] = state.watchers[sessionId] || {})
      w.repos = (args.repos || []).map(repoOf).filter(Boolean)
      if (!w.repos.length) return { ok: false, message: '仓库列表为空，未配置。' }
      // 轮询间隔钳制：至少 1 分钟，避免高频轮询撞 GitHub 限流。
      w.intervalMin = Math.max(1, Math.floor(args.intervalMin ?? w.intervalMin ?? DEFAULTS.intervalMin))
      w.notifyMode = args.notifyMode ?? w.notifyMode ?? DEFAULTS.notifyMode
      w.pushTarget = args.pushTarget ?? w.pushTarget ?? DEFAULTS.pushTarget
      w.nextPollAt = Date.now() + 1500 // 尽快首轮
      w.cursor = w.cursor || {}
      await persist()
      let tokenTip = ''
      try {
        const r = await credentials.resolve(credentialRef('GH_TOKEN'))
        if (!r) tokenTip = '（未配置 GH_TOKEN，匿名访问限流 60 次/小时；建议配置只读 PAT：credentials 存 GH_TOKEN 或设置环境变量）'
      } catch { /* 忽略 */ }
      return {
        ok: true,
        message: `已配置监视器：${w.repos.join(', ')}（间隔 ${w.intervalMin} 分钟，模式 ${w.notifyMode}，推送 ${w.pushTarget}）${tokenTip}`,
      }
    },
  })

  const toolStatus = defineTool({
    name: 'gh_watch_status',
    description:
      '查询本会话 GitHub 变更监视器的当前配置与跟踪状态（只读，不触发新检查）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          configured: { type: 'boolean' },
          watcher: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(_args, exec) {
      await ensureLoaded()
      const sessionId = exec.agent && exec.agent.id
      const w = sessionId && state.watchers[sessionId]
      if (!w) {
        return { configured: false, watcher: {}, note: '本会话尚未配置监视器。可用 gh_watch_configure 配置。' }
      }
      const repos = Object.keys(w.cursor || {}).map((repo) => ({
        repo,
        tracked: Object.keys(w.cursor[repo] || {}).length,
      }))
      return {
        configured: true,
        watcher: {
          repos: w.repos,
          intervalMin: w.intervalMin,
          notifyMode: w.notifyMode,
          pushTarget: w.pushTarget,
          reposTracked: repos,
          nextPollAt: w.nextPollAt || null,
        },
        note: '这是本会话的监视器配置。',
      }
    },
  })

  const toolAct = defineTool({
    name: 'gh_watch_act',
    description:
      '主动获取某个 GitHub PR/issue 的最新状态并把变更通知注入一个对话：target=new 新开对话，target=current 回到调用本工具的原对话。适合用户要求「去查一下这个 PR/issue 有没有更新」时，AI 主动调用来拉取并知会。',
    parameters: {
      repo: { type: 'string', required: true, description: '仓库 owner/repo。' },
      id: { type: 'number', required: true, description: 'PR 或 issue 编号。' },
      kind: { type: 'string', enum: ['pull', 'issue'], description: '类型，默认 pull。' },
      target: { type: 'string', enum: ['current', 'new'], description: '通知目标：current=原对话，new=新开对话。默认 current。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }]
      },
    },
    async execute(args, exec) {
      await ensureLoaded()
      const ownerSessionId = exec.agent && exec.agent.id
      if (!ownerSessionId) return { ok: false, message: '无法识别调用方会话。' }
      const repo = repoOf(args.repo)
      const kind = args.kind || 'pull'
      try {
        const it = await gh(`/repos/${repo}/${kind === 'pull' ? 'pulls' : 'issues'}/${args.id}`)
        const w = { repos: [repo], notifyMode: 'auto', pushTarget: args.target || 'current' }
        await dispatch(ownerSessionId, w, { kind, repo, item: it, type: '主动查询' })
        return { ok: true, message: `已将 ${repo} ${kind === 'pull' ? 'PR' : 'issue'}#${args.id} 的更新通知注入 ${args.target || 'current'} 对话。` }
      } catch (e) {
        return { ok: false, message: `获取 ${repo} ${kind === 'pull' ? 'PR' : 'issue'}#${args.id} 失败：${e.message}` }
      }
    },
  })

  const toolStop = defineTool({
    name: 'gh_watch_stop',
    description: '停止本会话的 GitHub 变更监视器，删除配置。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: value.message }]
      },
    },
    async execute(_args, exec) {
      await ensureLoaded()
      const sessionId = exec.agent && exec.agent.id
      if (sessionId && state.watchers[sessionId]) {
        delete state.watchers[sessionId]
        await persist()
        return { ok: true, message: '已停止本会话的监视器。' }
      }
      return { ok: false, message: '本会话没有已配置的监视器。' }
    },
  })

  tools.register(toolConfigure)
  tools.register(toolStatus)
  tools.register(toolAct)
  tools.register(toolStop)

  timer.interval(tick, TICK_MS)
  void ensureLoaded()

  console.log('[gh-watch] plugin loaded')
}
