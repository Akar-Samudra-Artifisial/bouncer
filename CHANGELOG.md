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

### Security
- The bot token is scrubbed from provider error details (network errors, Telegram `description`) before audit/logging
  and is never part of API responses.
- Glasses inbox/detail show Telegram flags (`@username: text`, group name); offline mock data uses fake Telegram messages.
- Demo seed / selftest sends fake Telegram updates.

### Removed
- GitHub and Sentry webhooks, providers and actions (`rerun`, `resolve`) inherited from the Pagerline base.
- Pagerline logo and brand assets (neutral placeholder favicon).
