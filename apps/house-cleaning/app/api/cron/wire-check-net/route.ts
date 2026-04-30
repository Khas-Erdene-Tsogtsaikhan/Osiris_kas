/**
 * Wire-Check-Net Cron — v2 follow-up safety net.
 *
 * Runs every 5 minutes. For each HC tenant with v2 enabled, finds recent
 * AI-generated outbound messages in the last 30 minutes. If the customer
 * has an active lead (or active quote) but NO pending followup.ghost_chase
 * task, the wire-up at the entry point was missed — recover it here by
 * calling wireFollowupsAfterOutbound and log WIRE_CHECK_NET_RECOVERED.
 *
 * Background: Build 2 wired the OpenPhone webhook AI paths but missed the
 * website + Meta webhooks (La Monica + Charles incident, 2026-04-30). Build 3
 * wires those entry points; this safety net catches any future regressions.
 *
 * Endpoint: GET /api/cron/wire-check-net
 * Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth, unauthorizedResponse } from '@/lib/cron-auth'
import { getSupabaseServiceClient } from '@/lib/supabase'
import { getAllActiveTenants } from '@/lib/tenant'
import { logSystemEvent } from '@/lib/system-events'
import {
  wireFollowupsAfterOutbound,
  getActiveLeadIdForCustomer,
  getActiveQuoteIdForCustomer,
  isV2Enabled,
} from '@/lib/services/followups/wire'

const LOOKBACK_MINUTES = 30
const MAX_TENANT_BUDGET_MS = 8000

interface WireCheckSummary {
  tenant: string
  scanned: number
  recovered: number
  skipped_v2_off: boolean
  errors: number
}

export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json(unauthorizedResponse(), { status: 401 })
  }

  const supabase = getSupabaseServiceClient()
  const tenants = await getAllActiveTenants()
  const cutoffIso = new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString()
  const summaries: WireCheckSummary[] = []
  let totalRecovered = 0

  for (const tenant of tenants) {
    const summary: WireCheckSummary = {
      tenant: tenant.slug,
      scanned: 0,
      recovered: 0,
      skipped_v2_off: false,
      errors: 0,
    }

    if (!isV2Enabled({ id: tenant.id, slug: tenant.slug, workflow_config: tenant.workflow_config })) {
      summary.skipped_v2_off = true
      summaries.push(summary)
      continue
    }

    const tenantStart = Date.now()

    // Pull recent AI outbound messages — these are candidates that should
    // have triggered wire at their original entry point. We only care about
    // ai_generated=true so we don't recover human-typed replies.
    const { data: recentMsgs, error: msgErr } = await supabase
      .from('messages')
      .select('id, customer_id, source, created_at')
      .eq('tenant_id', tenant.id)
      .eq('direction', 'outbound')
      .eq('ai_generated', true)
      .gte('created_at', cutoffIso)
      .not('customer_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200)

    if (msgErr) {
      console.error(`[wire-check-net] Failed to query messages for ${tenant.slug}:`, msgErr.message)
      summary.errors += 1
      summaries.push(summary)
      continue
    }
    if (!recentMsgs || recentMsgs.length === 0) {
      summaries.push(summary)
      continue
    }

    // Dedup by customer — one recovery per customer per run.
    const seen = new Set<number>()
    for (const msg of recentMsgs) {
      if (Date.now() - tenantStart > MAX_TENANT_BUDGET_MS) {
        console.log(`[wire-check-net] ${tenant.slug} budget exceeded, deferring rest`)
        break
      }
      const customerId = msg.customer_id as number | null
      if (!customerId || seen.has(customerId)) continue
      seen.add(customerId)
      summary.scanned += 1

      // Skip if customer is unsubscribed / paused / in active human takeover.
      const { data: cust } = await supabase
        .from('customers')
        .select('id, phone_number, unsubscribed_at, sms_opt_out, auto_response_paused, auto_response_disabled, human_takeover_until, manual_takeover_at')
        .eq('id', customerId)
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      if (!cust) continue
      if (cust.unsubscribed_at || cust.sms_opt_out) continue
      if (cust.auto_response_disabled) continue
      if (cust.auto_response_paused) continue
      if (cust.human_takeover_until && new Date(cust.human_takeover_until).getTime() > Date.now()) continue
      if (cust.manual_takeover_at) {
        const ageMs = Date.now() - new Date(cust.manual_takeover_at).getTime()
        if (ageMs < 30 * 60_000) continue
      }

      // Skip if a ghost chase is already scheduled.
      const { count: pendingCount } = await supabase
        .from('scheduled_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('task_type', 'followup.ghost_chase')
        .eq('status', 'pending')
        .filter('payload->>customer_id', 'eq', String(customerId))
      if ((pendingCount || 0) > 0) continue

      // Resolve current entity in scope. Prefer quote (more advanced state).
      const quoteId = await getActiveQuoteIdForCustomer(tenant.id, customerId)
      const leadId = quoteId ? null : await getActiveLeadIdForCustomer(tenant.id, customerId)
      if (!quoteId && !leadId) continue

      try {
        const result = await wireFollowupsAfterOutbound({
          tenant: { id: tenant.id, slug: tenant.slug, workflow_config: tenant.workflow_config },
          customer: { id: customerId, phone_number: cust.phone_number || null },
          quoteJustSent: !!quoteId,
          quoteId: quoteId ?? null,
          activeLeadId: leadId ?? null,
          source: 'wire_check_net',
        })
        if (result.scheduled) {
          summary.recovered += 1
          totalRecovered += 1
          await logSystemEvent({
            tenant_id: tenant.id,
            source: 'ghost-chase',
            event_type: 'WIRE_CHECK_NET_RECOVERED',
            message: `Recovered missed ghost-chase wire for customer ${customerId} (entity: ${result.entity_type})`,
            metadata: {
              customer_id: customerId,
              entity_type: result.entity_type,
              original_message_id: msg.id,
              original_message_source: msg.source,
              age_seconds: Math.round((Date.now() - new Date(msg.created_at).getTime()) / 1000),
            },
          })
        }
      } catch (err) {
        summary.errors += 1
        console.error(`[wire-check-net] wire failed for customer ${customerId}:`, err)
      }
    }

    summaries.push(summary)
  }

  return NextResponse.json({
    success: true,
    lookback_minutes: LOOKBACK_MINUTES,
    total_recovered: totalRecovered,
    summaries,
  })
}
