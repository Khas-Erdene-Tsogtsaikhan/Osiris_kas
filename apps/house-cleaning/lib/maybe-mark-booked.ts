/**
 * maybeMarkBooked — centralized "booked" gate.
 *
 * A job is only "booked" when BOTH conditions are true:
 *   1. Payment received  (payment_status = deposit_paid | fully_paid, OR paid = true)
 *   2. Cleaner assigned  (at least one cleaner_assignment in pending/accepted/confirmed)
 *
 * Call this after any payment confirmation or cleaner assignment.
 * It is safe to call multiple times — it's idempotent.
 */

import {
  getJobById,
  getCleanerAssignmentsForJob,
  getSupabaseServiceClient,
  type Job,
} from './supabase'

export async function maybeMarkBooked(
  jobId: string,
  /** Pass an already-fetched job to avoid an extra read */
  existingJob?: Job | null
): Promise<boolean> {
  const job = existingJob ?? await getJobById(jobId)
  if (!job) return false

  // Already booked — nothing to do
  if (job.booked) return true

  // 1. Payment check
  const hasPaid =
    job.payment_status === 'deposit_paid' ||
    job.payment_status === 'fully_paid' ||
    job.paid === true

  if (!hasPaid) return false

  // 2. Cleaner assignment check
  const assignments = await getCleanerAssignmentsForJob(jobId)
  const hasActiveCleaner = assignments.some(
    (a) => a.status === 'pending' || a.status === 'accepted' || a.status === 'confirmed'
  )

  if (!hasActiveCleaner) return false

  // Both conditions met — mark booked
  const client = getSupabaseServiceClient()

  await client
    .from('jobs')
    .update({ booked: true, status: 'assigned' })
    .eq('id', jobId)
    .eq('booked', false) // atomic guard

  // Also update lead status to 'booked' if one exists
  const { data: lead } = await client
    .from('leads')
    .select('id')
    .eq('converted_to_job_id', jobId)
    .maybeSingle()

  if (lead) {
    await client
      .from('leads')
      .update({ status: 'booked' })
      .eq('id', lead.id)
  }

  console.log(`[maybeMarkBooked] Job ${jobId} marked as booked (paid + cleaner assigned)`)
  return true
}
