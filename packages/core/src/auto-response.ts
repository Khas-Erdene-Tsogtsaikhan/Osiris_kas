/**
 * AI-Powered Auto-Response for SMS
 * Generates immediate, contextual replies to incoming messages
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { IntentAnalysis } from './ai-intent'
import type { Tenant } from './tenant'
import { getTenantServiceDescription, getTenantBusinessContext, tenantUsesFeature, formatTenantCurrency } from './tenant'

// =====================================================================
// POST-PROCESSING: Sanitize AI output before sending as SMS
// =====================================================================

function sanitizeAIResponse(text: string): string {
  let cleaned = text
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu, '')
  cleaned = cleaned.replace(/\u2014/g, ',').replace(/\u2013/g, '-')
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^[-*+]\s+/gm, '')
  // Strip any sentence containing "email" (model keeps asking despite instructions)
  if (cleaned.toLowerCase().includes('email')) {
    const sentences = cleaned.split(/(?<=[.!?])\s+/)
    cleaned = sentences.filter(s => !s.toLowerCase().includes('email')).join(' ')
    console.log('[SMS Sanitizer] Stripped email-asking sentence(s)')
  }
  // Clean up whitespace
  cleaned = cleaned.replace(/  +/g, ' ').replace(/ +\n/g, '\n').trim()
  if (cleaned !== text) console.log('[SMS Sanitizer] Cleaned AI output — removed emojis/dashes/markdown/email-asks')
  return cleaned
}

function autoSplitLongMessage(text: string, maxChars: number = 200): string {
  if (text.includes('|||') || text.length <= maxChars) return text
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g)
  if (!sentences || sentences.length <= 1) return text
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.slice(0, 3).join('|||')
}

export interface AutoResponseResult {
  response: string
  shouldSend: boolean
  reason: string
  escalation?: {
    shouldEscalate: boolean
    reasons: string[]
  }
  bookingComplete?: boolean
  /**
   * True when this response is the pre-quote rapport / value-build turn that
   * fires once per lead lifecycle BEFORE the quote link is sent. The webhook
   * caller is responsible for stamping `customers.pre_quote_rapport_sent_at`
   * when this is true.
   *
   * Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md (Build 1 #2)
   */
  rapportSent?: boolean
}

/**
 * Strip dollar / currency tokens from an SMS body. Defense-in-depth against
 * the AI leaking a price into the SMS — price MUST live only on the quote
 * page, never in plain text. Runs when a [BOOKING_COMPLETE] tag is present
 * (i.e. the system is about to send the quote link separately, so any number
 * the AI wrote is redundant and harmful).
 *
 * Exported for unit testing.
 *
 * Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md (Build 1 #1)
 */
export function stripCurrencyForQuoteSend(text: string): { stripped: string; didStrip: boolean } {
  let cleaned = text
  let didStrip = false

  // $123, $123.45, $1,234.56
  const dollarRe = /\$\s*\d{1,3}(?:[,\d]{0,8})?(?:\.\d{1,2})?/g
  if (dollarRe.test(cleaned)) {
    didStrip = true
    cleaned = cleaned.replace(dollarRe, 'your price')
  }

  // 123 USD, 123 CAD, 123 dollars
  const currencyWordRe = /\b\d{1,4}(?:[,\d]{0,8})?(?:\.\d{1,2})?\s*(?:USD|CAD|dollars|bucks)\b/gi
  if (currencyWordRe.test(cleaned)) {
    didStrip = true
    cleaned = cleaned.replace(currencyWordRe, 'your price')
  }

  // CA$123, US$123
  const prefixedSymbolRe = /\b(?:CA|US)\$\s*\d{1,4}(?:[,\d]{0,8})?(?:\.\d{1,2})?/gi
  if (prefixedSymbolRe.test(cleaned)) {
    didStrip = true
    cleaned = cleaned.replace(prefixedSymbolRe, 'your price')
  }

  // Collapse repeated "your price" or "your price your price"
  cleaned = cleaned.replace(/(?:your price\s*){2,}/g, 'your price ')
  // Collapse extra whitespace
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()

  return { stripped: cleaned, didStrip }
}

/**
 * Pure helper: compute rapport-first gate + takeover-resume awareness from
 * customer context + known facts. Extracted from `generateHouseCleaningResponse`
 * so it can be unit-tested without mocking the AI clients.
 *
 * - `shouldDeliverRapportFirst` is true when the AI has all booking facts
 *   (bed/bath + address) AND the customer has never received the pre-quote
 *   rapport message AND they are not a retargeting reply / returning customer
 *   / customer with an active job.
 * - `humanTakeoverRecentlyEnded` is true when human_takeover_until expired
 *   within the last 24h OR is about to expire within 5 minutes — both states
 *   require the AI to read history carefully on resume.
 *
 * Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md (Build 1 #2 + #3)
 */
export interface RapportGateInput {
  knownCustomerInfo?: KnownCustomerInfo
  customerContext?: CustomerContext | null
  isRetargetingReply?: boolean
  /** Override Date.now() for deterministic tests */
  nowMs?: number
}
export interface RapportGateResult {
  shouldDeliverRapportFirst: boolean
  humanTakeoverRecentlyEnded: boolean
}
export function computeRapportGate(input: RapportGateInput): RapportGateResult {
  const { knownCustomerInfo, customerContext, isRetargetingReply } = input
  const now = input.nowMs ?? Date.now()

  const hasBedBath = !!(knownCustomerInfo?.bedrooms && knownCustomerInfo?.bathrooms)
  const hasAddress = !!knownCustomerInfo?.address
  const bookingFactsReady = hasBedBath && hasAddress

  const rapportAlreadySent = !!customerContext?.customer?.pre_quote_rapport_sent_at
  const suppressRapport = !!isRetargetingReply
    || (customerContext?.activeJobs?.length ?? 0) > 0
    || (customerContext?.totalJobs ?? 0) > 0

  const shouldDeliverRapportFirst = bookingFactsReady && !rapportAlreadySent && !suppressRapport

  const takeoverUntilStr = customerContext?.customer?.human_takeover_until
  let humanTakeoverRecentlyEnded = false
  if (takeoverUntilStr) {
    const t = new Date(takeoverUntilStr).getTime()
    if (!Number.isNaN(t)) {
      const expiredRecently = t < now && now - t < 24 * 60 * 60 * 1000
      const aboutToExpire = t > now && t - now < 5 * 60 * 1000
      humanTakeoverRecentlyEnded = expiredRecently || aboutToExpire
    }
  }

  return { shouldDeliverRapportFirst, humanTakeoverRecentlyEnded }
}

/**
 * Generate an AI-powered auto-response based on the incoming message and intent analysis
 */
export interface KnownCustomerInfo {
  firstName?: string | null
  lastName?: string | null
  address?: string | null
  email?: string | null
  phone?: string | null
  source?: string | null // "housecall_pro", "ghl", etc.
  bedrooms?: number | null
  bathrooms?: number | null
  serviceType?: string | null
  frequency?: string | null
  estimatedPrice?: number | null
}

export interface AutoResponseOptions {
  isReturningCustomer?: boolean
  isRetargetingReply?: boolean
  customerContext?: CustomerContext | null
}

// =====================================================================
// CUSTOMER CONTEXT — loaded before AI calls for situation awareness
// =====================================================================

export interface CustomerContext {
  // Active jobs (scheduled or in_progress)
  activeJobs: Array<{
    id: number
    service_type: string | null
    date: string | null
    scheduled_at: string | null
    price: number | null
    status: string
    address: string | null
    cleaner_name: string | null
  }>
  // Recent completed jobs (last 3)
  recentJobs: Array<{
    id: number
    service_type: string | null
    date: string | null
    price: number | null
    completed_at: string | null
  }>
  // Customer profile
  customer: {
    id: number
    first_name: string | null
    last_name: string | null
    email: string | null
    address: string | null
    notes: string | null
    housecall_pro_customer_id: string | number | null
    /** When AI sent the pre-quote rapport turn. NULL = not yet sent. (Build 1 #2) */
    pre_quote_rapport_sent_at: string | null
    /** Active human-operator hold; AI must NOT auto-respond while in the future. (Build 1 #3) */
    human_takeover_until: string | null
  } | null
  // Lead record (if exists)
  lead: {
    id: number
    status: string
    source: string | null
    form_data: any
  } | null
  // Lifetime stats
  totalJobs: number
  totalSpend: number
}

/**
 * Load full customer context for a phone number.
 * Used to give the AI awareness of who's texting and their current status.
 */
export async function loadCustomerContext(
  client: any,
  tenantId: string,
  phone: string,
  customerId?: number
): Promise<CustomerContext> {
  // Run all queries in parallel
  const [activeJobsRes, recentJobsRes, customerRes, leadRes, statsRes] = await Promise.all([
    // Active jobs (scheduled or in_progress)
    client
      .from("jobs")
      .select("id, service_type, date, scheduled_at, price, status, address, cleaner_id, cleaners(name)")
      .eq("tenant_id", tenantId)
      .or(phone ? `phone_number.eq.${phone},customer_phone.eq.${phone}${customerId ? `,customer_id.eq.${customerId}` : ''}` : `customer_id.eq.${customerId || 0}`)
      .in("status", ["scheduled", "in_progress"])
      .order("scheduled_at", { ascending: true })
      .limit(5),

    // Recent completed jobs
    client
      .from("jobs")
      .select("id, service_type, date, price, completed_at")
      .eq("tenant_id", tenantId)
      .or(`phone_number.eq.${phone},customer_phone.eq.${phone}${customerId ? `,customer_id.eq.${customerId}` : ''}`)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(3),

    // Customer profile (Build 1: also fetch rapport + takeover state for messaging-flow gating)
    customerId
      ? client.from("customers").select("id, first_name, last_name, email, address, notes, housecall_pro_customer_id, pre_quote_rapport_sent_at, human_takeover_until").eq("id", customerId).eq("tenant_id", tenantId).maybeSingle()
      : client.from("customers").select("id, first_name, last_name, email, address, notes, housecall_pro_customer_id, pre_quote_rapport_sent_at, human_takeover_until").eq("tenant_id", tenantId).eq("phone_number", phone).maybeSingle(),

    // Lead record
    client
      .from("leads")
      .select("id, status, source, form_data")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Lifetime stats
    client
      .from("jobs")
      .select("id, price")
      .eq("tenant_id", tenantId)
      .or(`phone_number.eq.${phone},customer_phone.eq.${phone}${customerId ? `,customer_id.eq.${customerId}` : ''}`)
      .eq("status", "completed"),
  ])

  const activeJobs = (activeJobsRes.data || []).map((j: any) => ({
    id: j.id,
    service_type: j.service_type,
    date: j.date,
    scheduled_at: j.scheduled_at,
    price: j.price,
    status: j.status,
    address: j.address,
    cleaner_name: j.cleaners?.name || null,
  }))

  const recentJobs = (recentJobsRes.data || []).map((j: any) => ({
    id: j.id,
    service_type: j.service_type,
    date: j.date,
    price: j.price,
    completed_at: j.completed_at,
  }))

  const completedJobs = statsRes.data || []
  const totalJobs = completedJobs.length
  const totalSpend = completedJobs.reduce((sum: number, j: any) => sum + (j.price || 0), 0)

  return {
    activeJobs,
    recentJobs,
    customer: customerRes.data || null,
    lead: leadRes.data || null,
    totalJobs,
    totalSpend,
  }
}

