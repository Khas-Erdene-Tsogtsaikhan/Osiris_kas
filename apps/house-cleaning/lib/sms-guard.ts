/**
 * SMS Pre-Send Guard
 *
 * Catches dangerous AI outputs BEFORE they reach the customer.
 * Runs on every AI-generated message before sendSMS.
 *
 * Guards:
 * 1. Discount/price reduction language
 * 2. Price accuracy (quoted price vs DB)
 * 3. Conversation stage awareness (adapt tone to funnel position)
 * 4. Escalation triggers (hand off to owner instead of fumbling)
 */

import { getSupabaseServiceClient } from './supabase'

// ── Types ────────────────────────────────────────────────────────────

export interface GuardResult {
  safe: boolean
  blocked: boolean
  reason?: string
  warnings: string[]
  suggestedRewrite?: string
  shouldEscalate?: boolean
  escalationReason?: string
  conversationStage?: ConversationStage
}

export type ConversationStage =
  | 'greeting'           // First contact, no info yet
  | 'qualifying'         // Getting bed/bath, service type
  | 'quoting'            // Price has been or should be given
  | 'objection_handling' // Customer pushed back on price/timing
  | 'closing'            // Moving toward booking
  | 'booked'             // Job created, confirming details
  | 'post_job'           // After service, review/rebooking
  | 're_engagement'      // Dormant customer outreach
  | 'escalation'         // Needs human intervention

// ── Discount Guard ──────────────────────────────────────────────────

