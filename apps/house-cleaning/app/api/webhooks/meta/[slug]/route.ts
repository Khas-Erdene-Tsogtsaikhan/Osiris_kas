import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServiceClient } from "@/lib/supabase"
import { normalizePhoneNumber } from "@/lib/phone-utils"
import { scheduleLeadFollowUp } from "@/lib/scheduler"
import { logSystemEvent } from "@/lib/system-events"
import { getTenantBySlug, getTenantServiceDescription, type Tenant } from "@/lib/tenant"
import { upsertLeadCustomer } from "@/lib/customer-dedup"
import { sendSMS } from "@/lib/openphone"
import { generateAutoResponse } from "@/lib/auto-response"
import { analyzeBookingIntent } from "@/lib/ai-intent"
import { buildFirstTouchSMS } from "@/lib/website-lead-sms"
import { wireFollowupsAfterOutbound } from "@/lib/services/followups/wire"

/**
 * Meta Webhook Router — handles ALL Page events for a tenant.
 *
 * GET  /api/webhooks/meta/{slug} — Verification (Meta sends hub.challenge)
 * POST /api/webhooks/meta/{slug} — Event delivery
 *
 * Supports:
 *   - leadgen / leadgen_update  → ingest lead, schedule SMS follow-up
 *   - messages                   → AI auto-reply via Messenger (reuses SMS responder)
 *   - ratings                    → auto-thank 4-5★, alert owner on 1-3★
 *   - feed                       → auto-reply to public comments with price/service intent
 */

const META_API_BASE = "https://graph.facebook.com/v21.0"

// ── GET: Webhook Verification ──
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")

  if (mode !== "subscribe") {
    return new NextResponse("Invalid mode", { status: 400 })
  }

  const tenant = await getTenantBySlug(slug)
  const expectedToken =
    (tenant?.workflow_config as Record<string, unknown>)?.meta_verify_token ||
    process.env.META_VERIFY_TOKEN

  if (!expectedToken || token !== expectedToken) {
    console.error(`[Meta Webhook] Verification failed for ${slug} — token mismatch`)
    return new NextResponse("Forbidden", { status: 403 })
  }

  console.log(`[Meta Webhook] Verified for ${slug}`)
  return new NextResponse(challenge, { status: 200 })
}

// ── POST: Event Delivery ──
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const tenant = await getTenantBySlug(slug)
  if (!tenant) {
    console.error(`[Meta Webhook] Unknown tenant slug: ${slug}`)
    return NextResponse.json({ received: true })
  }

  const wc = (tenant.workflow_config || {}) as Record<string, unknown>
  const accessToken =
    (wc.meta_ads_access_token as string) ||
    (wc.meta_page_access_token as string) ||
    process.env.META_PAGE_ACCESS_TOKEN ||
    process.env.META_ACCESS_TOKEN
  if (!accessToken) {
    console.error(`[Meta Webhook] No access token for ${slug}`)
    return NextResponse.json({ received: true })
  }

  const entries = (body.entry || []) as Array<Record<string, unknown>>
  let counters = { leadgen: 0, messenger: 0, ratings: 0, feed: 0, other: 0 }

  for (const entry of entries) {
    // Messenger messages arrive as entry.messaging[], not entry.changes[]
    const messaging = entry.messaging as Array<Record<string, unknown>> | undefined
    if (messaging && messaging.length > 0) {
      for (const msg of messaging) {
        try {
          const handled = await handleMessengerEvent(tenant, msg, accessToken)
          if (handled) counters.messenger++
        } catch (err) {
          console.error(`[Meta Webhook:${slug}] messenger error:`, err)
        }
      }
      continue
    }

    const changes = (entry.changes || []) as Array<Record<string, unknown>>
    for (const change of changes) {
      const field = change.field as string
      const value = change.value as Record<string, unknown>

      try {
        if (field === "leadgen" || field === "leadgen_update") {
          const leadgenId = value?.leadgen_id as string
          if (!leadgenId) continue
          const leadData = await fetchMetaLead(leadgenId, accessToken)
          if (leadData) {
            await processMetaLead(tenant, leadData, leadgenId)
            counters.leadgen++
          }
        } else if (field === "ratings") {
          await handleRatingChange(tenant, value, accessToken)
          counters.ratings++
        } else if (field === "feed") {
          await handleFeedChange(tenant, value, accessToken)
          counters.feed++
        } else {
          counters.other++
        }
      } catch (err) {
        console.error(`[Meta Webhook:${slug}] ${field} error:`, err)
      }
    }
  }

  console.log(`[Meta Webhook:${slug}] processed`, counters)
  return NextResponse.json({ received: true, ...counters })
}

