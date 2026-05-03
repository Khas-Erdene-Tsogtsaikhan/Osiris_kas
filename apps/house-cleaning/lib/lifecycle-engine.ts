/**
 * Lifecycle Engine — Central module for customer messaging lifecycle
 *
 * All crons/webhooks call through this module before sending automated messages.
 * Single source of truth for "can we message this customer?"
 */

import { getSupabaseServiceClient } from './supabase'
import { sendSMS, isConversationQuiet } from './openphone'
import { scheduleTask } from './scheduler'
import { logSystemEvent } from './system-events'

/**
 * Check if it's safe to send an automated message to a customer.
 * Enforces per-phase cooldowns AND a global cap of 3 automated msgs/day.
 * tenantId is required for multi-tenant isolation.
 */
export async function canSendToCustomer(
  customerId: number,
  phase: string,
  cooldownHours: number = 24,
  tenantId?: string
): Promise<boolean> {
  if (!tenantId) {
    console.error(`[lifecycle] canSendToCustomer called without tenantId for customer ${customerId} — rejecting to prevent cross-tenant leak`)
    return false
  }

  const client = getSupabaseServiceClient()

  // Phase-specific cooldown (tenant-scoped)
  const cooldownCutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString()
  let phaseQuery = client
    .from('customer_message_log')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)
    .eq('lifecycle_phase', phase)
    .gte('sent_at', cooldownCutoff)
  phaseQuery = phaseQuery.eq('tenant_id', tenantId)

  const { count: phaseCount } = await phaseQuery

  if (phaseCount && phaseCount > 0) {
    console.log(`[lifecycle] Customer ${customerId} in cooldown for phase '${phase}' (${phaseCount} msgs in last ${cooldownHours}h)`)
    return false
  }

  // Active conversation check: if there's been any message activity with this customer
  // in the last 10 minutes, hold off — they're in a live convo with AI or a human.
  // This prevents retargeting/followup texts from barging into active conversations.
  try {
    const { data: custPhone } = await client
      .from('customers')
      .select('phone_number')
      .eq('id', customerId)
      .single()
    if (custPhone?.phone_number) {
      const quiet = await isConversationQuiet(tenantId, custPhone.phone_number, 10)
      if (!quiet) {
        console.log(`[lifecycle] Customer ${customerId} in active conversation — holding automated text`)
        return false
      }
    }
  } catch {
    // fail open — if we can't check, allow the send
  }

  return true
}

/**
 * Record that an automated message was sent to a customer.
 * Must be called after every successful automated SMS send.
 */
export async function recordMessageSent(
  tenantId: string,
  customerId: number | null,
  phone: string,
  source: string,
  phase: string
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseServiceClient()

  const { error } = await client.from('customer_message_log').insert({
    tenant_id: tenantId,
    customer_id: customerId,
    phone_number: phone,
    source,
    lifecycle_phase: phase,
  })

  if (error) {
    console.error(`[lifecycle] Failed to record message: ${error.message}`)
    return { success: false, error: error.message }
  }

  // Update customer's last_automated_message_at
  if (customerId) {
    const { error: updateErr } = await client
      .from('customers')
      .update({ last_automated_message_at: new Date().toISOString() })
      .eq('id', customerId)
    if (updateErr) {
      console.error(`[lifecycle] Failed to update last_automated_message_at: ${updateErr.message}`)
    }
  }

  return { success: true }
}

/**
 * Simple regex-based sentiment analysis for satisfaction replies.
 * Returns 'positive', 'negative', or 'neutral'.
 */
