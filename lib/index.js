import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
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
const DIAG_FILE = path.join(STATE_DIR, 'diag.log')

const DEFAULTS = {
  intervalMin: 10,
  notifyMode: 'inform',
  pushTarget: 'current',
  newPreset: 'standard',
  // 2026-09-22 用户需求：注入对话的每条通知都要有"已处理"确认；超时未确认就再次提醒
  ackTimeoutMin: 15,
  ackMaxRetries: 2,
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
  let lastBackupDay = ''
  // 防御性持久化（2026-09-14）：写盘前先与磁盘现状做 cursor 并集。
  // 背景：曾观察到「已关闭的历史 issue 被报为『新建』」——一次性成批（#106/#114/#118 同一次
  // 轮询、恰为 cursor 里 08-26~09-01 那段连续 key），符合「某个持有旧快照的写入者整体覆盖
  // state.json、把别的写入者新增的 key 抹掉，下次轮询又当新条目补回」的特征（与 09-08 那次
  // replay 备份同源）。此处以磁盘为准取并集：内存没有而磁盘有的 key 一律补回，从机制上消除
  // 「旧快照覆盖导致丢键」这一类问题；冲突时以内存（本轮最新快照）为准。
  function persist() {
    persistChain = persistChain.then(async () => {
      try {
        await fs.mkdir(STATE_DIR, { recursive: true })
        let recovered = 0
        try {
          const disk = await readJson(STATE_FILE, { watchers: {} })
          for (const [sid, dw] of Object.entries(disk.watchers || {})) {
            const mw = state.watchers[sid]
            if (!mw) {
              state.watchers[sid] = dw
              continue
            }
            mw.cursor = mw.cursor || {}
            for (const [repo, dkeys] of Object.entries(dw.cursor || {})) {
              const mkeys = mw.cursor[repo] || (mw.cursor[repo] = {})
              for (const [k, v] of Object.entries(dkeys)) {
                if (!(k in mkeys)) {
                  mkeys[k] = v
                  recovered += 1
                }
              }
            }
          }
        } catch (e) {
          console.error('[gh-watch] persist merge:', e.message)
        }
        if (recovered > 0) {
          await logDiag(`persist 前从磁盘补回 ${recovered} 个丢失 key（旧快照覆盖迹象）`)
        }
        // 每日留一份基线备份，便于事后 diff「基线到底被谁改动」
        const day = new Date().toISOString().slice(0, 10)
        if (day !== lastBackupDay) {
          lastBackupDay = day
          try {
            if (existsSync(STATE_FILE)) {
              await fs.copyFile(STATE_FILE, `${STATE_FILE}.bak-${day.replace(/-/g, '')}`)
            }
          } catch (e) {
            console.error('[gh-watch] daily backup:', e.message)
          }
        }
        await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2))
      } catch (e) {
        console.error('[gh-watch] persist:', e.message)
      }
    })
    return persistChain
  }
  // 诊断留痕（每行一条，含时间戳与上下文）——用于定位「基线为何变化」这类一次性异常
  async function logDiag(text) {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true })
      await fs.appendFile(DIAG_FILE, `${new Date().toISOString()} ${text}\n`)
    } catch (e) {
      console.error('[gh-watch] diag log:', e.message)
    }
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

  // 2026-09-22：每条注入带一个 id，并要求 AI 处理完后调用 gh_watch_ack 确认；
  // 未确认的会在 ackTimeoutMin 后再次提醒（见 checkAckTimeouts）。
  function ackLine(nid, w) {
    const t = Number(w.ackTimeoutMin || DEFAULTS.ackTimeoutMin)
    const r = Number(w.ackMaxRetries != null ? w.ackMaxRetries : DEFAULTS.ackMaxRetries)
    return ['', '【本条 id: ' + nid + '】处理完请调用 gh_watch_ack({ id: "' + nid + '" }) 让插件知道这条已被处理；', '若 ' + t + ' 分钟内没有确认，插件会再次提醒（最多 ' + r + ' 次）。'].join(String.fromCharCode(10))
  }

  function nextNid() {
    state.seq = (state.seq || 0) + 1
    return 'gw-' + Date.now().toString(36) + '-' + state.seq
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

  // 批量通知：一次轮询的全部变更合并为一条消息（#通知堆积治理：N 条变更 1 次 followup）
  function buildBatchNotification(w, changes) {
    const lines = [`[变更通知·合并] ${w.repos.join(' / ')} — ${changes.length} 条更新：`]
    for (const c of changes) {
      const tag = c.kind === 'pull' ? 'PR' : 'issue'
      const st = c.item.state === 'closed' ? (c.item.merged_at || c.item.pull_request?.merged_at ? '已合并' : 'closed') : 'open'
      lines.push(`- ${tag}#${c.item.number} [${c.type}] ${(c.item.title || '').trim()}（${st}）`)
    }
    lines.push('')
    lines.push('请逐条检查这些更新（分析变更、给出判断、告知结论）。需要详情用 gh 拉取。')
    lines.push('（gh-watch 合并通知。调整用 gh_watch_configure / gh_watch_stop。）')
    return lines.join('\n')
  }

  // ---------- dispatch ----------
  async function dispatch(ownerSessionId, w, changes) {
    const list = Array.isArray(changes) ? changes : [changes]
    const nid = nextNid()   // 2026-09-22：本条通知的确认 id
    const text = (list.length === 1 ? buildNotification(w, list[0]) : buildBatchNotification(w, list)) + ackLine(nid, w)
    const content = [{ type: 'text', text }]
    // 必须用 createUserMessage() 包裹（官方 dsh-command-goal/dsh-plan-mode 同款）：
    // 它补 role:'user' + 稳定 id 并 deep-freeze，消息才作为合规 Message 落库并在 UI
    // 渲染成可见气泡。裸对象缺 id/role → AI 被唤醒干活但气泡不显示。
    // source.kind 保留 'plugin'（dsh-llm 内部同款合法 kind，AgentTeams 等消费方
    // 读 source.kind 不崩）。
  // 派发策略（2026-09-20 用户要求「及时插话」）：目标会话正在跑这一轮时用 steer 打断插入，
  // 空闲时才 followup 排队——否则通知会排在长轮次后面，用户/AI 都不能及时知道。
  // 派发策略（2026-09-20 用户要求「及时插话」，与 safetrade-prl-watch 保持同一实现）：
  // 目标会话正在跑这一轮 → steer（插入下一步，立即打断）；空闲 → followup（排到下一轮）。
  // 分支顺序照搬 prl-watch（生产验证过的写法）：running+steer → steer；只有 steer 没有 followup → steer；否则 followup。
  const deliver = (agent, msg, label) => {
    try {
      if (agent.status === 'running' && typeof agent.steer === 'function') {
        agent.steer(msg)
      } else if (typeof agent.steer === 'function' && typeof agent.followup !== 'function') {
        agent.steer(msg)
      } else {
        agent.followup(msg)
      }
      console.log('[gh-watch] dispatched ' + label + '（' + (agent.status === 'running' ? 'steer 插话' : 'followup 排队') + '）')
      // 2026-09-22：记入 pending —— 等 AI 调 gh_watch_ack 确认；超时未确认会在后续轮询里重推
      state.pending = state.pending || {}
      state.pending[nid] = { at: Date.now(), retries: 0, sessionId: ownerSessionId, label, text: msg }
      persist()
    } catch (e) {
      console.error('[gh-watch] deliver(' + label + ') 失败:', e && e.message)
    }
  }

  // 统一的 agent 组合（2026-09-21 修：resume 路径缺 setup → 会话无模型 → persona 的 {{model}} 渲染失败）
  // 抄 dsh-webhook 的 installInitialModelSelection 与 dsh-wechat 的 agentSetup（两者都注册在 agent-scoped ctx）：
  //   ①挂 agent preset（工具与提示词段）②把模型选择灌进 system-prompt 组装变量（{{model}} 读这里）
  //   ③兜住 agent/request 的 provider/model 路由。
  // 选择优先级与 GUI/微信一致：会话自身最新 request header 优先，否则部署默认（agentDefaultModel.currentSelection()）。
  const buildAgentSetup = (presetId) => async (agentCtx, agent) => {
    const ctxAny = agentCtx || {}
    const live = agent || (ctxAny.agent || undefined)
    const presets = ctxAny.get && ctxAny.get('agentPresets')
    if (presets) {
      const want = presetId || (live && live.session && live.session.header && live.session.header.agentPreset)
      try { await presets.mount(ctxAny, want) } catch (e) { console.error('[gh-watch] preset mount:', e && e.message) }
    }
    const logged = live && live.session && typeof live.session.requestHeader === 'function'
      ? (live.session.requestHeader() || {}).config : undefined
    const fallback = ctxAny.get ? ctxAny.get('agentDefaultModel') : undefined
    const def = fallback && typeof fallback.currentSelection === 'function' ? fallback.currentSelection() : undefined
    const sel = (logged && logged.provider && logged.model)
      ? { provider: logged.provider, model: logged.model }
      : (def && def.provider && def.model ? { provider: def.provider, model: def.model } : null)
    if (!sel) { console.error('[gh-watch] 无可用模型选择：{{model}} 变量可能无法渲染'); return }
    if (typeof ctxAny.on !== 'function') return
    ctxAny.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return { ...assembled, variables: { ...(assembled && assembled.variables), provider: sel.provider, model: sel.model } }
    })
    ctxAny.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      if (resolved && resolved.provider && resolved.model) return resolved
      return { ...resolved, provider: sel.provider, model: sel.model }
    })
  }

  // 默认模型选择：DSH 的 agentOptions 契约（provider/model 必填，见 @deepseek-ai/dsh-agent-loop
  // 的 "has no provider/model" 断言）。webhook 路径由 dsh-webhook 用 agentDefaultModel 注入；
  // 插件自建/恢复 agent 时必须自己补，否则报错且该轮直接失败。
  const defaultAgentOptions = (c) => {
    try {
      const sel = c.get('agentDefaultModel')?.currentSelection?.()
      return sel && sel.provider && sel.model
        ? { agentOptions: { provider: sel.provider, model: sel.model } }
        : {}
    } catch { return {} }
  }

  const message = createUserMessage({
      content,
      source: { kind: 'plugin', plugin: 'gh-watch' },
    })
    const useNew = w.pushTarget === 'new'
    try {
      if (useNew) {
        const newId = randomUUID()
        const presets = ctx.get('agentPresets')
        let agentPreset
        if (presets) {
          try {
            const resolved = await presets.resolve(w.newPreset || DEFAULTS.newPreset)
            agentPreset = resolved.id
          } catch (e) {
            console.error('[gh-watch] preset resolve:', e.message)
          }
        }
        const setup = buildAgentSetup(agentPreset)
        const handle = await agents.create({
          sessionId: newId,
          meta: { cwd: process.cwd(), agentPreset },
          // DSH 要求 agent 必须有 provider/model（否则 agent-loop 抛 "has no provider/model"）。
          // 官方 webhook 路径就是用 agentDefaultModel.currentSelection() 注入；插件自建 agent
          // 必须自己补，否则新对话/恢复的会话第一次跑就失败。
          ...defaultAgentOptions(ctx),
          setup,
        })
        deliver(handle.agent, message, `new session ${newId}`)
      } else {
        let agent = agents.get(ownerSessionId)
        if (!agent) {
          // 会话未加载时 resume 同样要带 provider/model（DSH 重启后所有 watcher 都会走这支）
          const h = await agents.resume({ resumeSessionId: ownerSessionId, ...defaultAgentOptions(ctx), setup: buildAgentSetup() })
          agent = h.agent
        }
        deliver(agent, message, `session ${ownerSessionId}`)
      }
    } catch (e) {
      console.error(`[gh-watch] dispatch -> ${ownerSessionId} (${useNew ? 'new' : 'current'}):`, e.message)
      await logUndelivered(text)
    }
  }

  // ---------- polling ----------
  // 2026-09-22：超时未确认的通知再次提醒（用户需求：一次来太多条时 AI 可能漏处理）
  async function checkAckTimeouts() {
    const pending = state.pending || {}
    const ids = Object.keys(pending)
    if (!ids.length) return
    let changed = false
    for (const nid of ids) {
      const p = pending[nid]
      if (!p || !p.at) { delete pending[nid]; changed = true; continue }
      const w = state.watchers && state.watchers[p.sessionId]
      const timeoutMs = Number((w && w.ackTimeoutMin) || DEFAULTS.ackTimeoutMin) * 60000
      const maxRetries = Number(w && w.ackMaxRetries != null ? w.ackMaxRetries : DEFAULTS.ackMaxRetries)
      if (Date.now() - p.at < timeoutMs) continue
      if ((p.retries || 0) >= maxRetries) {
        console.log('[gh-watch] ack 超时且已达重推上限，放弃：' + nid)
        delete pending[nid]; changed = true; continue
      }
      try {
        const agent = await agents.resume(p.sessionId)
        if (agent) {
          const msg = '【再次提醒 · 第 ' + ((p.retries || 0) + 1) + ' 次】上一条通知（id ' + nid + '）还没有收到确认。' + String.fromCharCode(10, 10) + p.text
          await deliver(agent, msg, 'ack-retry ' + nid)
          p.retries = (p.retries || 0) + 1
          p.at = Date.now()
          changed = true
          console.log('[gh-watch] ack 超时，已重推（第 ' + p.retries + ' 次）：' + nid)
        }
      } catch (e) {
        console.error('[gh-watch] ack 重推失败 ' + nid + ':', e && e.message)
      }
    }
    if (changed) persist()
  }

  async function pollWatcher(sessionId, w) {
    await checkAckTimeouts()   // 2026-09-22：先处理超时未确认的通知
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
        if (!firstPoll && !prev) {
          const ageH = (Date.now() - Date.parse(p.updated_at || 0)) / 3.6e6
          if (ageH > 24) {
            await logDiag(`PR#${p.number} 判为新建但 updated=${p.updated_at}（距今 ${ageH.toFixed(1)}h，疑似基线回退）| cursor keys=${Object.keys(cur).length}`)
          }
        }
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
        if (!firstPoll && !prev) {
          // 回放指纹（2026-09-14）：prev 缺失说明该键此前不在 cursor 里。新建的 PR/issue 属正常，
          // 但「更新时间已过去很久」却判为新建 = 基线曾被回退的信号 → 留痕便于事后定位。
          const ageH = (Date.now() - Date.parse(i.updated_at || 0)) / 3.6e6
          if (ageH > 24) {
            await logDiag(`issue#${i.number} 判为新建但 updated=${i.updated_at}（距今 ${ageH.toFixed(1)}h，疑似基线回退）| cursor keys=${Object.keys(cur).length}`)
          }
        }
        if (!firstPoll && JSON.stringify(prev) !== JSON.stringify(now)) {
          changes.push({ kind: 'issue', repo, item: i, type: classify(prev, now, 'issue') })
        }
        cur[k] = now
      }
      // 不淘汰窗口外的 key（2026-09-09 修正）：原『仅保留本轮 50 窗口 key』的淘汰逻辑在
      // 条目数接近 per_page=50 边界时会造成 key 反复进出窗口——每次重新进入都因 prev=undefined
      // 被 classify 判为『新建』，对已关闭的历史 issue/PR 反复推送通知（实测 #162/#167 等重复
      // 回放数轮）。cursor 体积以仓库条目数为上限（本仓库 ~100 条，可忽略），故保留全部 key，
      // 彻底消除该类抖动。seenKeys 仍保留用于调试。
      void seenKeys;
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
              const pend = Object.keys(state.pending || {}).length
      const pendLine = pend ? ('\n待确认通知: ' + pend + ' 条（超时未确认会自动重推）') : ''
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

  const toolAck = defineTool({
    name: 'gh_watch_ack',
    description: '确认某条 gh-watch 注入的通知已被处理（处理完立即调用；未确认的会在超时后被再次提醒）。',
    parameters: {
      id: { type: 'string', required: true, description: '通知里的「本条 id」（形如 gw-xxxxx-1）。' },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: value.message }] },
    },
    async execute(args) {
      await ensureLoaded()
      const id = String(args.id || '').trim()
      state.pending = state.pending || {}
      if (!id || !state.pending[id]) return { ok: false, message: '没有待确认的记录：' + (id || '(空)') + '（可能已确认过）。' }
      const p = state.pending[id]
      delete state.pending[id]
      persist()
      return { ok: true, message: '已确认：' + id + '（' + (p.label || '') + '）' }
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
