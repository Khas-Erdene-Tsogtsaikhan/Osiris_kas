/**
 * Cleaner SMS Notifications
 *
 * Replaces lib/telegram.ts — all cleaner communications go via SMS (OpenPhone)
 * and include portal links for job management.
 *
 * Portal URL pattern: /crew/{portal_token}/job/{jobId}
 */

import type { Tenant } from './tenant'
import { formatTenantCurrency } from './tenant'
import { sendSMS } from './openphone'
import { getSupabaseServiceClient } from './supabase'

// ── Types (matching telegram.ts interfaces for drop-in replacement) ──

export interface CleanerInfo {
  id?: string | number
  telegram_id?: string | null  // kept for backwards compat during transition
  name: string
  phone?: string | null
  portal_token?: string | null
  hourly_rate?: number | null
}

export interface JobInfo {
  id?: string | number
  date?: string | null
  scheduled_at?: string | null
  address?: string | null
  service_type?: string | null
  notes?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  square_footage?: number | null
  hours?: number | null
  price?: number | string | null
  phone_number?: string | null
  frequency?: string | null
  addons?: Array<{ key: string; label?: string; price?: number }> | null
}

export interface CustomerInfo {
  first_name?: string | null
  last_name?: string | null
  address?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  square_footage?: number | null
  phone_number?: string | null
}

interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}

// ── Helpers ──

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://cleanmachine.live')
}

function portalUrl(portalToken: string): string {
  return `${getBaseUrl()}/crew/${portalToken}`
}

