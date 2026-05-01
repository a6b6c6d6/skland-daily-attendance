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

export interface MessageCollector {
  /** 记录一条消息到日志和控制台（error=true 会 console.error 并标记失败） */
  logger: (msg: string, error?: boolean) => void
  /** 把收集到的所有消息推送到所有已配置的渠道 */
  push: () => Promise<void>
  /** 仅追加消息，不打印日志 */
  add: (msg: string) => void
}

/** 钉钉推送（支持加签） */
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
  const body = { msgtype: 'text', text: { content: `${title}\n${content}` } }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 统一日志 + 推送封装 */
export function createCombinePushMessage(options: Options): MessageCollector {
  const messages: string[] = []
  let hasError = false

  const logger = (msg: string, error = false) => {
    messages.push(msg)
    console[error ? 'error' : 'log'](msg)
    if (error) hasError = true
  }

  const push = async () => {
    const title = '【森空岛每日签到】'
    const content = messages.join('\n\n')

    if (options.withServerChan) await serverChan(options.withServerChan, title, content)
    if (options.withBark) await bark(options.withBark, title, content)
    if (options.withMessagePusher) await messagePusher(options.withMessagePusher, title, content)

    // 钉钉（从环境变量读取）
    const dingWebhook = process.env.DINGTALK_WEBHOOK
    const dingSecret  = process.env.DINGTALK_SECRET
    if (dingWebhook) await dingtalk(dingWebhook, dingSecret, title, content)

    if (hasError) process.exit(1)
  }

  const add = (msg: string) => messages.push(msg)
  return { logger, push, add }
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
  const { logger: combineMessage, push: executePush, add: addMessage } = c

  const accountHeader = accountLabel ? `【${accountLabel}】` : ''
  addMessage(`━━━ ${accountHeader}明日方舟签到 ━━━`)

  const characterList = list
    .filter(i => i.appCode === 'arknights')
    .flatMap(i => i.bindingList)

  const maxRetries = Number.parseInt(process.env.MAX_RETRIES || '3', 10)
  let successAttendance = 0

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
            addMessage(`  ✓ ${chrName(character)} — 今日已签到`)
            break
          }

          if (data.code === 0 && data.message === 'OK') {
            const awards = data.data.awards
              .map(a => `「${a.resource.name}」×${a.count}`)
              .join('、')
            combineMessage(
              `  ✓ ${chrName(character)} — 签到成功，获得 ${awards}`,
            )
            successAttendance++
            break
          }

          combineMessage(
            `  ✗ ${chrName(character)} — 签到失败：${data.message}`,
            true,
          )
          retries++
        } catch (err: any) {
          if (err?.response?.status === 403) {
            addMessage(`  ✓ ${chrName(character)} — 今日已签到`)
            break
          }
          combineMessage(
            `  ✗ ${chrName(character)} — 异常：${err.message}`,
            true,
          )
          retries++
          if (retries >= maxRetries) process.exit(1)
        }
        await setTimeout(3000)
      }
    }),
  )

  if (successAttendance) addMessage(`━━━ 共成功签到 ${successAttendance} 个角色 ━━━`)

  // 没有外部 collector 时才自己推（单体模式）
  if (!collector) await executePush()
}