/** Convert raw ISO dates/timestamps to human-readable for LLM context */
function formatDateForContext(raw: string, timezone: string): string {
  try {
    // Handle "2026-03-05" (date only)
    const dateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (dateOnly) {
      const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    }
    // Handle ISO timestamps like "2026-03-05T14:00:00.000Z"
    const d = new Date(raw)
    if (!isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone,
      }).format(d)
    }
    return raw
  } catch {
    return raw
  }
}

/**
 * Serialize customer context into a text block for AI system prompts.
 */
export function formatCustomerContextForPrompt(ctx: CustomerContext, tenant: Tenant): string {
  const parts: string[] = []

  // Active jobs
  if (ctx.activeJobs.length > 0) {
    parts.push('== AUTHORITATIVE APPOINTMENT (source of truth — overrides anything said earlier in conversation) ==')
    for (const job of ctx.activeJobs) {
      const rawDate = job.date || job.scheduled_at || ''
      const datePart = rawDate ? formatDateForContext(rawDate, tenant.timezone || 'America/Chicago') : 'TBD'
      const cleanerPart = job.cleaner_name ? ` | Cleaner: ${job.cleaner_name}` : ''
      const pricePart = job.price ? ` | Price: ${formatTenantCurrency(tenant, Number(job.price))}` : ''
      parts.push(`  - ${(job.service_type || 'Cleaning').replace(/_/g, ' ')} on ${datePart} (${job.status})${pricePart}${cleanerPart}`)
    }
    parts.push('')
    parts.push('CRITICAL — The appointment above is the current, correct time. If earlier messages in the conversation mention a different date/time (e.g., the time was corrected after the first proposal), the AUTHORITATIVE time above is right and the earlier mention is stale. Always state the authoritative time in your reply.')
    parts.push('This customer has an active booking. Do NOT try to re-book them or run the booking flow.')
    parts.push('Instead, help them with questions about their upcoming service (date, time, what to expect, prep instructions).')
    parts.push('If they want to reschedule, cancel, or have a complaint, use [ESCALATE:reason].')
    parts.push('')
  }

  // Service history
  if (ctx.totalJobs > 0) {
    parts.push(`CUSTOMER HISTORY: ${ctx.totalJobs} completed job${ctx.totalJobs > 1 ? 's' : ''}, ${formatTenantCurrency(tenant, Number(ctx.totalSpend) || 0)} total spend`)
    if (ctx.recentJobs.length > 0) {
      parts.push('Recent jobs:')
      for (const job of ctx.recentJobs) {
        const rawDate = job.date || job.completed_at || ''
        const jobDate = rawDate ? formatDateForContext(rawDate, tenant.timezone || 'America/Chicago') : 'unknown'
        parts.push(`  - ${(job.service_type || 'Cleaning').replace(/_/g, ' ')} on ${jobDate} (${formatTenantCurrency(tenant, Number(job.price) || 0)})`)
      }
    }
    if (ctx.activeJobs.length === 0) {
      parts.push('')
      parts.push('This is a RETURNING customer. Welcome them back warmly. They already know the service.')
      parts.push('If they want to rebook, use their previous preferences as defaults (confirm, don\'t re-ask everything).')
    }
    parts.push('')
  }

  // Customer profile — only provide first name to avoid LLM using last name in messages
  if (ctx.customer) {
    if (ctx.customer.first_name) parts.push(`Customer first name: ${ctx.customer.first_name}`)
    if (ctx.customer.email) parts.push(`Email on file: ${ctx.customer.email}`)
    if (ctx.customer.address) parts.push(`Address on file: ${ctx.customer.address}`)
    if (ctx.customer.notes) parts.push(`Notes: ${ctx.customer.notes}`)
    parts.push('')
  }

  // ── KNOWN FACTS FROM FORM SUBMISSION (T3 — 2026-04-20) ─────────────
  // Linda Kingcade submitted the Texas Nova estimate form with bedrooms,
  // bathrooms, sqft, service, email and estimate. The SMS agent then asked
  // her for ALL of that again. Customers hate redundant intake. Surface the
  // form fields as "already known" and tell the agent to only ask for gaps.
  if (ctx.lead?.form_data && typeof ctx.lead.form_data === 'object') {
    const fd = ctx.lead.form_data as Record<string, unknown>
    const knownLines: string[] = []
    const pushIf = (label: string, val: unknown) => {
      if (val !== null && val !== undefined && String(val).trim() !== '') knownLines.push(`${label}: ${val}`)
    }
    pushIf('Name', fd.name || [fd.first_name, fd.last_name].filter(Boolean).join(' '))
    pushIf('Address', fd.address)
    pushIf('City', fd.city)
    pushIf('Email', fd.email)
    pushIf('Bedrooms', fd.bedrooms)
    pushIf('Bathrooms', fd.bathrooms)
    pushIf('Half baths', fd.half_baths || fd.halfBathrooms)
    pushIf('Sqft', fd.sqft || fd.square_footage || fd.squareFootage || fd.sqft_range)
    pushIf('Service', (fd.service_type as string) || (fd.serviceType as string))
    pushIf('Frequency', fd.frequency)
    pushIf('Estimate shown on form', fd.estimated_price ? `$${fd.estimated_price}` : null)
    pushIf('Preferred date', fd.preferred_date || fd.preferredDate)
    pushIf('Message/notes', fd.message || fd.notes)

    if (knownLines.length > 0) {
      parts.push('== KNOWN FACTS FROM FORM SUBMISSION (do NOT re-ask) ==')
      parts.push(...knownLines)
      parts.push('')
      parts.push('CRITICAL: These fields were already collected via the website form. NEVER re-ask for anything in the list above. Only ask for what is STILL MISSING (e.g., if address is unknown and you need it to book, ask for address — but do NOT ask for bedrooms/bathrooms/email/service type if they are listed above).')
      parts.push('If the customer restates one of the known facts, acknowledge briefly and move the conversation forward — do not re-collect.')
      parts.push('')
    }
  }

  if (parts.length === 0) {
    return '' // New customer, no context to add
  }

  return '\n\n== CUSTOMER CONTEXT ==\n' + parts.join('\n')
}

export async function generateAutoResponse(
  incomingMessage: string,
  intentAnalysis: IntentAnalysis,
  tenant: Tenant | null,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  knownCustomerInfo?: KnownCustomerInfo,
  options?: AutoResponseOptions
): Promise<AutoResponseResult> {
  // Don't respond to obvious opt-outs (exact match to avoid "don't stop calling me" false positives)
  const lowerMessage = incomingMessage.toLowerCase().trim()
  const optOutExact = ['stop', 'unsubscribe', 'opt out', 'optout', 'cancel texts', 'quit']
  if (optOutExact.includes(lowerMessage)) {
    return {
      response: '',
      shouldSend: false,
      reason: 'Opt-out message detected'
    }
  }

  // Don't respond to very short acknowledgments that don't need a reply
  // BUT: "yes", "no", "sure" could be responses to our questions - let AI handle those
  const noReplyNeeded = ['ok', 'k', 'kk', 'thanks', 'thx', 'ty', 'cool', 'great', 'got it', 'okay', 'np']
  if (noReplyNeeded.includes(lowerMessage)) {
    return {
      response: '',
      shouldSend: false,
      reason: 'Simple acknowledgment, no reply needed'
    }
  }

  // Special handling for "yes" / "no" / "sure" - these are likely responses to our questions
  const isAffirmativeResponse = ['yes', 'yeah', 'yep', 'yup', 'sure', 'absolutely', 'definitely'].includes(lowerMessage)
  const isNegativeResponse = ['no', 'nope', 'nah', 'not really', 'no thanks'].includes(lowerMessage)

  // TENANT ISOLATION — SMS BOOKING PROMPTS:
  // use_hcp_mirror=true  → WinBros window/pressure/gutter SMS flow
  // use_hcp_mirror=false → Cedar Rapids house cleaning SMS flow
  // These use completely different AI prompts. Do NOT merge them.
  // If adding a new service type, create a new response generator + feature flag.
  if (tenant && tenantUsesFeature(tenant, 'use_hcp_mirror')) {
    try {
      return await generateWinBrosResponse(incomingMessage, tenant, conversationHistory, knownCustomerInfo, options?.isReturningCustomer, options?.customerContext, options?.isRetargetingReply)
    } catch (error) {
      console.error('[Auto-Response] Window cleaning response failed, falling back to generic:', error)
    }
  }

  // House cleaning SMS booking flow (all non-window-cleaning tenants)
  if (tenant && !tenantUsesFeature(tenant, 'use_hcp_mirror')) {
    try {
      return await generateHouseCleaningResponse(incomingMessage, tenant, conversationHistory, knownCustomerInfo, options?.isReturningCustomer, options?.customerContext, options?.isRetargetingReply)
    } catch (error) {
      console.error('[Auto-Response] House cleaning response failed, falling back to generic:', error)
    }
  }

  const businessName = tenant?.business_name_short || tenant?.business_name || 'WinBros'
  const sdrName = tenant?.sdr_persona || 'Mary'
  const serviceArea = tenant?.service_area || 'your area'
  // Get the service type from tenant - this differentiates window cleaning from house cleaning etc.
  const serviceType = tenant ? getTenantServiceDescription(tenant) : 'cleaning'
  const businessContext = tenant ? getTenantBusinessContext(tenant) : `${businessName} is a professional ${serviceType} service`

  // Try AI generation first
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  // Build context about the message type
  const messageContext: MessageContext = {
    isAffirmativeResponse,
    isNegativeResponse,
    hasConversationHistory: !!(conversationHistory && conversationHistory.length > 0),
  }

  if (anthropicKey) {
    try {
      return await generateWithClaude(
        incomingMessage,
        intentAnalysis,
        businessName,
        sdrName,
        serviceType,
        businessContext,
        conversationHistory,
        messageContext
      )
    } catch (error) {
      console.error('[Auto-Response] Claude generation failed, trying OpenAI:', error)
    }
  }

  if (openaiKey) {
    try {
      return await generateWithOpenAI(
        incomingMessage,
        intentAnalysis,
        businessName,
        sdrName,
        serviceType,
        businessContext,
        conversationHistory,
        messageContext
      )
    } catch (error) {
      console.error('[Auto-Response] OpenAI generation failed, using fallback:', error)
    }
  }

  // Fallback to template-based responses
  return generateFallbackResponse(incomingMessage, intentAnalysis, businessName, sdrName, serviceType, conversationHistory, messageContext)
}

interface MessageContext {
  isAffirmativeResponse: boolean
  isNegativeResponse: boolean
  hasConversationHistory: boolean
}

/**
 * Generate response using Claude
 */
