import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { SignJWT } from 'jose'
import { toE164 } from './phone-utils'
import { getClientConfig } from './client-config'
import { syncHubSpotContact, syncHubSpotDeal } from './hubspot'
import { notifyJobDetailsChange } from './cleaner-sms'
import { getTenantById } from './tenant'

type JobChange = {
  field: 'address' | 'bedrooms' | 'bathrooms' | 'square_footage' | 'date' | 'scheduled_at' | 'notes'
  oldValue: string | number | null
  newValue: string | number | null
}
import { logSystemEvent } from './system-events'

type HubSpotSyncOptions = {
  skipHubSpotSync?: boolean
}

// Database types
export interface Customer {
  id?: string
  phone_number: string
  first_name?: string
  last_name?: string
  email?: string
  address?: string
  bedrooms?: number
  bathrooms?: number
  square_footage?: number
  texting_transcript?: string
  hubspot_contact_id?: string
  created_at?: string
  updated_at?: string
}

export interface Job {
  id?: string
  tenant_id?: string
  customer_id?: string
  phone_number: string
  service_type?: string
  date?: string
  scheduled_at?: string
  address?: string
  bedrooms?: number
  bathrooms?: number
  square_footage?: number
  status?: 'lead' | 'quoted' | 'scheduled' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'
  price?: number
  hours?: number
  cleaners?: number
  notes?: string
  pricing_adjustment_pct?: number
  pricing_strategy?: string
  pricing_insights?: Record<string, unknown>
  booked?: boolean
  paid?: boolean
  invoice_sent?: boolean
  stripe_invoice_id?: string
  hubspot_deal_id?: string
  docusign_envelope_id?: string
  docusign_status?: string
  created_at?: string
  updated_at?: string
  // Lead automation fields
  payment_status?: 'pending' | 'deposit_paid' | 'fully_paid' | 'payment_failed'
  stripe_payment_intent_id?: string
  confirmed_at?: string
  cleaner_confirmed?: boolean
  customer_notified?: boolean
  followup_sent_at?: string
  review_requested_at?: string
  monthly_followup_sent_at?: string
  completed_at?: string
  // HousecallPro sync
  hcp_job_id?: string
  team_id?: number
  // Salesman/technician split (WinBros)
  job_type?: 'estimate' | 'cleaning'
  // Membership link
  membership_id?: string
}

export interface Cleaner {
  id?: string
  tenant_id?: string
  name: string
  phone?: string
  email?: string
  telegram_id?: string
  telegram_username?: string
  connecteam_user_id?: string
  max_team_size?: number
  availability?: Record<string, unknown>
  active?: boolean
  is_team_lead?: boolean
  home_address?: string
  home_lat?: number
  home_lng?: number
  employee_type?: 'technician' | 'salesman'
  portal_token?: string | null
  rank?: number | null
  created_at?: string
}

export interface CleanerAssignment {
  id?: string
  job_id: string
  cleaner_id: string
  status?: 'pending' | 'accepted' | 'declined' | 'confirmed' | 'cancelled'
  connecteam_shift_id?: string
  connecteam_shift_status?: string
  created_at?: string
  updated_at?: string
}

export interface Call {
  id?: string
  phone_number: string
  from_number?: string
  to_number?: string
  direction?: string
  provider?: string
  provider_call_id?: string
  status?: string
  recording_url?: string
  started_at?: string
  caller_name?: string
  date?: string
  duration_seconds?: number
  transcript?: string
  audio_url?: string
  outcome?: 'booked' | 'not_booked' | 'voicemail'
  vapi_call_id?: string
  created_at?: string
}

export interface Message {
  id?: string
  customer_id: number
  call_id?: number
  openphone_id?: string
  role: 'client' | 'assistant' | 'system'
  content: string
  timestamp: string
  direction?: 'inbound' | 'outbound' | null
  message_type?: string
  ai_generated?: boolean
  created_at?: string
}

// Singleton client
let supabaseClient: SupabaseClient | null = null
let supabaseServiceClient: SupabaseClient | null = null

// Export supabase as a getter for dashboard compatibility
export const supabase = {
  from: (table: string) => getSupabaseClient().from(table),
  auth: { getSession: () => getSupabaseClient().auth.getSession() },
  rpc: (...args: Parameters<SupabaseClient['rpc']>) => getSupabaseClient().rpc(...args),
}

/**
 * Returns the service-role Supabase client for server-side helper functions.
 *
 * All callers of getSupabaseClient() run server-side (webhooks, crons, lib helpers).
 * The anon key has no tenant_id JWT claim, so RLS tenant_isolation policies block
 * every query. Using the service-role client here unblocks server-side operations.
 *
 * RLS is still enforced for dashboard routes via getTenantScopedClient(), which
 * mints a per-tenant JWT that the RLS policies can verify.
 */
export function getSupabaseClient(): SupabaseClient {
  return getSupabaseServiceClient()
}

/**
 * Service-role-only client (bypasses RLS). Use this for server-side APIs only.
 * We intentionally DO NOT fall back to anon keys here.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  if (!supabaseServiceClient) {
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      process.env.PUBLIC_SUPABASE_URL

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE

    if (!supabaseUrl || !serviceKey) {
      throw new Error(
        "Missing Supabase service role env. Set SUPABASE_SERVICE_ROLE_KEY in .env.local and restart `npm run dev`."
      )
    }

    supabaseServiceClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }

  return supabaseServiceClient
}

/**
 * Creates a short-lived JWT scoped to a specific tenant.
 * Signed with SUPABASE_JWT_SECRET so Supabase can verify it.
 * RLS policies read `auth.jwt() ->> 'tenant_id'` to enforce row isolation.
 */
