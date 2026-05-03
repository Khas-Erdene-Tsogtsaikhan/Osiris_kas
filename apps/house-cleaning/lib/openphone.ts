/**
 * OpenPhone API client for sending and receiving SMS
 * Multi-tenant: tenant is REQUIRED for all SMS operations
 *
 * API Documentation: https://www.openphone.com/docs/api
 */

import { createHmac } from 'crypto'
import { toE164, normalizePhoneNumber } from './phone-utils'
import type { Tenant } from './tenant'
import { getCleanerPhoneSet } from './tenant'
import { getSupabaseServiceClient } from './supabase'

// Re-export for dashboard compatibility
export { normalizePhoneNumber }

/**
 * Check if a customer is in an active conversation (any message in last 10 min).
 * Use this in marketing/retargeting crons BEFORE calling sendSMS to avoid
 * interrupting a live AI or human conversation.
 *
 * Returns true if it's safe to send (no recent activity).
 */
export async function isConversationQuiet(tenantId: string, phone: string, windowMinutes = 10): Promise<boolean> {
  const formatted = toE164(phone)
  if (!formatted) return true // can't check, allow send

  try {
    const client = getSupabaseServiceClient()
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

    const { count } = await client
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('phone_number', formatted)
      .eq('tenant_id', tenantId)
      .gte('created_at', cutoff)

    return !count || count === 0
  } catch {
    return true // fail open — if we can't check, allow the send
  }
}

const OPENPHONE_API_BASE = 'https://api.openphone.com/v1'

interface SendSMSResponse {
  success: boolean
  messageId?: string
  msgRecordId?: string
  error?: string
}

/**
 * Send an SMS message via OpenPhone
 * Tenant is REQUIRED — no more fallback to WinBros default tenant.
 *
 * When `source` is provided, a messages DB record is pre-inserted BEFORE
 * calling the OpenPhone API. This prevents the outbound webhook from
 * misidentifying the message as a manual send and triggering
 * auto_response_paused (customer ghosting bug). All automated callers
 * (crons, automations, webhooks) MUST pass a source.
 */