// =====================================================================
// LEADGEN
// =====================================================================

async function fetchMetaLead(leadId: string, accessToken: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(`${META_API_BASE}/${leadId}?access_token=${accessToken}`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      const err = await res.text()
      console.error(`[Meta Webhook] Graph API error: ${res.status} ${err}`)
      return null
    }
    return await res.json()
  } catch (err) {
    clearTimeout(timeout)
    console.error("[Meta Webhook] Graph API fetch failed:", err)
    return null
  }
}

async function processMetaLead(
  tenant: { id: string; slug: string; name: string; business_name_short?: string },
  leadData: Record<string, unknown>,
  leadgenId: string
) {
  const client = getSupabaseServiceClient()

  const fieldData = (leadData.field_data || []) as Array<{ name: string; values: string[] }>
  const fields: Record<string, string> = {}
  for (const f of fieldData) {
    fields[f.name?.toLowerCase()] = f.values?.[0] || ""
  }

  const fullName = fields.full_name || fields.name || ""
  const firstName = fields.first_name || fullName.split(" ")[0] || ""
  const lastName = fields.last_name || fullName.split(" ").slice(1).join(" ") || ""
  const email = fields.email || ""
  const phoneRaw = fields.phone_number || fields.phone || ""
  const phone = normalizePhoneNumber(phoneRaw) || phoneRaw
  const serviceType = fields.service_type || fields.what_service_are_you_interested_in || ""
  const address = fields.street_address || fields.address || fields.zip_code || fields.city || ""

  if (!phone) {
    console.warn(`[Meta Webhook] Lead ${leadgenId} has no phone number — skipping`)
    return
  }

  const { data: existing } = await client
    .from("leads")
    .select("id")
    .eq("source_id", `meta-${leadgenId}`)
    .eq("tenant_id", tenant.id)
    .limit(1)
    .maybeSingle()

  if (existing) {
    console.log(`[Meta Webhook] Lead ${leadgenId} already processed — skipping`)
    return
  }

  const dedupResult = await upsertLeadCustomer(client, {
    tenant_id: tenant.id,
    phone_number: phone,
    first_name: firstName || null,
    last_name: lastName || null,
    email: email || null,
    address: address || null,
    lead_source: "meta",
  })
  const customer = dedupResult ? { id: dedupResult.customer_id } : null

  if (dedupResult?.was_merged && dedupResult.match) {
    await logSystemEvent({
      tenant_id: tenant.id,
      source: "meta",
      event_type: "CUSTOMER_MERGED_ON_LEAD",
      message: `Meta lead merged into existing customer #${dedupResult.match.existing_id} by ${dedupResult.match.reason}`,
      phone_number: phone,
      metadata: {
        reason: dedupResult.match.reason,
        existing_phone: dedupResult.match.existing_phone,
        existing_email: dedupResult.match.existing_email,
        incoming_phone: phone,
        incoming_email: email || null,
        leadgen_id: leadgenId,
      },
    })
  }
  if (dedupResult?.duplicate_first_name_count && dedupResult.duplicate_first_name_count > 0) {
    await logSystemEvent({
      tenant_id: tenant.id,
      source: "meta",
      event_type: "DUPLICATE_FIRST_NAME_WARNING",
      message: `New Meta customer #${dedupResult.customer_id} shares first name "${firstName}" with ${dedupResult.duplicate_first_name_count} existing customer(s)`,
      phone_number: phone,
      metadata: {
        first_name: firstName,
        duplicate_count: dedupResult.duplicate_first_name_count,
        leadgen_id: leadgenId,
      },
    })
  }

  const { data: lead, error: leadError } = await client
    .from("leads")
    .insert({
      tenant_id: tenant.id,
      source_id: `meta-${leadgenId}`,
      phone_number: phone,
      customer_id: customer?.id ?? null,
      first_name: firstName || null,
      last_name: lastName || null,
      email: email || null,
      source: "meta",
      status: "new",
      form_data: {
        ...fields,
        meta_leadgen_id: leadgenId,
        meta_form_id: leadData.form_id,
        meta_ad_id: leadData.ad_id,
        service_type: serviceType,
        address,
        submitted_at: leadData.created_time || new Date().toISOString(),
      },
      followup_stage: 0,
      followup_started_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (leadError) {
    console.error(`[Meta Webhook] Error creating lead for ${tenant.slug}:`, leadError)
    return
  }

  await logSystemEvent({
    tenant_id: tenant.id,
    source: "meta",
    event_type: "META_LEAD_RECEIVED",
    message: `New Meta Lead Ad: ${firstName || "Unknown"} ${lastName || ""}`.trim(),
    phone_number: phone,
    metadata: {
      lead_id: lead?.id,
      leadgen_id: leadgenId,
      service_type: serviceType,
      tenant_slug: tenant.slug,
    },
  })

  // ── First-touch SMS (Build 3 — Meta leads previously relied on legacy
  // lead_followup stage 1 to send the intro, but the v2 cutover gate cancels
  // that, so 3 Meta leads on 4/30 (Charles, Cory, Thomas) got zero SMS).
  // Send directly + wire ghost chase, mirroring the website webhook pattern.
  if (lead?.id && customer?.id) {
    const businessName = (tenant as Tenant & { business_name_short?: string }).business_name_short || tenant.name || "Our team"
    const sdrName = (tenant as Tenant & { sdr_persona?: string }).sdr_persona || "Mary"
    const friendlyService = serviceType
      ? serviceType.replace(/[-_]/g, " ")
      : getTenantServiceDescription(tenant)

    const smsBody = buildFirstTouchSMS({
      firstName: firstName || "there",
      sdrName,
      businessName,
      serviceType,
      friendlyService,
      bedrooms: null,
      bathrooms: null,
      address,
      estimatedPrice: null,
      promo: null,
    })

    const smsResult = await sendSMS(tenant, phone, smsBody, {
      skipDedup: true,
      source: "meta_lead_auto",
      customerId: customer.id,
    })

    if (!smsResult.success) {
      console.error(`[Meta Webhook] First-touch SMS failed for lead ${lead.id}:`, smsResult.error)
    } else {
      try {
        await wireFollowupsAfterOutbound({
          tenant: { id: tenant.id, slug: tenant.slug, workflow_config: tenant.workflow_config },
          customer: { id: customer.id, phone_number: phone },
          quoteJustSent: false,
          activeLeadId: lead.id,
          source: "meta_lead_auto",
        })
      } catch (wireErr) {
        console.error("[Meta Webhook] v2 wire (intro) failed (non-blocking):", wireErr)
      }
    }
  }

  if (lead?.id) {
    try {
      const leadName = `${firstName || ""} ${lastName || ""}`.trim() || "Customer"
      // Legacy backup. Stage 1 dedup'd by message-source check; stages 2-5 are
      // cancelled by v2 cutover gate when followup_rebuild_v2_enabled=true.
      await scheduleLeadFollowUp(tenant.id, String(lead.id), phone, leadName)
      console.log(`[Meta Webhook] Scheduled follow-up for Meta lead ${lead.id} (${tenant.slug})`)
    } catch (err) {
      console.error("[Meta Webhook] Error scheduling follow-up:", err)
    }
  }
}

// =====================================================================
// MESSENGER
// =====================================================================

interface MessengerEvent {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: { mid?: string; text?: string; is_echo?: boolean }
  postback?: { payload?: string; title?: string }
}

async function handleMessengerEvent(
  tenant: Tenant,
  rawEvent: Record<string, unknown>,
  accessToken: string
): Promise<boolean> {
  const event = rawEvent as MessengerEvent
  const senderId = event.sender?.id
  const pageMessage = event.message

  // Echo (our own outbound message) → skip
  if (pageMessage?.is_echo) return false
  if (!senderId) return false

  const text = pageMessage?.text || event.postback?.payload || event.postback?.title
  if (!text || !text.trim()) return false

  const mid = pageMessage?.mid || `postback-${senderId}-${event.timestamp ?? Date.now()}`
  const client = getSupabaseServiceClient()

  // Dedup — Meta retries on non-200 within ~20s
  const { data: existing } = await client
    .from("messages")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("external_message_id", mid)
    .limit(1)
    .maybeSingle()
  if (existing) {
    console.log(`[Messenger:${tenant.slug}] duplicate mid ${mid} — skipping`)
    return false
  }

  // Persist inbound
  await client.from("messages").insert({
    tenant_id: tenant.id,
    direction: "inbound",
    content: text,
    external_message_id: mid,
    source: "meta_messenger",
    message_type: "messenger",
    role: "client",
    metadata: {
      messenger_psid: senderId,
      page_id: event.recipient?.id,
      timestamp: event.timestamp,
    },
  })

  // Generate AI reply via the existing SMS auto-responder
  let reply: string | null = null
  try {
    const intent = await analyzeBookingIntent(text)
    const aiResult = await generateAutoResponse(text, intent, tenant, [], undefined, {})
    if (aiResult.shouldSend && aiResult.response?.trim()) {
      reply = aiResult.response.replace(/\|\|\|/g, "\n\n").trim()
    } else {
      console.log(`[Messenger:${tenant.slug}] AI declined reply: ${aiResult.reason}`)
    }
  } catch (err) {
    console.error(`[Messenger:${tenant.slug}] AI generation failed:`, err)
  }

  if (!reply) {
    const short = tenant.business_name_short || tenant.name || "our team"
    reply = `Thanks for reaching out to ${short}! One of our team will follow up shortly.`
  }

  await sendMessengerMessage(senderId, reply, accessToken)
  await client.from("messages").insert({
    tenant_id: tenant.id,
    direction: "outbound",
    content: reply,
    source: "meta_messenger_ai",
    message_type: "messenger",
    role: "assistant",
    ai_generated: true,
    metadata: { messenger_psid: senderId, auto: true },
  })

  await logSystemEvent({
    tenant_id: tenant.id,
    source: "meta_messenger",
    event_type: "MESSENGER_AI_REPLY",
    message: `Messenger AI replied to PSID ${senderId}`,
    metadata: { psid: senderId, inbound_preview: text.slice(0, 120), outbound_preview: reply.slice(0, 120) },
  })

  return true
}

async function sendMessengerMessage(recipientPsid: string, text: string, accessToken: string) {
  const body = {
    recipient: { id: recipientPsid },
    messaging_type: "RESPONSE",
    message: { text: text.slice(0, 2000) },
  }
  const res = await fetch(`${META_API_BASE}/me/messages?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error(`[Messenger] send failed ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.ok
}

// =====================================================================
// RATINGS
// =====================================================================

async function handleRatingChange(
  tenant: Tenant,
  value: Record<string, unknown>,
  _accessToken: string
) {
  const verb = (value.verb as string) || "unknown"
  if (verb !== "add") return

  const rating = typeof value.rating === "number" ? value.rating : parseInt(String(value.rating || 0), 10)
  const reviewText = (value.review_text as string) || ""
  const reviewerName = (value.reviewer?.name as string) || "A customer"
  const permalink = (value.permalink_url as string) || ""

  const client = getSupabaseServiceClient()
  await client.from("system_events").insert({
    tenant_id: tenant.id,
    source: "meta_ratings",
    event_type: rating >= 4 ? "FB_REVIEW_POSITIVE" : "FB_REVIEW_NEGATIVE",
    message: `${rating}★ review from ${reviewerName}${reviewText ? ": " + reviewText.slice(0, 200) : ""}`,
    metadata: { rating, reviewer_name: reviewerName, review_text: reviewText, permalink },
  })

  if (tenant.owner_phone) {
    if (rating <= 3) {
      const msg = `🚨 ${rating}★ FB REVIEW for ${tenant.name}\n${reviewerName}: ${reviewText || "(no text)"}\n${permalink}\n\nReview + respond ASAP.`
      await sendSMS(tenant, tenant.owner_phone, msg, { source: "meta_ratings", bypassFilters: true })
    } else {
      const msg = `⭐ ${rating}★ FB review for ${tenant.name} from ${reviewerName}. ${permalink}`
      await sendSMS(tenant, tenant.owner_phone, msg, { source: "meta_ratings", bypassFilters: true })
    }
  }
}

// =====================================================================
// FEED (public comments on page posts)
// =====================================================================

const PRICE_INTENT_PATTERNS = [
  /\bhow much\b/i,
  /\bprice\b/i,
  /\bcost\b/i,
  /\bquote\b/i,
  /\$\d/,
  /\bfor (a|my)\b.*\b(bed|bath|house|apt)/i,
]

function hasPriceIntent(text: string): boolean {
  return PRICE_INTENT_PATTERNS.some((re) => re.test(text))
}

async function handleFeedChange(
  tenant: Tenant,
  value: Record<string, unknown>,
  accessToken: string
) {
  const item = value.item as string | undefined
  const verb = value.verb as string | undefined
  const commentId = value.comment_id as string | undefined
  const message = (value.message as string) || ""
  const from = value.from as { id?: string; name?: string } | undefined

  if (item !== "comment" || verb !== "add" || !commentId) return
  if (from?.id === (tenant.workflow_config as Record<string, unknown>)?.meta_page_id) return // our own comment
  if (!message.trim()) return

  const client = getSupabaseServiceClient()
  await client.from("system_events").insert({
    tenant_id: tenant.id,
    source: "meta_feed",
    event_type: "FB_PAGE_COMMENT",
    message: `${from?.name || "Someone"} commented: ${message.slice(0, 200)}`,
    metadata: { comment_id: commentId, from, message, value },
  })

  if (!hasPriceIntent(message)) return

  const shortName = tenant.business_name_short || tenant.name || "us"
  const reply = `Hi ${from?.name?.split(" ")[0] || "there"}, just DM'd you a quote from ${shortName}. Check your Messenger!`

  try {
    const res = await fetch(
      `${META_API_BASE}/${commentId}/comments?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message: reply }).toString(),
      }
    )
    if (!res.ok) {
      const err = await res.text()
      console.error(`[Feed] public reply failed ${res.status}: ${err.slice(0, 200)}`)
    }
  } catch (err) {
    console.error(`[Feed:${tenant.slug}] public reply error:`, err)
  }

  // Attempt DM — may fail if we can't initiate (Meta's 24h rule), that's fine
  if (from?.id) {
    const dmText = `Hi ${from.name?.split(" ")[0] || "there"}! Saw your comment on our page. For a fast quote, text us your address + bed/bath count and we'll send pricing right back.`
    await sendMessengerMessage(from.id, dmText, accessToken)
  }
}