export async function createTenantJwt(tenantId: string): Promise<string> {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not set')

  return new SignJWT({ tenant_id: tenantId, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

/**
 * Returns an anon-key Supabase client authenticated as a specific tenant.
 * RLS policies are enforced — the client can only see that tenant's rows.
 * Use this for all tenant-scoped API routes (customers, jobs, leads, etc.).
 *
 * Do NOT use this for admin, cron, or webhook routes — use getSupabaseServiceClient() there.
 */
export async function getTenantScopedClient(tenantId: string): Promise<SupabaseClient> {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.PUBLIC_SUPABASE_URL

  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY for tenant-scoped client')
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => createTenantJwt(tenantId),
  })

  return client
}

async function updateCustomerHubSpotId(customerId: string, contactId: string): Promise<void> {
  const client = getSupabaseClient()
  const { error } = await client
    .from('customers')
    .update({
      hubspot_contact_id: contactId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', customerId)

  if (error) {
    console.error('Error updating HubSpot contact ID:', error)
  }
}

async function updateJobHubSpotId(jobId: string, dealId: string): Promise<void> {
  const client = getSupabaseClient()
  const { error } = await client
    .from('jobs')
    .update({
      hubspot_deal_id: dealId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)

  if (error) {
    console.error('Error updating HubSpot deal ID:', error)
  }
}

// Customer operations
export async function upsertCustomer(
  phoneNumber: string,
  data: Partial<Customer>,
  options: HubSpotSyncOptions = {}
): Promise<Customer | null> {
  const client = getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for customer upsert:', phoneNumber)
    return null
  }

  const { data: customer, error } = await client
    .from('customers')
    .upsert(
      { ...data, phone_number: dbPhone, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,phone_number' }
    )
    .select()
    .single()

  if (error) {
    console.error('Error upserting customer:', error)
    return null
  }

  if (customer && !options.skipHubSpotSync) {
    try {
      const syncResult = await syncHubSpotContact(customer)
      if (syncResult.contactId && customer.id && syncResult.contactId !== customer.hubspot_contact_id) {
        await updateCustomerHubSpotId(customer.id, syncResult.contactId)
        customer.hubspot_contact_id = syncResult.contactId
      }
    } catch (syncError) {
      console.error('HubSpot customer sync error:', syncError)
    }
  }
  return customer
}

/**
 * Upsert customer and notify assigned cleaner if important fields changed
 * This wrapper function:
 * 1. Fetches old customer state
 * 2. Calls upsertCustomer to perform the update
 * 3. Detects which important fields changed
 * 4. If customer has active job with assigned cleaner, notifies them
 */
export async function upsertCustomerWithNotifications(
  phoneNumber: string,
  updates: Partial<Customer>,
  options: HubSpotSyncOptions = {}
): Promise<Customer | null> {
  // 1. Fetch old customer state for comparison
  const oldCustomer = await getCustomerByPhone(phoneNumber)

  // 2. Perform the upsert
  const updatedCustomer = await upsertCustomer(phoneNumber, updates, options)
  if (!updatedCustomer) {
    console.error('upsertCustomerWithNotifications: Upsert failed for phone:', phoneNumber)
    return null
  }

  // 3. If no old customer (new customer), skip notifications
  if (!oldCustomer) {
    return updatedCustomer
  }

  // 4. Detect changes in important fields
  const changes: JobChange[] = []
  const importantFields: Array<keyof Customer> = [
    'bedrooms',
    'bathrooms',
    'square_footage',
    'address',
  ]

  for (const field of importantFields) {
    if (updates[field] !== undefined && oldCustomer[field] !== updates[field]) {
      changes.push({
        field: field as JobChange['field'],
        oldValue: oldCustomer[field] as string | number | null,
        newValue: updates[field] as string | number | null,
      })
    }
  }

  // 5. If no changes to important fields, return early
  if (changes.length === 0) {
    return updatedCustomer
  }

  // 6. Check if customer has an active job
  const jobs = await getJobsByPhone(phoneNumber)
  const activeJob = jobs.find(
    (job) => job.status === 'scheduled' || job.status === 'in_progress'
  )

  if (!activeJob) {
    // No active job to notify about
    return updatedCustomer
  }

  // 7. Get assigned cleaner (accepted or confirmed status)
  const assignment = await getAcceptedAssignmentForJob(activeJob.id!)
  if (!assignment) {
    // No assigned cleaner to notify
    return updatedCustomer
  }

  const cleaner = await getCleanerById(assignment.cleaner_id)
  if (!cleaner?.phone) {
    // Cleaner doesn't have phone configured
    return updatedCustomer
  }

  // 8. Notify cleaner of changes
  try {
    const jobTenantId = (activeJob as any).tenant_id
    const tenant = jobTenantId ? await getTenantById(jobTenantId) : null
    if (!tenant) {
      console.warn('upsertCustomerWithNotifications: No tenant found for job, skipping cleaner notification')
      return updatedCustomer
    }

    await notifyJobDetailsChange(tenant, cleaner, activeJob, changes.map(c => ({
      field: String(c.field),
      oldValue: String(c.oldValue ?? ''),
      newValue: String(c.newValue ?? ''),
    })))

    // 9. Log the event
    await logSystemEvent({
      source: 'job_updates',
      event_type: 'JOB_DETAILS_CHANGED',
      message: `Customer ${updatedCustomer.first_name || 'details'} changed, cleaner ${cleaner.name} notified`,
      job_id: activeJob.id,
      customer_id: activeJob.customer_id,
      phone_number: phoneNumber,
      metadata: {
        changes: changes.map((c) => ({
          field: c.field,
          old: c.oldValue,
          new: c.newValue,
        })),
        cleaner_id: cleaner.id,
        cleaner_name: cleaner.name,
        source: 'customer_update',
      },
    })
  } catch (error) {
    console.error('upsertCustomerWithNotifications: Error notifying cleaner:', error)
    // Don't fail the whole update if notification fails
  }

  return updatedCustomer
}

export async function getCustomerByPhone(phoneNumber: string, overrideClient?: SupabaseClient): Promise<Customer | null> {
  const client = overrideClient || getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for customer lookup:', phoneNumber)
    return null
  }

  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('phone_number', dbPhone)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    console.error('Error fetching customer:', error)
    return null
  }
  return data
}

export async function appendToTextingTranscript(
  phoneNumber: string,
  newText: string,
  overrideClient?: SupabaseClient
): Promise<boolean> {
  const client = overrideClient || getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for transcript update:', phoneNumber)
    return false
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const customer = await getCustomerByPhone(phoneNumber, client)
    const currentTranscript = customer?.texting_transcript || ''
    const updatedTranscript = currentTranscript
      ? `${currentTranscript}\n${newText}`
      : newText

    const baseUpdate = () =>
      client
        .from('customers')
        .update({
          texting_transcript: updatedTranscript,
          updated_at: new Date().toISOString(),
        })
        .eq('phone_number', dbPhone)

    if (currentTranscript) {
      const { data, error } = await baseUpdate()
        .eq('texting_transcript', currentTranscript)
        .select('id')

      if (error) {
        console.error('Error updating transcript:', error)
        return false
      }
      if ((data || []).length > 0) {
        return true
      }
      continue
    }

    const emptyResult = await baseUpdate().eq('texting_transcript', '').select('id')
    if (emptyResult.error) {
      console.error('Error updating transcript:', emptyResult.error)
      return false
    }
    if ((emptyResult.data || []).length > 0) {
      return true
    }

    const nullResult = await baseUpdate().is('texting_transcript', null).select('id')
    if (nullResult.error) {
      console.error('Error updating transcript:', nullResult.error)
      return false
    }
    if ((nullResult.data || []).length > 0) {
      return true
    }
  }

  console.error('Failed to update transcript after retries')
  return false
}

export async function claimCustomerResponseLock(
  phoneNumber: string,
  currentTranscript: string,
  lockToken: string
): Promise<boolean> {
  const client = getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for response lock:', phoneNumber)
    return false
  }

  const lockLine = `[LOCK] ${lockToken}`
  const updatedTranscript = currentTranscript
    ? `${currentTranscript}\n${lockLine}`
    : lockLine

  const baseUpdate = () =>
    client
      .from('customers')
      .update({
        texting_transcript: updatedTranscript,
        updated_at: new Date().toISOString(),
      })
      .eq('phone_number', dbPhone)

  if (currentTranscript) {
    const { data, error } = await baseUpdate()
      .eq('texting_transcript', currentTranscript)
      .select('id')

    if (error) {
      console.error('Error claiming response lock:', error)
      return false
    }
    return (data || []).length > 0
  }

  const emptyResult = await baseUpdate().eq('texting_transcript', '').select('id')
  if (emptyResult.error) {
    console.error('Error claiming response lock:', emptyResult.error)
    return false
  }
  if ((emptyResult.data || []).length > 0) {
    return true
  }

  const nullResult = await baseUpdate().is('texting_transcript', null).select('id')
  if (nullResult.error) {
    console.error('Error claiming response lock:', nullResult.error)
    return false
  }
  return (nullResult.data || []).length > 0
}

