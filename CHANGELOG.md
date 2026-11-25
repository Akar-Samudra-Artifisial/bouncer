# Changelog

All notable changes are recorded here. Format follows Keep a Changelog; versions follow SemVer.

Bouncer starts from a copy of Pagerline `d1f0599` (same hackathon, 24–25 Nov 2026); Pagerline's own
history is not repeated here.

## [Unreleased]

### Added
- Telegram webhook ingest (`POST /api/webhooks/telegram`), verified with the `X-Telegram-Bot-Api-Secret-Token` header.
- Flag rules: `/report` (or `/report@<bot>`) as a reply flags the replied-to message (high, reporter recorded);
  messages with a link (`url`/`text_link` entity) are flagged medium; `FLAG_KEYWORDS` matches are flagged high.
- Only chats in `TELEGRAM_ALLOWED_CHATS` are processed; other updates answer `200 {ignored: true}`.
- Dedup per `update_id` (redelivery) and per message (`msg:<chatId>:<messageId>`); message text is capped at 500 characters
  and the raw update is never stored.
- Moderation actions call the Telegram Bot API: `delete` (deleteMessage; an already deleted message counts as done),
  `mute` (restrictChatMember, all permissions off for 1 hour, supergroups only), `ban` (banChatMember); `dismiss`
  closes the flag without calling Telegram. After success the alert is resolved (mute: acked, the message stays).
- Group owners and admins cannot be moderated: the intent checks `getChatMember` and answers `422 cannot moderate admins`
  (`502` when Telegram cannot be reached); the chat allowlist is re-checked at confirm.
- `DRY_RUN_ADMIN_IDS` marks fake admins for `ACTIONS_DRY_RUN=1`.
- Glasses action labels: Delete message / Mute 1h / Ban user / Dismiss; mock mode shows an admin refusal and a provider failure.
- Selftest covers intent → confirm for every action, admin refusal, chats outside the allowlist, reused/wrong/expired nonces,
  provider failure and bot-token scrubbing.
- Glasses inbox/detail show Telegram flags (`@username: text`, group name); offline mock data uses fake Telegram messages.
- Demo seed / selftest sends fake Telegram updates.
- AI risk label on the Detail screen: `spam | scam | toxic | ok | unclear` plus a reason of at most 200 characters,
  generated on demand by `claude-haiku-5-5` and cached until the alert status changes. Invalid model output falls back
  to `unclear` with a heuristic reason; `AI_LABELS=0` turns AI off. The label never changes which actions are offered.
- Voice commands for every moderation action (delete, mute, ban, dismiss) besides next/back/inbox/summary; a voice
  command only opens the Confirm screen with Cancel focused, and negated or ambiguous phrases are rejected.
- Pair glasses from Telegram: a group admin sends `/pair CODE` to the bot in a private chat; the server checks with
  `getChatMember` that the sender administers an allowlisted group and replies in the chat. The `/pair` page with
  `ADMIN_SECRET` remains as a fallback.
- Daily retention purge (`GET /api/cron/purge`, Vercel Cron, `CRON_SECRET`): alerts older than 7 days are deleted
  with their message text and AI label; the audit entry records counts only.
- `POST /api/actions/cancel` (`{requestId, nonce}`): Cancel on the glasses Confirm screen burns the pending request and
  records `action.cancel` in the audit log (request id + action, no message text).

### Changed
- The glasses app now points at the production server `https://bouncer-nine.vercel.app` (network whitelist and packed build).
- Glasses inbox lists open alerts only (acked/resolved/muted drop out; they stay in the audit log) and is rebuilt when
  its rows change (new or closed alert) instead of only updating the header count.

### Fixed
- AI risk labels mostly fell back to `unclear` ("model output failed validation"): the model sometimes opened with a
  thinking block that used up the 150-token budget, cutting the JSON off. Thinking is now disabled, the budget is 400
  tokens, and the parser accepts code fences, surrounding prose, extra fields and a reason cut off mid-sentence (label
  still restricted to the enum, reason still sanitized and ≤ 200 characters). When the output holds several JSON
  objects, the first one with a valid label and reason is used.
- The header clock no longer freezes while the pairing code is shown.

### Security
- The bot token is scrubbed from provider error details (network errors, Telegram `description`) before audit/logging
  and is never part of API responses.
- Flagged message text is sent to Anthropic only when a moderator opens the alert, wrapped as untrusted data, without tools.
- AI label reasons drop control, zero-width and bidi characters and `<>&`.
- Cancel with a wrong nonce returns 403 without an audit entry, so retries cannot flood the audit log.

### Removed
- GitHub and Sentry webhooks, providers and actions (`rerun`, `resolve`) inherited from the Pagerline base.
- Pagerline logo and brand assets (neutral placeholder favicon).
