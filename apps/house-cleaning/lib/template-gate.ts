/**
 * Template gate engine.
 *
 * Every outbound template declares the state it requires. `canFire(templateId,
 * state)` returns whether the template is safe to send right now. Gates are
 * evaluated AFTER `canSendOutreach` has already done the global skip checks
 * (opt-out, takeover, quiet hours, confirmed-booking, etc.).
 *
 * Gates are the last line of defense against the class of bugs where a cron
 * fires a template against the wrong lifecycle state (W2 cold-nurture-to-
 * booked, T8 hallucinated confirmation, etc.).
 */

export interface ConversationStateRow {
  booking_status: 'none' | 'quoted' | 'booking_pending' | 'confirmed' | 'completed' | 'canceled' | 'lost'
  active_job_id: number | null
  appointment_at: string | null
  human_takeover_until: string | null
  escalated: boolean
  last_agent_message_at: string | null
  last_customer_message_at: string | null
  cold_followup_stage: number
  timezone: string
}

export type TemplateId =
  | 'booking_confirmation'
  | 'appointment_reminder_24h'
  | 'quote_followup'
  | 'cold_followup_1'
  | 'cold_followup_2'
  | 'cold_followup_3'
  | 'retargeting_nudge'
  | 'seasonal_reminder'
  | 'post_job_rebook'

export interface GateResult {
  ok: boolean
  reason?: string
}

function hoursSince(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return (now.getTime() - t) / (1000 * 60 * 60)
}

function minutesUntil(iso: string | null, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY
  return (t - now.getTime()) / (1000 * 60)
}

function isTakeoverActive(iso: string | null, now: Date): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return !Number.isNaN(t) && t > now.getTime()
}

export function canFire(templateId: TemplateId, state: ConversationStateRow, now: Date = new Date()): GateResult {
  // Global pre-conditions
  if (state.escalated) return { ok: false, reason: 'escalated' }
  if (isTakeoverActive(state.human_takeover_until, now)) {
    return { ok: false, reason: 'human_takeover_active' }
  }

  switch (templateId) {
    case 'booking_confirmation':
      if (state.booking_status !== 'confirmed') return { ok: false, reason: `booking_status=${state.booking_status}` }
      if (!state.active_job_id) return { ok: false, reason: 'no_active_job_id' }
      if (!state.appointment_at) return { ok: false, reason: 'no_appointment_at' }
      if (minutesUntil(state.appointment_at, now) <= 0) return { ok: false, reason: 'appointment_in_past' }
      return { ok: true }

    case 'appointment_reminder_24h':
      if (state.booking_status !== 'confirmed') return { ok: false, reason: `booking_status=${state.booking_status}` }
      if (!state.appointment_at) return { ok: false, reason: 'no_appointment_at' }
      {
        const mins = minutesUntil(state.appointment_at, now)
        if (mins <= 0) return { ok: false, reason: 'appointment_in_past' }
        if (mins > 60 * 26) return { ok: false, reason: 'too_early_for_reminder' }
      }
      return { ok: true }

    case 'quote_followup':
      if (state.booking_status !== 'quoted') return { ok: false, reason: `booking_status=${state.booking_status}` }
      if (hoursSince(state.last_customer_message_at, now) < 24) return { ok: false, reason: 'customer_replied_within_24h' }
      return { ok: true }

    case 'cold_followup_1':
      if (state.booking_status !== 'none') return { ok: false, reason: `booking_status=${state.booking_status}` }
      if (state.cold_followup_stage !== 0) return { ok: false, reason: `stage=${state.cold_followup_stage}` }
      if (state.last_customer_message_at) return { ok: false, reason: 'customer_replied' }
      if (hoursSince(state.last_agent_message_at, now) < 4) return { ok: false, reason: 'too_early' }
      return { ok: true }

    case 'cold_followup_2':
      if (state.booking_status !== 'none') return { ok: false, reason: `booking_status=${state.booking_status}` }
      if (state.cold_followup_stage !== 1) return { ok: false, reason: `stage=${state.cold_followup_stage}` }
      if (state.last_customer_message_at) return { ok: false, reason: 'customer_replied' }
      if (hoursSince(state.last_agent_message_at, now) < 24) return { ok: false, reason: 'too_early' }
      return { ok: true }

    case 'cold_followup_3':
      if (state.booking_status !== 'none') return { ok: false, reason: `booking_status=${state.booking_status}` }
      if (state.cold_followup_stage !== 2) return { ok: false, reason: `stage=${state.cold_followup_stage}` }
      if (state.last_customer_message_at) return { ok: false, reason: 'customer_replied' }
      if (hoursSince(state.last_agent_message_at, now) < 72) return { ok: false, reason: 'too_early' }
      return { ok: true }

    case 'retargeting_nudge':
    case 'seasonal_reminder':
      if (state.booking_status === 'confirmed' || state.booking_status === 'completed') {
        return { ok: false, reason: `booking_status=${state.booking_status}` }
      }
      return { ok: true }

    case 'post_job_rebook':
      if (state.booking_status !== 'completed') return { ok: false, reason: `booking_status=${state.booking_status}` }
      return { ok: true }

    default:
      return { ok: false, reason: 'unknown_template' }
  }
}

/**
 * Convenience helper — fetches the conversation_state row and gates in one
 * call. Returns {ok:true} if the row doesn't exist yet (lets first-message
 * sends succeed when state hasn't been initialized).
 */
export async function canFireForPhone(
  templateId: TemplateId,
  opts: { client: any; tenantId: string; phone: string; now?: Date }
): Promise<GateResult> {
  const now = opts.now ?? new Date()
  const { data: row, error } = await opts.client
    .from('conversation_state')
    .select('booking_status, active_job_id, appointment_at, human_takeover_until, escalated, last_agent_message_at, last_customer_message_at, cold_followup_stage, timezone')
    .eq('tenant_id', opts.tenantId)
    .eq('phone', opts.phone)
    .maybeSingle()

  if (error) return { ok: false, reason: `state_read_error:${error.message}` }
  if (!row) return { ok: true } // no state yet — first contact; upstream caller decides
  return canFire(templateId, row as ConversationStateRow, now)
}
