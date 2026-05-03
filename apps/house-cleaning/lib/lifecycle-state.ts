/**
 * Lifecycle state machine — "the Railway" from OUTREACH-SPEC v1.0 Section 3.
 *
 * Every customer sits in exactly one state. Outreach decisions flow from
 * state, not from individual crons guessing. Transitions fire from webhooks
 * and action routes via `transitionState` — never from outreach crons
 * themselves (crons only READ state; they never MUTATE state except when
 * graduating an `engaged` or `quoted` customer into `retargeting`).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type LifecycleState =
  | 'new_lead'
  | 'engaged'
  | 'quoted'
  | 'approved'
  | 'scheduled'
  | 'in_service'
  | 'awaiting_payment'
  | 'paid'
  | 'recurring'
  | 'retargeting'
  | 'archived'

export const ALL_STATES: readonly LifecycleState[] = [
  'new_lead',
  'engaged',
  'quoted',
  'approved',
  'scheduled',
  'in_service',
  'awaiting_payment',
  'paid',
  'recurring',
  'retargeting',
  'archived',
] as const

/**
 * Allowed transitions — the Railway graph. Any transition not listed is
 * invalid and gets rejected by `transitionState`.
 */
export const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  new_lead: ['engaged', 'archived'],
  engaged: ['quoted', 'retargeting', 'archived'],
  quoted: ['approved', 'retargeting', 'archived', 'engaged'], // engaged = they came back to ask Qs
  approved: ['scheduled', 'archived'],
  scheduled: ['in_service', 'retargeting', 'archived'], // retargeting if cancelled
  in_service: ['awaiting_payment', 'archived'],
  awaiting_payment: ['paid', 'archived'],
  paid: ['recurring', 'retargeting', 'archived'],
  recurring: ['retargeting', 'archived'], // membership cancelled -> retargeting
  retargeting: ['engaged', 'scheduled', 'archived'], // inbound -> engaged; direct book -> scheduled
  archived: [], // terminal — only manual unlock
}

/**
 * State -> allowed outreach kind. Matches OUTREACH-SPEC Section 3 table.
 */
export type OutreachKind = 'pre_quote' | 'post_quote' | 'retargeting' | null

export function allowedOutreachForState(state: LifecycleState): OutreachKind {
  switch (state) {
    case 'engaged': return 'pre_quote'
    case 'quoted': return 'post_quote'
    case 'retargeting': return 'retargeting'
    default: return null
  }
}

export interface TransitionOptions {
  event: string
  metadata?: Record<string, unknown>
  /** Override the current-now for tests. */
  now?: Date
}

export interface TransitionResult {
  ok: boolean
  from?: LifecycleState
  to?: LifecycleState
  reason?: string
}

/**
 * Attempt a state transition. Fails closed (returns ok=false) if:
 *  - the from->to move isn't in ALLOWED_TRANSITIONS
 *  - the customer doesn't exist
 *  - the DB update errors
 *
 * On success, writes a row to customer_state_transitions for audit.
 */
export async function transitionState(
  client: SupabaseClient,
  tenantId: string,
  customerId: number,
  to: LifecycleState,
  opts: TransitionOptions,
): Promise<TransitionResult> {
  const { data: current, error: fetchErr } = await client
    .from('customers')
    .select('lifecycle_state')
    .eq('id', customerId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (fetchErr || !current) {
    return { ok: false, reason: 'customer_not_found' }
  }

  const from = (current.lifecycle_state || 'new_lead') as LifecycleState

  if (from === to) {
    return { ok: true, from, to, reason: 'noop' }
  }

  const allowed = ALLOWED_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    return { ok: false, from, reason: `invalid_transition:${from}->${to}` }
  }

  const { error: updateErr } = await client
    .from('customers')
    .update({ lifecycle_state: to })
    .eq('id', customerId)
    .eq('tenant_id', tenantId)

  if (updateErr) {
    return { ok: false, from, reason: `update_failed:${updateErr.message}` }
  }

  // Best-effort transition log. Failure here does not block the state change.
  await client
    .from('customer_state_transitions')
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      from_state: from,
      to_state: to,
      event: opts.event,
      metadata: opts.metadata ?? {},
    })

  return { ok: true, from, to }
}

/**
 * Pure validator — used by tests and by the message-linter's sanity check.
 * Does not hit the DB.
 */
export function isValidTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return true
  return (ALLOWED_TRANSITIONS[from] || []).includes(to)
}
