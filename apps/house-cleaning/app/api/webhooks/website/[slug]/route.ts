import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServiceClient } from "@/lib/supabase"
import { normalizePhoneNumber } from "@/lib/phone-utils"
import { sendSMS } from "@/lib/openphone"
import { scheduleLeadFollowUp } from "@/lib/scheduler"
import { logSystemEvent } from "@/lib/system-events"
import { getTenantBySlug, getTenantServiceDescription, tenantUsesFeature } from "@/lib/tenant"
import { upsertLeadCustomer } from "@/lib/customer-dedup"
import { buildFirstTouchSMS } from "@/lib/website-lead-sms"
import { transitionState } from "@/lib/lifecycle-state"
import { computeNudgeSendTime } from "@/lib/nudge-timing"
import { scheduleTask, scheduleRetargetingSequence } from "@/lib/scheduler"
import { wireFollowupsAfterOutbound } from "@/lib/services/followups/wire"

// CORS headers for embed-friendly response (any domain can POST)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

/**
 * Website Lead Form Webhook
 *
 * POST /api/webhooks/website/{slug}
 * Accepts flexible JSON payload from website forms / quote calculators.
 *
 * - Resolves tenant from URL slug
 * - Validates name + phone (required)
 * - Upserts customer, creates lead with source details + UTM
 * - Sends an immediate SMS acknowledging the submission
 * - Schedules follow-up sequence (stages 2-5, skips instant stage 1)
 * - Returns embed-friendly response with CORS headers
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  // Resolve tenant
  const tenant = await getTenantBySlug(slug)
  if (!tenant) {
    return NextResponse.json(
      { success: false, error: "Unknown business" },
      { status: 404, headers: corsHeaders }
    )
  }

  // Parse body
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown parse error'
    await logSystemEvent({
      tenant_id: tenant.id,
      source: "website",
      event_type: "WEBSITE_FORM_PARSE_FAIL",
      message: `Website form payload could not be parsed: ${msg}`,
      metadata: { error: msg },
    })
    return NextResponse.json(
      { success: false, error: "Invalid JSON body", code: "parse_error" },
      { status: 400, headers: corsHeaders }
    )
  }

  // ── Extract & validate required fields ──────────────────────────

  const nameRaw =
    (body.name as string) ||
    [body.first_name || body.firstName, body.last_name || body.lastName]
      .filter(Boolean)
      .join(" ") ||
    ""

  if (!nameRaw.trim()) {
    return NextResponse.json(
      { success: false, error: "Name is required" },
      { status: 400, headers: corsHeaders }
    )
  }

  const phoneRaw =
    (body.phone as string) ||
    (body.phone_number as string) ||
    (body.phoneNumber as string) ||
    ""
  const phone = normalizePhoneNumber(String(phoneRaw)) || String(phoneRaw)

  if (!phone) {
    return NextResponse.json(
      { success: false, error: "Phone number is required" },
      { status: 400, headers: corsHeaders }
    )
  }

  // ── Extract optional fields ─────────────────────────────────────

  const firstName =
    (body.first_name as string) ||
    (body.firstName as string) ||
    nameRaw.split(" ")[0] ||
    ""
  const lastName =
    (body.last_name as string) ||
    (body.lastName as string) ||
    nameRaw.split(" ").slice(1).join(" ") ||
    ""
  const email = (body.email as string) || ""
  const address = (body.address as string) || ""
  const serviceType = (body.service_type as string) || (body.serviceType as string) || ""
  const message = (body.message as string) || (body.notes as string) || ""
  const sourceDetail = (body.source as string) || "website"
  const source = "website" // DB CHECK constraint — detail preserved in form_data
  const bedrooms = typeof body.bedrooms === "number" ? body.bedrooms : null
  const bathrooms = typeof body.bathrooms === "number" ? body.bathrooms : null
  const frequency = (body.frequency as string) || null
  const estimatedPrice = typeof body.estimated_price === "number" ? body.estimated_price : null

  const client = getSupabaseServiceClient()

  // ── Dedup-aware customer upsert ──────────────────────────────────
  // Looks up existing customer by email first, then phone. Prevents the
  // AJ-style bug where the same person submits with a different phone
  // number and gets a duplicate customer record.

  const dedupResult = await upsertLeadCustomer(client, {
    tenant_id: tenant.id,
    phone_number: phone,
    first_name: firstName || null,
    last_name: lastName || null,
    email: email || null,
    address: address || null,
    lead_source: source,
  })
  const customer = dedupResult ? { id: dedupResult.customer_id } : null

  if (dedupResult?.was_merged && dedupResult.match) {
    await logSystemEvent({
      tenant_id: tenant.id,
      source: "website",
      event_type: "CUSTOMER_MERGED_ON_LEAD",
      message: `Website lead merged into existing customer #${dedupResult.match.existing_id} by ${dedupResult.match.reason}`,
      phone_number: phone,
      metadata: {
        reason: dedupResult.match.reason,
        existing_phone: dedupResult.match.existing_phone,
        existing_email: dedupResult.match.existing_email,
        incoming_phone: phone,
        incoming_email: email || null,
      },
    })
  }
  if (dedupResult?.duplicate_first_name_count && dedupResult.duplicate_first_name_count > 0) {
    await logSystemEvent({
      tenant_id: tenant.id,
      source: "website",
      event_type: "DUPLICATE_FIRST_NAME_WARNING",
      message: `New customer #${dedupResult.customer_id} shares first name "${firstName}" with ${dedupResult.duplicate_first_name_count} existing customer(s)`,
      phone_number: phone,
      metadata: {
        first_name: firstName,
        duplicate_count: dedupResult.duplicate_first_name_count,
      },
    })
  }

  // ── Cancel stale retargeting for this customer ──────────────────
  // If this phone already has an active retargeting sequence from a previous
  // interaction, cancel it — the customer is re-engaging organically.
  if (customer?.id) {
    try {
      const { cancelPendingTasks } = await import("@/lib/lifecycle-engine")
      const cancelled = await cancelPendingTasks(tenant.id, `retarget-${customer.id}-`)
      if (cancelled > 0) {
        console.log(`[Website Webhook] Cancelled ${cancelled} stale retargeting tasks for customer ${customer.id}`)
        await client
          .from("customers")
          .update({
            retargeting_completed_at: new Date().toISOString(),
            retargeting_stopped_reason: "new_website_lead",
            auto_response_paused: false,
          })
          .eq("id", customer.id)
      }
    } catch (cancelErr) {
      console.error("[Website Webhook] Error cancelling retargeting:", cancelErr)
    }
  }

  // ── Create lead ─────────────────────────────────────────────────

  const { data: lead, error: leadError } = await client
    .from("leads")
    .insert({
      tenant_id: tenant.id,
      source_id: `website-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phone_number: phone,
      customer_id: customer?.id ?? null,
      first_name: firstName || null,
      last_name: lastName || null,
      email: email || null,
      source,
      status: "new",
      form_data: {
        ...body,
        source_detail: sourceDetail,
        service_type: serviceType,
        message,
        address,
        bedrooms,
        bathrooms,
        frequency,
        estimated_price: estimatedPrice,
        utm_source: body.utm_source || null,
        utm_medium: body.utm_medium || null,
        utm_campaign: body.utm_campaign || null,
        utm_content: body.utm_content || null,
        utm_term: body.utm_term || null,
        submitted_at: new Date().toISOString(),
      },
      followup_stage: 1, // Mark stage 1 as done since we send SMS inline
      followup_started_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (leadError) {
    // Structured error logging — the generic "Something went wrong" message
    // on the Texas Nova form came from swallowing these details. Log the
    // full PostgrestError shape (code, message, hint, details) to
    // system_events so Patrick/Dominic can diagnose from the dashboard.
    // Bug T1 — 2026-04-20.
    console.error(`[Website Webhook] Error creating lead for ${tenant.slug}:`, {
      code: leadError.code,
      message: leadError.message,
      details: leadError.details,
      hint: leadError.hint,
    })
    await logSystemEvent({
      tenant_id: tenant.id,
      source: "website",
      event_type: "WEBSITE_FORM_LEAD_INSERT_FAIL",
      message: `Failed to insert lead for ${tenant.slug}: ${leadError.code} ${leadError.message}`,
      phone_number: phone,
      metadata: {
        code: leadError.code,
        message: leadError.message,
        details: leadError.details,
        hint: leadError.hint,
        payload_keys: Object.keys(body),
        name: nameRaw,
        bedrooms,
        bathrooms,
        has_email: !!email,
        has_address: !!address,
        service_type: serviceType,
      },
    })
    // Return a descriptive error code (NOT the raw DB details — those can
    // leak schema). The form UI can map the code to a user-friendly message.
    return NextResponse.json(
      {
        success: false,
        error: "Could not submit your estimate. Please try again or call us.",
        code: "lead_insert_failed",
        ref: `${tenant.slug}-${Date.now().toString(36)}`,
      },
      { status: 500, headers: corsHeaders }
    )
  }

  // ── Send immediate SMS ──────────────────────────────────────────

  const businessName = tenant.business_name_short || tenant.name || "Our team"
  const serviceDesc = getTenantServiceDescription(tenant)
  const friendlyService = serviceType
    ? serviceType.replace(/[-_]/g, " ")
    : serviceDesc

  const sdrName = tenant.sdr_persona || "Mary"

  // Check for promo campaign (shared config — single source of truth).
  // Pass `booking_data` through so the promo gate can refuse to downgrade
  // a customer who used the regular booking widget into a $149 promo just
  // because their URL had a stale utm_campaign tag (Ebony g, 2026-04-30).
  const { getPromoConfig } = await import('@/lib/promo-config')
  const promoConfig = getPromoConfig({
    utm_campaign: body.utm_campaign,
    source_detail: sourceDetail,
    service_type: serviceType,
    booking_data: body.booking_data,
  })

  // ── 5-minute auto-intro dedup ───────────────────────────────────
  // The widget on spotlessscrubbers.org has historically double-fired (Judy
  // 4/28, Crystal 4/26) — once with service=deep, once with service=standard,
  // 2-3 minutes apart. The customer sees the same `Hey {name}, it's Sarah...`
  // intro twice with different service labels, looks janky. Suppress a second
  // auto-intro within 5 minutes for the same phone+tenant.
  let suppressIntroDup = false
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { count: recentAutoIntros } = await client
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('phone_number', phone)
      .eq('direction', 'outbound')
      .eq('source', 'website_lead_auto')
      .gte('created_at', fiveMinAgo)
    if (recentAutoIntros && recentAutoIntros > 0) {
      suppressIntroDup = true
      console.log(`[Website Webhook] Suppressing duplicate auto-intro for ${phone} (already sent within 5 min)`)
      await logSystemEvent({
        tenant_id: tenant.id,
        source: 'website',
        event_type: 'WEBSITE_INTRO_DUPE_SUPPRESSED',
        message: `Duplicate website-lead auto-intro suppressed for ${phone}`,
        phone_number: phone,
        metadata: { recent_auto_intros: recentAutoIntros },
      })
    }
  } catch (dupErr) {
    // Non-blocking — if the dedup check fails, fall through to normal send.
    console.error('[Website Webhook] Intro dedup check failed (non-blocking):', dupErr)
  }

  // ── Upfront quote (full-info form submission) ───────────────────
  // When the form supplies enough to price a job (email + address + bed/bath)
  // and the tenant uses the standard remote-cleaning quote flow, skip the
  // "ask for missing info" first-touch SMS and create + send a quote link
  // immediately. Mirrors the [BOOKING_COMPLETE] branch in the openphone
  // webhook (apps/house-cleaning/app/api/webhooks/openphone/route.ts).
  const isWindowCleaningTenant = tenantUsesFeature(tenant, 'use_hcp_mirror')
  // Address is optional here — the spotlessscrubbers.org quote calculator only
  // collects name/phone/email + bed/bath. The customer fills in the address on
  // the quote page itself (quotes.customer_address is nullable, and the quote
  // UI prompts for address when it's missing).
  const hasQuoteableInfo =
    !!(email && typeof bedrooms === 'number' && typeof bathrooms === 'number') &&
    !!customer?.id &&
    !!lead?.id

  // Hold onto the quote URL across silent fall-through paths in the upfront-
  // quote branch (quote insert errors, quote-SMS errors). Even when the
  // dedicated quote SMS fails, we still want to surface the URL in the
  // buildFirstTouchSMS fallback so the customer always gets a usable link.
  let pendingQuoteUrl: string | null = null

  if (hasQuoteableInfo && !isWindowCleaningTenant) {
    const svcType = (serviceType || '').toLowerCase()
    const quoteCategory = svcType.includes('move') ? 'move_in_out' : 'standard'
    // Pre-select tier from form so the quote page matches what the customer
    // asked for (and what AI quoted in SMS) instead of dropping them on a
    // blank tier picker.
    const formTier: 'deep' | 'standard' | null =
      svcType.includes('deep') ? 'deep'
      : svcType.includes('standard') ? 'standard'
      : null
    const isMetaPromo = !!promoConfig

    const { data: newQuote, error: quoteError } = await client
      .from('quotes')
      .insert({
        tenant_id: tenant.id,
        customer_id: customer.id,
        customer_name: [firstName, lastName].filter(Boolean).join(' ') || null,
        customer_phone: phone,
        customer_email: email,
        customer_address: address || null,
        bedrooms,
        bathrooms,
        square_footage: null,
        service_category: quoteCategory,
        selected_tier: promoConfig?.tier || formTier,
        custom_base_price: promoConfig?.price || null,
        selected_addons: promoConfig?.addons || [],
        service_date: null,
        service_time: null,
        notes: [
          promoConfig ? `$${promoConfig.price} Meta Promo` : null,
          frequency ? `Frequency: ${frequency}` : null,
        ].filter(Boolean).join(' | ') || null,
        ...(promoConfig ? { custom_terms: promoConfig.terms } : {}),
      })
      .select('id, token')
      .single()

    if (quoteError || !newQuote) {
      console.error('[Website Webhook] Upfront quote insert failed; falling through to first-touch ack:', quoteError)
      await logSystemEvent({
        tenant_id: tenant.id,
        source: 'website',
        event_type: 'WEBSITE_UPFRONT_QUOTE_INSERT_FAIL',
        message: `Upfront quote insert failed for ${tenant.slug}: ${quoteError?.code || 'no-row'} ${quoteError?.message || ''}`.trim(),
        phone_number: phone,
        metadata: {
          lead_id: lead.id,
          customer_id: customer.id,
          code: quoteError?.code,
          message: quoteError?.message,
          details: quoteError?.details,
          hint: quoteError?.hint,
          service_category: quoteCategory,
          selected_tier: promoConfig?.tier || formTier,
          bedrooms,
          bathrooms,
          has_address: !!address,
          has_email: !!email,
        },
      })
    } else {
      await client
        .from('customers')
        .update({ lifecycle_stage_override: 'quoted_not_booked' })
        .eq('id', customer.id)
        .is('lifecycle_stage_override', null)

      const { getClientConfig } = await import('@/lib/client-config')
      const appDomain = getClientConfig().domain.replace(/\/+$/, '')
      const quoteUrl = `${appDomain}/quote/${newQuote.token}`
      // Capture the URL up-front so it survives the quote-SMS failure path
      // and gets appended to the buildFirstTouchSMS fallback below.
      pendingQuoteUrl = quoteUrl

      let quoteMsg: string
      if (isMetaPromo && promoConfig) {
        quoteMsg = promoConfig.quoteSms
          .replace('{name}', firstName || 'there')
          .replace('{url}', quoteUrl)
      } else {
        quoteMsg = firstName
          ? `Hey ${firstName}! Here are a couple options for your cleaning. Pick the one that works best for you and let me know if you have any questions: ${quoteUrl}`
          : `Here are a couple options for your cleaning. Pick the one that works best for you and let me know if you have any questions: ${quoteUrl}`
      }

      const quoteSmsResult = await sendSMS(tenant, phone, quoteMsg, {
        skipDedup: true,
        skipThrottle: true,
        bypassFilters: true,
        source: 'website_lead_quote',
        customerId: customer.id,
      })

      if (!quoteSmsResult.success) {
        console.error('[Website Webhook] Upfront quote SMS failed:', quoteSmsResult.error)
        await logSystemEvent({
          tenant_id: tenant.id,
          source: 'website',
          event_type: 'WEBSITE_UPFRONT_QUOTE_SMS_FAIL',
          message: `Upfront quote SMS failed for ${phone}: ${quoteSmsResult.error || 'unknown'}`,
          phone_number: phone,
          metadata: {
            lead_id: lead.id,
            quote_id: newQuote.id,
            quote_url: quoteUrl,
            error: quoteSmsResult.error,
          },
        })
        // fall through — first-touch fallback below will append the quote URL
      } else {
        await client
          .from('leads')
          .update({
            status: 'qualified',
          })
          .eq('id', lead.id)

        try {
          await transitionState(client, tenant.id, customer.id, 'engaged', {
            event: 'website_quote_sent',
            metadata: { lead_id: lead.id, quote_id: newQuote.id, source_detail: sourceDetail },
          })
        } catch (stateErr) {
          console.error('[Website Webhook] transitionState failed (non-blocking):', stateErr)
        }

        try {
          await scheduleTask({
            tenantId: tenant.id,
            taskType: 'quote_followup_urgent',
            taskKey: `quote-${newQuote.id}-urgent`,
            scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000),
            payload: {
              quoteId: newQuote.id,
              customerId: customer.id,
              customerPhone: phone,
              customerName: firstName || 'there',
              tenantId: tenant.id,
            },
          })
        } catch (taskErr) {
          console.error('[Website Webhook] quote_followup_urgent schedule failed (non-blocking):', taskErr)
        }

        try {
          await scheduleRetargetingSequence(
            tenant.id,
            customer.id,
            phone,
            firstName || 'there',
            'quoted_not_booked'
          )
        } catch (retargetErr) {
          console.error('[Website Webhook] retargeting schedule failed (non-blocking):', retargetErr)
        }

        // v2 ghost-chase wiring (Build 3, 2026-04-30). Idempotent + v2-flag-gated;
        // safe even with the legacy quote_followup_urgent + scheduleRetargetingSequence
        // calls above — the v2 cutover gate in process-scheduled-tasks cancels the
        // legacy rows for tenants with followup_rebuild_v2_enabled=true.
        try {
          await wireFollowupsAfterOutbound({
            tenant: { id: tenant.id, slug: tenant.slug, workflow_config: tenant.workflow_config },
            customer: { id: customer.id, phone_number: phone },
            quoteJustSent: true,
            quoteId: newQuote.id,
            activeLeadId: lead.id,
            source: 'website_lead_quote',
          })
        } catch (wireErr) {
          console.error('[Website Webhook] v2 wire (quote) failed (non-blocking):', wireErr)
        }

        await client
          .from('quotes')
          .update({ followup_enrolled_at: new Date().toISOString() })
          .eq('id', newQuote.id)

        await logSystemEvent({
          tenant_id: tenant.id,
          source: 'website',
          event_type: 'WEBSITE_LEAD_RECEIVED',
          message: `Website lead auto-quoted on submit: ${firstName || 'Unknown'} ${lastName || ''}`.trim(),
          phone_number: phone,
          metadata: {
            lead_id: lead.id,
            quote_id: newQuote.id,
            quote_url: quoteUrl,
            service_type: serviceType,
            source,
            source_detail: sourceDetail,
            bedrooms,
            bathrooms,
            tenant_slug: tenant.slug,
            flow: 'website_upfront_quote',
          },
        })

        return NextResponse.json(
          { success: true, id: lead.id, quote_url: quoteUrl },
          { headers: corsHeaders }
        )
      }
    }
  }

  const baseSmsMessage = buildFirstTouchSMS({
    firstName,
    sdrName,
    businessName,
    serviceType,
    friendlyService,
    bedrooms,
    bathrooms,
    address,
    estimatedPrice,
    promo: promoConfig ? { price: promoConfig.price, firstSms: promoConfig.firstSms } : null,
  })

  // If we managed to create a quote upstream but the dedicated quote SMS
  // didn't go through, append the URL to the first-touch ack so the customer
  // still gets a clickable link instead of just "what's the address?".
  const smsMessage = pendingQuoteUrl
    ? `${baseSmsMessage} Or grab pricing here: ${pendingQuoteUrl}`
    : baseSmsMessage

  // sendSMS pre-inserts its own messages row (via the `source` option) and
  // cleans it up on failure, so no manual insert is needed here.
  const smsResult = suppressIntroDup
    ? { success: true, messageId: 'suppressed:duplicate_intro_within_5min' }
    : await sendSMS(tenant, phone, smsMessage, {
        skipDedup: true,
        source: 'website_lead_auto',
        customerId: customer?.id ?? null,
      })

  if (!smsResult.success) {
    console.error(`[Website Webhook] SMS send failed for ${phone}:`, smsResult.error)
  }

  // Railway: new_lead -> engaged on first outbound. Fail-closed; a bad
  // transition is logged but doesn't block the webhook response.
  if (smsResult.success && customer?.id) {
    try {
      await transitionState(client, tenant.id, customer.id, 'engaged', {
        event: 'website_first_touch_sent',
        metadata: { lead_id: lead?.id, source_detail: sourceDetail },
      })
    } catch (stateErr) {
      console.error('[Website Webhook] transitionState failed (non-blocking):', stateErr)
    }

    // v2 ghost-chase wiring (Build 3, 2026-04-30) — root cause of La Monica
    // 2026-04-30 incident: website-form leads bypassed the OpenPhone webhook
    // path where the wire was integrated, so no ghost chase was scheduled.
    // Idempotent + v2-flag-gated: noops on tenants without v2 enabled.
    if (lead?.id) {
      try {
        await wireFollowupsAfterOutbound({
          tenant: { id: tenant.id, slug: tenant.slug, workflow_config: tenant.workflow_config },
          customer: { id: customer.id, phone_number: phone },
          quoteJustSent: false,
          activeLeadId: lead.id,
          source: 'website_lead_auto',
        })
      } catch (wireErr) {
        console.error('[Website Webhook] v2 wire (intro) failed (non-blocking):', wireErr)
      }
    }

    // Schedule +2h overnight-catchup nudge (next-morning 9 AM tenant-local
    // if now+2h lands in quiet hours). Handler re-checks the outreach gate
    // at send time, so a reply between now and then cancels it cleanly.
    try {
      const nudgeAt = computeNudgeSendTime({ now: new Date(), timezone: tenant.timezone || 'America/Los_Angeles' })
      await scheduleTask({
        tenantId: tenant.id,
        taskType: 'overnight_catchup',
        taskKey: `overnight-catchup-${customer.id}-${Date.now()}`,
        scheduledFor: nudgeAt,
        payload: {
          customerId: customer.id,
          phone,
          firstName: firstName || 'there',
          sdrName,
        },
      })
    } catch (nudgeErr) {
      console.error('[Website Webhook] scheduling overnight nudge failed (non-blocking):', nudgeErr)
    }
  }

  // ── Log system event ────────────────────────────────────────────

  await logSystemEvent({
    tenant_id: tenant.id,
    source: "website",
    event_type: "WEBSITE_LEAD_RECEIVED",
    message: `New website lead: ${firstName || "Unknown"} ${lastName || ""}`.trim(),
    phone_number: phone,
    metadata: {
      lead_id: lead?.id,
      service_type: serviceType,
      source,
      source_detail: sourceDetail,
      bedrooms,
      bathrooms,
      frequency,
      estimated_price: estimatedPrice,
      sms_sent: smsResult.success,
      tenant_slug: tenant.slug,
    },
  })

  // ── Schedule follow-up sequence (stages 2-5, skip instant stage 1) ──

  if (lead?.id) {
    try {
      const leadName = `${firstName || ""} ${lastName || ""}`.trim() || "Customer"
      // Stage 1 (delay 0) will be skipped by message dedup since we already sent an SMS above
      await scheduleLeadFollowUp(tenant.id, String(lead.id), phone, leadName)
      console.log(
        `[Website Webhook] Scheduled follow-up stages 2-5 for lead ${lead.id} (${tenant.slug})`
      )
    } catch (scheduleError) {
      console.error("[Website Webhook] Error scheduling follow-up:", scheduleError)
      // Don't fail the webhook — lead is already created and SMS sent
    }
  }

  return NextResponse.json(
    { success: true, id: lead?.id, ...(pendingQuoteUrl ? { quote_url: pendingQuoteUrl } : {}) },
    { headers: corsHeaders }
  )
}
