// Send fake Telegram Bot API updates (with the webhook secret header) to a local Bouncer server.
//   pnpm seed              → seed demo alerts (fresh update/message ids each run)
//   pnpm seed --selftest   → also assert secret, allowlist, flag rules, dedup, truncation,
//                            plus pairing + dry-run actions (needs ADMIN_SECRET and ACTIONS_DRY_RUN=1 on the server)
// Server env needed: TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_CHATS (first id is used here), FLAG_KEYWORDS (must include "airdrop").
// TODO H2: voice + AI summary selftests (removed with the GitHub/Sentry fixtures).

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

async function api(method, path, { token, body, ip = RUN_IP } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
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

  // Dry-run actions: delete → succeeded + alert resolved; dismiss on the resolved alert → 422.
  const intent = await api('POST', '/api/actions/intent', { token, body: { alertId: link.body.id, action: 'delete' } })
  check(
    'intent delete → 201 preview (dry run) with target',
    intent.status === 201 && intent.body.dryRun === true && intent.body.headline === 'Delete message' && intent.body.target.includes('@cheap_followers'),
    redact(intent),
  )
  const confirm = await api('POST', '/api/actions/confirm', { token, body: { requestId: intent.body?.requestId, nonce: intent.body?.nonce } })
  check(
    'confirm delete → succeeded (dry run), alert resolved',
    confirm.status === 200 && confirm.body.status === 'succeeded' && confirm.body.alertStatus === 'resolved',
    confirm,
  )
  const again = await api('POST', '/api/actions/intent', { token, body: { alertId: link.body.id, action: 'dismiss' } })
  check('dismiss on a resolved alert → 422', again.status === 422, again)
  const dismiss = await api('POST', '/api/actions/intent', { token, body: { alertId: ids.botReport, action: 'dismiss' } })
  const dismissed = await api('POST', '/api/actions/confirm', { token, body: { requestId: dismiss.body?.requestId, nonce: dismiss.body?.nonce } })
  check(
    'dismiss → succeeded without provider call, alert resolved',
    dismissed.status === 200 && dismissed.body.status === 'succeeded' && dismissed.body.providerStatus === null && dismissed.body.alertStatus === 'resolved',
    dismissed,
  )
  const badAction = await api('POST', '/api/actions/intent', { token, body: { alertId: report.body.id, action: 'rerun' } })
  check('unknown action → 400', badAction.status === 400, badAction)

  const audit = await api('GET', '/api/audit?limit=50', { token: ADMIN })
  const events = new Set((audit.body?.entries ?? []).map((e) => e.event))
  check('audit has webhook.telegram + action events', ['webhook.telegram', 'action.intent', 'action.succeeded'].every((e) => events.has(e)), [...events])

  const revoke = await api('POST', '/api/admin/devices/revoke', { token: ADMIN, body: { deviceId: paired.deviceId } })
  const revokedRead = await api('GET', '/api/alerts', { token })
  check('revoke device → reads 401', revoke.status === 200 && revokedRead.status === 401, { revoke: revoke.status, read: revokedRead.status })
  // TODO H2: rate limits, nonce expiry, provider-failure path and voice/summary selftests for Telegram actions.
}

process.exit(failed ? 1 : 0)
