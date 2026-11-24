// Send fake Telegram Bot API updates (with the webhook secret header) to a local Bouncer server.
//   pnpm seed              → seed demo alerts (fresh update/message ids each run)
//   pnpm seed --selftest   → also assert secret, allowlist, flag rules, dedup, truncation,
//                            plus pairing + dry-run actions (needs ADMIN_SECRET and ACTIONS_DRY_RUN=1 on the server)
// Server env needed: TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_CHATS (first id is used here), FLAG_KEYWORDS (must include "airdrop").
// Action selftest also needs: ACTIONS_DRY_RUN=1, DRY_RUN_ADMIN_IDS=70099, ACTION_NONCE_TTL_SECONDS ≤ 15,
// a dummy TELEGRAM_BOT_TOKEN (checked for leaks) and DATABASE_URL (local DB, for the foreign-chat alert).
// AI label + voice selftests also need SUMMARY_AI_MOCK=1 and VOICE_STT_MOCK=1 (dev only).

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const SERVER = process.env.SERVER_URL ?? 'http://localhost:3300'
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const CHAT_ID = Number((process.env.TELEGRAM_ALLOWED_CHATS ?? '').split(',')[0]?.trim())
const selftest = process.argv.includes('--selftest')
// Unique fake client IP per run (honoured by the dev server only) so per-IP limits never carry over.
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`
const RUN_IP = randomIp()

if (!SECRET || !Number.isSafeInteger(CHAT_ID)) {
  console.error('TELEGRAM_WEBHOOK_SECRET and TELEGRAM_ALLOWED_CHATS must be set (apps/server/.env.local)')
  process.exit(1)
}

// Fresh ids per run so repeated seeds create new alerts (dedup is per update_id and per message).
let nextUpdate = Date.now() * 100
let nextMessage = Date.now() % 1_000_000_000
const updateId = () => nextUpdate++
const messageId = () => nextMessage++

const CHAT = { id: CHAT_ID, type: 'supergroup', title: 'Bouncer Demo Group' }
const OTHER_CHAT = { id: -1009999999999, type: 'supergroup', title: 'Not allowed' }
const users = {
  spammer: { id: 70001, is_bot: false, first_name: 'Cheap', username: 'cheap_followers' },
  troll: { id: 70002, is_bot: false, first_name: 'Shouty', username: 'shouty_guy' },
  anon: { id: 70003, is_bot: false, first_name: 'Budi' },
  mod: { id: 70010, is_bot: false, first_name: 'Rina', username: 'rina_mod' },
  // Group admin in the dry-run selftest: the server needs DRY_RUN_ADMIN_IDS=70099.
  owner: { id: 70099, is_bot: false, first_name: 'Owner', username: 'group_owner' },
}

function message(from, text, { chat = CHAT, entities, reply } = {}) {
  return {
    message_id: messageId(),
    from,
    chat,
    date: Math.floor(Date.now() / 1000),
    text,
    ...(entities ? { entities } : {}),
    ...(reply ? { reply_to_message: reply } : {}),
  }
}

function linkMessage(from, text = 'Grow your channel fast https://example.com/promo 10k followers') {
  const at = text.indexOf('https://')
  return message(from, text, { entities: [{ type: 'url', offset: at, length: text.slice(at).split(' ')[0].length }] })
}

function reportOf(target, command = '/report') {
  return message(users.mod, command, { entities: [{ type: 'bot_command', offset: 0, length: command.length }], reply: target })
}

async function send(update, { secret = SECRET, rawBody } = {}) {
  const res = await fetch(`${SERVER}/api/webhooks/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: rawBody ?? JSON.stringify(update),
  })
  const text = await res.text()
  let body = text.slice(0, 200)
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body }
}