async function generateWithClaude(
  message: string,
  intent: IntentAnalysis,
  businessName: string,
  sdrName: string,
  serviceType: string,
  businessContext: string,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  messageContext?: MessageContext
): Promise<AutoResponseResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const historyContext = conversationHistory?.length
    ? `\nRecent conversation:\n${conversationHistory.slice(-30).map(m => `${m.role === 'client' ? 'Customer' : 'Us'}: ${m.content}`).join('\n')}\n`
    : ''

  // Build context about the response type
  let responseTypeHint = ''
  if (messageContext?.isAffirmativeResponse && messageContext?.hasConversationHistory) {
    responseTypeHint = '\nIMPORTANT: Customer said "yes" - this is likely a response to our last question. Continue the booking conversation based on what we last asked.'
  } else if (messageContext?.isNegativeResponse && messageContext?.hasConversationHistory) {
    responseTypeHint = '\nIMPORTANT: Customer said "no" - acknowledge gracefully and try a different approach to keep them engaged.'
  }

  // Build service-specific guidance
  const serviceGuidance = serviceType === 'window cleaning'
    ? 'Ask about number of windows, stories, or when they last had windows cleaned.'
    : serviceType === 'house cleaning'
    ? 'Ask about bedrooms, bathrooms, or square footage.'
    : `Ask relevant questions for ${serviceType}.`

  // Detect if customer provided an email address (passive extraction only)
  const emailMatch = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  const emailHint = emailMatch
    ? `\nIMPORTANT: Customer provided their email address (${emailMatch[0]}). Acknowledge receipt briefly. Do NOT promise to send anything to that email unless the customer explicitly asked to be emailed. The quote link delivered via SMS is the default path.`
    : ''

  // Detect if customer is confirming/responding to our previous message
  const isConfirming = messageContext?.isAffirmativeResponse && messageContext?.hasConversationHistory
  const confirmHint = isConfirming
    ? `\nIMPORTANT: Customer is confirming. Acknowledge and continue the booking flow with the quote link via SMS. Do NOT ask for email.`
    : ''

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are ${sdrName}, a friendly sales rep for ${businessContext}.

${historyContext}
Customer just texted: "${message}"
${responseTypeHint}${emailHint}${confirmHint}

Intent analysis: ${intent.hasBookingIntent ? 'INTERESTED in booking' : 'Not clearly interested'} (${intent.confidence} confidence)
${intent.extractedInfo.serviceType ? `Service mentioned: ${intent.extractedInfo.serviceType}` : ''}
${intent.extractedInfo.preferredDate ? `Date mentioned: ${intent.extractedInfo.preferredDate}` : ''}

Write a SHORT, friendly SMS reply (under 160 chars if possible, max 300 chars).

Rules:
- Be warm but professional
- Don't use emojis excessively (1-2 max)
- NEVER offer discounts, deals, or promotional pricing. You have NO authority to change prices.
- CRITICAL — BOOKING LANGUAGE: NEVER use phrases like "you're all set", "you're booked", "you're confirmed", "we've got you booked", "scheduled for [day]", "locked in for", "booking confirmed", or "see you [day]" unless the system has already created a confirmed booking. If you are discussing or proposing a time, use proposal language only: "Want me to hold [time] for you?" or "I can lock that in once you confirm" or "Let me pencil you in — I'll confirm once it's locked." The system emits the real confirmation message automatically when a booking is created; you do NOT author confirmations.
- CRITICAL: Read the conversation history carefully. Respond to what the customer is actually saying.
- NEVER ask for email. NEVER promise to email anything. The quote link is delivered via SMS. Email sends only happen if the customer explicitly asks ("email me", "send to my email", "prefer email").
- If they confirmed something (yes/yup/sure), acknowledge and continue the booking flow with the SMS quote link.
- If they volunteered an email address, briefly acknowledge receipt (we'll store it for their record) but keep the follow-up on SMS.
- If they already have a booking, do NOT ask generic questions about service needs. Continue the booking conversation.
- Only ask about ${serviceType} details if this is a NEW inquiry with no prior conversation.
- Never repeat information or questions that were already covered.
- Never be pushy or salesy
- Sign off as ${sdrName} only on first contact (not if there's conversation history)

Return ONLY the SMS text, nothing else.`
      }
    ],
  })

  const textContent = response.content.find(block => block.type === 'text')
  const smsText = textContent?.type === 'text' ? textContent.text.trim() : ''

  if (!smsText) {
    throw new Error('Empty response from Claude')
  }

  return {
    response: sanitizeAIResponse(autoSplitLongMessage(smsText)),
    shouldSend: true,
    reason: 'AI-generated response'
  }
}

/**
 * Generate response using OpenAI
 */
async function generateWithOpenAI(
  message: string,
  intent: IntentAnalysis,
  businessName: string,
  sdrName: string,
  serviceType: string,
  businessContext: string,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  messageContext?: MessageContext
): Promise<AutoResponseResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const historyContext = conversationHistory?.length
    ? `\nRecent conversation:\n${conversationHistory.slice(-30).map(m => `${m.role === 'client' ? 'Customer' : 'Us'}: ${m.content}`).join('\n')}\n`
    : ''

  // Build context about the response type
  let responseTypeHint = ''
  if (messageContext?.isAffirmativeResponse && messageContext?.hasConversationHistory) {
    responseTypeHint = 'Customer said YES - continue based on your last question. '
  } else if (messageContext?.isNegativeResponse && messageContext?.hasConversationHistory) {
    responseTypeHint = 'Customer said NO - acknowledge gracefully, try different approach. '
  }

  // Detect email in message (passive extraction)
  const emailMatch = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  const emailHint = emailMatch ? ` Customer provided email (${emailMatch[0]}) - briefly acknowledge receipt. Do NOT promise to send anything to that email. Continue on SMS.` : ''

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You are ${sdrName}, a friendly sales rep. ${businessContext}. Write short, friendly SMS replies. Keep under 160 chars when possible, max 300. Be warm but not pushy. ${conversationHistory?.length ? 'This is an ongoing conversation - read the history carefully and respond appropriately. Do NOT re-introduce yourself or ask questions that were already answered.' : ''} NEVER ask for email. NEVER promise to email anything. Quote links go via SMS. If customer is confirming (yes/yup), acknowledge and continue on SMS.${emailHint}`
      },
      {
        role: 'user',
        content: `${historyContext}Customer texted: "${message}"
${responseTypeHint}Intent: ${intent.hasBookingIntent ? 'INTERESTED' : 'Unclear'} (${intent.confidence})
${intent.extractedInfo.serviceType ? `Service: ${intent.extractedInfo.serviceType}` : ''}

Write the SMS reply only.`
      }
    ],
  })

  const smsText = response.choices[0]?.message?.content?.trim() || ''

  if (!smsText) {
    throw new Error('Empty response from OpenAI')
  }

  return {
    response: sanitizeAIResponse(autoSplitLongMessage(smsText)),
    shouldSend: true,
    reason: 'AI-generated response'
  }
}

/**
 * Detect when the AI says "someone will reach out" / "we'll get back to you"
 * but didn't include any action tag ([ESCALATE:...], [BOOKING_COMPLETE], [SCHEDULE_READY]).
 * This is the "hand off to nobody" scenario — the AI ended the conversation
 * without triggering any system action.
 */
function detectSilentHandoff(
  rawText: string,
  hasEscalation: boolean,
  hasBookingComplete: boolean,
  hasScheduleReady: boolean,
): boolean {
  if (hasEscalation || hasBookingComplete || hasScheduleReady) return false

  const lower = rawText.toLowerCase()
  const handoffPhrases = [
    'reach out',
    'get back to you',
    'be in touch',
    'will contact you',
    'someone will call',
    'team will',
    'we\'ll reach out',
    'they\'ll reach out',
    'will be reaching out',
    'touch base with you',
  ]

  return handoffPhrases.some(phrase => lower.includes(phrase))
}

/**
 * Safety net: detect when the AI offers specific days/times without emitting [SCHEDULE_READY].
 * This prevents the AI from fabricating availability. If detected, we return true so the
 * caller can inject [SCHEDULE_READY] and let the real scheduler provide actual times.
 */
function detectFakeScheduling(rawText: string, hasScheduleReady: boolean): boolean {
  if (hasScheduleReady) return false

  const lower = rawText.toLowerCase()

  // Check for day-of-week offers like "How about Monday or Tuesday?"
  const dayPattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/
  const dayMatches = lower.match(new RegExp(dayPattern, 'g'))
  const hasMultipleDays = dayMatches && dayMatches.length >= 2

  // Check for time offers like "9am", "10:00 AM", "around 2"
  const timePattern = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i
  const hasTimeOffer = timePattern.test(lower)

  // Only flag if the AI is clearly offering scheduling options (multiple days or day+time combos)
  return !!(hasMultipleDays || (dayMatches && hasTimeOffer))
}

/**
 * Fallback template-based responses when AI is unavailable
 */
function generateFallbackResponse(
  message: string,
  intent: IntentAnalysis,
  businessName: string,
  sdrName: string,
  serviceType: string,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  messageContext?: MessageContext
): AutoResponseResult {
  const hasHistory = conversationHistory && conversationHistory.length > 0
  const signoff = hasHistory ? '' : ` -${sdrName}`

  // Service-specific question based on service type
  const quoteQuestion = serviceType === 'window cleaning'
    ? `How many windows or stories does your home have?`
    : serviceType === 'house cleaning'
    ? `How many bedrooms and bathrooms?`
    : `What details can you share about the job?`

  // Handle affirmative responses (yes, yeah, sure, etc.)
  if (messageContext?.isAffirmativeResponse && hasHistory) {
    return {
      response: `Perfect! To get you a quote, I just need a few details. What's the address?`,
      shouldSend: true,
      reason: 'Template: affirmative response'
    }
  }

  // Handle negative responses (no, nope, etc.)
  if (messageContext?.isNegativeResponse && hasHistory) {
    return {
      response: `No problem! If you ever need ${serviceType} help in the future, just text us. Have a great day!`,
      shouldSend: true,
      reason: 'Template: negative response'
    }
  }

  if (intent.hasBookingIntent && intent.confidence !== 'low') {
    // High/medium confidence booking intent
    if (intent.extractedInfo.preferredDate) {
      return {
        response: `Hi! Thanks for reaching out to ${businessName}! I see you're looking at ${intent.extractedInfo.preferredDate}. What's the address?${signoff}`,
        shouldSend: true,
        reason: 'Template: booking intent with date'
      }
    }

    if (intent.extractedInfo.serviceType) {
      return {
        response: `Hi! Thanks for your interest in ${intent.extractedInfo.serviceType}! To get you a quick quote, ${quoteQuestion}${signoff}`,
        shouldSend: true,
        reason: 'Template: booking intent with service type'
      }
    }

    return {
      response: `Hi! Thanks for reaching out to ${businessName}! I'd love to help with your ${serviceType} needs. ${quoteQuestion}${signoff}`,
      shouldSend: true,
      reason: 'Template: general booking intent'
    }
  }

  // Question or inquiry without clear booking intent
  if (message.includes('?')) {
    return {
      response: hasHistory
        ? `Happy to help! Are you looking for ${serviceType} services? I can get you a quick quote.`
        : `Hi! This is ${sdrName} from ${businessName}. Happy to help! Are you looking for ${serviceType} services? I can get you a quick quote.`,
      shouldSend: true,
      reason: 'Template: question response'
    }
  }

  // Default engagement response
  return {
    response: hasHistory
      ? `Thanks for texting! Are you looking for ${serviceType} help? I'd be happy to get you a quote.`
      : `Hi! This is ${sdrName} from ${businessName}. Thanks for texting! Are you looking for ${serviceType} help? I'd be happy to get you a quote.`,
    shouldSend: true,
    reason: 'Template: default engagement'
  }
}

// =====================================================================
// WINBROS-SPECIFIC SMS RESPONSE
// =====================================================================