export function analyzeSimpleSentiment(
  message: string
): 'positive' | 'negative' | 'neutral' {
  const lower = message.toLowerCase().trim()

  const positivePatterns = [
    /\b(great|amazing|awesome|wonderful|fantastic|excellent|perfect|love|loved)\b/,
    /\b(good|nice|clean|spotless|happy|pleased|satisfied|beautiful)\b/,
    /\b(thank|thanks|thx|ty)\b/,
    /\b(yes|yep|yup|yeah|absolutely|definitely)\b/,
    /\b(5\s*star|five\s*star)\b/,
    /[😊😃😍🥰👍👏💯🙏✨⭐🌟]+/,
  ]

  const negativePatterns = [
    /\b(terrible|horrible|awful|worst|bad|poor|dirty|disgusting)\b/,
    /\b(disappointed|unhappy|upset|angry|frustrated|furious)\b/,
    /\b(complaint|complain|refund|damage|broke|broken|stain)\b/,
    /\b(never\s+again|waste\s+of|rip\s*off|scam)\b/,
    /\b(not\s+clean|not\s+good|not\s+happy|didn'?t\s+clean)\b/,
    /\b(missed|skipped|forgot|incomplete|half)\b/,
    /[😡😤😢😠👎]+/,
  ]

  for (const pattern of negativePatterns) {
    if (pattern.test(lower)) return 'negative'
  }

  for (const pattern of positivePatterns) {
    if (pattern.test(lower)) return 'positive'
  }

  return 'neutral'
}

/**
 * Cancel all pending scheduled_tasks matching a task_key prefix.
 */
export async function cancelPendingTasks(
  tenantId: string,
  taskKeyPrefix: string
): Promise<number> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from('scheduled_tasks')
    .update({ status: 'cancelled' })
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .like('task_key', `${taskKeyPrefix}%`)
    .select('id')

  if (error) {
    console.error(`[lifecycle] Failed to cancel tasks with prefix '${taskKeyPrefix}': ${error.message}`)
    return 0
  }

  const count = data?.length || 0
  if (count > 0) {
    console.log(`[lifecycle] Cancelled ${count} pending tasks matching '${taskKeyPrefix}*'`)
  }
  return count
}

/**
 * Trigger immediate satisfaction check SMS when a job is completed.
 * Called directly from completion paths (dashboard, Telegram, HCP webhook).
 * The post-job-followup cron serves as a safety net for any missed jobs.
 *
 * Returns { sent: true } if the SMS was sent, { sent: false } otherwise.
 */
export async function triggerSatisfactionCheck(params: {
  tenant: any
  jobId: string | number
  customerId: number | null
  customerPhone: string
  customerName: string
}): Promise<{ sent: boolean }> {
  const { tenant, jobId, customerId, customerPhone, customerName } = params
  const client = getSupabaseServiceClient()

  if (!customerPhone) {
    console.log(`[lifecycle] No phone for job ${jobId}, skipping satisfaction check`)
    return { sent: false }
  }

  // Check lifecycle cooldown (4hr for post_job phase)
  if (customerId) {
    const canSend = await canSendToCustomer(customerId, 'post_job', 4, tenant.id)
    if (!canSend) {
      console.log(`[lifecycle] Customer ${customerId} in post_job cooldown, skipping satisfaction check for job ${jobId}`)
      return { sent: false }
    }
  }

  const businessName = tenant.business_name_short || tenant.name || 'us'
  const firstName = customerName || 'there'
  const message = `Hi ${firstName}! How was your ${businessName} cleaning today? We'd love to hear your feedback — just reply and let us know!`

  const smsResult = await sendSMS(tenant, customerPhone, message)

  if (!smsResult.success) {
    console.error(`[lifecycle] Satisfaction SMS failed for job ${jobId}:`, smsResult.error)
    return { sent: false }
  }

  // Mark job so the cron doesn't double-send
  await client
    .from('jobs')
    .update({ satisfaction_sent_at: new Date().toISOString() })
    .eq('id', Number(jobId))

  // Update customer post-job stage
  if (customerId) {
    await client
      .from('customers')
      .update({
        post_job_stage: 'satisfaction_sent',
        post_job_stage_updated_at: new Date().toISOString(),
      })
      .eq('id', customerId)

    await recordMessageSent(tenant.id, customerId, customerPhone, 'post_job_satisfaction', 'post_job')
  }

  // Schedule 24hr timeout fallback (if customer never replies, send review anyway)
  await scheduleTask({
    tenantId: tenant.id,
    taskType: 'post_job_review',
    taskKey: `post-job-review-${jobId}`,
    scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000),
    payload: {
      jobId: Number(jobId),
      customerId,
      customerPhone,
      customerName: firstName,
      tenantId: tenant.id,
      isTimeout: true,
    },
  })

  await logSystemEvent({
    source: 'lifecycle',
    event_type: 'POST_JOB_SATISFACTION_SENT',
    message: `Immediate satisfaction check sent for job ${jobId}`,
    tenant_id: tenant.id,
    job_id: String(jobId),
    phone_number: customerPhone,
    metadata: { triggered_by: 'completion_hook' },
  })

  console.log(`[lifecycle] Satisfaction check sent immediately for job ${jobId}`)
  return { sent: true }
}
