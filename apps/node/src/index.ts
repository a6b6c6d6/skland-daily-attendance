import assert from 'node:assert'
import process from 'node:process'
import { doAttendanceForAccount, createCombinePushMessage } from './attendance'

try {
  process.loadEnvFile('.env')
} catch {
  // ignore, dotenv 基本只适用于本地开发
}

assert(typeof process.env.SKLAND_TOKEN === 'string', 'SKLAND_TOKEN 未设置')

const accounts = process.env.SKLAND_TOKEN.split(',')

// 创建共享的消息收集器，所有账号共用，最终只推送一次
const options = {
  withServerChan: process.env.SERVER_CHAN_TOKEN,
  withBark: process.env.BARK_URL,
  withMessagePusher: process.env.MESSAGE_PUSHER_URL,
}
const collector = createCombinePushMessage(options)

for (const [index, token] of accounts.entries()) {
  console.log(`开始处理第 ${index + 1}/${accounts.length} 个账号`)
  await doAttendanceForAccount(token, {
    withServerChan: process.env.SERVER_CHAN_TOKEN,
    withBark: process.env.BARK_URL,
    withMessagePusher: process.env.MESSAGE_PUSHER_URL,
  }, accounts.length > 1 ? `账号 ${index + 1}` : '', collector)
}

// 所有账号处理完毕，只推送一次
await collector.push()
