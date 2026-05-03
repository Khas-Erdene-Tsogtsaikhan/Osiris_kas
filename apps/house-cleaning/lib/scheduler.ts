/**
 * Internal Task Scheduler
 *
 * Replaces QStash with a database-backed scheduler.
 * Tasks are stored in the `scheduled_tasks` table and processed by a cron job.
 */

import { createClient } from '@supabase/supabase-js'

// Lazy-initialize Supabase client
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export type TaskType =
  | 'lead_followup'
  | 'job_broadcast'
  | 'day_before_reminder'
  | 'job_reminder'
  | 'post_cleaning_followup'
  | 'sms_retry'
  | 'retargeting'
  | 'post_job_satisfaction'
  | 'post_job_review'
  | 'post_job_recurring_push'
  | 'post_job_tip'
  | 'quote_followup_urgent'
  | 'mid_convo_nudge'
  | 'monthly_reengagement'
  | 'manual_call'
  | 'send_sms'
  | 'hot_lead_followup'
  | 'ranked_cascade'
  // Build 2 (HC follow-ups + retargeting rebuild)
  // Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md
  | 'followup.ghost_chase'
  | 'retargeting.win_back'

export interface ScheduledTask {
  id: string
  tenant_id?: string
  task_type: TaskType
  task_key?: string
  scheduled_for: string
  payload: Record<string, unknown>
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  attempts: number
  max_attempts: number
  last_error?: string
  created_at: string
  updated_at: string
  executed_at?: string
}

export interface ScheduleTaskOptions {
  tenantId?: string
  taskType: TaskType
  taskKey?: string // For deduplication
  scheduledFor: Date
  payload: Record<string, unknown>
  maxAttempts?: number
}

/**
 * Schedule a task for future execution
 */