export async function sendSMS(
  tenant: Tenant,
  to: string,
  message: string,
  options?: {
    skipThrottle?: boolean
    skipDedup?: boolean
    bypassFilters?: boolean
    /** When true, sends from the tenant's dedicated cleaner OpenPhone number (if configured) */
    useCleaner?: boolean
    /** When provided, pre-inserts a DB record so the outbound webhook skips manual takeover */
    source?: string
    /** Optional customer ID for the pre-inserted record */
    customerId?: string | number | null
    /**
     * Classifier for quiet-hours gating (T6 — 2026-04-20):
     *   - 'transactional' (default when missing): reply to an inbound customer
     *     message or any time-critical confirmation. Always sends.
     *   - 'outreach': proactive cron/agent-initiated send. Gated on the
     *     tenant's 9am–9pm quiet-hours window. Outside the window, the message
     *     is enqueued into sms_outreach_queue for /api/cron/drain-sms-queue.
     *   - 'internal': cleaner dispatch or owner alerts. Always sends.
     */
    kind?: 'transactional' | 'outreach' | 'internal'
  }
): Promise<SendSMSResponse> {

  if (!tenant) {
    console.error('No tenant found - cannot send SMS')
    return { success: false, error: 'No tenant configured' }
  }

  // ── Defense-in-depth: split on `|||` chunk separator ─────────────
  // Our AI prompts return multi-part SMS joined by `|||`. Most call sites
  // split before calling sendSMS, but at least one path leaked the literal
  // `|||` into a customer's text (Conner T., 2026-04-26 16:30: "...meet
  // them outside.|||See you then!"). Doing it here too means the leak
  // CANNOT recur regardless of which caller forgets.
  if (message.includes('|||')) {
    const parts = message.split('|||').map(p => p.trim()).filter(Boolean)
    if (parts.length > 1) {
      let lastResp: SendSMSResponse = { success: false, error: 'no parts sent' }
      for (let i = 0; i < parts.length; i++) {
        // Recurse without the separator. Pre-insert source applied to the
        // first part only — subsequent parts share the same conversation.
        const partOpts = i === 0 ? options : { ...options, source: undefined, skipDedup: true }
        lastResp = await sendSMS(tenant, to, parts[i], partOpts)
        if (!lastResp.success) return lastResp
        // Tiny pacing delay so OpenPhone preserves message order.
        if (i < parts.length - 1) await new Promise(r => setTimeout(r, 600))
      }
      return lastResp
    }
    // Only one non-empty part after split — fall through and send normally
    // with the trimmed content (drops a trailing/leading `|||`).
    message = parts[0] || message.replace(/\|\|\|/g, ' ').trim()
  }

  // ── Defense-in-depth: refuse to ship garbage first-name/template injections ─
  // Catches messages like "Hey aza_98@ymail.com, no pressure..." or
  // "Hey 32 Apartment Rooms, ..." where a polluted customers.first_name was
  // pasted into a `Hey {name},` template (cold_followup blast 2026-04-21/22).
  // Heuristic: only checks the literal `Hey <token>,` pattern at the start so
  // we don't over-block legitimate addresses, prices, etc. mid-sentence.
  const heyMatch = /^\s*Hey\s+([^,!?\n]{1,80})[,!?]/i.exec(message)
  if (heyMatch) {
    const greetTarget = heyMatch[1].trim()
    const looksLikeJunk =
      /[@$#]/.test(greetTarget) ||
      /\d/.test(greetTarget) ||
      greetTarget.split(/\s+/).length > 2 ||
      /^(no|yes|maybe|none|n\/a|hi|hello|address|old\s+lady|old\s+man|not\s+sure|idk|test|null|undefined)$/i.test(greetTarget)
    if (looksLikeJunk) {
      console.error(
        `[${tenant.slug}] BLOCKED garbage greeting — "Hey ${greetTarget}," looks like a polluted first_name. ` +
        `Source: ${options?.source || 'unknown'} customerId=${options?.customerId || 'none'}`
      )
      return { success: false, error: `Blocked garbage greeting: "Hey ${greetTarget},"` }
    }
  }

  // ── T6 Quiet-hours gate ───────────────────────────────────────────
  // Only applies to kind='outreach'. Transactional replies and internal
  // (cleaner-facing) sends always go immediately.
  if (options?.kind === 'outreach') {
    try {
      const { isWithinQuietHoursWindow, nextAllowedSendAt, resolveTimezone } = await import('./timezone-from-area-code')
      const tz = resolveTimezone({ tenantTimezone: tenant.timezone, phone: to })
      if (!isWithinQuietHoursWindow(tz)) {
        const scheduledFor = nextAllowedSendAt(tz)
        const queueClient = getSupabaseServiceClient()
        const { data: queued, error: queueErr } = await queueClient
          .from('sms_outreach_queue')
          .insert({
            tenant_id: tenant.id,
            customer_id: options.customerId ? Number(options.customerId) || null : null,
            phone: to,
            body: message,
            source: options.source || 'unknown',
            scheduled_for_at: scheduledFor.toISOString(),
            status: 'pending',
            metadata: { reason: 'quiet_hours', timezone: tz },
          })
          .select('id')
          .single()
        if (queueErr) {
          console.error(`[${tenant.slug}] Quiet-hours queue insert failed — skipping send:`, queueErr.message)
          return { success: false, error: `Queue insert failed: ${queueErr.message}` }
        }
        console.log(`[${tenant.slug}] SMS queued for ${scheduledFor.toISOString()} (${tz}) — outside 9am–9pm window. queue_id=${queued?.id}`)
        return { success: true, messageId: `queued:${queued?.id || ''}` }
      }
    } catch (err) {
      // Never let quiet-hours logic block a send when the helper itself errors.
      // Fall through to the normal send path.
      console.error(`[${tenant.slug}] Quiet-hours gate failed (non-blocking):`, err)
    }
  }

  // Try tenant config first, then fall back to env var
  const apiKey = tenant.openphone_api_key || process.env.OPENPHONE_API_KEY

  if (!apiKey) {
    console.error(`[${tenant.slug}] OpenPhone API key not configured in tenant or env`)
    return { success: false, error: 'OpenPhone API key not configured' }
  }

  console.log(`[${tenant.slug}] Using OpenPhone API key from: ${tenant.openphone_api_key ? 'tenant config' : 'env var'}`)

  // Use cleaner-specific phone ID when requested (falls back to main if not configured).
  // NOTE: no env-var fallback for the main phone ID — a missing tenant.openphone_phone_id
  // must fail closed. Falling through to a shared process.env.OPENPHONE_PHONE_ID would
  // send the message from another tenant's number (cross-tenant brand leak).
  const phoneNumberId = (options?.useCleaner && tenant.openphone_cleaner_phone_id)
    ? tenant.openphone_cleaner_phone_id
    : tenant.openphone_phone_id

  if (!phoneNumberId) {
    console.error(`[${tenant.slug}] OpenPhone phone number ID not configured for tenant — refusing to send to avoid cross-tenant send`)
    return { success: false, error: 'OpenPhone phone number ID not configured for tenant' }
  }

  const toE164Format = toE164(to)
  if (!toE164Format) {
    return { success: false, error: `Invalid phone number: ${to}` }
  }

  // ── Contact Safety Checks (skip with bypassFilters for cleaner-sms and manual sends) ──
  if (!options?.bypassFilters) {
    // 1. SMS Opt-Out Check — block customers who texted STOP
    try {
      const safetyClient = getSupabaseServiceClient()
      const { data: customer } = await safetyClient
        .from('customers')
        .select('id, sms_opt_out, auto_response_paused, auto_response_disabled')
        .eq('phone_number', toE164Format)
        .eq('tenant_id', tenant.id)
        .limit(1)
        .maybeSingle()

      if (customer?.sms_opt_out) {
        console.log(`[${tenant.slug}] SMS blocked: ${toE164Format} opted out`)
        return { success: false, error: 'Customer opted out of SMS' }
      }

      // 1.5. PERMANENT auto-response disable — owner toggled this off in dashboard.
      // NOTHING overrides this. Not crons, not timeouts, not retargeting, not skipThrottle.
      // Only bypassFilters can skip this (used for cleaner-to-cleaner operational SMS only).
      if (customer?.auto_response_disabled && !options?.bypassFilters) {
        console.log(`[sendSMS] BLOCKED — auto_response_disabled for ${toE164Format} (source: ${options?.source || 'unknown'})`)
        return { success: false, error: 'Customer auto-response permanently disabled by owner' }
      }

      // 2. Auto-Response Paused Check — block AI auto-responses when human took over.
      // Skip for priority/system sends (skipThrottle) since those are manual dashboard sends,
      // quote links, payment links, etc. — not AI auto-responses.
      if (customer?.auto_response_paused && !options?.skipThrottle) {
        console.log(`[${tenant.slug}] SMS blocked: ${toE164Format} has auto_response_paused`)
        return { success: false, error: 'Customer auto-response paused' }
      }
    } catch (optOutErr) {
      // FAIL CLOSED: if we can't verify status, don't send — TCPA compliance
      console.error(`[${tenant.slug}] SMS safety check failed — blocking send:`, optOutErr)
      return { success: false, error: 'Safety check failed — blocked for compliance' }
    }

    // 3. Cleaner Phone Check — don't send customer-facing SMS to cleaner numbers
    try {
      const cleanerPhones = await getCleanerPhoneSet(tenant.id)
      const phoneDigits = toE164Format.replace(/\D/g, '').slice(-10)
      if (cleanerPhones.has(toE164Format) || cleanerPhones.has(phoneDigits) || cleanerPhones.has(`+1${phoneDigits}`)) {
        console.log(`[${tenant.slug}] SMS blocked: ${toE164Format} belongs to a cleaner`)
        return { success: false, error: 'Phone belongs to cleaner' }
      }
    } catch (cleanerErr) {
      // Non-blocking — if cleaner check fails, still send (cleaners are a small list)
      console.error(`[${tenant.slug}] Cleaner phone check failed (non-blocking):`, cleanerErr)
    }
  }

  // ── Content dedup (skip when caller pre-inserted the DB record) ──
  // Prevents the exact same message from being sent twice within 5 minutes.
  // Uses full content match (not prefix) to avoid false positives when
  // different templates share a similar opening (e.g. "Hey {name} it's {business}...")
  // Auto-skip dedup when source is provided (we just pre-inserted the record)
  const shouldSkipDedup = options?.skipDedup || !!options?.source
  if (!shouldSkipDedup) try {
    const dedupClient = getSupabaseServiceClient()
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { data: recentDupes } = await dedupClient
      .from('messages')
      .select('id')
      .eq('phone_number', toE164Format)
      .eq('tenant_id', tenant.id)
      .eq('direction', 'outbound')
      .eq('content', message)
      .gte('created_at', fiveMinsAgo)
      .limit(1)

    if (recentDupes && recentDupes.length > 0) {
      console.warn(`[${tenant.slug}] SMS deduped for ${toE164Format}: same message sent within 5 min`)
      return { success: false, error: 'SMS deduped: identical message recently sent' }
    }
  } catch (dedupErr) {
    console.error(`[${tenant.slug}] SMS dedup check failed:`, dedupErr)
  }

  // ── Throttle removed ──
  // Old 3/day hard limit killed. Conversation awareness check lives in the
  // marketing crons (retargeting, lead followup, monthly nudge) instead of here.
  // All sendSMS calls pass through freely — the crons themselves decide whether
  // to call sendSMS based on conversation state.

  // ── Pre-insert DB record when source is provided ──
  // This prevents the OpenPhone outbound webhook from misidentifying the message
  // as manual and triggering auto_response_paused. The webhook's content-based
  // dedup (messages table match on phone+content+5min window) will find this
  // record and skip manual takeover.
  let preInsertedId: string | null = null
  if (options?.source) {
    try {
      const preInsertClient = getSupabaseServiceClient()
      const { data: preRecord } = await preInsertClient.from('messages').insert({
        tenant_id: tenant.id,
        customer_id: options.customerId || null,
        phone_number: toE164Format,
        role: 'assistant',
        content: message,
        direction: 'outbound',
        message_type: 'sms',
        ai_generated: true,
        timestamp: new Date().toISOString(),
        source: options.source,
      }).select('id').single()
      preInsertedId = preRecord?.id || null
      if (preInsertedId) {
        console.log(`[${tenant.slug}] Pre-inserted message record (source: ${options.source}) for ${toE164Format}`)
      }
    } catch (preInsertErr) {
      // Non-blocking: if pre-insert fails, still send the SMS.
      // The outbound webhook may trigger a false takeover, but at least the message goes out.
      console.error(`[${tenant.slug}] Pre-insert failed (non-blocking):`, preInsertErr)
    }
  }

  try {
    const controller = new AbortController()
    const fetchTimeout = setTimeout(() => controller.abort(), 15_000)
    const response = await fetch(`${OPENPHONE_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: phoneNumberId,
        to: [toE164Format],
        content: message,
      }),
      signal: controller.signal,
    })
    clearTimeout(fetchTimeout)

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[${tenant.slug}] OpenPhone API error:`, response.status, errorText)
      // Clean up pre-inserted record on send failure
      if (preInsertedId) {
        const cleanupClient = getSupabaseServiceClient()
        await cleanupClient.from('messages').delete().eq('id', preInsertedId)
      }
      return {
        success: false,
        error: `OpenPhone API error: ${response.status} - ${errorText}`
      }
    }

    const data = await response.json()
    console.log(`[${tenant.slug}] SMS sent to ${toE164Format}: ${message.slice(0, 50)}...`)
    return {
      success: true,
      messageId: data.data?.id || data.id,
      msgRecordId: preInsertedId || undefined,
    }
  } catch (error) {
    console.error(`[${tenant.slug}] Error sending SMS:`, error)
    // Clean up pre-inserted record on send failure
    if (preInsertedId) {
      try {
        const cleanupClient = getSupabaseServiceClient()
        await cleanupClient.from('messages').delete().eq('id', preInsertedId)
      } catch { /* cleanup is best-effort */ }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Create or update a contact in OpenPhone so names show up in the app.
 * Uses externalId = "customer-{id}" for dedup (409 = already exists).
 */
export async function syncContactToOpenPhone(
  tenant: { openphone_api_key?: string; slug: string },
  customer: { id: number; first_name?: string | null; last_name?: string | null; phone_number: string; email?: string | null }
): Promise<{ success: boolean; contactId?: string; skipped?: boolean; error?: string }> {
  const apiKey = tenant.openphone_api_key
  if (!apiKey) return { success: false, error: 'No OpenPhone API key' }

  const firstName = customer.first_name || 'Unknown'
  const externalId = `customer-${customer.id}`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const body: Record<string, unknown> = {
      externalId,
      source: 'osiris',
      defaultFields: {
        firstName,
        ...(customer.last_name ? { lastName: customer.last_name } : {}),
        phoneNumbers: [{ name: 'mobile', value: customer.phone_number }],
        ...(customer.email ? { emails: [{ name: 'main', value: customer.email }] } : {}),
      },
    }

    const response = await fetch('https://api.openphone.com/v1/contacts', {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (response.status === 409) {
      return { success: true, skipped: true }
    }

    if (!response.ok) {
      const err = await response.text()
      return { success: false, error: `${response.status}: ${err}` }
    }

    const data = await response.json()
    return { success: true, contactId: data.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/**
 * SMS message templates (kept for backwards compatibility)
 */
export const SMS_TEMPLATES = {
  vapiConfirmation: (name: string, serviceType: string, dateTime: string, address: string, isEstimate?: boolean, offerEarned?: boolean, offerApplied?: boolean): string => {
    // Avoid "Cleaning cleaning" — if serviceType already contains "cleaning", don't append it
    const humanType = serviceType.replace(/_/g, ' ')
    const serviceLabel = /cleaning/i.test(humanType) ? humanType : `${humanType} cleaning`
    const displayLabel = isEstimate ? `free ${serviceLabel} estimate` : serviceLabel
    const nextStep = isEstimate
      ? `just reply to confirm and I'll get you scheduled`
      : `just reply to confirm and I'll send over your quote`
    const greeting = name ? `Hi ${name}!` : `Hey!`
    let msg = `${greeting} Just confirming: ${displayLabel} on ${dateTime} at ${address}.\n\nIf anything looks off, just text me. If everything looks good, ${nextStep}!`
    if (offerApplied) {
      msg += `\n\n🎉 Your FREE standard cleaning has been applied to this booking!`
    }
    if (offerEarned) {
      msg += `\n\n🎁 BONUS: You've earned a FREE standard cleaning on your next visit! Book again within 90 days and it's on us.`
    }
    return msg
  },
  paymentConfirmation: (serviceType: string, date: string): string => {
    const humanType = serviceType.replace(/_/g, ' ')
    const serviceLabel = /cleaning/i.test(humanType) ? humanType : `${humanType} cleaning`
    return `Payment received for your ${serviceLabel} on ${date}. We're scheduling your cleaner now and will confirm shortly.`
  },
  invoiceSent: (email: string, invoiceUrl?: string): string => {
    const linkLine = invoiceUrl ? `\nInvoice link: ${invoiceUrl}` : ''
    return `Thanks! I'm sending everything now (and this will be in your email too if you prefer)!${linkLine}`
  },
  quoteFollowUp1hr: (name: string, quoteUrl: string): string => {
    const greeting = name ? `Hey ${name}!` : `Hey!`
    return `${greeting} Did you get a chance to look at that quote? Tap here to book your spot → ${quoteUrl}`
  },
  quoteFollowUp4hr: (name: string, quoteUrl: string): string => {
    const greeting = name ? `Hey ${name}` : `Hey`
    return `${greeting} — still have your time slot held! Book before it fills up → ${quoteUrl}`
  },
  quoteFollowUp24hr: (name: string, quoteUrl: string): string => {
    const greeting = name ? `Hey ${name}` : `Hey`
    return `${greeting}, any questions about the quote? Happy to help! Book here → ${quoteUrl}`
  },
  quoteFollowUp3day: (name: string, quoteUrl: string): string => {
    const greeting = name ? `Hey ${name}` : `Hey`
    return `${greeting} — last chance! We'd love to get you on the schedule. Your quote → ${quoteUrl}`
  },
  footer: '',
}

/**
 * Validate OpenPhone webhook signature for a tenant
 *
 * @param tenant - The tenant configuration
 * @param payload - Raw request body
 * @param signature - Signature from X-OpenPhone-Signature header
 * @returns boolean indicating if signature is valid
 */
export async function validateOpenPhoneWebhook(
  tenant: Tenant | null,
  payload: string,
  signature: string | null,
  timestamp?: string | null
): Promise<boolean> {
  if (!signature) {
    console.warn('No signature provided in webhook request')
    return false
  }

  // Collect all secrets to try: global env var + all per-tenant secrets
  const secretsToTry: string[] = []

  // 1. Global env var (backward compat)
  const globalSecret = process.env.OPENPHONE_WEBHOOK_SECRET
  if (globalSecret) secretsToTry.push(globalSecret)

  // 2. Per-tenant secrets from DB (each tenant has their own OpenPhone account)
  // NOTE: Do NOT filter by active — inactive tenants must still receive webhooks
  // so their messages are stored and visible on the dashboard.
  try {
    const { getSupabaseServiceClient } = await import('./supabase')
    const client = getSupabaseServiceClient()
    const { data: tenants } = await client
      .from('tenants')
      .select('openphone_webhook_secret')
      .not('openphone_webhook_secret', 'is', null)
    if (tenants) {
      for (const t of tenants) {
        if (t.openphone_webhook_secret && !secretsToTry.includes(t.openphone_webhook_secret)) {
          secretsToTry.push(t.openphone_webhook_secret)
        }
      }
    }
  } catch (err) {
    console.warn('[OpenPhone] Could not fetch tenant webhook secrets:', err)
  }

  // If no secrets configured anywhere, reject — fail closed
  if (secretsToTry.length === 0) {
    console.error('[OpenPhone] No webhook secrets configured — rejecting unsigned request')
    return false
  }

  const candidateSignatures = extractSignatureCandidates(signature)
  const payloadVariants = getPayloadVariants(payload, timestamp)

  // Try each secret until one matches
  try {
    for (const secret of secretsToTry) {
      const candidateKeys = getCandidateKeys(secret)
      for (const keyBytes of candidateKeys) {
        for (const payloadBytes of payloadVariants) {
          const signatureBytes = createHmac('sha256', keyBytes)
            .update(payloadBytes)
            .digest()

          const hexSig = signatureBytes.toString('hex')
          const base64Sig = signatureBytes.toString('base64')
          const base64UrlSig = base64Sig
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '')

          for (const candidate of candidateSignatures) {
            const cleaned = candidate.trim()
            if (!cleaned) continue
            if (cleaned.toLowerCase() === hexSig) {
              return true
            }
            if (cleaned === base64Sig || cleaned === base64UrlSig) {
              return true
            }
          }
        }
      }
    }

    console.warn('[OpenPhone] Signature validation failed against all secrets')
    return false
  } catch (error) {
    console.error('Error validating webhook signature:', error)
    return false
  }
}

/**
 * Extract message content from OpenPhone webhook payload
 *
 * OpenPhone v3 webhook structure:
 * {
 *   "object": {
 *     "type": "message.received",
 *     "data": {
 *       "object": {
 *         "from": "+1...",
 *         "body": "message text",
 *         "direction": "incoming"
 *       }
 *     }
 *   }
 * }
 */
export function extractMessageFromOpenPhonePayload(
  body: Record<string, unknown>
): { from: string; to?: string; content: string; createdAt: string; direction?: string; eventType?: string } | null {
  // Log full payload for debugging (truncated)
  console.log('[OpenPhone] Raw payload structure:', JSON.stringify(body).slice(0, 1000))

  // Handle OpenPhone v3 nested structure: body.object.data.object
  const rootObject = (body.object as Record<string, unknown>) || body
  const eventType = (rootObject.type as string) || (body.type as string)
  const dataWrapper = (rootObject.data as Record<string, unknown>) || (body.data as Record<string, unknown>) || body
  const message = (dataWrapper.object as Record<string, unknown>) || dataWrapper

  // Also try to get conversation info which may contain the phone number
  const conversation = (message.conversation as Record<string, unknown>) ||
                       (dataWrapper.conversation as Record<string, unknown>) || {}
  const conversationParticipants = (conversation.participants as Array<Record<string, unknown>>) || []

  const content = firstString(
    message.content,
    message.body,
    message.text,
    message.message,
    (message.message as Record<string, unknown> | undefined)?.content,
    (message.message as Record<string, unknown> | undefined)?.body,
    (message.message as Record<string, unknown> | undefined)?.text
  )

  const from = firstPhone(
    message.from,
    message.sender,
    message.phoneNumber,
    message.phone_number,
    dataWrapper.from,
    dataWrapper.sender,
    dataWrapper.phoneNumber,
    dataWrapper.phone_number
  )

  // Extract the "to" phone number - this is the business phone that received the message
  // OpenPhone may send this in different ways:
  // 1. Direct "to" field with phone number
  // 2. phoneNumberId (OpenPhone internal ID)
  // 3. In the conversation participants
  // 4. In a nested phoneNumber object
  const phoneNumberObj = (message.phoneNumber as Record<string, unknown>) ||
                         (dataWrapper.phoneNumber as Record<string, unknown>) || {}

  const to = firstPhone(
    // Direct to fields
    message.to,
    message.recipient,
    message.toPhoneNumber,
    message.to_phone_number,
    dataWrapper.to,
    dataWrapper.recipient,
    dataWrapper.toPhoneNumber,
    dataWrapper.to_phone_number,
    // Phone number from nested object
    phoneNumberObj.number,
    phoneNumberObj.phoneNumber,
    // OpenPhone phone ID (fallback)
    message.phoneNumberId,
    dataWrapper.phoneNumberId,
    // Conversation phone number (for incoming, the "to" is the conversation phone)
    conversation.phoneNumber,
    conversation.phoneNumberId,
    // Try participants (business phone is usually the one that's not the "from" number)
    ...conversationParticipants
      .filter((p: Record<string, unknown>) => p.phoneNumber !== from && p.number !== from)
      .map((p: Record<string, unknown>) => p.phoneNumber || p.number)
  )

  // Log what we found for debugging
  console.log('[OpenPhone] Extracted to field:', to, 'from fields:', {
    'message.to': message.to,
    'message.phoneNumberId': message.phoneNumberId,
    'dataWrapper.phoneNumberId': dataWrapper.phoneNumberId,
    'phoneNumberObj': phoneNumberObj,
    'conversation.phoneNumber': conversation.phoneNumber,
  })

  const createdAt = firstString(
    message.createdAt,
    message.created_at,
    message.timestamp,
    dataWrapper.createdAt,
    dataWrapper.timestamp
  ) || new Date().toISOString()

  const rawDirection = firstString(message.direction, dataWrapper.direction, body.direction)

  // Normalize direction: OpenPhone uses "incoming"/"outgoing", we use "inbound"/"outbound"
  let direction: string | undefined
  if (rawDirection === 'incoming' || rawDirection === 'inbound') {
    direction = 'inbound'
  } else if (rawDirection === 'outgoing' || rawDirection === 'outbound') {
    direction = 'outbound'
  } else {
    direction = rawDirection
  }

  // Try to find the message content
  if (!from || !content) {
    console.warn('Could not extract message from OpenPhone payload:', JSON.stringify(body).slice(0, 500))
    return null
  }

  return {
    from,
    to,
    content,
    createdAt,
    direction,
    eventType,
  }
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function firstPhone(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const candidate = firstString(
        record.phoneNumber,
        record.phone_number,
        record.number,
        record.phone
      )
      if (candidate) {
        return candidate
      }
    }
  }
  return undefined
}

function getCandidateKeys(secret: string): Buffer[] {
  const trimmed = secret.trim()
  const candidates: Buffer[] = [Buffer.from(trimmed, 'utf8')]

  const base64Bytes = decodeIfBase64ToBuffer(trimmed)
  if (base64Bytes) {
    candidates.push(base64Bytes)
  }

  const hexBytes = decodeIfHexToBuffer(trimmed)
  if (hexBytes) {
    candidates.push(hexBytes)
  }

  return candidates
}

function decodeIfBase64ToBuffer(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, 'base64')
    if (!buffer.length) {
      return null
    }

    const reencoded = buffer.toString('base64').replace(/=+$/g, '')
    const normalized = value.replace(/=+$/g, '')
    if (reencoded !== normalized) {
      return null
    }

    return buffer
  } catch {
    return null
  }
}

function decodeIfHexToBuffer(value: string): Buffer | null {
  const trimmed = value.trim()
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length % 2 !== 0) {
    return null
  }

  try {
    return Buffer.from(trimmed, 'hex')
  } catch {
    return null
  }
}

function extractSignatureCandidates(signature: string): string[] {
  const candidates = new Set<string>()
  const raw = signature.trim()
  if (!raw) return []

  candidates.add(raw)
  candidates.add(raw.replace(/^sha256=/i, ''))

  // OpenPhone format: "hmac;{version};{timestamp};{digest}"
  const semicolonParts = raw.split(';')
  if (semicolonParts.length >= 4 && semicolonParts[0].toLowerCase() === 'hmac') {
    candidates.add(semicolonParts[3])
  }

  // Stripe-style format: "t=1234,v1=abc..."
  const commaParts = raw.split(',')
  for (const part of commaParts) {
    const segment = part.trim()
    if (!segment) continue

    const eqIndex = segment.indexOf('=')
    if (eqIndex > 0) {
      const key = segment.slice(0, eqIndex).trim().toLowerCase()
      const value = segment.slice(eqIndex + 1).trim().replace(/^"|"$/g, '')
      if (value && ['v1', 'v0', 'sig', 'signature', 'sha256', 'hmac'].includes(key)) {
        candidates.add(value)
      }
    }
  }

  return Array.from(candidates)
}

function getPayloadVariants(payload: string, timestamp?: string | null): Buffer[] {
  const variants = [Buffer.from(payload, 'utf8')]
  const trimmedTimestamp = timestamp?.trim()
  if (trimmedTimestamp) {
    variants.push(Buffer.from(`${trimmedTimestamp}.${payload}`, 'utf8'))
  }
  return variants
}