function jobUrl(portalToken: string, jobId: string | number): string {
  return `${getBaseUrl()}/crew/${portalToken}/job/${jobId}`
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return 'TBD'
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatTime(timeStr?: string | null): string {
  if (!timeStr) return 'TBD'
  try {
    const [h, m] = timeStr.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hour12 = h % 12 || 12
    return `${hour12}:${m.toString().padStart(2, '0')} ${ampm}`
  } catch {
    return timeStr
  }
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Notification Functions ──

/**
 * Notify cleaner of a new job assignment.
 * Creates a pending_sms_assignments row for YES/NO reply handling.
 */
export async function notifyCleanerAssignment(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo,
  customer?: CustomerInfo | null,
  assignmentId?: string
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const date = formatDate(job.date)
  const time = formatTime(job.scheduled_at)
  const address = job.address || customer?.address || 'See details'
  const service = job.service_type ? humanize(job.service_type) : 'Cleaning'
  const custName = customer?.first_name || null

  // Build detail lines
  const details: string[] = []
  if (job.bedrooms || job.bathrooms) {
    details.push(`${job.bedrooms || 0} bed / ${job.bathrooms || 0} bath`)
  }
  if (job.square_footage) details.push(`${job.square_footage} sqft`)
  if (job.hours) details.push(`${job.hours} hrs`)
  if (job.frequency && job.frequency !== 'one-time') details.push(`Recurring: ${humanize(job.frequency)}`)

  // Cleaner pay: unified priority chain (mirrors notifyCleanerAwarded so the
  // FIRST broadcast SMS shows the same pay the cleaner sees on confirmation).
  // Order: cleaner_pay_override > tenant hourly model > NORMAL_PRICE-aware
  // percentage of price > cleaner.hourly_rate × hours fallback.
  const numCleaners = Number((job as any).cleaners) || 1
  let payAmount: number | null = null
  const override = (job as any).cleaner_pay_override
  if (override != null) {
    payAmount = Number(override) / numCleaners
  } else if (tenant.workflow_config?.cleaner_pay_model === 'hourly' && job.hours) {
    const isDeep = job.service_type?.toLowerCase().includes('deep')
    const rate = isDeep
      ? (tenant.workflow_config.cleaner_pay_hourly_deep || 30)
      : (tenant.workflow_config.cleaner_pay_hourly_standard || 25)
    payAmount = (rate * Number(job.hours)) / numCleaners
  } else {
    const payPercentage = tenant.workflow_config?.cleaner_pay_percentage
    let payBase = job.price ? parseFloat(String(job.price)) : 0
    if (job.notes && typeof job.notes === 'string' && job.notes.includes('NORMAL_PRICE:')) {
      const match = job.notes.match(/NORMAL_PRICE:(\d+(?:\.\d+)?)/)
      if (match) payBase = parseFloat(match[1])
    }
    if (payPercentage && payBase) {
      payAmount = (payBase * (payPercentage / 100)) / numCleaners
    } else if (cleaner.hourly_rate && job.hours) {
      payAmount = (cleaner.hourly_rate * Number(job.hours)) / numCleaners
    }
  }
  if (payAmount != null) {
    details.push(`Your pay: ${formatTenantCurrency(tenant, payAmount)}`)
  }

  // Add paid add-ons to message (labels only — NEVER show prices to cleaners)
  if (job.addons && Array.isArray(job.addons) && job.addons.length > 0) {
    const addonLabels = job.addons
      .map((a: { key: string; label?: string }) => a.label || a.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
      .filter(Boolean)
    if (addonLabels.length > 0) {
      details.push(`Add-ons: ${addonLabels.join(', ')}`)
    }
  }

  const detailStr = details.length > 0 ? `\n${details.join(' | ')}` : ''
  const custStr = custName ? `\nCustomer: ${custName}` : ''

  // Notes are NEVER included in the SMS — they can carry admin price info,
  // tagged metadata (PROMO:, NORMAL_PRICE:), or other internal text that
  // must never reach a cleaner. Cleaners see notes only via the portal,
  // which strips structured tags and dollar amounts.

  let link = ''
  if (cleaner.portal_token && job.id) {
    link = `\n\nView full details, checklist & confirm:\n${jobUrl(cleaner.portal_token, job.id)}`
  }

  const message = `New job: ${date} ${time}\n${address}\n${service}${detailStr}${custStr}${link}`

  const result = await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })

  // Create pending SMS assignment for reply tracking
  if (result.success && assignmentId && cleaner.id) {
    try {
      const client = getSupabaseServiceClient()

      // Expire any existing active assignments for this cleaner
      await client
        .from('pending_sms_assignments')
        .update({ status: 'expired' })
        .eq('cleaner_id', cleaner.id)
        .eq('tenant_id', tenant.id)
        .eq('status', 'active')

      await client.from('pending_sms_assignments').insert({
        tenant_id: tenant.id,
        cleaner_id: typeof cleaner.id === 'string' ? parseInt(cleaner.id) : cleaner.id,
        assignment_id: assignmentId,
        job_id: typeof job.id === 'string' ? parseInt(job.id as string) : job.id,
      })
    } catch (err) {
      console.error('[cleaner-sms] Failed to create pending SMS assignment:', err)
    }
  }

  return result
}

/**
 * Notify cleaner they've been confirmed for a job.
 */
export async function notifyCleanerAwarded(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo,
  customer?: CustomerInfo | null
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const date = formatDate(job.date)
  const time = formatTime(job.scheduled_at)
  const address = job.address || customer?.address || 'See details'
  const service = job.service_type ? humanize(job.service_type) : 'Cleaning'
  // Cleaner pay — hourly model vs percentage model (NEVER cross between them)
  let payStr = ''
  if (tenant.workflow_config?.cleaner_pay_model === 'hourly') {
    const isDeep = job.service_type?.toLowerCase().includes('deep')
    const rate = isDeep
      ? (tenant.workflow_config.cleaner_pay_hourly_deep || 30)
      : (tenant.workflow_config.cleaner_pay_hourly_standard || 25)
    if (job.hours) {
      payStr = `\nYour pay: ${formatTenantCurrency(tenant, rate * Number(job.hours))}`
    } else {
      payStr = `\nPay rate: ${formatTenantCurrency(tenant, rate)}/hr`
    }
  } else {
    const payPercentage2 = tenant.workflow_config?.cleaner_pay_percentage
    if (payPercentage2 && job.price) {
      const totalPay2 = parseFloat(String(job.price)) * (payPercentage2 / 100)
      const crewSize2 = Number((job as any).cleaners) || 1
      const cleanerPay = crewSize2 > 1 ? totalPay2 / crewSize2 : totalPay2
      payStr = `\nYour pay: ${formatTenantCurrency(tenant, cleanerPay)}`
    } else if (job.hours) {
      const rate = cleaner.hourly_rate || 25
      payStr = `\nYour pay: ${formatTenantCurrency(tenant, rate * Number(job.hours))}`
    }
  }

  // Add paid add-ons to message (labels only — NEVER show prices to cleaners)
  let addonsStr = ''
  if (job.addons && Array.isArray(job.addons) && job.addons.length > 0) {
    const addonLabels = job.addons
      .map((a: { key: string; label?: string }) => a.label || a.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
      .filter(Boolean)
    if (addonLabels.length > 0) {
      addonsStr = `\nAdd-ons: ${addonLabels.join(', ')}`
    }
  }

  let link = ''
  if (cleaner.portal_token && job.id) {
    link = `\n\nView checklist & details:\n${jobUrl(cleaner.portal_token, job.id)}`
  }

  const message = `You're confirmed for ${date} ${time}\n${address}\n${service}${payStr}${addonsStr}${link}`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Notify cleaner they were not selected for a job.
 */
export async function notifyCleanerNotSelected(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const date = formatDate(job.date)
  const message = `The ${date} job has been assigned to another cleaner. Thanks for your availability!`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Send urgent follow-up for unresponsive cleaners.
 * Includes address and portal link so cleaner knows which job it is.
 */
export async function sendUrgentFollowUp(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const date = formatDate(job.date)
  const time = formatTime(job.scheduled_at)
  const address = job.address || 'See details'

  let link = ''
  if (cleaner.portal_token && job.id) {
    link = `\n${jobUrl(cleaner.portal_token, job.id)}`
  }

  const message = `We still need your response for the ${date} ${time} job at ${address}.${link ? `\n\nTap here to respond:${link}` : ''}`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Send daily schedule summary to a cleaner with portal link.
 */
export async function sendDailySchedule(
  tenant: Tenant,
  cleaner: CleanerInfo,
  jobs: Array<JobInfo & { customer?: CustomerInfo | null }>
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  if (jobs.length === 0) {
    return { success: true } // Don't text about empty days
  }

  let link = ''
  if (cleaner.portal_token) {
    link = ` View schedule: ${portalUrl(cleaner.portal_token)}`
  }

  const message = `Good morning ${cleaner.name}! You have ${jobs.length} job${jobs.length > 1 ? 's' : ''} today.${link}`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Send job reminder (1 hour before or at job start).
 */
export async function sendJobReminder(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo,
  customer?: CustomerInfo | null,
  reminderType: 'one_hour_before' | 'job_start' = 'job_start'
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const address = job.address || 'Address TBD'
  let link = ''
  if (cleaner.portal_token && job.id) {
    link = ` Details: ${jobUrl(cleaner.portal_token, job.id)}`
  }

  const message = reminderType === 'one_hour_before'
    ? `Reminder: Job in 1 hour at ${address}.${link}`
    : `Job starting now at ${address}.${link}`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Notify cleaner of a job cancellation.
 */
export async function notifyJobCancellation(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const date = formatDate(job.date)
  const address = job.address || 'the scheduled address'
  const message = `Job on ${date} at ${address} has been cancelled.`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Notify cleaner of a schedule change.
 */
export async function notifyScheduleChange(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo,
  oldDate?: string,
  oldTime?: string
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const newDate = formatDate(job.date)
  const newTime = formatTime(job.scheduled_at)
  const message = `Schedule change: Your job has been moved to ${newDate} ${newTime}. Please update your calendar.`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Notify cleaner of job details change (address, time, notes, etc.).
 */
export async function notifyJobDetailsChange(
  tenant: Tenant,
  cleaner: CleanerInfo,
  job: JobInfo,
  changes: { field: string; oldValue: string | number | null; newValue: string | number | null }[]
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const date = formatDate(job.date)
  const changeList = changes.map(c => `${c.field}: ${c.newValue}`).join(', ')

  let link = ''
  if (cleaner.portal_token && job.id) {
    link = ` Details: ${jobUrl(cleaner.portal_token, job.id)}`
  }

  const message = `Update for your ${date} job: ${changeList}.${link}`
  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

/**
 * Send SMS to tenant owner.
 */
export async function notifyOwnerSMS(
  tenant: Tenant,
  message: string
): Promise<SendResult> {
  if (!tenant.owner_phone) {
    return { success: false, error: 'No owner phone configured' }
  }
  return await sendSMS(tenant, tenant.owner_phone, message)
}

/**
 * Send a message from a cleaner to a customer via the business phone number.
 * Stores in messages table with cleaner_id metadata for portal display.
 */
export async function sendCleanerPortalMessage(
  tenant: Tenant,
  cleaner: CleanerInfo,
  customerPhone: string,
  content: string,
  jobId: string | number,
  customerId?: string | number
): Promise<SendResult> {
  // Append cleaner identity tag so client knows who's texting
  const firstName = cleaner.name.split(' ')[0]
  const businessName = tenant.business_name_short || tenant.name
  const taggedContent = `${content}\n\n— ${firstName} from ${businessName}, your cleaner`

  const result = await sendSMS(tenant, customerPhone, taggedContent, { skipThrottle: true, bypassFilters: true })

  if (result.success) {
    try {
      const client = getSupabaseServiceClient()
      await client.from('messages').insert({
        tenant_id: tenant.id,
        customer_id: customerId || null,
        phone_number: customerPhone,
        role: 'assistant',
        content,
        direction: 'outbound',
        message_type: 'sms',
        ai_generated: false,
        timestamp: new Date().toISOString(),
        source: 'cleaner_portal',
        metadata: {
          cleaner_id: cleaner.id,
          cleaner_name: cleaner.name,
          job_id: jobId,
          source: 'cleaner_portal',
        },
      })
    } catch (err) {
      console.error('[cleaner-sms] Failed to store portal message:', err)
    }
  }

  return result
}

// ── Customer Status Notifications ──

/**
 * Notify customer when cleaner updates their status (OMW/HERE/DONE).
 */
export async function notifyCustomerStatus(
  tenant: Tenant,
  customerPhone: string,
  customerName: string | null,
  status: 'omw' | 'arrived' | 'done',
  cleanerName?: string | null
): Promise<SendResult> {
  const name = customerName || 'there'
  const businessName = tenant.business_name_short || tenant.name
  const cleanerFirst = cleanerName ? cleanerName.split(' ')[0] : null

  const messages: Record<string, string> = cleanerFirst
    ? {
        omw: `Hey ${name}! ${cleanerFirst} from ${businessName} is on the way and should be there shortly.`,
        arrived: `${cleanerFirst} from ${businessName} has arrived! If you have any special instructions, let them know.`,
        done: `Your cleaning is all done! We hope you love it. Thank you for choosing ${businessName}!`,
      }
    : {
        omw: `Hey ${name}! Your cleaner is on the way and should be there shortly.`,
        arrived: `Your cleaner has arrived! If you have any special instructions, let them know.`,
        done: `Your cleaning is all done! We hope you love it. Thank you for choosing us!`,
      }

  return await sendSMS(tenant, customerPhone, messages[status], { skipThrottle: true, bypassFilters: true })
}

/**
 * Send a cleaner their portal login credentials via SMS.
 */
export async function sendLoginCredentials(
  tenant: Tenant,
  cleanerId: string | number
): Promise<SendResult> {
  const client = getSupabaseServiceClient()
  const { data: cleaner } = await client
    .from('cleaners')
    .select('phone, username, pin, portal_token')
    .eq('id', Number(cleanerId))
    .single()

  if (!cleaner?.phone || !cleaner.username || !cleaner.pin) {
    return { success: false, error: 'Cleaner has no credentials or phone' }
  }

  const baseUrl = getBaseUrl()
  const portalLink = `${baseUrl}/crew/${cleaner.portal_token}`
  const message = `Your portal login:\n\nWebsite: ${baseUrl.replace('https://', '')}\nUsername: ${cleaner.username}\nPIN: ${cleaner.pin}\n\nOr tap here to go straight to your portal: ${portalLink}`

  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}

// ── SMS Inbound Handlers ──

/** Regex patterns for cleaner SMS commands */
export const CLEANER_SMS_PATTERNS = {
  omw: /^(omw|on my way|otw|heading over|leaving now)\b/i,
  here: /^(here|arrived|i'?m here|at the house)\b/i,
  done: /^(done|finished|complete|all done)\b/i,
  accept: /^(yes|yeah|yep|yup|y|sure|accept|1)\b/i,
  decline: /^(no|nah|n|decline|pass|can'?t|2)\b/i,
  login: /\b(login|log in|password|pin|username|sign in|my credentials|how do i log in|my login)\b/i,
}

/**
 * Parse a cleaner's inbound SMS to determine intent.
 */
export function parseCleanerSMS(content: string): 'omw' | 'here' | 'done' | 'accept' | 'decline' | 'login' | null {
  const trimmed = content.trim()
  for (const [key, pattern] of Object.entries(CLEANER_SMS_PATTERNS)) {
    if (pattern.test(trimmed)) {
      return key as 'omw' | 'here' | 'done' | 'accept' | 'decline' | 'login'
    }
  }
  return null
}

/**
 * Process a cleaner's status update (OMW/HERE/DONE).
 * Updates job timestamps, notifies customer, triggers post-job flow on DONE.
 */
export async function processCleanerStatusUpdate(
  tenant: Tenant,
  cleanerId: number | string,
  status: 'omw' | 'here' | 'done'
): Promise<{ success: boolean; error?: string; jobId?: number }> {
  const client = getSupabaseServiceClient()

  // Find the cleaner's active job (confirmed assignment, job in_progress or scheduled)
  const { data: activeAssignment } = await client
    .from('cleaner_assignments')
    .select('job_id, jobs!inner(id, status, customer_id, phone_number, date, customers(first_name, phone_number))')
    .eq('cleaner_id', cleanerId)
    .eq('tenant_id', tenant.id)
    .in('status', ['confirmed', 'accepted'])
    .in('jobs.status', ['scheduled', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!activeAssignment) {
    return { success: false, error: 'No active job found' }
  }

  const job = (activeAssignment as any).jobs
  const customer = job?.customers
  const jobId = job?.id

  // Update job status/timestamps
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (status === 'omw') {
    updates.cleaner_omw_at = new Date().toISOString()
    if (job.status === 'scheduled') updates.status = 'in_progress'
  } else if (status === 'here') {
    updates.cleaner_arrived_at = new Date().toISOString()
    if (job.status === 'scheduled') updates.status = 'in_progress'
  } else if (status === 'done') {
    updates.status = 'completed'
    updates.completed_at = new Date().toISOString()
  }

  await client.from('jobs').update(updates).eq('id', jobId)

  // Get cleaner name for customer notification
  const { data: cleanerData } = await client
    .from('cleaners')
    .select('name')
    .eq('id', cleanerId)
    .maybeSingle()

  // Notify customer
  const customerPhone = customer?.phone_number || job?.phone_number
  if (customerPhone) {
    const statusMap = { omw: 'omw', here: 'arrived', done: 'done' } as const
    await notifyCustomerStatus(tenant, customerPhone, customer?.first_name || null, statusMap[status], cleanerData?.name)
  }

  return { success: true, jobId }
}

/**
 * Process a cleaner's accept/decline of a pending assignment via SMS.
 */
export async function processCleanerAssignmentReply(
  tenant: Tenant,
  cleanerId: number | string,
  accepted: boolean
): Promise<{ success: boolean; error?: string }> {
  const client = getSupabaseServiceClient()

  // Find active pending SMS assignment for this cleaner
  const { data: pending } = await client
    .from('pending_sms_assignments')
    .select('id, assignment_id, job_id')
    .eq('cleaner_id', cleanerId)
    .eq('tenant_id', tenant.id)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!pending) {
    return { success: false, error: 'No pending assignment found' }
  }

  // Mark the pending assignment as resolved
  await client
    .from('pending_sms_assignments')
    .update({ status: 'resolved' })
    .eq('id', pending.id)

  if (accepted) {
    // Guard: check if another cleaner already accepted this job
    const { data: existingAccepted } = await client
      .from('cleaner_assignments')
      .select('id, cleaner_id')
      .eq('job_id', pending.job_id)
      .eq('status', 'accepted')
      .limit(1)
      .maybeSingle()

    if (existingAccepted) {
      console.log(`[cleaner-sms] Job ${pending.job_id} already has accepted cleaner ${existingAccepted.cleaner_id} — rejecting late accept from ${cleanerId}`)
      return { success: false, error: 'Job already assigned to another cleaner' }
    }

    // Accept: update cleaner_assignment status — only if still pending
    const { data: updated } = await client
      .from('cleaner_assignments')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', pending.assignment_id)
      .eq('status', 'pending')
      .select('id')

    // If no rows updated, the assignment was already cancelled/accepted — abort
    if (!updated || updated.length === 0) {
      console.log(`[cleaner-sms] Assignment ${pending.assignment_id} no longer pending — skipping confirmation`)
      return { success: false, error: 'Assignment no longer pending (already cancelled or accepted)' }
    }

    // Update job status + set cleaner_id so it shows in calendar/teams
    await client
      .from('jobs')
      .update({ cleaner_id: cleanerId, updated_at: new Date().toISOString() })
      .eq('id', pending.job_id)
    // Also move to scheduled if still pending/new
    await client
      .from('jobs')
      .update({ status: 'scheduled' })
      .eq('id', pending.job_id)
      .in('status', ['pending', 'new'])

    // Get cleaner info for confirmation (skip inactive cleaners)
    const { data: cleaner } = await client
      .from('cleaners')
      .select('name, phone, portal_token')
      .eq('id', cleanerId)
      .eq('active', true)
      .maybeSingle()

    const { data: job } = await client
      .from('jobs')
      .select('*')
      .eq('id', pending.job_id)
      .maybeSingle()

    if (cleaner && job) {
      await notifyCleanerAwarded(tenant, cleaner, job)
    }

    // Cancel other pending assignments for this job (broadcast mode)
    const { data: otherAssignments } = await client
      .from('cleaner_assignments')
      .select('id, cleaner_id')
      .eq('job_id', pending.job_id)
      .eq('status', 'pending')
      .neq('id', pending.assignment_id)

    if (otherAssignments) {
      for (const other of otherAssignments) {
        await client
          .from('cleaner_assignments')
          .update({ status: 'cancelled' })
          .eq('id', other.id)

        // Expire their pending SMS assignments too
        await client
          .from('pending_sms_assignments')
          .update({ status: 'expired' })
          .eq('assignment_id', other.id)
          .eq('status', 'active')

        // Notify them (skip inactive cleaners)
        const { data: otherCleaner } = await client
          .from('cleaners')
          .select('name, phone')
          .eq('id', other.cleaner_id)
          .eq('active', true)
          .maybeSingle()

        if (otherCleaner && job) {
          await notifyCleanerNotSelected(tenant, otherCleaner, job)
        }
      }
    }
  } else {
    // Decline: update assignment status
    await client
      .from('cleaner_assignments')
      .update({ status: 'declined', responded_at: new Date().toISOString() })
      .eq('id', pending.assignment_id)
      .eq('status', 'pending')

    // Cascade to next cleaner
    try {
      const { triggerCleanerAssignment } = await import('./cleaner-assignment')
      await triggerCleanerAssignment(String(pending.job_id))
    } catch (err) {
      console.error('[cleaner-sms] Failed to cascade assignment:', err)
    }
  }

  return { success: true }
}

// ── Pre-Confirm Notification ──

export interface PreconfirmInfo {
  id: number
  quote_id: number
  cleaner_pay: number | null
  description: string | null
  customer_name: string | null
  customer_address: string | null
  service_category: string | null
}

/**
 * Notify a cleaner about a pre-confirm opportunity on a quote.
 * The cleaner can confirm or decline BEFORE the client picks a date.
 */
export async function notifyCleanerPreconfirm(
  tenant: Tenant,
  cleaner: CleanerInfo,
  preconfirm: PreconfirmInfo,
): Promise<SendResult> {
  if (!cleaner.phone) {
    return { success: false, error: 'Cleaner has no phone number' }
  }

  const service = preconfirm.description || preconfirm.service_category || 'Cleaning'
  const payStr = preconfirm.cleaner_pay ? `\nYour pay: ${formatTenantCurrency(tenant, Number(preconfirm.cleaner_pay))}` : ''
  const addressStr = preconfirm.customer_address ? `\nArea: ${preconfirm.customer_address}` : ''
  const custStr = preconfirm.customer_name ? `\nCustomer: ${preconfirm.customer_name.split(' ')[0]}` : ''

  let link = ''
  if (cleaner.portal_token) {
    link = `\n\nInterested? Tap to confirm:\n${getBaseUrl()}/crew/${cleaner.portal_token}/preconfirm/${preconfirm.id}`
  }

  const message = `Hey ${cleaner.name.split(' ')[0]}! We have a ${humanize(service)} job.${payStr}${addressStr}${custStr}\n\nClient will pick the date — are you in?${link}`

  return await sendSMS(tenant, cleaner.phone, message, { skipThrottle: true, bypassFilters: true, useCleaner: true })
}