/**
 * Generate a WinBros-specific SMS response using the dedicated estimate prompt.
 * Mirrors the VAPI phone call flow: service type, name, address, referral,
 * then system provides 3 available times, customer picks, then email.
 */
async function generateWinBrosResponse(
  message: string,
  tenant: Tenant,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  knownCustomerInfo?: KnownCustomerInfo,
  isReturningCustomer?: boolean,
  customerContext?: CustomerContext | null,
  isRetargetingReply?: boolean,
): Promise<AutoResponseResult> {
  const { buildWinBrosEstimatePrompt, detectEscalation, detectBookingComplete, detectScheduleReady, stripEscalationTags } = await import('./winbros-sms-prompt')

  const systemPrompt = buildWinBrosEstimatePrompt()
  const sdrName = tenant.sdr_persona || 'Mary'
  const businessName = tenant.business_name_short || tenant.business_name || 'WinBros'

  const historyContext = conversationHistory?.length
    ? conversationHistory.slice(-50).map(m => `${m.role === 'client' ? 'Customer' : sdrName}: ${m.content}`).join('\n')
    : '(No prior messages — this is a new conversation.)'

  // ── HCP Customer Brain ──
  // Pull all HCP data to give the AI full context about this customer
  let hcpBrainBlock = ''
  if (tenant.housecall_pro_api_key && customerContext?.customer?.housecall_pro_customer_id) {
    try {
      const { getCustomerHCPBrain, formatHCPBrainForPrompt } = await import('./housecall-pro-api')
      const brain = await getCustomerHCPBrain(tenant, String(customerContext.customer.housecall_pro_customer_id))
      if (brain) {
        hcpBrainBlock = '\n\n' + formatHCPBrainForPrompt(brain)
      }
    } catch (err) {
      console.warn(`[WinBros AI] HCP brain load failed:`, err)
    }
  }

  // ── Assistant Memory ──
  // Load remembered facts from past conversations
  let memoryBlock = ''
  if (customerContext?.customer?.id) {
    try {
      const { buildMemoryContext } = await import('./assistant-memory')
      const memCtx = await buildMemoryContext(tenant.id, customerContext.customer.id, conversationHistory || [])
      if (memCtx) {
        memoryBlock = '\n\n' + memCtx
      }
    } catch (err) {
      console.warn(`[WinBros AI] Memory load failed:`, err)
    }
  }

  // Build known info context so the AI can confirm rather than re-ask
  let knownInfoBlock = ''
  if (knownCustomerInfo) {
    const parts: string[] = []
    if (knownCustomerInfo.firstName) {
      parts.push(`First name: ${knownCustomerInfo.firstName}`)
    }
    if (knownCustomerInfo.address) {
      parts.push(`Address on file: ${knownCustomerInfo.address}`)
    }
    if (knownCustomerInfo.email) {
      parts.push(`Email on file: ${knownCustomerInfo.email}`)
    }
    if (knownCustomerInfo.bedrooms) {
      parts.push(`Bedrooms: ${knownCustomerInfo.bedrooms}`)
    }
    if (knownCustomerInfo.bathrooms) {
      parts.push(`Bathrooms: ${knownCustomerInfo.bathrooms}`)
    }
    if (knownCustomerInfo.serviceType) {
      parts.push(`Service type: ${knownCustomerInfo.serviceType.replace(/[-_]/g, ' ')}`)
    }
    if (knownCustomerInfo.frequency) {
      parts.push(`Frequency: ${knownCustomerInfo.frequency.replace(/[-_]/g, ' ')}`)
    }
    if (knownCustomerInfo.estimatedPrice) {
      parts.push(`Estimated price: $${knownCustomerInfo.estimatedPrice}`)
    }
    // NOTE: knownCustomerInfo.source is an internal system field (e.g. "sms", "housecall_pro")
    // that tracks how the lead was created — NOT how the customer heard about the business.
    // Do NOT include it — the AI would mistake it for the "how did you hear about us" answer.
    if (parts.length > 0) {
      knownInfoBlock = `\n\nINFO ALREADY ON FILE FOR THIS CUSTOMER:\n${parts.join('\n')}\nWhen you reach the step for any info listed above, CONFIRM it instead of asking. But still follow the step order — don't jump ahead to confirm these early.\n`
    }
  }

  let returningCustomerBlock = ''
  if (isRetargetingReply) {
    returningCustomerBlock = '\n\nIMPORTANT: This customer is replying to a retargeting text we sent them. They already know who we are. Do NOT pitch them immediately or list service types right away. Just be conversational and warm, like a friend checking in. Ask how you can help or what they had in mind. Build rapport first, let THEM tell you what they need. Only start collecting booking info once they express clear interest.\n'
  } else if (isReturningCustomer) {
    returningCustomerBlock = '\n\nIMPORTANT: This customer previously used our services and is replying to a seasonal promotional offer we sent them. Treat them as a valued returning customer. Be warm, thank them for being a returning client, reference their past experience with us, and make rebooking easy. Do NOT treat them like a cold new lead.\n'
  }

  // Inject customer context (active jobs, history, profile) for situation awareness
  const contextBlock = customerContext ? formatCustomerContextForPrompt(customerContext, tenant) : ''

  const tz = tenant.timezone || 'America/Chicago'
  const now = new Date()
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz,
  }).format(now)
  const timeStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(now)
  const today = `${dateStr} (current time: ${timeStr})`

  // AI learning: frustration detection + winning pattern injection
  let winbrosLearningBlock = ''
  try {
    const { detectFrustration, findSimilarWinningConversations } = await import('./conversation-scoring')

    if (conversationHistory?.length) {
      const frustration = detectFrustration(
        conversationHistory.map(m => ({ role: m.role === 'client' ? 'client' : 'assistant', content: m.content })),
        message
      )
      if (frustration.frustrated) {
        winbrosLearningBlock += `\n\nWARNING: Customer seems frustrated (signals: ${frustration.signals.join(', ')}). Give a DIRECT answer. Don't ask more questions. If they want a price, give one NOW.\n`
      }
    }

    const patterns = await findSimilarWinningConversations(tenant.id, message, 3)
    if (patterns.length > 0) {
      winbrosLearningBlock += '\n\nWINNING PATTERNS FROM SIMILAR CONVERSATIONS (TACTICS ONLY — IGNORE ALL DOLLAR AMOUNTS, NEVER offer discounts or deals):\n'
      for (const p of patterns) {
        winbrosLearningBlock += `- ${p.conversation_summary}`
        if (p.patterns && typeof p.patterns === 'object' && 'winning_tactics' in p.patterns) {
          const tactics = (p.patterns as { winning_tactics?: string[] }).winning_tactics
          if (tactics?.length) {
            winbrosLearningBlock += ` (what worked: ${tactics.join(', ')})`
          }
        }
        winbrosLearningBlock += '\n'
      }
      winbrosLearningBlock += 'Use these patterns to guide your tone and approach.\n'
    }
  } catch (learningErr) {
    console.warn('[WinBros AI] Learning injection failed (non-blocking):', learningErr)
  }

  const userMessage = `Today's date: ${today}\n\nConversation so far:\n${historyContext}${knownInfoBlock}${returningCustomerBlock}${contextBlock}${hcpBrainBlock}${memoryBlock}${winbrosLearningBlock}\n\nCustomer just texted: "${message}"\n\nRespond as ${sdrName}. Write ONLY the SMS text (and tags like [SCHEDULE_READY] or [BOOKING_COMPLETE] if needed). Nothing else.`

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    })

    const textContent = response.content.find(block => block.type === 'text')
    const rawText = textContent?.type === 'text' ? textContent.text.trim() : ''

    if (!rawText) {
      throw new Error('Empty response from Claude (WinBros)')
    }

    const lastCustomerMsg = conversationHistory?.filter(m => m.role === 'client').pop()?.content
    const escalation = detectEscalation(rawText, conversationHistory, lastCustomerMsg)
    const isBookingComplete = detectBookingComplete(rawText)
    let isScheduleReady = detectScheduleReady(rawText)
    let cleanResponse = sanitizeAIResponse(autoSplitLongMessage(stripEscalationTags(rawText)))

    // Safety net: if the AI offered specific days/times without [SCHEDULE_READY],
    // strip the fake times and trigger the real scheduler instead.
    if (!isScheduleReady && detectFakeScheduling(rawText, isScheduleReady)) {
      console.warn('[WinBros AI] Safety net: AI offered fake times without [SCHEDULE_READY], injecting scheduler')
      isScheduleReady = true
      // Strip the AI's fabricated scheduling text — scheduler will provide real times
      cleanResponse = 'Let me check what times we have available for your estimate!'
    }

    // Safety net: if the AI said "reach out" / "get back to you" but didn't include
    // any action tag, treat it as a silent escalation so the owner gets notified.
    const silentHandoff = detectSilentHandoff(rawText, escalation.shouldEscalate, isBookingComplete, isScheduleReady)

    // If the AI says it's ready to schedule, call the estimate scheduler
    // and append the available time options to the response
    // BUT: if times were already offered in conversation, skip re-scheduling
    if (isScheduleReady) {
      const timesAlreadyOffered = conversationHistory?.some(m =>
        m.role === 'assistant' &&
        /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b.*\b(AM|PM)\b/i.test(m.content) &&
        /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i.test(m.content)
      )
      if (timesAlreadyOffered) {
        console.log('[WinBros AI] Times already offered in conversation — skipping re-schedule, letting AI confirm')
        isScheduleReady = false
        // Strip the "Let me check..." preamble since we're not re-scheduling
        if (cleanResponse.includes('Let me check what times')) {
          cleanResponse = cleanResponse.replace(/Let me check what times.*$/i, '').trim()
        }
        // If the AI response is now empty or just the schedule text, let it confirm the booking
        if (!cleanResponse || cleanResponse.length < 10) {
          cleanResponse = `Perfect! We'll get that on the calendar for you.`
        }
      }
    }
    if (isScheduleReady) {
      const timeOptions = await getEstimateTimeOptions(tenant, conversationHistory, knownCustomerInfo)
      if (timeOptions) {
        cleanResponse = cleanResponse + '\n\n' + timeOptions
      } else {
        // Scheduler couldn't find slots - still continue the booking flow!
        // Ask for email so we can create the job and assign a salesman who will
        // coordinate the date directly with the customer.
        cleanResponse = cleanResponse + '\n\nOur schedule is filling up fast but we\'ll get you in! What\'s your best email? I\'ll send over your confirmed estimate details.'
        // Signal booking complete so job gets created + salesman assigned
        return {
          response: cleanResponse,
          shouldSend: true,
          reason: 'WinBros AI - scheduler full, continuing to email capture',
          escalation: { shouldEscalate: true, reasons: ['scheduling_failed'] },
          bookingComplete: false, // Not complete yet - need email first
        }
      }
    }

    return {
      response: cleanResponse,
      shouldSend: true,
      reason: 'WinBros AI-generated response',
      escalation: silentHandoff
        ? { shouldEscalate: true, reasons: ['silent_handoff_no_tag'] }
        : escalation.shouldEscalate ? escalation : undefined,
      bookingComplete: isBookingComplete || undefined,
    }
  }

  // OpenAI fallback for WinBros
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    const client = new OpenAI({ apiKey: openaiKey })

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    })

    const rawText = response.choices[0]?.message?.content?.trim() || ''

    if (!rawText) {
      throw new Error('Empty response from OpenAI (WinBros)')
    }

    const lastCustomerMsg = conversationHistory?.filter(m => m.role === 'client').pop()?.content
    const escalation = detectEscalation(rawText, conversationHistory, lastCustomerMsg)
    const isBookingComplete = detectBookingComplete(rawText)
    let isScheduleReady = detectScheduleReady(rawText)
    let cleanResponse = sanitizeAIResponse(autoSplitLongMessage(stripEscalationTags(rawText)))

    // Safety net: same fake-scheduling detection as Claude path
    if (!isScheduleReady && detectFakeScheduling(rawText, isScheduleReady)) {
      console.warn('[WinBros AI] Safety net (OpenAI): AI offered fake times without [SCHEDULE_READY], injecting scheduler')
      isScheduleReady = true
      cleanResponse = 'Let me check what times we have available for your estimate!'
    }

    const silentHandoff = detectSilentHandoff(rawText, escalation.shouldEscalate, isBookingComplete, isScheduleReady)

    // Same scheduling logic for OpenAI fallback
    if (isScheduleReady) {
      const timeOptions = await getEstimateTimeOptions(tenant, conversationHistory, knownCustomerInfo)
      if (timeOptions) {
        cleanResponse = cleanResponse + '\n\n' + timeOptions
      } else {
        cleanResponse = cleanResponse + '\n\nOur schedule is filling up fast but we\'ll get you in! What\'s your best email? I\'ll send over your confirmed estimate details.'
        return {
          response: cleanResponse,
          shouldSend: true,
          reason: 'WinBros AI (OpenAI) - scheduler full, continuing to email capture',
          escalation: { shouldEscalate: true, reasons: ['scheduling_failed'] },
          bookingComplete: false,
        }
      }
    }

    return {
      response: cleanResponse,
      shouldSend: true,
      reason: 'WinBros AI-generated response (OpenAI)',
      escalation: silentHandoff
        ? { shouldEscalate: true, reasons: ['silent_handoff_no_tag'] }
        : escalation.shouldEscalate ? escalation : undefined,
      bookingComplete: isBookingComplete || undefined,
    }
  }

  // Template fallback for WinBros (no AI keys)
  const hasHistory = conversationHistory && conversationHistory.length > 0
  return {
    response: hasHistory
      ? `Thanks for your message! I'd love to get you set up with a free estimate. What's your full name?`
      : `Hi! This is ${sdrName} from ${businessName}. I'd love to get you set up with a free estimate. What's your full name?`,
    shouldSend: true,
    reason: 'WinBros template fallback',
  }
}

