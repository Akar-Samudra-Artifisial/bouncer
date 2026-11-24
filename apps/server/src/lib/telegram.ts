import type { AlertSeverity, TelegramTarget } from '@bouncer/shared'
import type { NormalizedAlert } from './ingest'
import { truncate } from './ingest'
import { type Json, num, obj, str } from './payload'

// Telegram Bot API `Update` → alert. Fields used (https://core.telegram.org/bots/api#update):
// update_id; message | edited_message → Message {message_id, from?: User, sender_chat?: Chat,
// chat: Chat {id, title?, username?}, text?, entities?, caption?, caption_entities?, reply_to_message?}.
// MessageEntity {type: 'url' | 'text_link' | 'bot_command' | …}.

/** Max characters of message text kept anywhere (alert summary). */
export const TEXT_MAX = 500
const TITLE_MAX = 140

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Chat ids (as strings) the bot moderates: `TELEGRAM_ALLOWED_CHATS`. Updates from other chats are ignored. */
export function allowedChats(): Set<string> {
  return new Set(csv('TELEGRAM_ALLOWED_CHATS'))
}

/** Lower-cased auto-flag keywords from `FLAG_KEYWORDS`. */
function flagKeywords(): string[] {
  return csv('FLAG_KEYWORDS').map((k) => k.toLowerCase())
}

/** `/report` or `/report@SomeBot` as the first word. */
const REPORT_COMMAND = /^\/report(@[A-Za-z0-9_]+)?(\s|$)/i

export type TelegramNormalized =
  | { ok: true; deliveryId: string; alert: NormalizedAlert; payload: Json }
  | { ok: false; reason: string }

interface Flagged {
  kind: 'telegram.report' | 'telegram.keyword' | 'telegram.link'
  severity: AlertSeverity
  reasons: string[]
}

function messageText(m: Json): string {
  return str(m.text) ?? str(m.caption) ?? ''
}

function hasLink(m: Json): boolean {
  const entities = [m.entities, m.caption_entities].flatMap((e) => (Array.isArray(e) ? e : []))
  return entities.some((e) => {
    const type = str(obj(e).type)
    return type === 'url' || type === 'text_link'
  })
}

function matchedKeyword(text: string): string | null {
  const lower = text.toLowerCase()
  return flagKeywords().find((k) => lower.includes(k)) ?? null
}

function displayName(user: Json): string | null {
  const username = str(user.username)
  if (username) return `@${username}`
  return str(user.first_name) ?? null
}

/** `t.me` link to the message: public groups by username, private supergroups via `/c/<id>`. */
function messageUrl(chat: Json, chatId: number, messageId: number): string | null {
  const username = str(chat.username)
  if (username) return `https://t.me/${username}/${messageId}`
  const id = String(chatId)
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${messageId}` : null
}

function autoFlag(m: Json): Flagged | null {
  const keyword = matchedKeyword(messageText(m))
  const link = hasLink(m)
  const reasons = [...(keyword ? [`keyword "${keyword}"`] : []), ...(link ? ['link'] : [])]
  if (keyword) return { kind: 'telegram.keyword', severity: 'high', reasons }
  if (link) return { kind: 'telegram.link', severity: 'medium', reasons }
  return null
}

/**
 * Normalize one Update. Flags (a) a `/report` reply → the replied-to message, (b) a message
 * with a link entity or a `FLAG_KEYWORDS` match. Only chats in `TELEGRAM_ALLOWED_CHATS`.
 * The stored payload is a minimal summary, never the raw update.
 */
export function normalizeTelegram(update: Json): TelegramNormalized {
  const updateId = num(update.update_id)
  if (updateId === null || !Number.isSafeInteger(updateId)) return { ok: false, reason: 'missing update_id' }

  const incoming = update.message ?? update.edited_message
  if (incoming === undefined) return { ok: false, reason: 'unsupported update type' }
  const msg = obj(incoming)
  const chat = obj(msg.chat)
  const chatId = num(chat.id)
  if (chatId === null) return { ok: false, reason: 'message without chat' }
  if (!allowedChats().has(String(chatId))) return { ok: false, reason: 'chat not allowed' }

  let target = msg
  let flag: Flagged | null
  let reporter: Json | null = null
  if (REPORT_COMMAND.test(str(msg.text) ?? '')) {
    if (msg.reply_to_message === undefined) return { ok: false, reason: 'report without reply' }
    target = obj(msg.reply_to_message)
    reporter = obj(msg.from)
    const extra = autoFlag(target)?.reasons ?? []
    flag = { kind: 'telegram.report', severity: 'high', reasons: [`reported by ${displayName(reporter) ?? 'member'}`, ...extra] }
  } else {
    flag = autoFlag(msg)
  }
  if (!flag) return { ok: false, reason: 'not flagged' }

  const messageId = num(target.message_id)
  if (messageId === null) return { ok: false, reason: 'flagged message without message_id' }
  const author = target.from !== undefined ? obj(target.from) : obj(target.sender_chat)
  const userId = num(author.id)
  if (userId === null) return { ok: false, reason: 'flagged message without author' }

  const username = str(author.username) ?? undefined
  const chatTitle = str(chat.title) ?? undefined
  const who = displayName(author) ?? str(author.title) ?? `user ${userId}`
  const text = messageText(target) || '(no text)'

  const telegramTarget: TelegramTarget = {
    chatId,
    messageId,
    userId,
    ...(username ? { username } : {}),
    ...(chatTitle ? { chatTitle } : {}),
  }

  return {
    ok: true,
    deliveryId: String(updateId),
    alert: {
      kind: flag.kind,
      severity: flag.severity,
      title: truncate(`${who}: ${text}`, TITLE_MAX),
      summary: truncate(`${flag.reasons.join(' · ')} — ${text}`, TEXT_MAX),
      scope: chatTitle ?? String(chatId),
      url: messageUrl(chat, chatId, messageId),
      dedupKey: `msg:${chatId}:${messageId}`,
      target: telegramTarget,
    },
    payload: {
      updateId,
      chatId,
      messageId,
      userId,
      reasons: flag.reasons,
      textLength: text.length,
      ...(reporter ? { reporterId: num(reporter.id) } : {}),
    },
  }
}