export async function appendSpotlessResponse(
  phoneNumber: string,
  responseText: string,
  lockToken?: string
): Promise<boolean> {
  const client = getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for response update:', phoneNumber)
    return false
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const customer = await getCustomerByPhone(phoneNumber)
    const currentTranscript = customer?.texting_transcript || ''
    const cleanedLines = currentTranscript
      .split('\n')
      .filter(line => {
        if (!line.startsWith('[LOCK]')) {
          return true
        }
        if (!lockToken) {
          return false
        }
        return !line.includes(lockToken)
      })

    const config = getClientConfig()
    const responseLine = `[${new Date().toISOString()}] ${config.businessNameShort}: ${responseText}`
    const updatedTranscript = cleanedLines.length > 0
      ? `${cleanedLines.join('\n')}\n${responseLine}`
      : responseLine

    const baseUpdate = () =>
      client
        .from('customers')
        .update({
          texting_transcript: updatedTranscript,
          updated_at: new Date().toISOString(),
        })
        .eq('phone_number', dbPhone)

    if (currentTranscript) {
      const { data, error } = await baseUpdate()
        .eq('texting_transcript', currentTranscript)
        .select('id')

      if (error) {
        console.error('Error updating transcript with response:', error)
        return false
      }
      if ((data || []).length > 0) {
        return true
      }
      continue
    }

    const emptyResult = await baseUpdate().eq('texting_transcript', '').select('id')
    if (emptyResult.error) {
      console.error('Error updating transcript with response:', emptyResult.error)
      return false
    }
    if ((emptyResult.data || []).length > 0) {
      return true
    }

    const nullResult = await baseUpdate().is('texting_transcript', null).select('id')
    if (nullResult.error) {
      console.error('Error updating transcript with response:', nullResult.error)
      return false
    }
    if ((nullResult.data || []).length > 0) {
      return true
    }
  }

  console.error('Failed to update transcript response after retries')
  return false
}