export async function scheduleTask(
  options: ScheduleTaskOptions
): Promise<{ success: boolean; taskId?: string; error?: string }> {
  const supabase = getSupabase()

  try {
    // First, try to find an existing task with this key (might be cancelled)
    if (options.taskKey) {
      const { data: existing } = await supabase
        .from('scheduled_tasks')
        .select('id, status')
        .eq('task_key', options.taskKey)
        .maybeSingle()

      if (existing) {
        // If task exists (even if cancelled), update it to pending with new schedule
        const { data: updated, error: updateError } = await supabase
          .from('scheduled_tasks')
          .update({
            tenant_id: options.tenantId,
            task_type: options.taskType,
            scheduled_for: options.scheduledFor.toISOString(),
            payload: options.payload,
            max_attempts: options.maxAttempts || 3,
            status: 'pending',
            attempts: 0,
            last_error: null,
          })
          .eq('id', existing.id)
          .select('id')
          .single()

        if (updateError) throw updateError

        console.log(`[scheduler] Re-scheduled task ${options.taskType}: ${updated.id} (was ${existing.status})`)
        return { success: true, taskId: updated.id }
      }
    }

    // No existing task, insert a new one
    const { data, error } = await supabase
      .from('scheduled_tasks')
      .insert({
        tenant_id: options.tenantId,
        task_type: options.taskType,
        task_key: options.taskKey,
        scheduled_for: options.scheduledFor.toISOString(),
        payload: options.payload,
        max_attempts: options.maxAttempts || 3,
        status: 'pending',
      })
      .select('id')
      .single()

    if (error) {
      // Handle unique constraint violation (race condition)
      if (error.code === '23505') {
        console.log(`[scheduler] Task already scheduled: ${options.taskKey}`)
        return { success: true, taskId: 'existing' }
      }
      throw error
    }

    console.log(`[scheduler] Scheduled task ${options.taskType}: ${data.id}`)
    return { success: true, taskId: data.id }
  } catch (error) {
    console.error('[scheduler] Error scheduling task:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Cancel a scheduled task by task_key
 */
export async function cancelTask(
  taskKey: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabase()

  try {
    const { error } = await supabase
      .from('scheduled_tasks')
      .update({ status: 'cancelled' })
      .eq('task_key', taskKey)
      .eq('status', 'pending')

    if (error) throw error

    console.log(`[scheduler] Cancelled task: ${taskKey}`)
    return { success: true }
  } catch (error) {
    console.error('[scheduler] Error cancelling task:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Get tasks that are due for execution
 */
export async function getDueTasks(
  limit: number = 50
): Promise<ScheduledTask[]> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(limit)

  if (error) {
    console.error('[scheduler] Error getting due tasks:', error)
    return []
  }

  return data || []
}

/**
 * Mark a task as processing (claim it)
 */
export async function claimTask(
  taskId: string
): Promise<{ success: boolean; task?: ScheduledTask }> {
  const supabase = getSupabase()

  // Use optimistic locking to prevent double-processing
  const { data, error } = await supabase
    .from('scheduled_tasks')
    .update({
      status: 'processing',
    })
    .eq('id', taskId)
    .eq('status', 'pending')
    .select('*')
    .single()

  if (error || !data) {
    // Task was already claimed by another worker
    return { success: false }
  }

  // Increment attempts
  await supabase
    .from('scheduled_tasks')
    .update({ attempts: (data.attempts || 0) + 1 })
    .eq('id', taskId)

  return { success: true, task: data }
}

/**
 * Mark a task as completed
 */
export async function completeTask(taskId: string): Promise<void> {
  const supabase = getSupabase()

  await supabase
    .from('scheduled_tasks')
    .update({
      status: 'completed',
      executed_at: new Date().toISOString(),
    })
    .eq('id', taskId)

  console.log(`[scheduler] Task completed: ${taskId}`)
}

/**
 * Mark a task as failed
 */
export async function failTask(taskId: string, error: string): Promise<void> {
  const supabase = getSupabase()

  // Get current task to check attempts
  const { data: task } = await supabase
    .from('scheduled_tasks')
    .select('attempts, max_attempts')
    .eq('id', taskId)
    .single()

  const shouldRetry = task && task.attempts < task.max_attempts

  await supabase
    .from('scheduled_tasks')
    .update({
      status: shouldRetry ? 'pending' : 'failed',
      last_error: error,
    })
    .eq('id', taskId)

  if (shouldRetry) {
    console.log(`[scheduler] Task ${taskId} will retry (attempt ${task.attempts}/${task.max_attempts})`)
  } else {
    console.error(`[scheduler] Task ${taskId} failed permanently: ${error}`)
  }
}

// ============================================
// OSIRIS-Specific Scheduling Functions
// ============================================

/**
 * Schedule lead follow-up sequence
 * 5 touches over 14 days (4 SMS + 1 manual call):
 * 1 (instant/text), 2 (day 1/text), 3 (day 3/call), 4 (day 7/text), 5 (day 14/text)
 */
export async function scheduleLeadFollowUp(
  tenantId: string,
  leadId: string,
  leadPhone: string,
  leadName: string,
  delays: number[] = [0, 1440, 4320, 10080, 20160] // Default delays in minutes
): Promise<{ success: boolean; taskIds: string[] }> {
  const taskIds: string[] = []
  const now = new Date()

  // Stage 3 (day 3) is a manual call; all others are text
  const CALL_STAGE = 3

  for (let i = 0; i < delays.length; i++) {
    const stage = i + 1
    const scheduledFor = new Date(now.getTime() + delays[i] * 60 * 1000)

    const result = await scheduleTask({
      tenantId,
      taskType: 'lead_followup',
      taskKey: `lead-${leadId}-stage-${stage}`,
      scheduledFor,
      payload: {
        leadId,
        leadPhone,
        leadName,
        stage,
        action: stage === CALL_STAGE ? 'manual_call' : 'text',
      },
    })

    if (result.taskId) {
      taskIds.push(result.taskId)
    }
  }

  return { success: true, taskIds }
}

/**
 * Schedule job assignment broadcast with escalation
 */
export async function scheduleJobBroadcast(
  tenantId: string,
  jobId: string,
  teamLeadIds: string[]
): Promise<{ success: boolean; taskIds: string[] }> {
  const taskIds: string[] = []
  const now = new Date()

  const phases = [
    { phase: 'initial', delay: 0 },
    { phase: 'urgent', delay: 10 * 60 * 1000 }, // 10 minutes
    { phase: 'escalate', delay: 20 * 60 * 1000 }, // 20 minutes
  ]

  for (const { phase, delay } of phases) {
    const result = await scheduleTask({
      tenantId,
      taskType: 'job_broadcast',
      taskKey: `job-${jobId}-broadcast-${phase}`,
      scheduledFor: new Date(now.getTime() + delay),
      payload: {
        jobId,
        teamLeadIds,
        phase,
      },
    })

    if (result.taskId) {
      taskIds.push(result.taskId)
    }
  }

  return { success: true, taskIds }
}

/**
 * Schedule day-before reminder for a job
 */
export async function scheduleDayBeforeReminder(
  tenantId: string,
  jobId: string,
  customerPhone: string,
  customerName: string,
  appointmentDate: string
): Promise<{ success: boolean; taskId?: string }> {
  // Calculate timestamp for day before at 4 PM local time
  const appointmentDateObj = new Date(appointmentDate)
  appointmentDateObj.setDate(appointmentDateObj.getDate() - 1)
  appointmentDateObj.setHours(16, 0, 0, 0)

  return await scheduleTask({
    tenantId,
    taskType: 'day_before_reminder',
    taskKey: `reminder-${jobId}-day-before`,
    scheduledFor: appointmentDateObj,
    payload: {
      jobId,
      customerPhone,
      customerName,
      type: 'day_before',
    },
  })
}

// ==================== RETARGETING SEQUENCES ====================

export type RetargetingSequenceType = 'unresponsive' | 'quoted_not_booked' | 'one_time' | 'lapsed' | 'new_lead' | 'repeat' | 'active' | 'lost'

interface RetargetingStep {
  step: number
  delay_days: number
  template: string // template key — message is built at send time using customer name + tenant context
}

/**
 * Sequence definitions based on research:
 * - unresponsive: 9-word reactivation (3 texts over 7 days)
 * - quoted_not_booked: Quote follow-up (6 texts over 14 days)
 * - one_time: Win-back (3 texts over 14 days)
 * - lapsed: "We miss you" (3 texts over 10 days)
 */
export const RETARGETING_SEQUENCES: Record<RetargetingSequenceType, RetargetingStep[]> = {
  unresponsive: [
    { step: 1, delay_days: 0, template: '9_word' },
    { step: 2, delay_days: 3, template: 'value_nudge' },
    { step: 3, delay_days: 5, template: 'manual_call' },
    { step: 4, delay_days: 7, template: 'closing_file' },
  ],
  quoted_not_booked: [
    { step: 1, delay_days: 1, template: 'quote_followup' },
    { step: 2, delay_days: 3, template: 'question_based' },
    { step: 3, delay_days: 7, template: 'manual_call' },
    { step: 4, delay_days: 14, template: 'social_proof' },
    { step: 5, delay_days: 21, template: 'closing_file' },
  ],
  one_time: [
    { step: 1, delay_days: 0, template: 'we_miss_you' },
    { step: 2, delay_days: 3, template: 'manual_call' },
    { step: 3, delay_days: 7, template: 'seasonal_nudge' },
    { step: 4, delay_days: 14, template: 'closing_file' },
  ],
  lapsed: [
    { step: 1, delay_days: 0, template: 'feedback_ask' },
    { step: 2, delay_days: 3, template: 'manual_call' },
    { step: 3, delay_days: 5, template: 'incentive_offer' },
    { step: 4, delay_days: 10, template: 'closing_file' },
  ],
  new_lead: [
    { step: 1, delay_days: 0, template: '9_word' },
    { step: 2, delay_days: 2, template: 'value_nudge' },
    { step: 3, delay_days: 5, template: 'closing_file' },
  ],
  repeat: [
    { step: 1, delay_days: 0, template: 'seasonal_nudge' },
    { step: 2, delay_days: 7, template: 'incentive_offer' },
  ],
  active: [
    { step: 1, delay_days: 0, template: 'seasonal_nudge' },
    { step: 2, delay_days: 7, template: 'value_nudge' },
  ],
  lost: [
    { step: 1, delay_days: 0, template: 'feedback_ask' },
    { step: 2, delay_days: 5, template: 'incentive_offer' },
    { step: 3, delay_days: 10, template: 'closing_file' },
  ],
}

/**
 * SMS templates per retargeting step — A/B tested.
 * Each template has variant 'a' (default) and 'b' (challenger).
 * {name} = customer first name, {service} = tenant service type, {business} = business name
 *
 * Data-driven rules (research-backed):
 * - Every message ends with a question (questions >> statements for response rate)
 * - Under 160 chars (single SMS segment) when possible
 * - 9-word format: pure question, no pitch, no explanation (15-20% response on dead leads)
 * - Breakup/close-file: 33% response rate — highest of any step
 * - "Your neighbor" strongest local social proof trigger
 * - Conversational tone, no corporate speak
 */
export const RETARGETING_TEMPLATES: Record<string, { a: string; b: string }> = {
  '9_word': {
    // Dean Jackson 9-word format: pure question, no pitch. Opens a loop the brain must close.
    a: 'Hey {name}, are you still thinking about {service}?',
    b: 'Hey {name}, are you still looking to get {service} done?',
  },
  'value_nudge': {
    // Real scarcity + question CTA. Specific numbers ("one opening") more believable than vague.
    a: 'Hey {name} it\'s {business}, just had a cancellation and have one opening for {service} this week. Want me to hold it for you?',
    b: '{name} it\'s {business}, we\'re booking {service} for next week and only have a few spots left. Want one?',
  },
  'quote_followup': {
    // Name the common objection (price) to give permission to be honest. "Soon or later" = both keep convo alive.
    a: 'Hey {name} it\'s {business}, checking in on your {service} quote. Any questions or was it the price? I might be able to help',
    b: '{name} it\'s {business}, still have your {service} quote on file. Looking to get it done soon or should I check back later?',
  },
  'question_based': {
    // Open question about THEIR home, not your service. Gets engagement without selling.
    a: '{name} it\'s {business}, when was the last time you had {service} done? Just curious',
    b: 'Hey {name} it\'s {business}, if you could get one thing done on your home right now what would it be?',
  },
  'limited_time': {
    // Specific deadline (Friday, this week) + question CTA. Real urgency, not fake.
    a: 'Hey {name} it\'s {business}, our {service} schedule is almost full this week, 2 spots left. Want one before they\'re gone?',
    b: '{name} it\'s {business}, we\'re running a special on {service} but only through Friday. Want me to lock you in?',
  },
  'we_miss_you': {
    // Casual, assumes positive past experience. "Swing by again" = effortless.
    a: 'Hey {name} it\'s {business}, been a while! Your place is probably due for {service} again. Want us to swing by?',
    b: '{name} it\'s {business}, noticed it\'s been a bit since your last {service}. Ready for a refresh? Just say when',
  },
  'seasonal_nudge': {
    // Combines social proof ("neighbors are booking") with scarcity ("before we fill up").
    a: '{name} it\'s {business}, your neighbors are already booking {service} this season. Want to get on the schedule before we fill up?',
    b: 'Hey {name} it\'s {business}, perfect time of year for {service}. We\'ve got openings this week if you want to get ahead of it',
  },
  'feedback_ask': {
    // Asks about THEIR experience, not a vague "anything we could improve". Low pressure, reopens relationship.
    a: 'Hey {name} it\'s {business}, we did your {service} a while back. How\'d everything hold up? Would love to hear',
    b: '{name} it\'s {business}, quick question, how\'d your {service} turn out last time? We always like to check in',
  },
  'incentive_offer': {
    // Dollar-off > percentage-off for services under $300. Free add-on = perceived value without discounting.
    a: '{name} it\'s {business}, we\'d love to have you back. I can do priority scheduling for your next {service} if you\'re interested?',
    b: 'Hey {name} it\'s {business}, giving returning customers first pick on {service} this week. Want me to put you at the top of the list?',
  },
  'check_in': {
    // Soft. "No rush" paradoxically increases reply rate. "Priorities shift" = face-saving exit that still gets response.
    a: '{name} it\'s {business}, any thoughts on the {service} quote? No rush at all',
    b: 'Hey {name} it\'s {business}, circling back on your {service} estimate. Still on your radar or did priorities shift?',
  },
  'social_proof': {
    // "Your street" / "your neighbor" = strongest local proof. "While we're in the area" = feels convenient.
    a: '{name} it\'s {business}, we just finished {service} on your street and it looks great. Want us to stop by while we\'re in the area?',
    b: 'Hey {name} it\'s {business}, your neighbor just left us a 5-star review after their {service}. Want the same treatment? We\'ve got availability',
  },
  'closing_file': {
    // Breakup message: 33% response rate (highest of any step). Loss aversion. Respectful, preserves relationship.
    a: '{name} it\'s {business}, last check on {service}. Should I keep you on the list or close your file? Either way no worries',
    b: 'Hey {name} it\'s {business}, this is my last text about {service}. Not interested? Totally fine. Just let me know either way',
  },
}

/**
 * Schedule a retargeting sequence for a customer.
 * Creates scheduled_tasks for each step in the sequence.
 */
export async function scheduleRetargetingSequence(
  tenantId: string,
  customerId: number,
  customerPhone: string,
  customerName: string,
  sequence: RetargetingSequenceType,
): Promise<{ success: boolean; taskIds: string[] }> {
  const steps = RETARGETING_SEQUENCES[sequence]
  if (!steps) return { success: false, taskIds: [] }

  const taskIds: string[] = []
  const now = new Date()

  // A/B test: randomly assign variant for the entire sequence
  const variant = Math.random() < 0.5 ? 'a' : 'b'

  for (const step of steps) {
    const scheduledFor = new Date(now.getTime() + step.delay_days * 24 * 60 * 60 * 1000)

    const result = await scheduleTask({
      tenantId,
      taskType: 'retargeting',
      taskKey: `retarget-${customerId}-${sequence}-step-${step.step}`,
      scheduledFor,
      payload: {
        customerId,
        customerPhone,
        customerName,
        sequence,
        step: step.step,
        template: step.template,
        variant,
      },
    })

    if (result.taskId) {
      taskIds.push(result.taskId)
    }
  }

  // Update customer retargeting status + A/B variant
  const supabase = getSupabase()
  await supabase
    .from('customers')
    .update({
      retargeting_sequence: sequence,
      retargeting_step: 1,
      retargeting_enrolled_at: now.toISOString(),
      retargeting_completed_at: null,
      retargeting_stopped_reason: null,
      retargeting_variant: variant,
      retargeting_replied_at: null,
    })
    .eq('id', customerId)
    .eq('tenant_id', tenantId)

  return { success: true, taskIds }
}