/**
 * Call the estimate scheduler to get available time slots for a WinBros customer.
 * Extracts the customer address from conversation history or known info,
 * then calls the scheduler to get up to 3 optimal time options.
 * Returns a formatted string like "Wednesday Feb 25th at 8:00 AM, Thursday Feb 26th at 8:00 AM, or Friday Feb 27th at 9:30 AM"
 */
async function getEstimateTimeOptions(
  tenant: Tenant,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  knownCustomerInfo?: KnownCustomerInfo,
): Promise<string | null> {
  try {
    const { scheduleEstimate } = await import('./vapi-estimate-scheduler')

    // Extract address: prefer known info, then scan conversation history
    let address = knownCustomerInfo?.address || null

    if (!address && conversationHistory?.length) {
      // Look for address in conversation — find messages after bot asked for address
      for (let i = 0; i < conversationHistory.length - 1; i++) {
        const msg = conversationHistory[i]
        if (msg.role === 'assistant' && /address/i.test(msg.content) && !/email/i.test(msg.content)) {
          // Collect all client messages until next assistant message
          const addressParts: string[] = []
          for (let j = i + 1; j < conversationHistory.length; j++) {
            if (conversationHistory[j].role === 'client') {
              addressParts.push(conversationHistory[j].content.trim())
            } else {
              break
            }
          }
          if (addressParts.length > 0) {
            address = addressParts.join(', ')
          }
          break
        }
      }
    }

    // Last resort: scan all client messages for something that looks like an address
    if (!address && conversationHistory?.length) {
      const clientMessages = conversationHistory.filter(m => m.role === 'client').map(m => m.content)
      for (const msg of clientMessages) {
        // Match patterns like "123 Main St", "205 E Jefferson St", "456 NW Oak Ave, Springfield IL 62704"
        // Allows optional direction prefix (N, S, E, W, NE, NW, SE, SW) and multiple words before street suffix
        if (/\d+\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\.?\s+)?\w+(?:\s+\w+)*\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|pl|place|cir|circle)\b/i.test(msg)) {
          address = msg.trim()
          break
        }
      }
    }

    if (!address) {
      console.error('[WinBros Schedule] No address found in conversation or known info')
      return null
    }

    console.log(`[WinBros Schedule] Calling scheduler with address: "${address}" for tenant ${tenant.id}`)
    const result = await scheduleEstimate({ address }, tenant.id)

    if (!result.scheduled || !result.options || result.options.length === 0) {
      console.warn(`[WinBros Schedule] No slots available: ${result.error || 'unknown reason'}`)
      return null
    }

    // Format the options as a readable list for SMS
    const formatted = result.options.map(opt => {
      const d = new Date(opt.date + 'T12:00:00')
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
      const monthDay = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
      return `${dayName} ${monthDay} at ${opt.time}`
    })

    if (formatted.length === 1) {
      return `We have ${formatted[0]} available for your estimate. Does that work for you?`
    } else if (formatted.length === 2) {
      return `We have a couple times available — ${formatted[0]} or ${formatted[1]}. Which works best for you?`
    } else {
      const last = formatted.pop()
      return `We have a few times available — ${formatted.join(', ')}, or ${last}. Which works best for you?`
    }
  } catch (err) {
    console.error('[WinBros Schedule] Error calling estimate scheduler:', err)
    return null
  }
}

// =====================================================================
// EMAIL BOT RESPONSE (house cleaning via email)
// =====================================================================

/**
 * Look up 3 available cleaning time slots for a tenant.
 * Uses the same tiered cascade algorithm as the VAPI estimate scheduler:
 *   8:00 AM → 11:00 AM → 2:00 PM → 5:00 PM
 * For each tier, checks the next 3 days. Fills 8 AM slots first across all
 * days, then cascades to 11 AM, etc. Returns a formatted string the AI can
 * present in the email, or null if lookup fails.
 */
async function getAvailableCleaningSlots(
  tenantId: string,
  timezone: string
): Promise<string | null> {
  try {
    const { getSupabaseServiceClient } = await import('./supabase')
    const client = getSupabaseServiceClient()

    // Load tenant config for business hours
    const { data: tenantRow } = await client
      .from('tenants')
      .select('workflow_config')
      .eq('id', tenantId)
      .single()

    const wc = (tenantRow?.workflow_config ?? {}) as Record<string, unknown>
    const hoursStart = typeof wc.business_hours_start === 'number' ? wc.business_hours_start : 480
    const hoursEnd = typeof wc.business_hours_end === 'number' ? wc.business_hours_end : 1020

    // Build time tiers dynamically from business hours
    function buildTiers(startMin: number, endMin: number): Array<{ minutes: number; label: string }> {
      const fmt = (m: number) => {
        const h24 = Math.floor(m / 60)
        const min = m % 60
        const period = h24 >= 12 ? 'PM' : 'AM'
        const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24
        return `${h12}:${String(min).padStart(2, '0')} ${period}`
      }
      const range = endMin - startMin
      if (range <= 0) return [{ minutes: startMin, label: fmt(startMin) }]
      const tiers = [startMin]
      if (range >= 180) tiers.push(startMin + Math.round(range / 3))
      if (range >= 360) tiers.push(startMin + Math.round((2 * range) / 3))
      tiers.push(endMin)
      const snapped = [...new Set(tiers.map(t => Math.round(t / 30) * 30))]
      return snapped.map(m => ({ minutes: m, label: fmt(m) }))
    }

    const TIME_TIERS = buildTiers(hoursStart, hoursEnd)
    const LOOKAHEAD_DAYS = 7

    // Get current time in tenant timezone
    const now = new Date()
    const opts = { timeZone: timezone } as const
    const year = Number(new Intl.DateTimeFormat('en-US', { ...opts, year: 'numeric' }).format(now))
    const month = Number(new Intl.DateTimeFormat('en-US', { ...opts, month: 'numeric' }).format(now))
    const day = Number(new Intl.DateTimeFormat('en-US', { ...opts, day: 'numeric' }).format(now))
    const hour = Number(new Intl.DateTimeFormat('en-US', { ...opts, hour: 'numeric', hour12: false }).format(now))
    const minute = Number(new Intl.DateTimeFormat('en-US', { ...opts, minute: 'numeric' }).format(now))
    const nowMinutes = (hour === 24 ? 0 : hour) * 60 + minute

    // Build candidate dates (skip Sundays, skip today if past business hours end)
    const cursor = new Date(year, month - 1, day)
    if (nowMinutes >= hoursEnd) cursor.setDate(cursor.getDate() + 1)
    const candidates: string[] = []
    while (candidates.length < LOOKAHEAD_DAYS) {
      if (cursor.getDay() !== 0) {
        const yyyy = cursor.getFullYear()
        const mm = String(cursor.getMonth() + 1).padStart(2, '0')
        const dd = String(cursor.getDate()).padStart(2, '0')
        candidates.push(`${yyyy}-${mm}-${dd}`)
      }
      cursor.setDate(cursor.getDate() + 1)
    }

    const priorityDates = candidates.slice(0, 3)
    const todayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

    // Load existing jobs for these dates
    const { data: jobRows } = await client
      .from('jobs')
      .select('date, scheduled_at')
      .eq('tenant_id', tenantId)
      .in('date', candidates)
      .neq('status', 'cancelled')

    // Build a set of occupied slots: "date|tierMinutes"
    const occupiedSlots = new Set<string>()
    for (const job of (jobRows || [])) {
      if (!job.date || !job.scheduled_at) continue
      // Parse scheduled_at to minutes
      const raw = String(job.scheduled_at).trim().toLowerCase()
      let jobMinutes: number | null = null
      const match12 = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
      if (match12) {
        let h = Number(match12[1])
        const m = Number(match12[2])
        if (match12[3].toLowerCase() === 'pm' && h < 12) h += 12
        if (match12[3].toLowerCase() === 'am' && h === 12) h = 0
        jobMinutes = h * 60 + m
      } else {
        const match24 = raw.match(/^(\d{1,2}):(\d{2})/)
        if (match24) jobMinutes = Number(match24[1]) * 60 + Number(match24[2])
      }
      if (jobMinutes === null) continue

      // Mark the tier slot as occupied if the job falls within 30 min of the tier
      for (const tier of TIME_TIERS) {
        if (Math.abs(jobMinutes - tier.minutes) < 30) {
          occupiedSlots.add(`${job.date}|${tier.minutes}`)
        }
      }
    }

    // Tiered cascade: 8 AM across all 3 days, then 11 AM, then 2 PM, then 5 PM
    const options: Array<{ date: string; time: string }> = []
    const usedSlots = new Set<string>()

    for (const tier of TIME_TIERS) {
      if (options.length >= 3) break
      for (const date of priorityDates) {
        if (options.length >= 3) break
        const slotKey = `${date}|${tier.minutes}`
        if (usedSlots.has(slotKey)) continue
        if (occupiedSlots.has(slotKey)) continue

        // Skip if today and past this time
        if (date === todayStr && nowMinutes >= tier.minutes + 30) continue

        usedSlots.add(slotKey)
        options.push({ date, time: tier.label })
      }
    }

    if (options.length === 0) return null

    // Format for the AI
    const formatted = options.map(opt => {
      const d = new Date(opt.date + 'T12:00:00')
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
      const monthDay = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
      return `${dayName}, ${monthDay} at ${opt.time}`
    })

    return formatted.join(' / ')
  } catch (err) {
    console.error('[Email Bot] Failed to look up available cleaning slots:', err)
    return null
  }
}

