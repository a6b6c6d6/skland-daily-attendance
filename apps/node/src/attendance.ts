import process from 'node:process'
import crypto from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { attendance, auth, getBinding, signIn } from '@skland-x/core'
import { bark, messagePusher, serverChan } from '@skland-x/notification'

interface Options {
  /** Server 酱 SendKey */
  withServerChan?: false | string
  /** Bark URL */
  withBark?: false | string
  /** MessagePusher Webhook URL */
  withMessagePusher?: false | string
}

/* ---------- 消息推送 ---------- */

interface CharacterResult {
  name: string
  status: 'success' | 'already' | 'fail'
  awards?: string
  error?: string
}

interface AccountStats {
  label: string
  characters: CharacterResult[]
  successCount: number
}

export interface MessageCollector {
  /** 记录一条消息到日志和控制台（error=true 会 console.error 并标记失败） */
  logger: (msg: string, error?: boolean) => void
  /** 把收集到的所有消息推送到所有已配置的渠道 */
  push: () => Promise<void>
  /** 仅追加消息，不打印日志 */
  add: (msg: string) => void
  /** 追加账号签到统计 */
  addAccountStats: (stats: AccountStats) => void
}

/** 钉钉推送（支持加签，Markdown 格式） */
async function dingtalk(
  webhook: string,
  secret: string | undefined,
  title: string,
  content: string,
) {
  let url = webhook
  if (secret) {
    const timestamp = Date.now()
    const sign = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`)
      .digest('base64')
    url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
  }
  const body = {
    msgtype: 'markdown',
    markdown: { title, text: content },
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 构建钉钉 Markdown 消息 */
function buildDingTalkMessage(title: string, accounts: AccountStats[]): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  const weekDay = weekDays[now.getDay()]
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`

  const lines: string[] = [
    `### 🎮 ${title}`,
    '',
    `> 📅 ${dateStr} 星期${weekDay}　　🕐 ${timeStr}`,
    '',
    '---',
  ]

  let totalSuccess = 0
  let totalFail = 0

  for (const account of accounts) {
    lines.push('', `**${account.label || '账号'}**`)
    for (const ch of account.characters) {
      if (ch.status === 'success') {
        lines.push(`- ✅ **${ch.name}** — 签到成功`)
        if (ch.awards) lines.push(`  - 🎁 获得：${ch.awards}`)
        totalSuccess++
      } else if (ch.status === 'already') {
        lines.push(`- ✅ **${ch.name}** — 今日已签到`)
        totalSuccess++
      } else {
        lines.push(`- ❌ **${ch.name}** — ${ch.error || '签到失败'}`)
        totalFail++
      }
    }
  }

  lines.push('', '---', '')
  lines.push(`**📊 签到统计**　　✅ ${totalSuccess} 成功　　${totalFail > 0 ? `❌ ${totalFail} 失败` : ''}`)

  return lines.join('\n\n')
}

/** 统一日志 + 推送封装 */
export function createCombinePushMessage(options: Options): MessageCollector {
  const messages: string[] = []
  const accounts: AccountStats[] = []
  let hasError = false

  const logger = (msg: string, error = false) => {
    messages.push(msg)
    console[error ? 'error' : 'log'](msg)
    if (error) hasError = true
  }

  const addAccountStats = (stats: AccountStats) => {
    accounts.push(stats)
  }

  const push = async () => {
    const title = '森空岛每日签到'
    const content = messages.join('\n\n')

    if (options.withServerChan) await serverChan(options.withServerChan, title, content)
    if (options.withBark) await bark(options.withBark, title, content)
    if (options.withMessagePusher) await messagePusher(options.withMessagePusher, title, content)

    // 钉钉（从环境变量读取，使用格式化模板）
    const dingWebhook = process.env.DINGTALK_WEBHOOK
    const dingSecret  = process.env.DINGTALK_SECRET
    if (dingWebhook) {
      const dingContent = buildDingTalkMessage(title, accounts)
      await dingtalk(dingWebhook, dingSecret, title, dingContent)
    }

    if (hasError) process.exit(1)
  }

  const add = (msg: string) => messages.push(msg)
  return { logger, push, add, addAccountStats }
}

/** 角色显示名 */
function chrName(character: { channelMasterId: number; uid: number }) {
  return `${character.channelMasterId !== 1 ? 'B服' : '官服'} ${character.uid}`
}

/** 针对一个 token 执行签到 */
export async function doAttendanceForAccount(
  token: string,
  options: Options,
  accountLabel = '',
  collector?: MessageCollector,
) {
  const { code } = await auth(token)
  const { cred, token: signToken } = await signIn(code)
  const { list } = await getBinding(cred, signToken)

  // 如果传入了外部 collector，复用它的消息队列；否则自建一个（独立推送）
  const c = collector ?? createCombinePushMessage(options)
  const { logger: combineMessage, push: executePush, add: addMessage, addAccountStats } = c

  const accountHeader = accountLabel ? `**${accountLabel}**` : ''
  addMessage(`---\n\n### ${accountHeader}明日方舟签到`)

  const characterList = list
    .filter(i => i.appCode === 'arknights')
    .flatMap(i => i.bindingList)

  const maxRetries = Number.parseInt(process.env.MAX_RETRIES || '3', 10)
  let successAttendance = 0
  const characters: CharacterResult[] = []

  await Promise.all(
    characterList.map(async (character) => {
      let retries = 0
      while (retries < maxRetries) {
        try {
          const data = await attendance(cred, signToken, {
            uid: character.uid,
            gameId: character.channelMasterId,
          })

          if (!data) {
            addMessage(`- ✅ **${chrName(character)}** — 今日已签到`)
            characters.push({ name: chrName(character), status: 'already' })
            break
          }

          if (data.code === 0 && data.message === 'OK') {
            const awards = data.data.awards
              .map(a => `「${a.resource.name}」×${a.count}`)
              .join('、')
            combineMessage(
              `- ✅ **${chrName(character)}** — 签到成功`,
            )
            addMessage(`  - 获得：${awards}`)
            characters.push({ name: chrName(character), status: 'success', awards })
            successAttendance++
            break
          }

          combineMessage(
            `- ❌ **${chrName(character)}** — 签到失败：${data.message}`,
            true,
          )
          characters.push({ name: chrName(character), status: 'fail', error: data.message })
          retries++
        } catch (err: any) {
          if (err?.response?.status === 403) {
            addMessage(`- ✅ **${chrName(character)}** — 今日已签到`)
            characters.push({ name: chrName(character), status: 'already' })
            break
          }
          combineMessage(
            `- ❌ **${chrName(character)}** — 异常：${err.message}`,
            true,
          )
          characters.push({ name: chrName(character), status: 'fail', error: err.message })
          retries++
          if (retries >= maxRetries) process.exit(1)
        }
        await setTimeout(3000)
      }
    }),
  )

  if (successAttendance) addMessage(`---\n\n📊 **共成功签到 ${successAttendance} 个角色**`)

  // 收集统计信息供钉钉使用
  addAccountStats({
    label: accountLabel || '账号',
    characters,
    successCount: successAttendance,
  })

  // 没有外部 collector 时才自己推（单体模式）
  if (!collector) await executePush()
}