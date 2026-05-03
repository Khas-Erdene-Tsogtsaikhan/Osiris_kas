/**
 * SMS Opt-Out Detection — Hybrid keyword + AI intent detection
 *
 * Layer 1: Exact keyword matches (instant, free) for standard TCPA words
 * Layer 2: AI intent classification via Haiku for polite/indirect opt-out requests
 */

import Anthropic from '@anthropic-ai/sdk'

const STOP_KEYWORDS = ['stop', 'unsubscribe', 'opt out', 'optout', 'cancel texts', 'quit']

/**
 * Check if a message is an opt-out request using keyword matching.
 * Returns true for standard TCPA opt-out words.
 */
export function isKeywordOptOut(message: string): boolean {
  const trimmedLower = message.trim().toLowerCase()
  return STOP_KEYWORDS.includes(trimmedLower)
}

/**
 * Check if a message is a START/re-subscribe request.
 */
export function isStartRequest(message: string): boolean {
  return message.trim().toLowerCase() === 'start'
}

/**
 * AI-based opt-out intent detection using Claude Haiku.
 * Only called when keyword matching doesn't match — catches polite/indirect opt-outs.
 *
 * Returns true if the message indicates the person wants to stop receiving texts.
 * Returns false for ambiguous or non-opt-out messages (errs on the side of caution).
 */
export async function detectOptOutIntent(message: string): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[opt-out] No ANTHROPIC_API_KEY — skipping AI opt-out detection')
    return false
  }

  // Skip very short messages that aren't keywords — likely just a greeting or typo
  if (message.trim().length < 4) {
    return false
  }

  // Short-circuit: if the message contains clear booking/inquiry intent, it's NOT an opt-out.
  // Saves ~50-70% of Haiku opt-out calls which are wasted on obvious inquiries.
  const lower = message.toLowerCase()
  const inquiryMarkers = [
    'quote', 'price', 'cost', 'rate', 'book', 'schedule', 'appoint', 'available',
    'clean', 'service', 'need', 'want', 'when can', 'how much', 'how do',
    'yes', 'yeah', 'yep', 'sure', 'sounds good', 'ok ', 'okay', 'thanks',
    '?',
  ]
  if (inquiryMarkers.some(m => lower.includes(m))) {
    return false
  }

  try {
    const client = new Anthropic({ apiKey })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: `Does this text message from a customer indicate they want to stop receiving text messages from a business? Only answer "yes" if they are clearly asking to not be contacted anymore. Answer "no" if the message is ambiguous, a normal conversation reply, or just expressing disinterest in a specific offer without asking to stop all messages.

Message: "${message}"

Answer with only "yes" or "no":`,
        },
      ],
    }, { signal: controller.signal })

    clearTimeout(timeout)

    const block = response.content[0]
    const answer = (block && 'text' in block ? block.text : 'no')
      .trim()
      .toLowerCase()

    const isOptOut = answer === 'yes'

    if (isOptOut) {
      console.log(`[opt-out] AI detected opt-out intent in message: "${message.slice(0, 80)}"`)
    }

    return isOptOut
  } catch (error) {
    // On any AI failure, default to NOT opting out (safe fallback — don't accidentally unsubscribe)
    console.error('[opt-out] AI opt-out detection failed, defaulting to no:', error)
    return false
  }
}