// Job operations
export async function createJob(
  jobData: Partial<Job>,
  options: HubSpotSyncOptions = {},
  userId?: number
): Promise<Job | null> {
  const client = getSupabaseClient()
  const dbPhone = toE164(jobData.phone_number)

  if (!dbPhone) {
    console.error('Invalid phone number for job creation:', jobData.phone_number)
    return null
  }

  // Strip fields that don't exist on the jobs table
  const { invoice_sent, user_id, ...cleanJobData } = jobData as any

  const { data, error } = await client
    .from('jobs')
    .insert({
      ...cleanJobData,
      phone_number: dbPhone,
      status: jobData.status || 'lead',
      booked: jobData.booked ?? false,
      paid: jobData.paid ?? false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .select()
    .single()

  if (error) {
    console.error('Error creating job:', error)
    return null
  }

  if (data && !options.skipHubSpotSync) {
    try {
      const customer = await getCustomerByPhone(data.phone_number)
      const syncResult = await syncHubSpotDeal(data, customer || undefined)
      if (syncResult.contactId && customer?.id && syncResult.contactId !== customer.hubspot_contact_id) {
        await updateCustomerHubSpotId(customer.id, syncResult.contactId)
      }
      if (syncResult.dealId && data.id && syncResult.dealId !== data.hubspot_deal_id) {
        await updateJobHubSpotId(data.id, syncResult.dealId)
      }
    } catch (syncError) {
      console.error('HubSpot job sync error:', syncError)
    }
  }
  return data
}

export async function updateJob(
  jobId: string,
  data: Partial<Job>,
  options: HubSpotSyncOptions = {},
  overrideClient?: SupabaseClient
): Promise<Job | null> {
  const client = overrideClient || getSupabaseClient()

  const { data: job, error } = await client
    .from('jobs')
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .select()
    .single()

  if (error) {
    console.error('Error updating job:', error)
    return null
  }

  if (job && !options.skipHubSpotSync) {
    try {
      const customer = await getCustomerByPhone(job.phone_number)
      const syncResult = await syncHubSpotDeal(job, customer || undefined)
      if (syncResult.contactId && customer?.id && syncResult.contactId !== customer.hubspot_contact_id) {
        await updateCustomerHubSpotId(customer.id, syncResult.contactId)
      }
      if (syncResult.dealId && job.id && syncResult.dealId !== job.hubspot_deal_id) {
        await updateJobHubSpotId(job.id, syncResult.dealId)
      }
    } catch (syncError) {
      console.error('HubSpot job sync error:', syncError)
    }
  }
  return job
}

/**
 * Update job and notify assigned cleaner of important field changes
 * This wrapper function:
 * 1. Fetches the old job state
 * 2. Calls updateJob to perform the update
 * 3. Detects which important fields changed
 * 4. Notifies the assigned cleaner via SMS if changes were made
 */
export async function updateJobWithNotifications(
  jobId: string,
  updates: Partial<Job>,
  options: HubSpotSyncOptions = {}
): Promise<Job | null> {
  // 1. Fetch old job state for comparison
  const oldJob = await getJobById(jobId)
  if (!oldJob) {
    console.error('updateJobWithNotifications: Job not found:', jobId)
    return null
  }

  // 2. Perform the update
  const updatedJob = await updateJob(jobId, updates, options)
  if (!updatedJob) {
    console.error('updateJobWithNotifications: Update failed for job:', jobId)
    return null
  }

  // 3. Detect changes in important fields
  const changes: JobChange[] = []
  const importantFields: Array<keyof Job> = [
    'address',
    'bedrooms',
    'bathrooms',
    'square_footage',
    'date',
    'scheduled_at',
  ]

  for (const field of importantFields) {
    if (updates[field] !== undefined && oldJob[field] !== updates[field]) {
      changes.push({
        field: field as JobChange['field'],
        oldValue: oldJob[field] as string | number | null,
        newValue: updates[field] as string | number | null,
      })
    }
  }

  // 4. If no changes to important fields, return early
  if (changes.length === 0) {
    return updatedJob
  }

  // 5. Get assigned cleaner (accepted or confirmed status)
  const assignment = await getAcceptedAssignmentForJob(jobId)
  if (!assignment) {
    // No assigned cleaner to notify
    return updatedJob
  }

  const cleaner = await getCleanerById(assignment.cleaner_id)
  if (!cleaner?.phone) {
    // Cleaner doesn't have phone configured
    return updatedJob
  }

  // 6. Notify cleaner of changes
  try {
    const jobTenantId = (updatedJob as any).tenant_id
    const tenant = jobTenantId ? await getTenantById(jobTenantId) : null
    if (!tenant) {
      console.warn('updateJobWithNotifications: No tenant found for job, skipping cleaner notification')
      return updatedJob
    }

    await notifyJobDetailsChange(tenant, cleaner, updatedJob, changes.map(c => ({
      field: String(c.field),
      oldValue: String(c.oldValue ?? ''),
      newValue: String(c.newValue ?? ''),
    })))

    // 7. Log the event
    await logSystemEvent({
      source: 'job_updates',
      event_type: 'JOB_DETAILS_CHANGED',
      message: `Job ${jobId} details changed, cleaner ${cleaner.name} notified`,
      job_id: jobId,
      customer_id: updatedJob.customer_id,
      phone_number: updatedJob.phone_number,
      metadata: {
        changes: changes.map(c => ({
          field: c.field,
          old: c.oldValue,
          new: c.newValue,
        })),
        cleaner_id: cleaner.id,
        cleaner_name: cleaner.name,
      },
    })
  } catch (error) {
    console.error('updateJobWithNotifications: Error notifying cleaner:', error)
    // Don't fail the whole update if notification fails
  }

  return updatedJob
}

export async function getJobsByPhone(phoneNumber: string, userId?: number): Promise<Job[]> {
  const client = getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for job lookup:', phoneNumber)
    return []
  }

  let query = client
    .from('jobs')
    .select('*')
    .eq('phone_number', dbPhone)
    .order('created_at', { ascending: false })

  if (userId) {
    query = query.eq('user_id', userId)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching jobs:', error)
    return []
  }
  return data || []
}

export async function getJobById(jobId: string, overrideClient?: SupabaseClient): Promise<Job | null> {
  const client = overrideClient || getSupabaseClient()

  const { data, error } = await client
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single()

  if (error) {
    console.error('Error fetching job:', error)
    return null
  }
  return data
}

export async function getJobByStripeInvoiceId(invoiceId: string): Promise<Job | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('jobs')
    .select('*')
    .eq('stripe_invoice_id', invoiceId)
    .single()

  if (error) {
    console.error('Error fetching job by invoice:', error)
    return null
  }
  return data
}

export async function getAllJobs(userId?: number, overrideClient?: SupabaseClient): Promise<Job[]> {
  const client = overrideClient || getSupabaseClient()

  let query = client
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })

  if (userId) {
    query = query.eq('user_id', userId)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching all jobs:', error)
    return []
  }

  return data || []
}

// Cleaner operations
export async function getCleaners(userId?: number, tenantId?: string): Promise<Cleaner[]> {
  const client = getSupabaseClient()

  let query = client
    .from('cleaners')
    .select('*')
    .eq('active', true)
    .is('deleted_at', null)

  if (userId) {
    query = query.eq('user_id', userId)
  }

  if (tenantId) {
    query = query.eq('tenant_id', tenantId)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching cleaners:', error)
    return []
  }
  return data || []
}

// Alias for dashboard compatibility
export const getActiveCleaners = getCleaners

export async function getCleanersByType(
  employeeType: 'technician' | 'salesman',
  tenantId?: string
): Promise<Cleaner[]> {
  const client = getSupabaseClient()
  let query = client
    .from('cleaners')
    .select('*')
    .eq('active', true)
    .is('deleted_at', null)
    .eq('employee_type', employeeType)

  if (tenantId) {
    query = query.eq('tenant_id', tenantId)
  }

  const { data, error } = await query
  if (error) {
    console.error('Error fetching cleaners by type:', error)
    return []
  }
  return data || []
}

export async function getCleanerBlockedDates(
  cleanerId: string | number,
  startDate: string,
  endDate: string
): Promise<Array<{ date: string; reason?: string }>> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_blocked_dates')
    .select('*')
    .eq('cleaner_id', String(cleanerId))
    .gte('date', startDate)
    .lte('date', endDate)

  if (error) {
    console.error('Error fetching blocked dates:', error)
    return []
  }
  return data || []
}

