import { lookupMember } from './actions'
import { audit } from './audit'
import { approvePairing } from './pairing'
import { type Json, num, obj, str } from './payload'
import { allowedChats } from './telegram'

// Pair glasses from a private chat with the bot: `/pair ABC234` (or `/pair@SomeBot ABC234`).
// The sender must be creator/administrator of at least one chat in TELEGRAM_ALLOWED_CHATS
// (getChatMember). The reply is returned as the webhook response body
// (https://core.telegram.org/bots/api#making-requests-when-getting-updates), so the bot token
// is not needed for it and Telegram executes the sendMessage itself.

const PAIR_COMMAND = /^\/pair(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/is

export interface PairCommand {
  updateId: number
  chatId: number
  userId: number
  username: string | null
  code: string
}

/** A `/pair` command sent in a private chat with the bot; null for anything else. */
export function parsePairCommand(update: Json): PairCommand | null {
  const updateId = num(update.update_id)
  const m = obj(update.message)
  const chat = obj(m.chat)
  const from = obj(m.from)
  const chatId = num(chat.id)
  const userId = num(from.id)
  const text = str(m.text)
  if (updateId === null || chatId === null || userId === null || text === null) return null
  if (str(chat.type) !== 'private' || from.is_bot === true) return null
  const match = PAIR_COMMAND.exec(text.trim())
  if (!match) return null
  return { updateId, chatId, userId, username: str(from.username), code: (match[1] ?? '').trim().slice(0, 20) }
}

/** Webhook answer that makes Telegram send `text` to the private chat. */
export interface TelegramReply {
  method: 'sendMessage'
  chat_id: number
  text: string
}

function reply(chatId: number, text: string): TelegramReply {
  return { method: 'sendMessage', chat_id: chatId, text }
}

type AdminCheck = { ok: true; chatId: string } | { ok: false; reason: 'not_admin' | 'telegram_error' }

/** First allowlisted chat where the user is creator/administrator. Fails closed. */
async function findAdminChat(userId: number): Promise<AdminCheck> {
  let sawError = false
  for (const chat of allowedChats()) {
    const chatId = Number(chat)
    if (!Number.isSafeInteger(chatId)) continue
    const member = await lookupMember(chatId, userId)
    if (!member.ok) {
      sawError = true
      continue
    }
    if (member.status === 'creator' || member.status === 'administrator') return { ok: true, chatId: chat }
  }
  return { ok: false, reason: sawError ? 'telegram_error' : 'not_admin' }
}

export async function handlePairCommand(cmd: PairCommand): Promise<TelegramReply> {
  const actor = `telegram:${cmd.userId}`
  if (!cmd.code) return reply(cmd.chatId, 'Send /pair followed by the 6-character code shown on your glasses.')

  // Admin check first so non-admins learn nothing about codes.
  const admin = await findAdminChat(cmd.userId)
  if (!admin.ok) {
    await audit({ event: 'pair.telegram_denied', actor, detail: { tgUserId: cmd.userId, reason: admin.reason } })
    return reply(
      cmd.chatId,
      admin.reason === 'telegram_error'
        ? 'Could not check your admin status with Telegram. Try again in a minute.'
        : 'Only admins of a group moderated by this bot can pair glasses.',
    )
  }

  const name = cmd.username ? `G2 of @${cmd.username}` : `G2 of tg ${cmd.userId}`
  const result = await approvePairing(cmd.code, name, { actor, tgUserId: cmd.userId })
  if (!result.ok) {
    await audit({ event: 'pair.telegram_failed', actor, detail: { tgUserId: cmd.userId, reason: result.message } })
    return reply(cmd.chatId, `Pairing failed: ${result.message}.`)
  }
  return reply(cmd.chatId, `Paired “${name}”. Your glasses will pick up the token in a few seconds.`)
}
