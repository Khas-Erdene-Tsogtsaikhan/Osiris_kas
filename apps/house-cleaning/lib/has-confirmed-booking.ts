/**
 * Job-status helpers used by outreach/pipeline gates.
 *
 * Two distinct concepts — do NOT conflate them:
 *
 *  1. "Confirmed booking" = customer said yes. Statuses: scheduled, in_progress.
 *     Used by the legacy follow-up-quoted / lifecycle-auto-enroll /
 *     seasonal-reminders crons and by W2 regression tests (Paige incident,
 *     2026-04-20).
 *
 *  2. "Active job" = any live job, including pre-confirmation. Statuses:
 *     pending, quoted, scheduled, in_progress. Used by the new outreach-gate
 *     (OUTREACH-SPEC v1.0 Hard Rule #2, 2026-04-22, OH Nass / Paul incident).
 *     A customer with a live quote still in flight should not be retargeted.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const CONFIRMED_JOB_STATUSES = ['scheduled', 'in_progress'] as const
export const ACTIVE_JOB_STATUSES = ['pending', 'quoted', 'scheduled', 'in_progress'] as const

async function anyJobWithStatuses(
  client: SupabaseClient,
  tenantId: string,
  customerId: number | string,
  statuses: readonly string[],
): Promise<boolean> {
  const { data, error } = await client
    .from('jobs')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .in('status', statuses as unknown as string[])
    .limit(1)
    .maybeSingle()

  if (error) return true
  return !!data
}

async function customerSubsetWithStatuses(
  client: SupabaseClient,
  tenantId: string,
  customerIds: Array<number | string>,
  statuses: readonly string[],
): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set()

  const { data, error } = await client
    .from('jobs')
    .select('customer_id')
    .eq('tenant_id', tenantId)
    .in('customer_id', customerIds)
    .in('status', statuses as unknown as string[])

  if (error || !data) {
    return new Set(customerIds.map(String))
  }

  return new Set(data.map(r => String(r.customer_id)))
}

/**
 * Returns true if the customer has a job with status `scheduled` or
 * `in_progress` — i.e. a confirmed booking on the calendar.
 *
 * Does NOT include `pending` or `quoted`. For that, use `customerHasActiveJob`.
 */
export async function customerHasConfirmedBooking(
  client: SupabaseClient,
  tenantId: string,
  customerId: number | string | null | undefined,
): Promise<boolean> {
  if (!customerId) return false
  return anyJobWithStatuses(client, tenantId, customerId, CONFIRMED_JOB_STATUSES)
}

/** Batch variant of `customerHasConfirmedBooking`. */
export async function customersWithConfirmedBookings(
  client: SupabaseClient,
  tenantId: string,
  customerIds: Array<number | string>,
): Promise<Set<string>> {
  return customerSubsetWithStatuses(client, tenantId, customerIds, CONFIRMED_JOB_STATUSES)
}

/**
 * Returns true if the customer has ANY live job (`pending`, `quoted`,
 * `scheduled`, `in_progress`). Used by the outreach-gate to block
 * retargeting / follow-up while a job is already in flight.
 */
export async function customerHasActiveJob(
  client: SupabaseClient,
  tenantId: string,
  customerId: number | string | null | undefined,
): Promise<boolean> {
  if (!customerId) return false
  return anyJobWithStatuses(client, tenantId, customerId, ACTIVE_JOB_STATUSES)
}

/** Batch variant of `customerHasActiveJob`. */
export async function customersWithActiveJobs(
  client: SupabaseClient,
  tenantId: string,
  customerIds: Array<number | string>,
): Promise<Set<string>> {
  return customerSubsetWithStatuses(client, tenantId, customerIds, ACTIVE_JOB_STATUSES)
}
