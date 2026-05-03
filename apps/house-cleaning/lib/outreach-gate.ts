/**
 * Outreach Gate — the single eligibility choke point.
 *
 * OUTREACH-SPEC v1.0 Section 4. Every Pipeline A / B / C cron and every
 * retargeting-class task type passes through `isEligibleForOutreach` before
 * generating or sending a message. No parallel gates, no inline checks.
 *
 * Checks run in order; first failure wins. Every refusal logs to
 * `system_events` with a machine-readable reason + kind + customer_id.
 *
 * Hard rules enforced here (from Spec Section 2):
 *   1. No message to active members (customer_memberships active|paused)
 *   2. No message to customers with any active job (pending|quoted|scheduled|in_progress)
 *   3. No message when retargeting_stopped_reason = admin_disabled
 *   4. Kill switch: RETARGETING_DISABLED=true short-circuits everything
 *   5. WinBros is globally excluded
 *   6. Manual-managed customers (tenant list) are never messaged
 *
 * Additional per-kind rules:
 *   - retargeting: no inbound reply in last 14 days (paused drip)
 *   - email channel: customer email not bounced
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LifecycleState, OutreachKind } from './lifecycle-state'
import { allowedOutreachForState } from './lifecycle-state'
import { customerHasActiveJob } from './has-confirmed-booking'
import { isRetargetingPaused } from './retargeting-paused'
import { isCleanerPhone, getCleanerPhoneSet } from './tenant'

export type OutreachGateReason =
  | 'ok'
  | 'kill_switch'
  | 'pipeline_disabled'
  | 'tenant_excluded'
  | 'tenant_disabled'
  | 'customer_not_found'
  | 'no_phone'
  | 'opt_out'
  | 'auto_response_disabled'
  | 'auto_response_paused'
  | 'admin_disabled'
  | 'human_takeover_active'
  | 'state_mismatch'
  | 'active_membership'
  | 'active_job'
  | 'manual_managed'
  | 'cleaner_phone'
  | 'recent_inbound'
  | 'active_conversation'
  | 'email_bounced'
  | 'internal_error'

export interface OutreachGateResult {
  ok: boolean
  reason: OutreachGateReason
  detail?: string
  state?: LifecycleState
}

export interface OutreachGateInput {
  client: SupabaseClient
  tenantId: string
  tenantSlug: string
  customerId: number
  kind: 'pre_quote' | 'post_quote' | 'retargeting'
  channel?: 'sms' | 'email' | 'mms'
  /**
   * Minutes-since-last-inbound below which the gate treats the customer as
   * mid-conversation and refuses outreach. Defaults to 30. Pass 0 to disable.
   * Intended override: tenant.workflow_config.active_conversation_window_minutes.
   */
  activeConversationWindowMinutes?: number
  /** Override current time for tests. */
  now?: Date
}

const GLOBAL_EXCLUDED_TENANT_SLUGS = new Set(['winbros'])

/**
 * Check if the per-pipeline env kill switch is set.
 *   Pipeline A -> PIPELINE_A_DISABLED
 *   Pipeline B -> PIPELINE_B_DISABLED
 *   Pipeline C -> PIPELINE_C_DISABLED
 */
function pipelineDisabled(kind: 'pre_quote' | 'post_quote' | 'retargeting'): boolean {
  const key =
    kind === 'pre_quote' ? 'PIPELINE_A_DISABLED'
    : kind === 'post_quote' ? 'PIPELINE_B_DISABLED'
    : 'PIPELINE_C_DISABLED'
  return (process.env[key] || '').toLowerCase() === 'true'
}

/**
 * Normalize E.164-ish to last 10 digits for comparison against cleaner phone set.
 */
function normalizePhone(raw: string | null | undefined): string[] {
  if (!raw) return []
  const digits = raw.replace(/\D/g, '')
  const last10 = digits.slice(-10)
  return [raw, digits, last10, `+1${last10}`].filter(Boolean)
}