/**
 * Generate an email response for house cleaning booking conversations.
 * Same flow as SMS but adapted: batches 2-3 questions per email,
 * professional tone, and email address is already known.
 */
export async function generateEmailResponse(
  message: string,
  tenant: Tenant,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  knownCustomerInfo?: KnownCustomerInfo,
  customerContext?: CustomerContext | null
): Promise<AutoResponseResult> {
  const { buildEmailBotSystemPrompt, buildWinBrosEmailPrompt } = await import('./email-bot-prompt')
  const { detectEscalation, detectBookingComplete, stripEscalationTags } = await import('./winbros-sms-prompt')

  const isWinBros = tenantUsesFeature(tenant, 'use_hcp_mirror')
  const systemPrompt = isWinBros ? buildWinBrosEmailPrompt(tenant) : buildEmailBotSystemPrompt(tenant)
  const sdrName = tenant.sdr_persona || 'Sarah'

  const historyContext = conversationHistory?.length
    ? conversationHistory.slice(-10).map(m => `${m.role === 'client' ? 'Customer' : sdrName}: ${m.content}`).join('\n')
    : '(No prior messages — this is a new email conversation.)'

  let knownInfoBlock = ''
  if (knownCustomerInfo) {
    const parts: string[] = []
    if (knownCustomerInfo.firstName) parts.push(`First name: ${knownCustomerInfo.firstName}`)
    if (knownCustomerInfo.address) parts.push(`Address on file: ${knownCustomerInfo.address}`)
    if (knownCustomerInfo.email) parts.push(`Email on file: ${knownCustomerInfo.email}`)
    if (knownCustomerInfo.phone) parts.push(`Phone on file: ${knownCustomerInfo.phone}`)
    if (knownCustomerInfo.bedrooms) parts.push(`Bedrooms: ${knownCustomerInfo.bedrooms}`)
    if (knownCustomerInfo.bathrooms) parts.push(`Bathrooms: ${knownCustomerInfo.bathrooms}`)
    if (knownCustomerInfo.serviceType) parts.push(`Service type: ${knownCustomerInfo.serviceType.replace(/[-_]/g, ' ')}`)
    if (knownCustomerInfo.frequency) parts.push(`Frequency: ${knownCustomerInfo.frequency.replace(/[-_]/g, ' ')}`)
    if (knownCustomerInfo.estimatedPrice) parts.push(`Estimated price: $${knownCustomerInfo.estimatedPrice}`)
    if (parts.length > 0) {
      knownInfoBlock = `\n\nINFO ALREADY ON FILE FOR THIS CUSTOMER:\n${parts.join('\n')}\nWhen you reach the step for any info listed above, CONFIRM it instead of asking.\n`
    }
  }

  const contextBlock = customerContext ? formatCustomerContextForPrompt(customerContext, tenant) : ''

  // Look up available time slots so the AI can suggest specific times in the first email
  const tz = tenant.timezone || 'America/Chicago'
  const availableSlots = await getAvailableCleaningSlots(tenant.id, tz)
  const slotsBlock = availableSlots
    ? `\n\nAVAILABLE TIME SLOTS (present these to the customer when asking about date/time):\n${availableSlots}\nPresent these naturally — e.g. "We have a few openings coming up — [slot 1], [slot 2], or [slot 3]. Which works best for you?"\n`
    : ''

  const emailNow = new Date()
  const emailDateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz,
  }).format(emailNow)
  const emailTimeStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(emailNow)
  const today = `${emailDateStr} (current time: ${emailTimeStr})`

  const tagHint = '(and tags like [BOOKING_COMPLETE] or [ESCALATE:reason] if needed)'
  const userMessage = `Today's date: ${today}\n\nEmail conversation so far:\n${historyContext}${knownInfoBlock}${slotsBlock}${contextBlock}\n\nCustomer just emailed: "${message}"\n\nRespond as ${sdrName}. Write the full email reply text ${tagHint}. Nothing else.`

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    })

    const textContent = response.content.find(block => block.type === 'text')
    const rawText = textContent?.type === 'text' ? textContent.text.trim() : ''

    if (!rawText) {
      throw new Error('Empty response from Claude (EmailBot)')
    }

    const lastCustomerMsg = conversationHistory?.filter(m => m.role === 'client').pop()?.content
    const escalation = detectEscalation(rawText, conversationHistory, lastCustomerMsg)
    const isBookingComplete = detectBookingComplete(rawText)
    // Email-only: no SMS chunking (||| splits) and no SMS sanitizer (it strips
    // markdown bullets, em-dashes, and any sentence containing "email").
    const cleanResponse = stripEscalationTags(rawText).trim()

    return {
      response: cleanResponse,
      shouldSend: true,
      reason: 'Email bot AI-generated response',
      escalation: escalation.shouldEscalate ? escalation : undefined,
      bookingComplete: isBookingComplete || undefined,
    }
  }

  // OpenAI fallback
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey: openaiKey })

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    })

    const rawText = response.choices[0]?.message?.content?.trim() || ''

    if (!rawText) {
      throw new Error('Empty response from OpenAI (EmailBot)')
    }

    const lastCustomerMsg = conversationHistory?.filter(m => m.role === 'client').pop()?.content
    const escalation = detectEscalation(rawText, conversationHistory, lastCustomerMsg)
    const isBookingComplete = detectBookingComplete(rawText)
    const cleanResponse = stripEscalationTags(rawText).trim()

    return {
      response: cleanResponse,
      shouldSend: true,
      reason: 'Email bot AI-generated response (OpenAI)',
      escalation: escalation.shouldEscalate ? escalation : undefined,
      bookingComplete: isBookingComplete || undefined,
    }
  }

  // Template fallback
  const businessName = tenant.business_name_short || tenant.business_name || tenant.name
  return {
    response: `Hi there!\n\nThank you for reaching out to ${businessName}! We'd love to help you with your cleaning needs.\n\nTo get started, could you let us know:\n- Are you looking for a Standard Cleaning, Deep Cleaning, or Move-in/Move-out Cleaning?\n- What's your full name?\n\nLooking forward to hearing from you!\n\nBest,\n${sdrName}`,
    shouldSend: true,
    reason: 'Email bot template fallback',
  }
}

// =====================================================================
// HOUSE CLEANING SMS RESPONSE (non-WinBros tenants)
// =====================================================================

/**
 * Generate a house cleaning SMS response using the dedicated booking prompt.
 * Routes through a structured booking flow with [BOOKING_COMPLETE] detection.
 */
