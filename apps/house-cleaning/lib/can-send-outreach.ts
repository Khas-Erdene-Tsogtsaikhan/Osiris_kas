/**
 * canSendOutreach — the single pre-flight check every outreach-class SMS
 * passes through before the send happens. Replaces the ad-hoc patchwork of
 * skip-conditions scattered across 20+ cron routes.
 *
 * An outreach message is a proactive, agent/cron-authored send: follow-ups,
 * re-engagements, cold nudges, retargeting, seasonal promos. Transactional
 * replies to live inbound customer messages do NOT use this — they always send.
 *
 * Skip conditions (any one blocks the send):
 *   - Customer missing / has no phone_number
 *   - sms_opt_out
 *   - auto_response_disabled (permanent)
 *   - auto_response_paused (temporary — manual takeover still active)
 *   - human_takeover_until in the future (W3)
 *   - Customer has a confirmed booking (W2) — use transactional for booked customers
 *   - Tenant is on the retargeting exclusion list (WinBros)
 *   - Outside the tenant's quiet-hours window (T6) — caller decides whether to queue or skip
 *
 * Returns a structured result so callers can log, queue, or bail.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { customerHasConfirmedBooking } from './has-confirmed-booking'
import { isWithinQuietHoursWindow, resolveTimezone, nextAllowedSendAt } from './timezone-from-area-code'

export interface TenantForOutreach {
  id: string
  slug: string
  timezone?: string | null
}

export interface CustomerForOutreach {
  id: number
  phone_number?: string | null
  sms_opt_out?: boolean | null
  auto_response_disabled?: boolean | null
  auto_response_paused?: boolean | null
  human_takeover_until?: string | null
}

export type OutreachGateReason =
  | 'ok'
  | 'no_phone'
  | 'opt_out'
  | 'auto_response_disabled'
  | 'auto_response_paused'
  | 'human_takeover_active'
  | 'confirmed_booking_exists'
  | 'tenant_excluded'
  | 'outside_quiet_hours'

export interface OutreachGateResult {
  ok: boolean
  reason: OutreachGateReason
  /** When the block is outside-quiet-hours, this is the next send-at. */
  queueUntil?: Date
  detail?: string
}

const RETARGETING_EXCLUDED_TENANT_SLUGS = new Set(['winbros'])

export async function canSendOutreach(opts: {
  client: SupabaseClient
  tenant: TenantForOutreach
  customer: CustomerForOutreach
  /** Whether to run the `customerHasConfirmedBooking` check (default true). */
  checkConfirmedBooking?: boolean
  /** Override current time for tests. */
  now?: Date
}): Promise<OutreachGateResult> {
  const { client, tenant, customer } = opts
  const now = opts.now ?? new Date()

  if (!customer.phone_number) {
    return { ok: false, reason: 'no_phone' }
  }

  if (customer.sms_opt_out === true) {
    return { ok: false, reason: 'opt_out' }
  }

  if (customer.auto_response_disabled === true) {
    return { ok: false, reason: 'auto_response_disabled' }
  }

  if (customer.auto_response_paused === true) {
    return { ok: false, reason: 'auto_response_paused' }
  }

  if (customer.human_takeover_until) {
    const until = new Date(customer.human_takeover_until)
    if (!Number.isNaN(until.getTime()) && until > now) {
      return {
        ok: false,
        reason: 'human_takeover_active',
        detail: `Takeover until ${until.toISOString()}`,
      }
    }
  }

  if (RETARGETING_EXCLUDED_TENANT_SLUGS.has(tenant.slug)) {
    return { ok: false, reason: 'tenant_excluded' }
  }

  if (opts.checkConfirmedBooking !== false) {
    const booked = await customerHasConfirmedBooking(client, tenant.id, customer.id)
    if (booked) {
      return { ok: false, reason: 'confirmed_booking_exists' }
    }
  }

  const tz = resolveTimezone({ tenantTimezone: tenant.timezone, phone: customer.phone_number })
  if (!isWithinQuietHoursWindow(tz, now)) {
    return {
      ok: false,
      reason: 'outside_quiet_hours',
      queueUntil: nextAllowedSendAt(tz, now),
      detail: `Outside 9am–9pm ${tz}`,
    }
  }

  return { ok: true, reason: 'ok' }
}