export async function getCleanerById(cleanerId: string): Promise<Cleaner | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaners')
    .select('*')
    .eq('id', cleanerId)
    .is('deleted_at', null)
    .single()

  if (error) {
    console.error('Error fetching cleaner:', error)
    return null
  }
  return data
}

export async function getCleanerByTelegramId(telegramId: string): Promise<Cleaner | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaners')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('active', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) {
    console.error('Error fetching cleaner by telegram id:', error)
    return null
  }

  if (!data || data.length === 0) {
    return null
  }

  if (data.length > 1) {
    console.warn('Multiple cleaners found for telegram id:', telegramId)
  }

  return data[0]
}

export async function upsertCleanerByTelegramId(
  telegramId: string,
  data: Partial<Cleaner>
): Promise<Cleaner | null> {
  const existing = await getCleanerByTelegramId(telegramId)
  if (existing?.id) {
    return await updateCleaner(existing.id, data)
  }

  const client = getSupabaseClient()
  const { data: cleaner, error } = await client
    .from('cleaners')
    .insert({
      ...data,
      telegram_id: telegramId,
    })
    .select()
    .single()

  if (error) {
    console.error('Error inserting cleaner by telegram id:', error)
    return null
  }

  return cleaner
}

export async function updateCleaner(
  cleanerId: string,
  data: Partial<Cleaner>
): Promise<Cleaner | null> {
  const client = getSupabaseClient()

  const { data: cleaner, error } = await client
    .from('cleaners')
    .update(data)
    .eq('id', cleanerId)
    .select()
    .single()

  if (error) {
    console.error('Error updating cleaner:', error)
    return null
  }

  return cleaner
}

/**
 * Check if a cleaner is available based on their availability JSONB rules
 * This function checks both:
 * 1. If cleaner has availability rules that allow work at the requested time
 * 2. If cleaner is not already assigned to another job at that time
 */
function isCleanerAvailableByRules(
  cleaner: Cleaner,
  jobDate: string,
  jobTime?: string
): boolean {
  // If no availability rules set, assume available (backward compatibility)
  if (!cleaner.availability || typeof cleaner.availability !== 'object') {
    return true
  }

  const availability = cleaner.availability as {
    tz?: string
    rules?: Array<{ days: string[]; start: string; end: string }>
    is24_7?: boolean
  }

  // If marked as 24/7, always available
  if (availability.is24_7 === true) {
    return true
  }

  // If no rules, assume available
  if (!availability.rules || availability.rules.length === 0) {
    return true
  }

  // Parse the job date to get day of week
  const jobDateObj = new Date(jobDate + 'T12:00:00')
  const dayOfWeek = jobDateObj.getDay() // 0 = Sunday, 1 = Monday, etc.
  
  // Map to 2-letter day codes
  const dayMap: Record<number, string> = {
    0: 'SU',
    1: 'MO',
    2: 'TU',
    3: 'WE',
    4: 'TH',
    5: 'FR',
    6: 'SA',
  }
  const jobDay = dayMap[dayOfWeek]

  // Find a rule that matches the day
  const matchingRule = availability.rules.find(rule => 
    rule.days && Array.isArray(rule.days) && rule.days.includes(jobDay)
  )

  if (!matchingRule) {
    // No rule for this day, cleaner not available
    return false
  }

  // If no time specified, just check day availability
  if (!jobTime) {
    return true
  }

  // Parse time (format: "HH:MM" or "HH:MM:SS")
  const timeParts = jobTime.split(':')
  const jobHour = parseInt(timeParts[0])
  const jobMinute = parseInt(timeParts[1])
  const jobMinutes = jobHour * 60 + jobMinute

  // Parse rule start/end times (format: "HH:MM")
  const startParts = matchingRule.start.split(':')
  const endParts = matchingRule.end.split(':')
  const startMinutes = parseInt(startParts[0]) * 60 + parseInt(startParts[1])
  const endMinutes = parseInt(endParts[0]) * 60 + parseInt(endParts[1])

  // Check if job time falls within the rule's time window
  return jobMinutes >= startMinutes && jobMinutes <= endMinutes
}

export async function getCleanerAvailability(date: string, jobTime?: string, tenantId?: string): Promise<Cleaner[]> {
  // Tenant isolation guard: without tenantId, this returns ALL tenants' cleaners
  if (!tenantId) {
    console.error('[getCleanerAvailability] WARN: tenantId not provided — returning empty to prevent cross-tenant leakage')
    return []
  }

  // Get active cleaners (scoped to tenant if provided)
  const cleaners = await getCleaners(undefined, tenantId)

  // Get jobs scheduled for that date (scoped to tenant if provided)
  const client = getSupabaseClient()
  let jobQuery = client
    .from('jobs')
    .select('*')
    .eq('date', date)
    .not('status', 'in', '("cancelled","completed")')
  if (tenantId) {
    jobQuery = jobQuery.eq('tenant_id', tenantId)
  }
  const { data: scheduledJobs } = await jobQuery

  // Get cleaner assignments for those jobs
  const jobIds = (scheduledJobs || []).map(j => j.id)

  if (jobIds.length === 0) {
    // No jobs on this date, filter by availability rules only
    return cleaners.filter(c => isCleanerAvailableByRules(c, date, jobTime))
  }

  const { data: assignments } = await client
    .from('cleaner_assignments')
    .select('cleaner_id')
    .in('job_id', jobIds)
    .in('status', ['accepted', 'confirmed']) // Only consider accepted/confirmed as "busy"

  const busyCleanerIds = new Set((assignments || []).map(a => a.cleaner_id))

  // Return cleaners that:
  // 1. Are not assigned to jobs on that date
  // 2. Have availability rules that allow work at the requested time
  return cleaners.filter(c => 
    !busyCleanerIds.has(c.id) && isCleanerAvailableByRules(c, date, jobTime)
  )
}