async function generateHouseCleaningResponse(
  message: string,
  tenant: Tenant,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  knownCustomerInfo?: KnownCustomerInfo,
  isReturningCustomer?: boolean,
  customerContext?: CustomerContext | null,
  isRetargetingReply?: boolean,
): Promise<AutoResponseResult> {
  // Reuse escalation/booking detection from WinBros (same tag format)
  const { detectEscalation, detectBookingComplete, stripEscalationTags } = await import('./winbros-sms-prompt')

  const sdrName = tenant.sdr_persona || 'Sarah'
  const businessName = tenant.business_name_short || tenant.business_name || tenant.name
  const serviceArea = tenant.service_area || 'your area'

  // ── BUILD 1 #2 + #3: Rapport-first gate + takeover-resume awareness ─────
  // Extracted to a pure helper for unit testability.
  // Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md
  const { shouldDeliverRapportFirst, humanTakeoverRecentlyEnded } = computeRapportGate({
    knownCustomerInfo,
    customerContext,
    isRetargetingReply,
  })

  // ── INLINE SYSTEM PROMPT (no dynamic import — Turbopack caches stale files) ──
  const systemPrompt = `You are ${sdrName}, a real person who works at ${businessName}, a professional house cleaning service in ${serviceArea}. You're texting with a potential customer.

You have a CUSTOMER BRAIN section below with everything you know about this person. Use this naturally. Don't announce "I see from our records..." — just reference things like a person who actually remembers.

HARD RULES (these override EVERYTHING):
- NO emojis. None. Your message will be blocked if you include any.
- NO em dashes. Use commas or periods.
- NO markdown. Plain SMS text only.
- NEVER ask for email, address, name, or square footage. The quote page handles all of that.
- NEVER offer discounts, deals, or lower prices. You have ZERO price authority. Build value instead.
- Keep each text 1-2 sentences max. Use ||| to split into multiple texts.
- Match the customer's energy. If they text short, you text short.

YOUR GOAL:
Get them a quote and book a cleaning. You're not following a script. Read the room. Use the INDUSTRY INTELLIGENCE, WINNING PATTERNS, and OWNER MESSAGING PATTERNS below to guide your approach. These are real data from conversations that led to bookings.

HOW TO SELL:
- You genuinely believe this service will improve their life. You're doing them a favor.
- When they hesitate on price: satisfaction guarantee, Google reviews, background-checked staff, professional supplies. Stack value.
- "We have a 100% satisfaction guarantee, if anything isn't perfect we come back and fix it free"
- "Our cleaners are background-checked, insured, and bring all their own supplies"
- Social proof: "We're highly rated on Google, feel free to check our reviews"
- Urgency (only when natural): "Our schedule fills up fast, especially weekends"
- NEVER compare to other companies. NEVER say "competitive".
- If they mention another company's lower price, acknowledge and pivot to value. Don't bash the competitor.

HOW CONVERSATIONS WORK:
- If they ask for a price and you have their bed/bath: give the EXACT price from the VERIFIED PRICING section below, then fire [BOOKING_COMPLETE].
- If they're exploring: build rapport, get bed/bath, acknowledge their needs, then offer "Want me to send you your pricing options?" and fire [BOOKING_COMPLETE].
- If they're returning: be warm, reference their past experience, make rebooking easy.
- If they came from a promotion (ACTIVE PROMOTIONAL OFFER below): honor the offer price exactly.
- If a FRUSTRATION WARNING appears: drop everything and give a direct answer.

WHEN TO FIRE [BOOKING_COMPLETE]:
- Customer asks for price and you have bed/bath → quote + [BOOKING_COMPLETE]
- Customer says they want to book → [BOOKING_COMPLETE]
- You've built rapport and have bed/bath → "Want me to send you your options?" then [BOOKING_COMPLETE]
- NEVER fire it without bed/bath.
- NEVER wait more than 2-3 exchanges after getting bed/bath.

The ONLY required data point is bedrooms and bathrooms. Everything else is handled by the quote page.

ABOUT ${businessName.toUpperCase()}:
- Licensed, bonded, and insured. Background-checked staff.
- 100% satisfaction guarantee. Not happy? We come back and fix it free.
- Highly rated on Google. Professional-grade supplies, safe for kids and pets.
- We clean homes all across ${serviceArea}.

ESCALATION (include tag at END of your response):
- Special requests beyond standard → [ESCALATE:special_request]
- Cancel/reschedule/billing → [ESCALATE:service_issue]
- Customer upset/complaining → [ESCALATE:unhappy_customer]
- Commercial/Airbnb/post-construction → [ESCALATE:custom_quote]
When you escalate, say "Our team will reach out shortly!" and STOP.

CRITICAL:
- NEVER re-ask a question already answered
- If a human (owner) is already texting, DO NOT jump in
- If someone is looking for work as a cleaner, say "Shoot me a text at ${tenant.owner_phone || 'the owner directly'} and we can chat about opportunities"`

  const historyContext = conversationHistory?.length
    ? conversationHistory.slice(-50).map(m => `${m.role === 'client' ? 'Customer' : sdrName}: ${m.content}`).join('\n')
    : '(No prior messages — this is a new conversation.)'

  // ── Osiris Customer Brain ──
  // Pull full customer history from Osiris DB for personalized responses
  let customerBrainBlock = ''
  if (customerContext?.customer?.id) {
    try {
      const brainParts: string[] = ['CUSTOMER BRAIN:']
      const cust = customerContext.customer
      if (cust.first_name) brainParts.push(`Name: ${cust.first_name} ${cust.last_name || ''}`.trim())
      if (cust.address) brainParts.push(`Address: ${cust.address}`)
      if (cust.email) brainParts.push(`Email: ${cust.email}`)

      if (customerContext.totalJobs > 0) {
        brainParts.push(`History: ${customerContext.totalJobs} completed job${customerContext.totalJobs > 1 ? 's' : ''}, ${formatTenantCurrency(tenant, Number(customerContext.totalSpend) || 0)} total`)
        if (customerContext.recentJobs?.length > 0) {
          const lastJob = customerContext.recentJobs[0]
          const jobDate = lastJob.date || lastJob.completed_at
          const daysAgo = jobDate ? Math.round((Date.now() - new Date(jobDate).getTime()) / (24 * 60 * 60 * 1000)) : null
          brainParts.push(`Last service: ${(lastJob.service_type || 'cleaning').replace(/_/g, ' ')} (${formatTenantCurrency(tenant, Number(lastJob.price) || 0)})${daysAgo ? ` — ${daysAgo} days ago` : ''}`)
        }
      }

      if (customerContext.activeJobs?.length > 0) {
        brainParts.push(`\n→ ALREADY BOOKED. Don't re-sell. Just help with their upcoming service.`)
      } else if (customerContext.totalJobs > 0) {
        brainParts.push(`\n→ Returning customer. Be warm, reference their past experience. Make rebooking easy.`)
      } else {
        brainParts.push(`\n→ New customer. Be friendly and helpful. Don't assume anything about them.`)
      }

      customerBrainBlock = '\n\n' + brainParts.join('\n')
    } catch (err) {
      console.warn(`[HC AI] Customer brain build failed:`, err)
    }
  }

  // ── Assistant Memory ──
  // Load remembered facts from past conversations
  let memoryBlock = ''
  if (customerContext?.customer?.id) {
    try {
      const { buildMemoryContext } = await import('./assistant-memory')
      const memCtx = await buildMemoryContext(tenant.id, customerContext.customer.id, conversationHistory || [])
      if (memCtx) {
        memoryBlock = '\n\n' + memCtx
      }
    } catch (err) {
      console.warn(`[HC AI] Memory load failed:`, err)
    }
  }

  // Build known info context so the AI can confirm rather than re-ask
  let knownInfoBlock = ''
  if (knownCustomerInfo) {
    const parts: string[] = []
    if (knownCustomerInfo.firstName) {
      parts.push(`First name: ${knownCustomerInfo.firstName}`)
    }
    if (knownCustomerInfo.address) {
      parts.push(`Address on file: ${knownCustomerInfo.address}`)
    }
    if (knownCustomerInfo.email) {
      parts.push(`Email on file: ${knownCustomerInfo.email}`)
    }
    if (knownCustomerInfo.bedrooms) {
      parts.push(`Bedrooms: ${knownCustomerInfo.bedrooms}`)
    }
    if (knownCustomerInfo.bathrooms) {
      parts.push(`Bathrooms: ${knownCustomerInfo.bathrooms}`)
    }
    if (knownCustomerInfo.serviceType) {
      parts.push(`Service type: ${knownCustomerInfo.serviceType.replace(/[-_]/g, ' ')}`)
    }
    if (knownCustomerInfo.frequency) {
      parts.push(`Frequency: ${knownCustomerInfo.frequency.replace(/[-_]/g, ' ')}`)
    }
    if (knownCustomerInfo.estimatedPrice) {
      parts.push(`Estimated price: $${knownCustomerInfo.estimatedPrice}`)
    }
    // NOTE: knownCustomerInfo.source is an internal system field (e.g. "sms", "housecall_pro")
    // that tracks how the lead was created — NOT how the customer heard about the business.
    // Do NOT include it — the AI would mistake it for the "how did you hear about us" answer.

    // Build the booking-ready hint: if we already have bed/bath or address, tell
    // the AI exactly what's missing so it triggers [BOOKING_COMPLETE] immediately
    // once the last piece arrives — no extra confirmation round-trips.
    const hasBedBath = !!(knownCustomerInfo.bedrooms && knownCustomerInfo.bathrooms)
    const hasAddress = !!knownCustomerInfo.address
    let bookingReadyHint = ''
    if (hasBedBath && hasAddress && shouldDeliverRapportFirst) {
      // Build 1 #2: rapport-first gate intercepts the [BOOKING_COMPLETE] trigger.
      // Send ONE human-feeling rapport / value-build turn instead. No price, no tag.
      bookingReadyHint = '\nCRITICAL — RAPPORT-FIRST GATE: You have all booking facts (bed/bath/address). However, this customer has NEVER received our pre-quote rapport / value-build message. You MUST send that message NOW before the system can deliver the quote link. Rules for THIS turn only:\n'
        + '  - Send ONE short, human-feeling message (under 160 chars, splits with ||| if needed).\n'
        + '  - Briefly acknowledge what they want.\n'
        + '  - Ask ONE casual rapport question that invites a reply (examples: "real quick before I send your quote, anything specific you want us to focus on?", "any pets we should know about?", "how is your day going?").\n'
        + '  - Mention ONE value point: insured + background-checked staff, all supplies included, 100% satisfaction guarantee, or highly rated on Google.\n'
        + '  - DO NOT mention any price, dollar amount, or quote URL.\n'
        + '  - DO NOT fire [BOOKING_COMPLETE] in this turn. The system fires the quote link on the NEXT inbound from them.\n'
        + '  - Do NOT promise to "send the quote now", say "send your quote next" or similar future tense.\n'
    } else if (hasBedBath && hasAddress) {
      bookingReadyHint = '\nIMPORTANT: You already have address + bedrooms + bathrooms. Trigger [BOOKING_COMPLETE] RIGHT NOW in your response. Do not ask any more questions first. NEVER include any dollar amount, price number, or currency symbol in the SMS body, the quote link reveals price.'
    } else if (hasBedBath) {
      bookingReadyHint = '\nIMPORTANT: You already have bedrooms and bathrooms on file. The ONLY thing you need is the address. As soon as the customer provides an address (in this message or a previous one), trigger [BOOKING_COMPLETE] immediately. Do not ask additional questions. NEVER include any dollar amount in the SMS body.'
    } else if (hasAddress) {
      bookingReadyHint = '\nIMPORTANT: You already have the address on file. The ONLY thing you need is bedrooms and bathrooms. As soon as the customer provides bed/bath count, trigger [BOOKING_COMPLETE] immediately. Do not ask additional questions. NEVER include any dollar amount in the SMS body.'
    }

    // Build 1 #3: takeover-resume awareness, prepended to the booking hint.
    if (humanTakeoverRecentlyEnded) {
      bookingReadyHint = '\nHUMAN-OPERATOR-WAS-HANDLING-THIS-THREAD: A human operator was managing this conversation until very recently. Read the FULL conversation history below carefully. Do NOT repeat anything the human already said. If the human already addressed the customer\'s last question, briefly acknowledge and move forward. Be especially careful not to undo or contradict anything the human told the customer. When in doubt, defer to what the human said.\n' + bookingReadyHint
    }

    if (parts.length > 0) {
      knownInfoBlock = `\n\nINFO ALREADY ON FILE FOR THIS CUSTOMER:\n${parts.join('\n')}\nWhen you reach the step for any info listed above, CONFIRM it instead of asking.${bookingReadyHint}\n`
    }
  }

  let returningCustomerBlock = ''
  if (isRetargetingReply) {
    returningCustomerBlock = '\n\nIMPORTANT: This customer is replying to a retargeting text we sent them. They already know who we are. Do NOT pitch them immediately or list service types right away. Just be conversational and warm, like a friend checking in. Ask how you can help or what they had in mind. Build rapport first, let THEM tell you what they need. Only start collecting booking info once they express clear interest.\n'
  } else if (isReturningCustomer) {
    returningCustomerBlock = '\n\nIMPORTANT: This customer previously used our services and is replying to a promotional message we sent them. Treat them as a valued returning customer. Be warm, reference their past experience with us, and make rebooking easy. Do NOT treat them like a cold new lead.\n'
  }

  // Inject customer context (active jobs, history, profile) for situation awareness
  const contextBlock = customerContext ? formatCustomerContextForPrompt(customerContext, tenant) : ''

  const hcTz = tenant.timezone || 'America/Chicago'
  const hcNow = new Date()
  const hcDateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: hcTz,
  }).format(hcNow)
  const hcTimeStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: hcTz,
  }).format(hcNow)
  const today = `${hcDateStr} (current time: ${hcTimeStr})`

  // ── MEGA BRAIN: Parallel context gathering ──
  // All async lookups run in parallel for speed (~200-500ms total vs ~3s sequential)

  // 1. Conversation stage + frustration (synchronous, fast)
  let aiLearningBlock = ''
  try {
    const { detectFrustration } = await import('./conversation-scoring')
    const { detectConversationStage, getStageGuidance } = await import('./sms-guard')

    if (conversationHistory?.length) {
      const convForStage = conversationHistory.map(m => ({
        role: m.role === 'client' ? 'client' : 'assistant',
        content: m.content,
      }))
      const hasPriceQuoted = conversationHistory.some(m =>
        m.role === 'assistant' && /\$\d/.test(m.content)
      )
      const stage = detectConversationStage(convForStage, false, hasPriceQuoted)
      const guidance = getStageGuidance(stage)
      if (guidance) {
        aiLearningBlock += `\n\nCONVERSATION STAGE: ${stage}\n${guidance}\n`
      }

      const frustration = detectFrustration(
        conversationHistory.map(m => ({ role: m.role === 'client' ? 'client' : 'assistant', content: m.content })),
        message
      )
      if (frustration.frustrated) {
        aiLearningBlock += `\n\nWARNING: Customer seems frustrated (signals: ${frustration.signals.join(', ')}). Give a DIRECT answer. Don't ask more questions. If they want a price, give one NOW.\n`
      }
    }
  } catch (stageErr) {
    console.warn('[HC AI] Stage/frustration detection failed (non-blocking):', stageErr)
  }

  // 2. Parallel async: Brain intelligence + cross-tenant patterns + verified pricing
  let brainBlock = ''
  let patternsBlock = ''
  let verifiedPricingBlock = ''

  try {
    const { queryBrainChunksOnly } = await import('./brain')
    const { getHouseCleaningTenantIds, findCrossTenantWinningConversations } = await import('./conversation-scoring')
    const { getPricingRow } = await import('./pricing-db')

    const [brainChunks, hcTenantIds, pricingStd, pricingDeep, pricingMove] = await Promise.all([
      // Brain: industry intelligence from coaching knowledge base
      queryBrainChunksOnly({ question: message, domain: 'sales', maxChunks: 3, minSimilarity: 0.5 })
        .catch((err: unknown) => { console.warn('[HC AI] Brain query failed (non-blocking):', err); return [] }),
      // Cross-tenant: get ALL house cleaning tenant IDs (cached 5min)
      getHouseCleaningTenantIds()
        .catch(() => []),
      // Verified pricing: exact prices for this customer's bed/bath
      knownCustomerInfo?.bedrooms && knownCustomerInfo?.bathrooms
        ? getPricingRow('standard', knownCustomerInfo.bedrooms, knownCustomerInfo.bathrooms, null, tenant.id).catch(() => null)
        : Promise.resolve(null),
      knownCustomerInfo?.bedrooms && knownCustomerInfo?.bathrooms
        ? getPricingRow('deep', knownCustomerInfo.bedrooms, knownCustomerInfo.bathrooms, null, tenant.id).catch(() => null)
        : Promise.resolve(null),
      knownCustomerInfo?.bedrooms && knownCustomerInfo?.bathrooms
        ? getPricingRow('move', knownCustomerInfo.bedrooms, knownCustomerInfo.bathrooms, null, tenant.id).catch(() => null)
        : Promise.resolve(null),
    ])

    // Cross-tenant winning patterns (runs after we have tenant IDs)
    const patterns = hcTenantIds.length > 0
      ? await findCrossTenantWinningConversations(hcTenantIds, message, 5).catch(() => [])
      : []

    // Format brain chunks
    if (brainChunks.length > 0) {
      brainBlock = '\n\nINDUSTRY INTELLIGENCE (from top cleaning business coaches — use to inform your approach, do NOT quote directly):\n'
      brainBlock += 'IMPORTANT: This intelligence is for YOUR reference only. NEVER offer discounts, deals, or lower prices regardless of what the coaching suggests. You have ZERO price authority.\n'
      brainBlock += 'ALSO: NEVER ask for the customer\'s email address, regardless of what the coaching suggests. The quote link handles email collection.\n'
      for (const chunk of brainChunks) {
        brainBlock += `- ${chunk.chunkText}\n`
      }
    }

    // Format cross-tenant winning patterns (anonymized — no tenant names)
    if (patterns.length > 0) {
      patternsBlock = '\n\nWINNING PATTERNS FROM SIMILAR CONVERSATIONS (TACTICS ONLY — IGNORE ALL DOLLAR AMOUNTS IN THESE EXAMPLES, use ONLY the VERIFIED PRICING block for prices):\n'
      for (const p of patterns) {
        patternsBlock += `- ${p.conversation_summary}`
        if (p.patterns && typeof p.patterns === 'object' && 'winning_tactics' in p.patterns) {
          const tactics = (p.patterns as { winning_tactics?: string[] }).winning_tactics
          if (tactics?.length) {
            patternsBlock += ` (what worked: ${tactics.join(', ')})`
          }
        }
        patternsBlock += '\n'
      }
      patternsBlock += 'Use these patterns to guide your tone and approach.\n'
    }

    // If no patterns available, the brain chunks already provide coaching fallback
    // (cold start handling — new tenants still get industry intelligence)
    if (patterns.length === 0 && brainChunks.length === 0) {
      // Extra brain fetch with more chunks as last resort
      try {
        const extraChunks = await queryBrainChunksOnly({ question: message, domain: 'sales', maxChunks: 5, minSimilarity: 0.4 })
        if (extraChunks.length > 0) {
          brainBlock = '\n\nINDUSTRY INTELLIGENCE (from top cleaning business coaches — use to inform your approach, do NOT quote directly):\n'
          brainBlock += 'IMPORTANT: NEVER offer discounts, deals, or lower prices. You have ZERO price authority.\n'
          brainBlock += 'ALSO: NEVER ask for the customer\'s email address. The quote link handles email collection.\n'
          for (const chunk of extraChunks) {
            brainBlock += `- ${chunk.chunkText}\n`
          }
        }
      } catch { /* non-blocking */ }
    }

    // Format verified pricing (exact DB prices, currency-correct)
    if (pricingStd || pricingDeep || pricingMove) {
      const currency = tenant.workflow_config && (tenant.workflow_config as Record<string, unknown>).currency === 'CAD' ? 'CAD' : 'USD'
      const sym = currency === 'CAD' ? 'CA$' : '$'
      verifiedPricingBlock = `\n\nVERIFIED PRICING FOR THIS CUSTOMER (${knownCustomerInfo?.bedrooms} bed / ${knownCustomerInfo?.bathrooms} bath) — all prices in ${currency}:\n`
      if (pricingStd) verifiedPricingBlock += `- Standard clean: ${sym}${pricingStd.price}\n`
      if (pricingDeep) verifiedPricingBlock += `- Deep clean: ${sym}${pricingDeep.price}\n`
      if (pricingMove) verifiedPricingBlock += `- Move in/out: ${sym}${pricingMove.price}\n`
      verifiedPricingBlock += 'Use ONLY these prices. Do NOT guess or interpolate.\n'
    }
  } catch (megaBrainErr) {
    console.error('[HC AI] Mega brain context failed (non-blocking):', megaBrainErr)
  }

  // ── PROMPT ASSEMBLY ORDER ──
  // 1. Date/time context (grounding)
  // 2. Conversation history (what's been said)
  // 3. Known customer info (bed/bath/address from lead form)
  // 4. Verified pricing (exact prices for this customer's bed/bath)
  // 5. Returning customer / retargeting context
  // 6. Customer context (active jobs, history, notes)
  // 7. Customer brain (DB profile, spend, preferences)
  // 8. Memory (remembered facts from past conversations)
  // 9. Industry intelligence (Osiris Brain knowledge chunks)
  // 10. AI learning (conversation stage + frustration + winning patterns)
  // 11. The customer's actual message
  const userMessage = `Today's date: ${today}\n\nConversation so far:\n${historyContext}${knownInfoBlock}${verifiedPricingBlock}${returningCustomerBlock}${contextBlock}${customerBrainBlock}${memoryBlock}${brainBlock}${aiLearningBlock}${patternsBlock}\n\nCustomer just texted: "${message}"\n\nRespond as ${sdrName}. Write ONLY the SMS text (and escalation/booking-complete tag if needed). Nothing else.\n\nFORMATTING: NO emojis (blocked if included). NO em dashes. NO markdown. Plain short texts. Use ||| to split. Match the customer's texting style.`

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    })

    const textContent = response.content.find(block => block.type === 'text')
    const rawText = textContent?.type === 'text' ? textContent.text.trim() : ''

    if (!rawText) {
      throw new Error('Empty response from Claude (HouseCleaning)')
    }

    const lastCustomerMsg = conversationHistory?.filter(m => m.role === 'client').pop()?.content
    const escalation = detectEscalation(rawText, conversationHistory, lastCustomerMsg)
    let isBookingComplete = detectBookingComplete(rawText)
    let cleanResponse = sanitizeAIResponse(autoSplitLongMessage(stripEscalationTags(rawText)))

    // Build 1 #2: rapport-first override. If we instructed rapport-only and the
    // model still tagged [BOOKING_COMPLETE], strip the tag and treat as rapport.
    let isRapportTurn = false
    if (shouldDeliverRapportFirst) {
      isBookingComplete = false
      isRapportTurn = true
      cleanResponse = cleanResponse.replace(/\[BOOKING_COMPLETE\]/gi, '').trim()
    }

    // Build 1 #1: defense-in-depth currency strip when a quote-send is imminent.
    // Whether shouldDeliverRapportFirst (no price ever) OR booking-complete (link
    // delivers price), the SMS body must NOT contain a dollar amount.
    if (isRapportTurn || isBookingComplete) {
      const { stripped, didStrip } = stripCurrencyForQuoteSend(cleanResponse)
      if (didStrip) {
        console.warn('[HC AI] Currency token leaked into SMS body — stripped. Raw:', rawText.slice(0, 200))
      }
      cleanResponse = stripped
    }

    const silentHandoff = detectSilentHandoff(rawText, escalation.shouldEscalate, isBookingComplete, false)

    return {
      response: cleanResponse,
      shouldSend: true,
      reason: isRapportTurn ? 'House cleaning rapport-first turn' : 'House cleaning AI-generated response',
      escalation: silentHandoff
        ? { shouldEscalate: true, reasons: ['silent_handoff_no_tag'] }
        : escalation.shouldEscalate ? escalation : undefined,
      bookingComplete: isBookingComplete || undefined,
      rapportSent: isRapportTurn || undefined,
    }
  }

  // OpenAI fallback
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey: openaiKey })

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    })

    const rawText = response.choices[0]?.message?.content?.trim() || ''

    if (!rawText) {
      throw new Error('Empty response from OpenAI (HouseCleaning)')
    }

    const lastCustomerMsg = conversationHistory?.filter(m => m.role === 'client').pop()?.content
    const escalation = detectEscalation(rawText, conversationHistory, lastCustomerMsg)
    let isBookingComplete = detectBookingComplete(rawText)
    let cleanResponse = sanitizeAIResponse(autoSplitLongMessage(stripEscalationTags(rawText)))

    // Build 1 #2: rapport-first override (mirror Claude path).
    let isRapportTurn = false
    if (shouldDeliverRapportFirst) {
      isBookingComplete = false
      isRapportTurn = true
      cleanResponse = cleanResponse.replace(/\[BOOKING_COMPLETE\]/gi, '').trim()
    }

    // Build 1 #1: currency strip when a quote-send is imminent.
    if (isRapportTurn || isBookingComplete) {
      const { stripped, didStrip } = stripCurrencyForQuoteSend(cleanResponse)
      if (didStrip) {
        console.warn('[HC AI/OpenAI] Currency token leaked into SMS body — stripped. Raw:', rawText.slice(0, 200))
      }
      cleanResponse = stripped
    }

    const silentHandoff = detectSilentHandoff(rawText, escalation.shouldEscalate, isBookingComplete, false)

    return {
      response: cleanResponse,
      shouldSend: true,
      reason: isRapportTurn ? 'House cleaning rapport-first turn (OpenAI)' : 'House cleaning AI-generated response (OpenAI)',
      escalation: silentHandoff
        ? { shouldEscalate: true, reasons: ['silent_handoff_no_tag'] }
        : escalation.shouldEscalate ? escalation : undefined,
      bookingComplete: isBookingComplete || undefined,
      rapportSent: isRapportTurn || undefined,
    }
  }

  // Template fallback (no AI keys) — businessName already declared above
  const hasHistory = conversationHistory && conversationHistory.length > 0
  return {
    response: hasHistory
      ? `Thanks for reaching out! How can I help get your home taken care of?`
      : `Hey! This is ${sdrName} from ${businessName}, how can I help get your home taken care of?`,
    shouldSend: true,
    reason: 'House cleaning template fallback',
  }
}
// Cache bust: Thu, Apr 16, 2026  3:51:29 PM