export async function isEligibleForOutreach(input: OutreachGateInput): Promise<OutreachGateResult> {
  const { client, tenantId, tenantSlug, customerId, kind, channel = 'sms' } = input
  const now = input.now ?? new Date()
  // Sanitize the window. Accept a non-negative finite number; anything else
  // (undefined / null / NaN / string / negative) falls back to the 30-min default.
  // Negative or NaN silently disabling the check is exactly the fail-open we
  // never want, so this guard is intentionally strict.
  const rawWindow = input.activeConversationWindowMinutes
  const activeWindowMinutes =
    typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow >= 0
      ? rawWindow
      : 30

  // 1. Global kill switch (already live from Phase 1)
  if (isRetargetingPaused()) {
    return { ok: false, reason: 'kill_switch' }
  }

  // 2. Per-pipeline kill switch
  if (pipelineDisabled(kind)) {
    return { ok: false, reason: 'pipeline_disabled', detail: kind }
  }

  // 3. Global tenant exclusion (WinBros — Jack handles his own outreach)
  if (GLOBAL_EXCLUDED_TENANT_SLUGS.has(tenantSlug)) {
    return { ok: false, reason: 'tenant_excluded', detail: tenantSlug }
  }

  // 4. Load customer
  const { data: customer, error: custErr } = await client
    .from('customers')
    .select('id, phone_number, email, lifecycle_state, sms_opt_out, auto_response_disabled, auto_response_paused, human_takeover_until, retargeting_stopped_reason, manual_managed, email_bounced_at')
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (custErr || !customer) {
    return { ok: false, reason: 'customer_not_found' }
  }

  // 5. No phone for SMS channel
  if ((channel === 'sms' || channel === 'mms') && !customer.phone_number) {
    return { ok: false, reason: 'no_phone' }
  }

  // 6. Opt-out / disabled / paused
  if (customer.sms_opt_out === true) {
    return { ok: false, reason: 'opt_out' }
  }
  if (customer.auto_response_disabled === true) {
    return { ok: false, reason: 'auto_response_disabled' }
  }
  if (customer.auto_response_paused === true) {
    return { ok: false, reason: 'auto_response_paused' }
  }

  // 7. admin_disabled — the specific bug that triggered the 2026-04-22 rebuild
  if (customer.retargeting_stopped_reason === 'admin_disabled') {
    return { ok: false, reason: 'admin_disabled' }
  }

  // 8. Human takeover active
  if (customer.human_takeover_until) {
    const until = new Date(customer.human_takeover_until)
    if (!Number.isNaN(until.getTime()) && until > now) {
      return { ok: false, reason: 'human_takeover_active', detail: `until ${until.toISOString()}` }
    }
  }

  // 9. Manual-managed (tenant-configured list — Raza, Mahas on Spotless, etc.)
  if (customer.manual_managed === true) {
    return { ok: false, reason: 'manual_managed' }
  }

  // 10. State must match outreach kind
  const state = (customer.lifecycle_state || 'new_lead') as LifecycleState
  const allowedKind = allowedOutreachForState(state)
  if (allowedKind !== kind) {
    return { ok: false, reason: 'state_mismatch', state, detail: `state=${state} wants ${allowedKind ?? 'none'} got ${kind}` }
  }

  // 11. Active membership — never message members
  const { data: mem } = await client
    .from('customer_memberships')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .in('status', ['active', 'paused'])
    .limit(1)
    .maybeSingle()
  if (mem) {
    return { ok: false, reason: 'active_membership', state }
  }

  // 12. Active job — never message customers with pending/quoted/scheduled/in_progress
  // (expanded in Section 15 checklist from the 2026-04-22 bug)
  const hasActiveJob = await customerHasActiveJob(client, tenantId, customerId)
  if (hasActiveJob) {
    return { ok: false, reason: 'active_job', state }
  }

  // 13. Cleaner phone — never send customer outreach to a cleaner's phone
  if (customer.phone_number) {
    try {
      const cleanerSet = await getCleanerPhoneSet(tenantId)
      if (isCleanerPhone(customer.phone_number, cleanerSet)) {
        return { ok: false, reason: 'cleaner_phone', state }
      }
    } catch {
      // non-fatal — cleaner check failure shouldn't block, but log
    }
  }

  // 14. Active conversation — never interrupt a live back-and-forth.
  // Applies to EVERY pipeline. If the customer sent an inbound message in the
  // last N minutes (default 30, override per-tenant), something is in flight:
  // either Dominic is texting, the AI is mid-convo, or a reply just landed and
  // hasn't been processed yet. Follow-ups can always wait another run.
  if (activeWindowMinutes > 0) {
    const activeCutoff = new Date(now.getTime() - activeWindowMinutes * 60 * 1000).toISOString()
    const { data: liveInbound } = await client
      .from('messages')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('customer_id', customerId)
      .eq('direction', 'inbound')
      .gte('timestamp', activeCutoff)
      .limit(1)
      .maybeSingle()
    if (liveInbound) {
      return { ok: false, reason: 'active_conversation', state }
    }
  }

  // 15. Retargeting-specific: recent inbound pauses drip (14-day window,
  // separate from the short live-convo window above — this one also drives
  // the 'retargeting -> engaged' state transition upstream).
  if (kind === 'retargeting') {
    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await client
      .from('messages')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('customer_id', customerId)
      .eq('direction', 'inbound')
      .gte('timestamp', cutoff)
      .limit(1)
      .maybeSingle()
    if (recent) {
      return { ok: false, reason: 'recent_inbound', state }
    }
  }

  // 16. Email-specific: not previously bounced
  if (channel === 'email' && customer.email_bounced_at) {
    return { ok: false, reason: 'email_bounced', state }
  }

  return { ok: true, reason: 'ok', state }
}

/**
 * Log a gate refusal to system_events so operators can audit why outreach was
 * (or wasn't) sent. Best-effort — never throws.
 */
export async function logGateRefusal(
  client: SupabaseClient,
  tenantId: string,
  customerId: number,
  kind: string,
  result: OutreachGateResult,
): Promise<void> {
  try {
    await client.from('system_events').insert({
      tenant_id: tenantId,
      source: 'outreach_gate',
      event_type: 'OUTREACH_GATE_REFUSAL',
      message: `${kind} refused for customer ${customerId}: ${result.reason}`,
      metadata: { kind, reason: result.reason, detail: result.detail, state: result.state, customer_id: customerId },
    })
  } catch {
    // swallow — logging shouldn't fail outreach
  }
}
