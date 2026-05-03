/**
 * Message Linter — the last gate before an outreach message hits sendSMS/email.
 *
 * OUTREACH-SPEC v1.0 Section 8.8.
 *
 * Every AI-generated outreach message runs through `lintMessage`. On fail,
 * the caller regenerates up to 3 times; if still failing it falls back to a
 * template and logs OUTREACH_LINT_FAILED to system_events.
 *
 * Rules (any trigger rejects):
 *   - Contains any banned phrase (tenant.voice_profile.never_says + global list)
 *   - More than 3 emojis
 *   - Unreplaced `{placeholder}` tokens
 *   - First name used in message is a carrier keyword (STOP, UNSUBSCRIBE, ...)
 *   - Pipeline C (retargeting) messages that don't reference any callback
 *   - Length exceeds channel limit (SMS=160, MMS=600)
 */

export const GLOBAL_BANNED_PHRASES: readonly string[] = [
  'valued customer',
  'exclusive offer',
  'limited time',
  "we've upgraded",
  'dear',
  'synergy',
  'as a courtesy',
  'book now!',
  'hello valued',
  '🎉🎉🎉',
] as const

const CARRIER_KEYWORDS = new Set([
  'stop', 'unsubscribe', 'cancel', 'quit', 'end', 'optout', 'unsub', 'remove',
])

const EMOJI_RE = /\p{Extended_Pictographic}/gu

export type LintRule =
  | 'banned_phrase'
  | 'too_many_emojis'
  | 'unreplaced_placeholder'
  | 'carrier_keyword_name'
  | 'missing_callback'
  | 'length_exceeded'
  | 'empty_message'

export interface LintFailure {
  rule: LintRule
  detail: string
}

export interface LintInput {
  text: string
  pipeline: 'pre_quote' | 'post_quote' | 'retargeting'
  channel: 'sms' | 'email' | 'mms'
  /** First name inserted into the message (used for carrier-keyword check). */
  firstName?: string | null
  /** Tenant-configured banned phrases — merged with the global list. */
  tenantBannedPhrases?: readonly string[]
  /**
   * Callback anchors — substrings or tokens from the customer's history that
   * the message ought to reference. Pipeline C messages must include at least
   * one. `undefined` or `[]` disables the check (use when the tenant has no
   * chat history yet).
   */
  callbackAnchors?: readonly string[]
}

export interface LintResult {
  ok: boolean
  failures: LintFailure[]
}

function maxLengthForChannel(channel: LintInput['channel']): number {
  switch (channel) {
    case 'sms': return 160
    case 'mms': return 600
    case 'email': return 5000
  }
}

export function lintMessage(input: LintInput): LintResult {
  const failures: LintFailure[] = []
  const text = (input.text || '').trim()

  if (!text) {
    return { ok: false, failures: [{ rule: 'empty_message', detail: 'empty after trim' }] }
  }

  const lower = text.toLowerCase()

  const banned = [
    ...GLOBAL_BANNED_PHRASES,
    ...(input.tenantBannedPhrases ?? []),
  ].map(p => p.toLowerCase())
  for (const phrase of banned) {
    if (!phrase) continue
    if (lower.includes(phrase)) {
      failures.push({ rule: 'banned_phrase', detail: phrase })
    }
  }

  const emojiMatches = text.match(EMOJI_RE) || []
  if (emojiMatches.length > 3) {
    failures.push({ rule: 'too_many_emojis', detail: `found ${emojiMatches.length}` })
  }

  if (/\{[a-zA-Z0-9_]+\}/.test(text)) {
    const match = text.match(/\{[a-zA-Z0-9_]+\}/g) || []
    failures.push({ rule: 'unreplaced_placeholder', detail: match.join(',') })
  }

  if (input.firstName) {
    const fn = input.firstName.trim().toLowerCase()
    if (fn && CARRIER_KEYWORDS.has(fn)) {
      failures.push({ rule: 'carrier_keyword_name', detail: fn })
    }
  }

  if (input.pipeline === 'retargeting' && input.callbackAnchors && input.callbackAnchors.length > 0) {
    const hit = input.callbackAnchors.some(anchor =>
      anchor && lower.includes(anchor.toLowerCase().trim())
    )
    if (!hit) {
      failures.push({
        rule: 'missing_callback',
        detail: 'no chat-history reference found',
      })
    }
  }

  const maxLen = maxLengthForChannel(input.channel)
  if (text.length > maxLen) {
    failures.push({ rule: 'length_exceeded', detail: `${text.length} > ${maxLen}` })
  }

  return { ok: failures.length === 0, failures }
}