let failed = false
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`)
  if (!ok) failed = true
}

// ---- seed ----------------------------------------------------------------------
const linkMsg = linkMessage(users.spammer)
const trollMsg = message(users.troll, 'you are all idiots, leave this group')
const keywordMsg = message(users.anon, 'DM me for crypto AIRDROP, guaranteed 10x')

const link = await send({ update_id: updateId(), message: linkMsg })
check('link message → 201 created', link.status === 201 && link.body.status === 'created', link)
const reportUpdate = { update_id: updateId(), message: reportOf(trollMsg) }
const report = await send(reportUpdate)
check('/report reply → 201 created', report.status === 201 && report.body.status === 'created', report)
const keyword = await send({ update_id: updateId(), message: keywordMsg })
check('keyword message → 201 created', keyword.status === 201 && keyword.body.status === 'created', keyword)

if (selftest) await telegramSelftest()

async function telegramSelftest() {
  const wrong = await send({ update_id: updateId(), message: linkMessage(users.spammer) }, { secret: 'wrong-secret' })
  check('wrong secret token → 401', wrong.status === 401, wrong)
  const missing = await send({ update_id: updateId(), message: linkMessage(users.spammer) }, { secret: null })
  check('missing secret token → 401', missing.status === 401, missing)

  const other = await send({ update_id: updateId(), message: { ...linkMessage(users.spammer), chat: OTHER_CHAT } })
  check('chat outside TELEGRAM_ALLOWED_CHATS → 200 ignored', other.status === 200 && other.body.ignored === true, other)
  const plain = await send({ update_id: updateId(), message: message(users.anon, 'see you at the trailhead at 7') })
  check('plain message → 200 ignored (not flagged)', plain.status === 200 && plain.body.ignored === true, plain)
  const lonelyReport = await send({ update_id: updateId(), message: message(users.mod, '/report') })
  check('/report without reply → 200 ignored', lonelyReport.status === 200 && lonelyReport.body.ignored === true, lonelyReport)
  const callback = await send({ update_id: updateId(), callback_query: { id: '1' } })
  check('unsupported update type → 200 ignored', callback.status === 200 && callback.body.ignored === true, callback)

  const redelivery = await send(reportUpdate)
  check('same update_id redelivered → duplicate, no new row', redelivery.status === 200 && redelivery.body.status === 'duplicate', redelivery)
  const reportOnLink = await send({ update_id: updateId(), message: reportOf(linkMsg, '/report@BouncerDemoBot') })
  check(
    '/report@bot on an already flagged message → duplicate (msg dedup key)',
    reportOnLink.status === 200 && reportOnLink.body.status === 'duplicate',
    reportOnLink,
  )
  const botReport = await send({ update_id: updateId(), message: reportOf(message(users.troll, 'second insult'), '/report@BouncerDemoBot') })
  check('/report@BouncerDemoBot reply → 201 created', botReport.status === 201, botReport)

  const caption = 'free airdrop here'
  const photo = await send({
    update_id: updateId(),
    message: { message_id: messageId(), from: users.spammer, chat: CHAT, date: 0, caption, photo: [] },
  })
  check('keyword in photo caption → 201 created', photo.status === 201, photo)

  const longText = `airdrop ${'x'.repeat(2000)}`
  const long = await send({ update_id: updateId(), message: message(users.spammer, longText) })
  check('2000-char message → 201 created', long.status === 201, long)

  const badJson = await send(null, { rawBody: '{not json' })
  check('invalid JSON body → 400', badJson.status === 400, badJson)
  const tooLarge = await send(null, { rawBody: JSON.stringify({ update_id: 1, pad: 'x'.repeat(1_100_000) }) })
  check('body > 1 MB → 413', tooLarge.status === 413, { status: tooLarge.status })

  await feedSelftest({ long: long.body?.id, botReport: botReport.body?.id })
}

// ---------------------------------------------------------------------------
// Alert feed + pairing + dry-run actions (run the server with ACTIONS_DRY_RUN=1).

async function api(method, path, { token, body, ip = RUN_IP, headers = {} } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      ...headers,
      'x-forwarded-for': ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text.slice(0, 200)
  }
  return { status: res.status, body: json }
}

/** Short view for logs: never print tokens/nonces/poll secrets. */
function redact(r) {
  return {
    status: r.status,
    body:
      r.body && typeof r.body === 'object'
        ? Object.fromEntries(Object.entries(r.body).map(([k, v]) => [k, /token|nonce|pollSecret/i.test(k) ? '<redacted>' : v]))
        : r.body,
  }
}

async function pairDevice(adminSecret, name) {
  const start = await api('POST', '/api/pair/start')
  if (start.status !== 201) return { start }
  const approve = await api('POST', '/api/admin/pair/approve', { token: adminSecret, body: { code: start.body.code, name } })
  const status = await api('GET', '/api/pair/status', { token: start.body.pollSecret })
  return { start, approve, status, token: status.body?.token, deviceId: status.body?.deviceId }
}

async function feedSelftest(ids) {
  const ADMIN = process.env.ADMIN_SECRET
  if (!ADMIN) {
    check('ADMIN_SECRET set for feed/action selftest', false, 'export ADMIN_SECRET (same as the server)')
    return
  }
  const paired = await pairDevice(ADMIN, 'selftest telegram')
  check('pair device (start → approve → claim)', typeof paired.token === 'string', redact(paired.status ?? paired.start))
  const token = paired.token

  const feed = await api('GET', '/api/alerts?since=0', { token })
  const rows = feed.body?.alerts ?? []
  // since=0 pages 50 at a time: fetch the latest page too so this run's rows are present.
  const latest = await api('GET', '/api/alerts', { token })
  const byId = new Map([...rows, ...(latest.body?.alerts ?? [])].map((a) => [a.id, a]))
  const linkRow = byId.get(link.body.id)
  const reportRow = byId.get(report.body.id)
  const keywordRow = byId.get(keyword.body.id)
  const longRow = byId.get(ids.long)

  check(
    'link alert: telegram.link / medium / title "@user: text" / group scope / target',
    linkRow?.source === 'telegram' &&
      linkRow.kind === 'telegram.link' &&
      linkRow.severity === 'medium' &&
      linkRow.title.startsWith('@cheap_followers: Grow your channel') &&
      linkRow.scope === CHAT.title &&
      linkRow.target?.chatId === CHAT_ID &&
      linkRow.target?.messageId === linkMsg.message_id &&
      linkRow.target?.userId === users.spammer.id,
    { kind: linkRow?.kind, severity: linkRow?.severity, title: linkRow?.title, scope: linkRow?.scope, target: linkRow?.target },
  )
  check(
    'report alert: telegram.report / high / targets the replied-to message / reporter recorded',
    reportRow?.kind === 'telegram.report' &&
      reportRow.severity === 'high' &&
      reportRow.target?.messageId === trollMsg.message_id &&
      reportRow.target?.userId === users.troll.id &&
      reportRow.title.startsWith('@shouty_guy:') &&
      reportRow.summary.includes('reported by @rina_mod'),
    { kind: reportRow?.kind, severity: reportRow?.severity, title: reportRow?.title, summary: reportRow?.summary },
  )
  check(
    'keyword alert: telegram.keyword / high / case-insensitive / no username → first name',
    keywordRow?.kind === 'telegram.keyword' && keywordRow.severity === 'high' && keywordRow.title.startsWith('Budi: '),
    { kind: keywordRow?.kind, severity: keywordRow?.severity, title: keywordRow?.title },
  )
  check(
    'long message: summary ≤ 500 chars (ellipsis), title ≤ 140',
    longRow !== undefined && longRow.summary.length <= 500 && longRow.summary.endsWith('…') && longRow.title.length <= 140,
    { summary: longRow?.summary.length, title: longRow?.title.length },
  )
  check(
    'alerts expose all four actions in an allowed chat',
    ['delete', 'mute', 'ban', 'dismiss'].every((a) => linkRow?.actions?.includes(a)),
    linkRow?.actions,
  )
  const ownRows = [link.body.id, report.body.id, keyword.body.id, ids.long].map((id) => byId.get(id))
  check('raw update payload never exposed in the feed', ownRows.every((r) => r && !('payload' in r)), {})

  await actionSelftest(token, ids)
  await aiLabelSelftest(token)
  await voiceSelftest(ADMIN)
  await telegramPairSelftest(ADMIN)

  const audit = await api('GET', '/api/audit?limit=100', { token: ADMIN })
  const events = new Set((audit.body?.entries ?? []).map((e) => e.event))
  check(
    'audit has webhook.telegram + action intent/confirm/succeeded/failed/denied events',
    ['webhook.telegram', 'action.intent', 'action.confirm', 'action.succeeded', 'action.failed', 'action.denied'].every((e) => events.has(e)),
    [...events],
  )
  const auditText = JSON.stringify(audit.body ?? '')
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  check(
    'bot token never appears in the audit log (scrubbed provider detail present)',
    Boolean(botToken) && !auditText.includes(botToken) && !/bot\d+:/.test(auditText) && auditText.includes('<redacted>'),
    { tokenSet: Boolean(botToken), redactedMarker: auditText.includes('<redacted>') },
  )

  const revoke = await api('POST', '/api/admin/devices/revoke', { token: ADMIN, body: { deviceId: paired.deviceId } })
  const revokedRead = await api('GET', '/api/alerts', { token })
  check('revoke device → reads 401', revoke.status === 200 && revokedRead.status === 401, { revoke: revoke.status, read: revokedRead.status })
}

// ---------------------------------------------------------------------------
// Pairing via bot DM `/pair CODE` (dry run: DRY_RUN_ADMIN_IDS=70099 is a group admin).

function dm(from, text) {
  return { update_id: updateId(), message: { message_id: messageId(), from, chat: { id: from.id, type: 'private', first_name: from.first_name }, date: 0, text } }
}

async function telegramPairSelftest(adminSecret) {
  const ip = randomIp()
  const start = await api('POST', '/api/pair/start', { ip })
  const code = start.body?.code ?? ''
  const pollSecret = start.body?.pollSecret

  const stranger = await send(dm(users.spammer, `/pair ${code}`))
  const afterStranger = await api('GET', '/api/pair/status', { token: pollSecret, ip })
  check(
    'DM /pair from a non-admin → refused reply, code stays pending',
    stranger.status === 200 &&
      stranger.body?.method === 'sendMessage' &&
      stranger.body?.chat_id === users.spammer.id &&
      /only admins/i.test(stranger.body?.text ?? '') &&
      afterStranger.body?.status === 'pending',
    { reply: stranger.body?.text, status: afterStranger.body?.status },
  )
  const inGroup = await send({ update_id: updateId(), message: message(users.owner, `/pair ${code}`) })
  check('/pair inside the group (not a DM) → ignored', inGroup.status === 200 && inGroup.body?.ignored === true, inGroup)
  const usage = await send(dm(users.owner, '/pair'))
  check('DM /pair without a code → usage reply', /6-character code/.test(usage.body?.text ?? ''), usage.body)

  // Lower case with a dash: codes are normalized like the /pair page.
  const typed = `${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}`
  const owner = await send(dm(users.owner, `/pair@BouncerDemoBot ${typed}`))
  const claimed = await api('GET', '/api/pair/status', { token: pollSecret, ip })
  const feed = await api('GET', '/api/alerts', { token: claimed.body?.token, ip })
  check(
    'DM /pair@bot from a group admin → approved, glasses claim a working token',
    /^Paired/.test(owner.body?.text ?? '') && claimed.body?.status === 'approved' && typeof claimed.body?.token === 'string' && feed.status === 200,
    { reply: owner.body?.text, status: claimed.body?.status, feed: feed.status },
  )
  const reuse = await send(dm(users.owner, `/pair ${code}`))
  check('same code again → "Pairing failed" reply', /^Pairing failed/.test(reuse.body?.text ?? ''), reuse.body)

  const audit = await api('GET', '/api/audit?limit=100', { token: adminSecret })
  const entries = audit.body?.entries ?? []
  const approved = entries.find((e) => e.event === 'pair.approved' && e.detail?.deviceId === claimed.body?.deviceId)
  check(
    'audit: pair.approved by telegram:<admin id> with tgUserId, pair.telegram_denied for the stranger',
    approved?.actor === `telegram:${users.owner.id}` &&
      approved?.detail?.tgUserId === users.owner.id &&
      entries.some((e) => e.event === 'pair.telegram_denied' && e.detail?.tgUserId === users.spammer.id),
    { actor: approved?.actor, tgUserId: approved?.detail?.tgUserId },
  )
  if (claimed.body?.deviceId) await api('POST', '/api/admin/devices/revoke', { token: adminSecret, body: { deviceId: claimed.body.deviceId } })
}

// ---------------------------------------------------------------------------
// Voice intents (server: VOICE_STT_MOCK=1; `x-mock-transcript` replaces Cartesia STT).

// A function declaration (hoisted), not a const: the top-level `await` above runs the selftest
// before later consts initialize.
function voiceCases() {
  return [
  ['delete this message', 'delete'],
  ['take it down', 'delete'],
  ['mute him', 'mute'],
  ['give them a time out', 'mute'],
  ['ban this user', 'ban'],
  ['kick them out', 'ban'],
  ['dismiss', 'dismiss'],
  ["it's fine, false alarm", 'dismiss'],
  ["don't ban him", 'unknown'],
  ['no, mute', 'unknown'],
  ['delete it and ban him', 'unknown'],
  ['unban', 'unknown'],
  ['banana pancakes', 'unknown'],
  ['next', 'next'],
  ['summarize this', 'summary'],
  ['back to the inbox', 'inbox'],
  ]
}

async function voiceSelftest(adminSecret) {
  // Own device + IP: the voice quota (20 / 10 min) is per device.
  const ip = randomIp()
  const start = await api('POST', '/api/pair/start', { ip })
  await api('POST', '/api/admin/pair/approve', { token: adminSecret, body: { code: start.body?.code, name: 'selftest voice' }, ip })
  const status = await api('GET', '/api/pair/status', { token: start.body?.pollSecret, ip })
  const token = status.body?.token
  const audio = new Uint8Array(3200) // 0.1 s of silence, PCM s16le 16 kHz
  const wrong = []
  const cases = voiceCases()
  for (const [transcript, expected] of cases) {
    const res = await fetch(`${SERVER}/api/voice?sampleRate=16000`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/pcm', 'x-mock-transcript': transcript, 'x-forwarded-for': ip },
      body: audio,
    })
    const body = await res.json().catch(() => null)
    if (res.status !== 200 || body?.intent !== expected) wrong.push({ transcript, expected, status: res.status, got: body?.intent ?? body })
  }
  check(`voice parser: ${cases.length} phrases (delete/mute/ban/dismiss, negation, ambiguity)`, wrong.length === 0, wrong)
  if (status.body?.deviceId) await api('POST', '/api/admin/devices/revoke', { token: adminSecret, body: { deviceId: status.body.deviceId } })
}

// ---------------------------------------------------------------------------
// AI risk labels (server: SUMMARY_AI_MOCK=1; `x-mock-ai-output` = raw model text).

function label(token, alertId, output, { refresh = false } = {}) {
  const headers = { 'x-mock-ai': '1', ...(output ? { 'x-mock-ai-output': output } : {}) }
  return api('POST', `/api/alerts/${alertId}/summary${refresh ? '?refresh=1' : ''}`, { token, headers })
}

async function aiLabelSelftest(token) {
  const scamId = await flagged(message(users.anon, 'airdrop: send 1 ETH, get 10 back'))
  const scamOut = JSON.stringify({ label: 'scam', reason: 'Budi promises 10x returns for crypto sent first, a classic giveaway scam.' })
  const first = await label(token, scamId, scamOut)
  check(
    'AI label (mock) → 200 scam, source ai, reason ≤ 200',
    first.status === 200 && first.body.label === 'scam' && first.body.source === 'ai' && first.body.summary.length <= 200,
    first.body,
  )
  const again = await label(token, scamId, JSON.stringify({ label: 'ok', reason: 'should not be used' }))
  check('second request → cached label (no new model call)', again.body?.source === 'cache' && again.body?.label === 'scam', again.body)

  const feed = await api('GET', '/api/alerts', { token })
  const row = (feed.body?.alerts ?? []).find((a) => a.id === scamId)
  check(
    'label never changes the action list (server matrix only)',
    ['delete', 'mute', 'ban', 'dismiss'].every((a) => row?.actions?.includes(a)) && row?.actions?.length === 4,
    row?.actions,
  )

  const cases = [
    ['non-JSON model output → unclear + heuristic fallback', 'Sure! This looks like spam.'],
    ['label outside the enum → unclear + heuristic fallback', JSON.stringify({ label: 'ban-now', reason: 'ban this user' })],
    ['missing reason → unclear + heuristic fallback', JSON.stringify({ label: 'spam' })],
  ]
  for (const [name, output] of cases) {
    const id = await flagged(linkMessage(users.spammer))
    const r = await label(token, id, output)
    check(name, r.status === 200 && r.body.label === 'unclear' && r.body.source === 'fallback' && r.body.generatedAt === null, r.body)
  }

  const longId = await flagged(linkMessage(users.spammer))
  const longOut = `Here you go: {"label":"SPAM","reason":"${'promo '.repeat(80)} see https://evil.example/x"}`
  const long = await label(token, longId, longOut)
  check(
    'reason clipped to 200 chars, URLs stripped, label case-normalized',
    long.body?.label === 'spam' && long.body.summary.length <= 200 && !/https?:/.test(long.body.summary),
    { label: long.body?.label, length: long.body?.summary?.length },
  )

  // A status change (dismiss) clears the cached label.
  const intent = await api('POST', '/api/actions/intent', { token, body: { alertId: scamId, action: 'dismiss' } })
  await confirmOf(token, intent)
  const afterDismiss = await label(token, scamId, JSON.stringify({ label: 'ok', reason: 'Dismissed by a moderator.' }))
  check('status change invalidates the cached label', afterDismiss.body?.source === 'ai' && afterDismiss.body?.label === 'ok', afterDismiss.body)
}

/** Fresh alert from one webhook update; returns its id. */
async function flagged(msg) {
  const r = await send({ update_id: updateId(), message: msg })
  return r.status === 201 ? r.body.id : null
}

/** Alert in a chat outside the allowlist cannot come through the webhook: insert it directly (local DB only). */
async function insertForeignAlert() {
  const url = process.env.DATABASE_URL
  if (!url) return null
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url))
  const { default: postgres } = await import(pathToFileURL(require.resolve('postgres')).href)
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const mid = messageId()
    const target = { chatId: OTHER_CHAT.id, messageId: mid, userId: users.spammer.id, username: users.spammer.username, chatTitle: OTHER_CHAT.title }
    const [row] = await sql`
      insert into alerts (source, delivery_id, dedup_key, kind, severity, title, summary, scope, payload, target)
      values ('telegram', ${`selftest-${mid}`}, ${`msg:${OTHER_CHAT.id}:${mid}`}, 'telegram.link', 'medium',
              '@cheap_followers: foreign chat', 'link — foreign chat', ${OTHER_CHAT.title}, ${sql.json({ selftest: true })}, ${sql.json(target)})
      returning id`
    return row.id
  } finally {
    await sql.end()
  }
}

function confirmOf(token, intent, nonce = intent.body?.nonce) {
  return api('POST', '/api/actions/confirm', { token, body: { requestId: intent.body?.requestId, nonce } })
}

async function actionSelftest(token, ids) {
  // delete → succeeded, alert resolved.
  const intent = await api('POST', '/api/actions/intent', { token, body: { alertId: link.body.id, action: 'delete' } })
  check(
    'intent delete → 201 preview (dry run) with target',
    intent.status === 201 && intent.body.dryRun === true && intent.body.headline === 'Delete message' && intent.body.target.includes('@cheap_followers'),
    redact(intent),
  )
  const confirm = await confirmOf(token, intent)
  check(
    'confirm delete → succeeded (dry run), alert resolved',
    confirm.status === 200 && confirm.body.status === 'succeeded' && confirm.body.alertStatus === 'resolved',
    confirm,
  )
  const reused = await confirmOf(token, intent)
  check('confirm with an already used nonce → 409', reused.status === 409, reused)

  // mute → succeeded, alert acked (message stays); ban → succeeded, alert resolved.
  const muteIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: report.body.id, action: 'mute' } })
  const muteBadNonce = await confirmOf(token, muteIntent, 'not-the-nonce')
  check('confirm with a wrong nonce → 403', muteBadNonce.status === 403, muteBadNonce)
  const mute = await confirmOf(token, muteIntent)
  check(
    'intent → confirm mute → succeeded (dry run), alert acked',
    muteIntent.status === 201 && muteIntent.body.headline.startsWith('Mute') && mute.status === 200 && mute.body.status === 'succeeded' && mute.body.alertStatus === 'acked',
    { intent: muteIntent.status, confirm: mute },
  )
  const banIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: keyword.body.id, action: 'ban' } })
  const ban = await confirmOf(token, banIntent)
  check(
    'intent → confirm ban → succeeded (dry run), alert resolved',
    banIntent.status === 201 && ban.status === 200 && ban.body.status === 'succeeded' && ban.body.alertStatus === 'resolved',
    { intent: banIntent.status, confirm: ban },
  )

  // dismiss: no provider; not allowed again on a resolved alert.
  const again = await api('POST', '/api/actions/intent', { token, body: { alertId: link.body.id, action: 'dismiss' } })
  check('dismiss on a resolved alert → 422', again.status === 422, again)
  const dismiss = await api('POST', '/api/actions/intent', { token, body: { alertId: ids.botReport, action: 'dismiss' } })
  const dismissed = await confirmOf(token, dismiss)
  check(
    'dismiss → succeeded without provider call, alert resolved',
    dismissed.status === 200 && dismissed.body.status === 'succeeded' && dismissed.body.providerStatus === null && dismissed.body.alertStatus === 'resolved',
    dismissed,
  )

  const badAction = await api('POST', '/api/actions/intent', { token, body: { alertId: report.body.id, action: 'rerun' } })
  check('unknown action → 400', badAction.status === 400, badAction)

  // Target is a group admin (DRY_RUN_ADMIN_IDS stands in for getChatMember) → 422 at intent.
  const adminAlert = await flagged(linkMessage(users.owner, 'Meetup moved, details https://example.com/meetup'))
  const adminIntents = await Promise.all(
    ['delete', 'mute', 'ban'].map((action) => api('POST', '/api/actions/intent', { token, body: { alertId: adminAlert, action } })),
  )
  check(
    'delete/mute/ban on a group admin → 422 cannot moderate admins',
    adminAlert !== null && adminIntents.every((r) => r.status === 422 && r.body.error === 'cannot moderate admins'),
    adminIntents.map((r) => r.status),
  )

  // Chat outside TELEGRAM_ALLOWED_CHATS → 403, and no actions offered.
  const foreign = await insertForeignAlert().catch((err) => {
    check('insert foreign-chat alert (local DB)', false, err.message)
    return null
  })
  const foreignIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: foreign, action: 'delete' } })
  check('delete in a chat outside the allowlist → 403', foreign !== null && foreignIntent.status === 403, foreignIntent)

  // Provider failure (dry-run simulation 9999…400) → failed, alert stays open.
  const runTag = String(Date.now() % 1_000_000).padStart(6, '0')
  const failAlert = await flagged({ ...linkMessage(users.spammer), message_id: Number(`9999${runTag}400`) })
  const failIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: failAlert, action: 'delete' } })
  const fail = await confirmOf(token, failIntent)
  check(
    'provider error (simulated 400) → failed, providerStatus 400, alert still open',
    fail.status === 200 && fail.body.status === 'failed' && fail.body.providerStatus === 400 && fail.body.alertStatus === 'open',
    fail,
  )

  // Network error whose raw text contains the bot URL + token → scrubbed everywhere.
  const netAlert = await flagged({ ...linkMessage(users.spammer), message_id: Number(`8888${runTag}`) })
  const netIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: netAlert, action: 'ban' } })
  const net = await confirmOf(token, netIntent)
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? ''
  check(
    'network error → failed, response has no bot token',
    net.status === 200 && net.body.status === 'failed' && net.body.providerStatus === null && botToken !== '' && !JSON.stringify(net.body).includes(botToken),
    net,
  )

  // Nonce expiry: wait past ACTION_NONCE_TTL_SECONDS → 410, then the same nonce stays unusable.
  const ttl = Number(process.env.ACTION_NONCE_TTL_SECONDS ?? '60')
  if (ttl > 15) {
    check('ACTION_NONCE_TTL_SECONDS ≤ 15 for the expiry test', false, { ttl })
  } else {
    const expIntent = await api('POST', '/api/actions/intent', { token, body: { alertId: ids.long, action: 'delete' } })
    await new Promise((resolve) => setTimeout(resolve, (ttl + 1) * 1000))
    const expired = await confirmOf(token, expIntent)
    const expiredAgain = await confirmOf(token, expIntent)
    check('confirm after nonce TTL → 410 expired (twice)', expIntent.status === 201 && expired.status === 410 && expiredAgain.status === 410, {
      intent: expIntent.status,
      first: expired.status,
      second: expiredAgain.status,
    })
  }
}

process.exit(failed ? 1 : 0)