const DISCOUNT_PATTERNS = [
  /\b\d+%\s*off\b/i,
  /\b\d+%\s*discount\b/i,
  /\bdiscount(?:ed)?\b/i,
  /\bspecial\s+(?:price|rate|deal|offer)\b/i,
  /\bI\s+can\s+do\s+(?:it\s+)?(?:for\s+)?\$\d/i,
  /\bhow\s+about\s+\$\d/i,
  /\blet\s+me\s+(?:see|check)\s+(?:if|what)\s+I\s+can\s+do/i,
  /\breduc(?:e|ed|tion)\s+(?:the\s+)?price/i,
  /\blower\s+(?:the\s+)?price/i,
  /\bknock\s+(?:off|down)\b/i,
  /\bfree\s+(?:cleaning|service|session|add[\s-]?on)/i,
  /\bwe(?:'ll| will)\s+(?:waive|drop|lower|reduce)/i,
  /\bI(?:'ll| will)\s+(?:waive|drop|lower|reduce)/i,
  /\bno\s+charge\s+for\b/i,
  /\bon\s+(?:the\s+)?house\b/i,
  /\bcomp(?:limentary)?\s+(?:cleaning|service)/i,
  /\bprice\s+match/i,
]

function checkDiscountLanguage(message: string): { found: boolean; matches: string[] } {
  const matches: string[] = []
  for (const pattern of DISCOUNT_PATTERNS) {
    const match = message.match(pattern)
    if (match) {
      matches.push(match[0])
    }
  }
  // Exclude false positives: "satisfaction guarantee" mentions "free" in context of redo
  const falsePositives = [
    /come\s+back.*free/i,      // "we come back and fix it free" (guarantee)
    /redo.*free/i,              // "we redo it free" (guarantee)
    /free\s+(?:of\s+charge\s+)?(?:redo|fix|return)/i,
  ]
  const filtered = matches.filter(m => {
    return !falsePositives.some(fp => fp.test(message))
  })
  return { found: filtered.length > 0, matches: filtered }
}

// ── Price Accuracy Guard ────────────────────────────────────────────

const PRICE_IN_MESSAGE = /\$\s*(\d+(?:\.\d{2})?)/g

async function checkPriceAccuracy(
  message: string,
  tenantId: string,
  customerBedrooms?: number | null,
  customerBathrooms?: number | null
): Promise<{ accurate: boolean; warning?: string }> {
  const priceMatches = [...message.matchAll(PRICE_IN_MESSAGE)]
  if (priceMatches.length === 0) return { accurate: true }

  // Only verify if we know the customer's bed/bath
  if (!customerBedrooms || !customerBathrooms) return { accurate: true }

  try {
    const client = getSupabaseServiceClient()
    const { data: tier } = await client
      .from('pricing_tiers')
      .select('price')
      .eq('tenant_id', tenantId)
      .eq('bedrooms', customerBedrooms)
      .eq('bathrooms', customerBathrooms)
      .limit(1)
      .maybeSingle()

    if (!tier?.price) return { accurate: true } // Can't verify, let it pass

    const dbPrice = Number(tier.price)
    for (const match of priceMatches) {
      const quotedPrice = Number(match[1])
      // Flag if the quoted price is significantly lower than DB price (>15% off)
      if (quotedPrice < dbPrice * 0.85) {
        return {
          accurate: false,
          warning: `AI quoted $${quotedPrice} but DB price for ${customerBedrooms}bed/${customerBathrooms}bath is $${dbPrice}. Blocked to prevent undercharging.`
        }
      }
    }
    return { accurate: true }
  } catch {
    return { accurate: true } // DB error, let it pass
  }
}

// ── Booking Confirmation Guard ──────────────────────────────────────
//
// Blocks phrases that claim a booking is locked in when no confirmed job row
// exists. Prevents hallucinated confirmations (Rosemary Johnson incident,
// 2026-04-20) which cause no-shows, chargebacks, and reputation damage.
//
// A "confirmed booking" = a `jobs` row with status IN ('scheduled','in_progress').
// A 'quoted' job is NOT a confirmation.

const BOOKING_CONFIRMATION_PATTERNS: RegExp[] = [
  /\byou.?re\s+(all\s+set|booked|confirmed|scheduled)\b/i,
  /\bwe.?ve\s+got\s+you\s+(booked|confirmed|scheduled|set)\b/i,
  /\bconfirmed\s+for\s+\w+day\b/i,
  /\bscheduled\s+for\s+\w+day\b/i,
  /\byour\s+(cleaning|booking|appointment|service)\s+is\s+(confirmed|scheduled|booked|locked\s+in|set)\b/i,
  /\blocked\s+in\s+(?:for|your)\b/i,
  /\bI.?ve\s+(booked|scheduled|confirmed)\s+(?:you|your)\b/i,
  /\bgot\s+you\s+on\s+the\s+(?:calendar|schedule)\b/i,
  /\bbooking\s+confirmed\b/i,
  /\bsee\s+you\s+(?:on\s+)?\w+day\b/i, // e.g. "see you Monday"
]

function checkBookingConfirmationLanguage(message: string): { found: boolean; matches: string[] } {
  const matches: string[] = []
  for (const pattern of BOOKING_CONFIRMATION_PATTERNS) {
    const match = message.match(pattern)
    if (match) matches.push(match[0])
  }
  return { found: matches.length > 0, matches }
}

// ── Conversation Stage Detection ────────────────────────────────────

export function detectConversationStage(
  messages: Array<{ role: string; content: string }>,
  hasJob: boolean,
  hasPriceBeenQuoted: boolean
): ConversationStage {
  const customerMsgs = messages.filter(m => m.role === 'client' || m.role === 'inbound')
  const agentMsgs = messages.filter(m => m.role === 'assistant' || m.role === 'outbound')
  const totalMsgs = messages.length
  const lastCustomerMsg = customerMsgs[customerMsgs.length - 1]?.content?.toLowerCase() || ''

  if (hasJob) return 'booked'
  if (totalMsgs <= 2) return 'greeting'

  // Check for objection signals
  const objectionPatterns = /too\s*(much|expensive|high)|can('t| not)\s*afford|budget|cheaper|less|discount|deal|lower/i
  if (objectionPatterns.test(lastCustomerMsg)) return 'objection_handling'

  // Check for closing signals
  const closingPatterns = /book|schedule|when.*available|let('s| us)\s*do|ready|sign.*up|sounds good|let('s| us)\s*go/i
  if (closingPatterns.test(lastCustomerMsg)) return 'closing'

  // Check for escalation needs
  const escalationPatterns = /speak.*manager|talk.*owner|complaint|sue|lawyer|bbb|attorney|refund/i
  if (escalationPatterns.test(lastCustomerMsg)) return 'escalation'

  if (hasPriceBeenQuoted) return 'quoting'
  if (totalMsgs >= 3) return 'qualifying'

  return 'greeting'
}

// ── Stage-Specific Tone Guidance ────────────────────────────────────

export function getStageGuidance(stage: ConversationStage): string {
  switch (stage) {
    case 'greeting':
      return 'TONE: Warm and welcoming. Ask about their home (bed/bath) so you can give a price. Keep it brief.'
    case 'qualifying':
      return 'TONE: Friendly and efficient. You need bed/bath count to quote. If they already gave it, give the price NOW. Don\'t ask unnecessary questions.'
    case 'quoting':
      return 'TONE: Confident and clear. State the price directly. Don\'t hedge. After quoting, ask if they\'d like to book. One question at a time.'
    case 'objection_handling':
      return 'TONE: Empathetic but firm. They pushed back on price. Build value: satisfaction guarantee, insured, background-checked, 5-star reviews. Do NOT lower the price. Do NOT offer discounts. If they keep pushing, offer to have the owner call them.'
    case 'closing':
      return 'TONE: Excited but not pushy. They want to book! Send the quote link immediately. Make it easy. Confirm the details quickly.'
    case 'booked':
      return 'TONE: Grateful and helpful. Job is booked. Answer any questions about what to expect. Keep it short.'
    case 'post_job':
      return 'TONE: Warm. Ask how the cleaning went. Mention the review link. Offer recurring booking.'
    case 're_engagement':
      return 'TONE: Casual and friendly. It\'s been a while. Mention what you liked about their home. Offer to book their next clean.'
    case 'escalation':
      return 'TONE: Calm and professional. The customer needs a human. Say: "Let me have [owner] reach out to you directly." Do NOT try to handle complaints yourself.'
    default:
      return ''
  }
}

// ── Escalation Detection ────────────────────────────────────────────

function shouldEscalate(
  message: string,
  conversationHistory: Array<{ role: string; content: string }>,
  stage: ConversationStage
): { escalate: boolean; reason?: string } {
  const lower = message.toLowerCase()

  // Immediate escalation triggers
  if (stage === 'escalation') {
    return { escalate: true, reason: 'Customer asked for manager/owner/wants to complain' }
  }

  // Customer asked same question 3+ times
  const customerMsgs = conversationHistory
    .filter(m => m.role === 'client' || m.role === 'inbound')
    .map(m => m.content.toLowerCase())

  if (customerMsgs.length >= 3) {
    const lastThreeTopics = customerMsgs.slice(-3)
    const priceAsks = lastThreeTopics.filter(m => /price|cost|how much|quote|rate/.test(m))
    if (priceAsks.length >= 3) {
      return { escalate: true, reason: 'Customer asked about price 3+ times — AI may be dodging' }
    }
  }

  // Explicit anger/legal threats
  if (/fuck|shit|lawsuit|sue|attorney|lawyer|bbb|report|scam/.test(lower)) {
    return { escalate: true, reason: 'Customer is angry or making threats' }
  }

  // AI has sent 6+ messages without booking — conversation is going nowhere
  const agentMsgs = conversationHistory.filter(m => m.role === 'assistant' || m.role === 'outbound')
  if (agentMsgs.length >= 6 && stage !== 'booked' && stage !== 'post_job') {
    return { escalate: true, reason: '6+ AI messages without booking — hand to human' }
  }

  return { escalate: false }
}

// ── Main Guard Function ─────────────────────────────────────────────

export async function guardMessage(
  aiResponse: string,
  tenantId: string,
  conversationHistory: Array<{ role: string; content: string }>,
  customerInfo?: {
    bedrooms?: number | null
    bathrooms?: number | null
    hasActiveJob?: boolean
    /**
     * True only when a `jobs` row exists with status IN ('scheduled','in_progress').
     * A 'quoted' job does NOT count — quoted is not confirmed. Required for the
     * booking-confirmation guard to allow confirmation language through.
     */
    hasConfirmedBooking?: boolean
    hasPriceBeenQuoted?: boolean
  }
): Promise<GuardResult> {
  const warnings: string[] = []

  // 1. Detect conversation stage
  const stage = detectConversationStage(
    conversationHistory,
    customerInfo?.hasActiveJob || false,
    customerInfo?.hasPriceBeenQuoted || false
  )

  // 2. Check for discount language (HARD BLOCK)
  const discountCheck = checkDiscountLanguage(aiResponse)
  if (discountCheck.found) {
    return {
      safe: false,
      blocked: true,
      reason: `AI tried to offer discount/price reduction: "${discountCheck.matches.join('", "')}"`,
      warnings: [`BLOCKED: Discount language detected — ${discountCheck.matches.join(', ')}`],
      shouldEscalate: true,
      escalationReason: 'AI attempted to offer unauthorized discount — escalating to owner',
      conversationStage: stage,
    }
  }

  // 2.5. Check for hallucinated booking confirmation (HARD BLOCK)
  // If the AI emits "you're all set / confirmed / booked / scheduled for X"
  // without a real confirmed booking in the DB, block it and escalate.
  const confirmationCheck = checkBookingConfirmationLanguage(aiResponse)
  if (confirmationCheck.found && !customerInfo?.hasConfirmedBooking) {
    return {
      safe: false,
      blocked: true,
      reason: `AI emitted booking-confirmation language without a confirmed booking: "${confirmationCheck.matches.join('", "')}"`,
      warnings: [`BLOCKED: Hallucinated confirmation — ${confirmationCheck.matches.join(', ')}`],
      shouldEscalate: true,
      escalationReason: 'AI claimed booking is confirmed when no confirmed `jobs` row exists — risks no-shows and chargebacks',
      conversationStage: stage,
    }
  }

  // 3. Check price accuracy (HARD BLOCK if significantly under)
  const priceCheck = await checkPriceAccuracy(
    aiResponse,
    tenantId,
    customerInfo?.bedrooms,
    customerInfo?.bathrooms
  )
  if (!priceCheck.accurate) {
    return {
      safe: false,
      blocked: true,
      reason: priceCheck.warning || 'Price accuracy check failed',
      warnings: [`BLOCKED: ${priceCheck.warning}`],
      conversationStage: stage,
    }
  }

  // 4. Check escalation triggers
  const lastCustomerMsg = conversationHistory
    .filter(m => m.role === 'client' || m.role === 'inbound')
    .slice(-1)[0]?.content || ''

  const escalation = shouldEscalate(lastCustomerMsg, conversationHistory, stage)
  if (escalation.escalate) {
    return {
      safe: true, // Still send, but flag for escalation
      blocked: false,
      warnings: [`ESCALATION: ${escalation.reason}`],
      shouldEscalate: true,
      escalationReason: escalation.reason,
      conversationStage: stage,
    }
  }

  // 5. Soft warnings (don't block, just log)
  if (aiResponse.length > 500) {
    warnings.push('Message is very long (>500 chars) — customers prefer brief texts')
  }

  if (/emoji|😊|👍|🏠|✨|🧹|💪|❤️|🙏/.test(aiResponse)) {
    warnings.push('Contains emoji — house-cleaning-sms-prompt says NEVER use emojis')
  }

  return {
    safe: true,
    blocked: false,
    warnings,
    conversationStage: stage,
  }
}