// Cleaner assignment operations
export async function createCleanerAssignment(
  jobId: string,
  cleanerId: string
): Promise<CleanerAssignment | null> {
  const client = getSupabaseClient()

  // Get tenant_id from the job
  const { data: job } = await client
    .from('jobs')
    .select('tenant_id')
    .eq('id', jobId)
    .single()

  if (!job?.tenant_id) {
    console.error('Error creating assignment: could not resolve tenant_id for job', jobId)
    return null
  }

  // Cross-tenant validation: cleaner must belong to the same tenant as the job
  const { data: cleaner } = await client
    .from('cleaners')
    .select('tenant_id')
    .eq('id', cleanerId)
    .single()

  if (!cleaner || cleaner.tenant_id !== job.tenant_id) {
    console.error(`createCleanerAssignment: cleaner ${cleanerId} (tenant=${cleaner?.tenant_id}) does not belong to job tenant ${job.tenant_id}`)
    return null
  }

  const { data, error } = await client
    .from('cleaner_assignments')
    .insert({
      tenant_id: job.tenant_id,
      job_id: jobId,
      cleaner_id: cleanerId,
      status: 'pending',
      created_at: new Date().toISOString()
    })
    .select()
    .single()

  if (error) {
    console.error('Error creating assignment:', error)
    return null
  }
  return data
}

export async function getCleanerAssignmentsForJob(
  jobId: string
): Promise<CleanerAssignment[]> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_assignments')
    .select('*')
    .eq('job_id', jobId)

  if (error) {
    console.error('Error fetching assignments for job:', error)
    return []
  }

  return data || []
}

export async function getCleanerAssignmentsForCleaner(
  cleanerId: string,
  statuses?: Array<CleanerAssignment['status']>
): Promise<CleanerAssignment[]> {
  const client = getSupabaseClient()
  let query = client
    .from('cleaner_assignments')
    .select('*')
    .eq('cleaner_id', cleanerId)

  if (statuses && statuses.length > 0) {
    query = query.in('status', statuses)
  }

  const { data, error } = await query.order('created_at', { ascending: false })

  if (error) {
    console.error('Error fetching assignments for cleaner:', error)
    return []
  }

  return data || []
}

export async function getJobsByIds(jobIds: string[]): Promise<Job[]> {
  const client = getSupabaseClient()
  if (jobIds.length === 0) return []

  const { data, error } = await client
    .from('jobs')
    .select('*')
    .in('id', jobIds)

  if (error) {
    console.error('Error fetching jobs by ids:', error)
    return []
  }

  return data || []
}

export async function getCleanerAssignmentById(
  assignmentId: string
): Promise<CleanerAssignment | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_assignments')
    .select('*')
    .eq('id', assignmentId)
    .single()

  if (error) {
    console.error('Error fetching assignment:', error)
    return null
  }

  return data
}

export async function updateCleanerAssignment(
  assignmentId: string,
  status: 'pending' | 'accepted' | 'declined' | 'confirmed' | 'cancelled'
): Promise<CleanerAssignment | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_assignments')
    .update({ status })
    .eq('id', assignmentId)
    .select()
    .single()

  if (error) {
    console.error('Error updating assignment:', error)
    return null
  }

  return data
}

export async function updateCleanerAssignmentFields(
  assignmentId: string,
  updates: Partial<CleanerAssignment>
): Promise<CleanerAssignment | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_assignments')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', assignmentId)
    .select()
    .single()

  if (error) {
    console.error('Error updating assignment fields:', error)
    return null
  }

  return data
}

export async function getPendingAssignmentsForJob(
  jobId: string
): Promise<CleanerAssignment[]> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_assignments')
    .select('*')
    .eq('job_id', jobId)
    .eq('status', 'pending')

  if (error) {
    console.error('Error fetching pending assignments:', error)
    return []
  }

  return data || []
}

export async function getAcceptedAssignmentForJob(
  jobId: string
): Promise<CleanerAssignment | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('cleaner_assignments')
    .select('*')
    .eq('job_id', jobId)
    .in('status', ['accepted', 'confirmed'])
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    console.error('Error fetching accepted assignment:', error)
    return null
  }

  return data
}

// Call operations
export async function createCall(callData: Partial<Call>): Promise<Call | null> {
  const client = getSupabaseClient()
  const dbPhone = toE164(callData.phone_number)

  if (!dbPhone) {
    console.error('Invalid phone number for call record:', callData.phone_number)
    return null
  }

  const durationSeconds = normalizeCallDuration(callData.duration_seconds)

  const { data, error } = await client
    .from('calls')
    .insert({
      ...callData,
      phone_number: dbPhone,
      duration_seconds: durationSeconds,
      created_at: new Date().toISOString()
    })
    .select()
    .single()

  if (error) {
    console.error('Error creating call record:', error)
    return null
  }
  return data
}

export async function upsertCallEvent(callData: Partial<Call>): Promise<Call | null> {
  const client = getSupabaseClient()
  const primaryPhone = toE164(callData.phone_number) || toE164(callData.from_number)

  if (!primaryPhone) {
    console.error('Invalid phone number for call upsert:', callData.phone_number || callData.from_number)
    return null
  }

  const payload: Partial<Call> & { phone_number: string } = {
    ...callData,
    phone_number: primaryPhone,
    created_at: callData.created_at || new Date().toISOString(),
    duration_seconds: normalizeCallDuration(callData.duration_seconds),
  }

  const fromE164 = callData.from_number ? toE164(callData.from_number) : ''
  if (fromE164) {
    payload.from_number = fromE164
  }

  const toE164Value = callData.to_number ? toE164(callData.to_number) : ''
  if (toE164Value) {
    payload.to_number = toE164Value
  }

  const conflictTarget = callData.provider_call_id
    ? 'provider_call_id'
    : callData.vapi_call_id
      ? 'vapi_call_id'
      : null

  if (!conflictTarget) {
    const { data, error } = await client
      .from('calls')
      .insert(payload)
      .select()
      .single()

    if (error) {
      console.error('Error inserting call record:', error)
      return null
    }
    return data
  }

  const { data, error } = await client
    .from('calls')
    .upsert(payload, { onConflict: conflictTarget })
    .select()
    .single()

  if (error) {
    console.error('Error upserting call record:', error)
    const fallbackPayload: Partial<Call> & { phone_number: string } = {
      phone_number: primaryPhone,
      date: (callData.started_at || callData.date || callData.created_at) as string | undefined,
      duration_seconds: normalizeCallDuration(callData.duration_seconds),
      audio_url: callData.audio_url,
      outcome: callData.outcome,
    }

    const { data: fallback, error: fallbackError } = await client
      .from('calls')
      .insert(fallbackPayload)
      .select()
      .single()

    if (fallbackError) {
      console.error('Error inserting call record fallback:', fallbackError)
      return null
    }

    return fallback
  }
  return data
}

function normalizeCallDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    if (!Number.isNaN(parsed)) {
      return Math.round(parsed)
    }
  }
  return undefined
}

// ===========================================
// GHL Lead Operations (Meta Ads Integration)
// ===========================================

export interface GHLLead {
  id?: string
  tenant_id?: string
  source_id: string
  ghl_location_id?: string
  phone_number: string
  customer_id?: string
  job_id?: string
  converted_to_job_id?: string
  first_name?: string
  last_name?: string
  email?: string
  source?: string
  ad_campaign?: string
  ad_set?: string
  ad_name?: string
  form_data?: Record<string, unknown>
  brand?: string
  status?: string
  last_customer_response_at?: string
  last_outreach_at?: string
  next_followup_at?: string
  call_attempt_count?: number
  sms_attempt_count?: number
  created_at?: string
  updated_at?: string
}

export interface GHLFollowUp {
  id?: string
  lead_id: string
  phone_number: string
  followup_type: string
  scheduled_at: string
  executed_at?: string
  status?: string
  result?: Record<string, unknown>
  error_message?: string
  created_at?: string
}

export async function createGHLLead(leadData: Partial<GHLLead>, userId?: number): Promise<GHLLead | null> {
  const client = getSupabaseClient()
  const dbPhone = toE164(leadData.phone_number)

  if (!dbPhone) {
    console.error('Invalid phone number for GHL lead:', leadData.phone_number)
    return null
  }

  const { data, error } = await client
    .from('leads')
    .insert({
      ...leadData,
      user_id: userId,
      phone_number: dbPhone,
      status: leadData.status || 'new',
      call_attempt_count: leadData.call_attempt_count ?? 0,
      sms_attempt_count: leadData.sms_attempt_count ?? 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error('Error creating GHL lead:', error)
    return null
  }
  return data
}

export async function getGHLLeadByContactId(ghlContactId: string): Promise<GHLLead | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('leads')
    .select('*')
    .eq('source_id', ghlContactId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    console.error('Error fetching GHL lead by contact ID:', error)
    return null
  }
  return data
}

export async function getGHLLeadByPhone(phoneNumber: string): Promise<GHLLead | null> {
  const client = getSupabaseClient()
  const dbPhone = toE164(phoneNumber)

  if (!dbPhone) {
    console.error('Invalid phone number for GHL lead lookup:', phoneNumber)
    return null
  }

  const { data, error } = await client
    .from('leads')
    .select('*')
    .eq('phone_number', dbPhone)
    .not('status', 'in', '("booked","lost","unqualified")')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    console.error('Error fetching GHL lead by phone:', error)
    return null
  }
  return data
}

export async function getGHLLeadById(leadId: string): Promise<GHLLead | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    console.error('Error fetching GHL lead by ID:', error)
    return null
  }
  return data
}

export async function updateGHLLead(
  leadId: string,
  updates: Partial<GHLLead>
): Promise<GHLLead | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('leads')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)
    .select()
    .single()

  if (error) {
    console.error('Error updating GHL lead:', error)
    return null
  }
  return data
}

export async function getActiveGHLLeads(userId?: number): Promise<GHLLead[]> {
  const client = getSupabaseClient()

  let query = client
    .from('leads')
    .select('*')
    .not('status', 'in', '("booked","lost","unqualified")')
    .order('created_at', { ascending: false })

  if (userId) {
    query = query.eq('user_id', userId)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching active GHL leads:', error)
    return []
  }
  return data || []
}

// GHL Follow-up Queue Operations

export async function createGHLFollowUp(followUpData: Partial<GHLFollowUp>): Promise<GHLFollowUp | null> {
  const client = getSupabaseClient()
  const dbPhone = toE164(followUpData.phone_number)

  if (!dbPhone) {
    console.error('Invalid phone number for follow-up:', followUpData.phone_number)
    return null
  }

  const { data, error } = await client
    .from('followup_queue')
    .insert({
      ...followUpData,
      phone_number: dbPhone,
      status: followUpData.status || 'pending',
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error('Error creating GHL follow-up:', error)
    return null
  }
  return data
}

export async function getPendingGHLFollowUps(beforeTime?: Date): Promise<GHLFollowUp[]> {
  const client = getSupabaseClient()
  const cutoff = beforeTime || new Date()

  const { data, error } = await client
    .from('followup_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', cutoff.toISOString())
    .order('scheduled_at', { ascending: true })

  if (error) {
    console.error('Error fetching pending follow-ups:', error)
    return []
  }
  return data || []
}

export async function updateGHLFollowUp(
  followUpId: string,
  updates: Partial<GHLFollowUp>
): Promise<GHLFollowUp | null> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('followup_queue')
    .update(updates)
    .eq('id', followUpId)
    .select()
    .single()

  if (error) {
    console.error('Error updating GHL follow-up:', error)
    return null
  }
  return data
}

export async function cancelPendingGHLFollowUps(
  ghlLeadId: string,
  followUpTypes?: string[]
): Promise<number> {
  const client = getSupabaseClient()

  let query = client
    .from('followup_queue')
    .update({ status: 'cancelled' })
    .eq('lead_id', ghlLeadId)
    .eq('status', 'pending')

  if (followUpTypes && followUpTypes.length > 0) {
    query = query.in('followup_type', followUpTypes)
  }

  const { data, error } = await query.select()

  if (error) {
    console.error('Error cancelling follow-ups:', error)
    return 0
  }
  return data?.length || 0
}

export async function getGHLLeadsNeedingFollowUp(silenceThresholdMs: number): Promise<GHLLead[]> {
  const client = getSupabaseClient()
  const cutoffTime = new Date(Date.now() - silenceThresholdMs).toISOString()

  const { data, error } = await client
    .from('leads')
    .select('*')
    .in('status', ['contacted', 'qualified'])
    .or(`last_contact_at.lt.${cutoffTime},last_contact_at.is.null`)
    .order('last_contact_at', { ascending: true })

  if (error) {
    console.error('Error fetching leads needing follow-up:', error)
    return []
  }
  return data || []
}

// ==================== Reminder Notification Tracking ====================

/**
 * Check if a specific reminder has already been sent
 */
