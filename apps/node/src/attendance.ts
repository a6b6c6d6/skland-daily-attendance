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
function createCombinePushMessage(options: Options) {
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
  return [logger, push, add] as const
}

/** 针对一个 token 执行签到 */
export async function doAttendanceForAccount(token: string, options: Options) {
  const { code } = await auth(token)
  const { cred, token: signToken } = await signIn(code)
  const { list } = await getBinding(cred, signToken)

  const [combineMessage, executePush, addMessage] = createCombinePushMessage(options)

  addMessage('## 明日方舟签到')

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
            addMessage(`${character.channelMasterId !== 1 ? 'B服' : '官服'}角色 ${character.uid} 今天已签到`)
            break
          }

          if (data.code === 0 && data.message === 'OK') {
            const awards = data.data.awards
              .map(a => `「${a.resource.name}」${a.count}个`)
              .join(', ')
            combineMessage(
              `${character.channelMasterId !== 1 ? 'B服' : '官服'}角色 ${character.uid} 签到成功，获得 ${awards}`,
            )
            successAttendance++
            break
          }

          combineMessage(
            `${character.channelMasterId !== 1 ? 'B服' : '官服'}角色 ${character.uid} 签到失败：${data.message}`,
            true,
          )
          retries++
        } catch (err: any) {
          if (err?.response?.status === 403) {
            addMessage(`${character.channelMasterId !== 1 ? 'B服' : '官服'}角色 ${character.uid} 今天已签到`)
            break
          }
          combineMessage(
            `${character.channelMasterId !== 1 ? 'B服' : '官服'}角色 ${character.uid} 未知错误：${err.message}`,
            true,
          )
          retries++
          if (retries >= maxRetries) process.exit(1)
        }
        await setTimeout(3000)
      }
    }),
  )

  if (successAttendance) combineMessage(`共成功签到 ${successAttendance} 个角色`)
  await executePush()
}