export async function hasReminderBeenSent(
  assignmentId: string,
  reminderType: 'daily_8am' | 'one_hour_before' | 'job_start' | 'evening_before' | 'morning_schedule',
  jobDate: string
): Promise<boolean> {
  const client = getSupabaseClient()

  const { data, error } = await client
    .from('reminder_notifications')
    .select('id')
    .eq('cleaner_assignment_id', assignmentId)
    .eq('reminder_type', reminderType)
    .eq('job_date', jobDate)
    .limit(1)
    .single()

  if (error && error.code !== 'PGRST116') {
    // PGRST116 is "not found" which is fine
    console.error('Error checking if reminder was sent:', error)
  }

  return !!data
}

/**
 * Mark a reminder as sent to prevent duplicates
 */
export async function markReminderSent(
  assignmentId: string,
  reminderType: 'daily_8am' | 'one_hour_before' | 'job_start' | 'evening_before' | 'morning_schedule',
  jobDate: string,
  jobTime?: string
): Promise<void> {
  const client = getSupabaseClient()

  const { error } = await client
    .from('reminder_notifications')
    .insert({
      cleaner_assignment_id: assignmentId,
      reminder_type: reminderType,
      job_date: jobDate,
      job_time: jobTime || null,
    })

  if (error) {
    console.error('Error marking reminder as sent:', error)
  }
}

/**
 * Get all jobs for a specific cleaner on a specific date
 */
export async function getCleanerJobsForDate(
  cleanerId: string,
  date: string,
  statuses: Array<'accepted' | 'confirmed'> = ['accepted', 'confirmed']
): Promise<Array<{ job: Job; assignment: CleanerAssignment; customer?: Customer }>> {
  const client = getSupabaseClient()

  const { data: assignments, error } = await client
    .from('cleaner_assignments')
    .select(`
      *,
      jobs!inner (
        *
      )
    `)
    .eq('cleaner_id', cleanerId)
    .in('status', statuses)
    .eq('jobs.date', date)

  if (error) {
    console.error('Error fetching cleaner jobs for date:', error)
    return []
  }

  const results = []
  for (const assignment of assignments || []) {
    const job = assignment.jobs as unknown as Job
    const customer = job.phone_number
      ? await getCustomerByPhone(job.phone_number)
      : undefined

    results.push({
      job,
      assignment,
      customer: customer || undefined,
    })
  }

  return results
}

/**
 * Get all jobs starting within a specific time window (in minutes)
 * @param minutesBefore - Negative number for past times (e.g., -75 for 75 min in future)
 * @param minutesAfter - Negative number for past times (e.g., -45 for 45 min in future)
 */
export async function getJobsStartingSoon(
  minutesBefore: number,
  minutesAfter: number = 0,
  timezone: string = 'America/Los_Angeles'
): Promise<Array<{ job: Job; assignment: CleanerAssignment; cleaner: Cleaner; customer?: Customer }>> {
  const client = getSupabaseClient()
  const now = new Date()

  // Get today's date in the specified timezone
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  // Get current time in the specified timezone
  const timeLocal = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  // Calculate time window
  const nowMinutes = parseInt(timeLocal.split(':')[0]) * 60 + parseInt(timeLocal.split(':')[1])
  const startMinutes = nowMinutes + minutesBefore
  const endMinutes = nowMinutes + minutesAfter

  // Query jobs for today
  const { data: jobs, error } = await client
    .from('jobs')
    .select('*')
    .eq('date', todayLocal)
    .not('status', 'eq', 'cancelled')

  if (error) {
    console.error('Error fetching jobs starting soon:', error)
    return []
  }

  const results = []
  for (const job of jobs || []) {
    if (!job.scheduled_at) continue

    // Parse job time (format: "HH:MM" or "HH:MM:SS" or "H:MM AM/PM")
    let jobMinutes: number
    const ampmMatch = job.scheduled_at.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
    if (ampmMatch) {
      let h = parseInt(ampmMatch[1])
      const m = parseInt(ampmMatch[2])
      const period = ampmMatch[3].toUpperCase()
      if (period === 'PM' && h !== 12) h += 12
      if (period === 'AM' && h === 12) h = 0
      jobMinutes = h * 60 + m
    } else {
      const jobTimeParts = job.scheduled_at.split(':')
      jobMinutes = parseInt(jobTimeParts[0]) * 60 + parseInt(jobTimeParts[1])
    }

    // Check if job is in the time window
    if (jobMinutes >= startMinutes && jobMinutes <= endMinutes) {
      // Get accepted assignment
      const { data: assignment } = await client
        .from('cleaner_assignments')
        .select('*')
        .eq('job_id', job.id)
        .in('status', ['accepted', 'confirmed'])
        .limit(1)
        .single()

      if (assignment) {
        const cleaner = await getCleanerById(String(assignment.cleaner_id))
        const customer = await getCustomerByPhone(job.phone_number)

        if (cleaner) {
          results.push({
            job,
            assignment,
            cleaner,
            customer: customer || undefined,
          })
        }
      }
    }
  }

  return results
}

// Dashboard compatibility functions
export async function getCustomerContext(customerId: number): Promise<{
  customer: Customer | null
  jobs: Job[]
  calls: Call[]
  messages: Message[]
}> {
  const client = getSupabaseClient()
  const [customerResult, jobsResult, callsResult, messagesResult] = await Promise.all([
    client.from('customers').select('*').eq('id', customerId).single(),
    client.from('jobs').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(10),
    client.from('calls').select('*').eq('customer_id', customerId).order('date', { ascending: false }).limit(5),
    client.from('messages').select('*').eq('customer_id', customerId).order('timestamp', { ascending: false }).limit(20),
  ])

  return {
    customer: customerResult.data as Customer | null,
    jobs: (jobsResult.data || []) as Job[],
    calls: (callsResult.data || []) as Call[],
    messages: (messagesResult.data || []) as Message[],
  }
}

export async function logAutomationEvent(log: {
  event_type: string
  source: string
  customer_id?: number | string
  job_id?: number | string
  payload?: Record<string, unknown>
  result?: Record<string, unknown>
  success?: boolean
  error_message?: string
}) {
  const client = getSupabaseClient()
  const { data, error } = await client
    .from('automation_logs')
    .insert({
      ...log,
      customer_id: log.customer_id ? String(log.customer_id) : undefined,
      job_id: log.job_id ? String(log.job_id) : undefined,
    })
    .select()
    .single()

  if (error) {
    console.error('Failed to log automation event:', error)
  }
  return data
}
