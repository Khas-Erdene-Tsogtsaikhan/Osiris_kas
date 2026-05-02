/**
 * Stripe Integration - Invoice creation and payment handling
 */

import Stripe from 'stripe'
import { Job, Customer } from './supabase'
import { toE164 } from './phone-utils'
import { getClientConfig } from './client-config'
import { getApiKey } from './user-api-keys'
import {
  PRICING_TABLE,
  type PricingRow,
  type PricingTier,
  type AddOnKey,
  getAddOnDefinition,
  getAddOnLabel,
  getAddOnsFromNotes,
  getOverridesFromNotes,
} from './pricing-config'
import {
  getPricingTiers,
  getPricingAddons,
  getPricingRow as getPricingRowFromDb,
  type PricingRow as DbPricingRow,
  type PricingAddon as DbPricingAddon,
} from './pricing-db'

// Initialize Stripe client
function getStripeClient(): Stripe {
  const rawKey = getApiKey('stripeSecretKey')
  const secretKey = rawKey ? rawKey.replace(/[\r\n]/g, '').trim() : ''

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured')
  }

  return new Stripe(secretKey, {
    apiVersion: '2025-02-24.acacia',
  })
}

/**
 * Create a Stripe client using a specific secret key (for multi-tenant).
 * NEVER falls back to env var — throws if no key provided.
 * This prevents cross-tenant charge contamination.
 */
export function getStripeClientForTenant(stripeSecretKey: string): Stripe {
  const secretKey = stripeSecretKey?.replace(/[\r\n]/g, '').trim()
  if (!secretKey) {
    throw new Error('[Stripe] CRITICAL: No tenant Stripe key provided. Set stripe_secret_key on the tenant. Refusing to fall back to default key to prevent cross-tenant charges.')
  }
  return new Stripe(secretKey, { apiVersion: '2025-02-24.acacia' })
}

/** Map currency code to Stripe country code */
const CURRENCY_TO_COUNTRY: Record<string, string> = {
  cad: 'CA',
  usd: 'US',
}

/** Best-effort country inference from address string (Ontario, ON, Canada → CA) */
function inferCountryFromAddress(address?: string | null): string | null {
  if (!address) return null
  const lower = address.toLowerCase()
  if (/\b(ontario|on|canada|alberta|ab|british columbia|bc|quebec|qc|manitoba|mb|saskatchewan|sk|nova scotia|ns|new brunswick|nb|pei|pe|newfoundland|nl|yukon|yt|nwt|nt|nunavut|nu)\b/.test(lower)) {
    return 'CA'
  }
  return null
}

/** Resolve Stripe country from tenant currency */
export function currencyToCountry(currency?: string | null): string {
  return CURRENCY_TO_COUNTRY[(currency || 'usd').toLowerCase()] || 'US'
}

function getClientDomain(): string {
  const domain = getClientConfig().domain
  return domain.endsWith('/') ? domain.slice(0, -1) : domain
}

/**
 * Get redirect domain for a tenant (Stripe success/cancel URLs).
 * Prefers tenant.website_url, falls back to deployment URL.
 */
export async function getTenantRedirectDomain(tenantId?: string): Promise<string> {
  if (tenantId) {
    const { getTenantById } = await import('./tenant')
    const tenant = await getTenantById(tenantId)
    if (tenant?.website_url) {
      return tenant.website_url.replace(/\/+$/, '')
    }
  }
  return getClientDomain()
}

type StripePaymentType = 'DEPOSIT' | 'ADDON' | 'FINAL' | 'CUSTOM' | 'AUTO_CHARGE' | 'CANCELLATION_FEE'

function resolveStripeTestChargeCents(): number | null {
  if (process.env.ENABLE_STRIPE_TEST_CHARGES !== 'true') {
    return null
  }

  const raw = process.env.STRIPE_TEST_CHARGE_CENTS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn('ENABLE_STRIPE_TEST_CHARGES is true but STRIPE_TEST_CHARGE_CENTS is invalid; using default.')
    return null
  }

  return Math.round(parsed)
}

export function resolveStripeChargeCents(
  defaultCents: number,
  paymentType: StripePaymentType
): { amountCents: number; testChargeCents?: number } {
  const testChargeCents = resolveStripeTestChargeCents()
  if (!testChargeCents) {
    return { amountCents: defaultCents }
  }

  console.warn(`[Stripe] Test charge override active (${paymentType}): ${testChargeCents} cents`)
  return { amountCents: testChargeCents, testChargeCents }
}

// Strip control chars / zero-width unicode and normalize. Stripe's customers.create
// rejects emails with hidden whitespace ("Invalid email address") even though
// customers.list happily searches with them — that mismatch is what produced the
// "lookup failed → create failed" error chain on a visually-valid address.
function sanitizeEmailForStripe(email?: string | null): string | undefined {
  if (!email) return undefined
  const cleaned = Array.from(String(email))
    .filter((char) => {
      const code = char.charCodeAt(0)
      if (code <= 0x20) return false
      if (code === 0x7f) return false
      if (code >= 0x80 && code <= 0x9f) return false
      if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return false
      return true
    })
    .join('')
    .toLowerCase()
  if (!cleaned) return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return undefined
  return cleaned
}

/**
 * Create a Stripe customer
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function createStripeCustomer(
  customer: Partial<Customer>,
  stripeSecretKey: string,
  country?: string
): Promise<Stripe.Customer> {
  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)

    const normalizedPhone = toE164(customer.phone_number)
    const resolvedCountry = country || inferCountryFromAddress(customer.address) || 'US'
    const cleanEmail = sanitizeEmailForStripe(customer.email)
    if (customer.email && !cleanEmail) {
      console.warn(`[Stripe] Dropping malformed email on customer create: ${JSON.stringify(customer.email)}`)
    }
    const stripeCustomer = await stripe.customers.create({
      email: cleanEmail,
      phone: normalizedPhone || undefined,
      name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || undefined,
      address: customer.address
        ? {
            line1: customer.address,
            country: resolvedCountry,
          }
        : undefined,
      metadata: {
        supabase_customer_id: customer.id || '',
        phone_number: customer.phone_number || '',
      },
    })

    console.log(`Created Stripe customer: ${stripeCustomer.id}`)
    return stripeCustomer
  } catch (error) {
    console.error('Error creating Stripe customer:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`Stripe customer create failed: ${message}`)
  }
}

/**
 * Find or create a Stripe customer by email
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function findOrCreateStripeCustomer(
  customer: Partial<Customer>,
  stripeSecretKey: string
): Promise<Stripe.Customer> {
  if (!customer.email) {
    throw new Error('Cannot create Stripe customer without email')
  }

  const cleanEmail = sanitizeEmailForStripe(customer.email)
  if (!cleanEmail) {
    console.warn(`[Stripe] findOrCreateStripeCustomer: email failed sanitization, creating without email. Raw: ${JSON.stringify(customer.email)}`)
    return await createStripeCustomer({ ...customer, email: undefined }, stripeSecretKey)
  }

  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)

    // Search for existing customer by email
    const existingCustomers = await stripe.customers.list({
      email: cleanEmail,
      limit: 1,
    })

    if (existingCustomers.data.length > 0) {
      console.log(`Found existing Stripe customer: ${existingCustomers.data[0].id}`)
      return existingCustomers.data[0]
    }

    // Create new customer (with sanitized email)
    return await createStripeCustomer({ ...customer, email: cleanEmail }, stripeSecretKey)
  } catch (error) {
    console.error('Error finding/creating Stripe customer:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`Stripe customer lookup failed: ${message}`)
  }
}

/**
 * Create and send an invoice for a job.
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function createAndSendInvoice(
  job: Job,
  customer: Customer,
  stripeSecretKey: string,
  membershipInfo?: { discount: number; planName: string },
  currency: string = 'usd'
): Promise<{ success: boolean; invoiceId?: string; invoiceUrl?: string; error?: string }> {
  currency = currency || 'usd'
  if (!customer.email) {
    return { success: false, error: 'Customer email required for invoice' }
  }

  if (!job.price || job.price <= 0) {
    return { success: false, error: 'Invalid job price' }
  }

  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)
    const domain = await getTenantRedirectDomain((job as any).tenant_id)

    // Find or create Stripe customer (on the same Stripe account)
    const stripeCustomer = await findOrCreateStripeCustomer(customer, stripeSecretKey)

    // Create invoice as informational breakdown (no payment collection — customer pays via deposit link)
    const invoice = await stripe.invoices.create({
      customer: stripeCustomer.id,
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: false, // Don't auto-send emails or auto-charge
      metadata: {
        job_id: job.id || '',
        phone_number: job.phone_number,
        service_type: job.service_type || '',
        informational: 'true',
      },
    })

    // Add line item with rich service description (same format as Wave invoices)
    let description: string
    try {
      const { buildStaticCleaningDescription, buildPropertyLine } = await import('./invoices')
      const summaryParts: string[] = []
      summaryParts.push(`Service: ${job.service_type || 'Cleaning Service'}`)
      if (job.date) {
        const dateObj = new Date(job.date + 'T12:00:00')
        summaryParts.push(`Date: ${dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`)
      }
      if (job.scheduled_at) summaryParts.push(`Time: ${job.scheduled_at}`)
      if (job.address) summaryParts.push(`Address: ${job.address}`)
      const propLine = buildPropertyLine(job as any, customer as any)
      if (propLine) summaryParts.push(propLine)

      const staticDesc = buildStaticCleaningDescription(job as any, customer as any)
      description = summaryParts.join('\n') + '\n\n' + staticDesc + '\n\nGuarantee: If anything is missed, we will return within 24 hours to make it right.'
      // Stripe invoice item descriptions have a 500 character limit
      if (description.length > 500) {
        description = description.slice(0, 497) + '...'
      }
    } catch {
      description = buildInvoiceDescription(job)
    }

    await stripe.invoiceItems.create({
      customer: stripeCustomer.id,
      invoice: invoice.id,
      amount: Math.round(job.price * 100), // Convert to cents
      currency,
      description,
    })

    // Add membership discount line item if applicable
    if (membershipInfo && membershipInfo.discount > 0) {
      await stripe.invoiceItems.create({
        customer: stripeCustomer.id,
        invoice: invoice.id,
        amount: -Math.round(membershipInfo.discount * 100),
        currency,
        description: `${membershipInfo.planName} member discount`,
      })
    }

    // Finalize the invoice to generate hosted page with line-item breakdown
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id)

    // Do NOT mark paid — invoice stays open as a viewable breakdown.
    // Actual payment is collected via card-on-file charge when job completes.

    console.log(`[Stripe] Informational invoice ${finalizedInvoice.id} created for ${customer.email} (open — card charged on completion)`)

    return {
      success: true,
      invoiceId: finalizedInvoice.id,
      invoiceUrl: finalizedInvoice.hosted_invoice_url || undefined,
    }
  } catch (error) {
    console.error('Error creating invoice:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Build invoice description from job details
 */
function buildInvoiceDescription(job: Job): string {
  const parts = [job.service_type || 'Cleaning Service']

  if (job.date) {
    const dateObj = new Date(job.date + 'T12:00:00')
    const formattedDate = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
    parts.push(`on ${formattedDate}`)
  }

  if (job.scheduled_at) {
    parts.push(`at ${job.scheduled_at}`)
  }

  if (job.address) {
    parts.push(`| Address: ${job.address}`)
  }

  if (job.notes) {
    // Clean up internal override notes, keep customer-facing info
    const cleanNotes = job.notes
      .replace(/OVERRIDE:\s*\w+=\d+/g, '')
      .replace(/\n+/g, ', ')
      .trim()
    if (cleanNotes) {
      parts.push(`| Details: ${cleanNotes}`)
    }
  }

  if (job.cleaners && job.cleaners > 1) {
    parts.push(`| ${job.cleaners} cleaners`)
  }

  if (job.hours) {
    parts.push(`| Est. ${job.hours}hrs`)
  }

  return parts.join(' ')
}

/**
 * Validate Stripe webhook signature.
 *
 * Multi-tenant: tries the global STRIPE_WEBHOOK_SECRET env var first,
 * then each tenant's stripe_webhook_secret from the DB.
 * Pass `tenantSecrets` from the webhook route to enable per-tenant fallback.
 */
export function validateStripeWebhook(
  payload: string,
  signature: string | null,
  tenantSecrets?: string[]
): Stripe.Event | null {
  if (!signature) {
    console.error('No Stripe signature provided')
    return null
  }

  // Build ordered list of secrets to try
  const secrets: string[] = []
  const envSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (envSecret) secrets.push(envSecret)
  if (tenantSecrets) {
    for (const s of tenantSecrets) {
      if (s && !secrets.includes(s)) secrets.push(s)
    }
  }

  if (secrets.length === 0) {
    console.error('[Stripe] CRITICAL: No webhook secrets configured — rejecting all webhook calls')
    return null
  }

  const stripe = getStripeClient()
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret)
    } catch {
      // Try next secret
    }
  }

  console.error('Stripe webhook validation failed: no matching secret found')
  return null
}

/**
 * Get invoice details from Stripe
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function getInvoice(invoiceId: string, stripeSecretKey: string): Promise<Stripe.Invoice | null> {
  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)
    return await stripe.invoices.retrieve(invoiceId)
  } catch (error) {
    console.error('Error fetching invoice:', error)
    return null
  }
}

/**
 * Create a setup intent checkout session for card on file
 * Sent after deposit payment succeeds
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function createCardOnFileLink(
  customer: Customer,
  jobId: string,
  tenantId: string,
  stripeSecretKey: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  if (!customer.email) {
    return { success: false, error: 'Customer email required' }
  }

  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)

    // Find or create Stripe customer (on the same Stripe account)
    const stripeCustomer = await findOrCreateStripeCustomer(customer, stripeSecretKey)

    // Create checkout session in setup mode (card on file)
    // Redirect to tenant's website after card is saved
    const cardOnFileRedirect = await getTenantRedirectDomain(tenantId)
    const sessionMetadata = {
      job_id: jobId,
      phone_number: customer.phone_number,
      purpose: 'card_on_file',
    }
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      mode: 'setup',
      payment_method_types: ['card'],
      success_url: cardOnFileRedirect,
      cancel_url: cardOnFileRedirect,
      metadata: sessionMetadata,
      // Propagate metadata to the setup_intent so the setup_intent.succeeded
      // webhook event also has job_id, phone_number, and purpose
      setup_intent_data: {
        metadata: sessionMetadata,
      },
    })

    console.log(`Created card-on-file session: ${session.id}`)

    return {
      success: true,
      url: session.url || undefined,
    }
  } catch (error) {
    console.error('Error creating card-on-file session:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Create a deposit payment link (50% + 3% fee)
 * Per PRD: Deposit amount = (price * 1.03) / 2
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function createDepositPaymentLink(
  customer: Customer,
  job: Job,
  extraMetadata: Record<string, string> | undefined,
  tenantId: string,
  stripeSecretKey: string,
  currency: string = 'usd'
): Promise<{ success: boolean; url?: string; amount?: number; error?: string }> {
  currency = currency || 'usd'
  if (!customer.email) {
    return { success: false, error: 'Customer email required' }
  }

  if (!job.price || job.price <= 0) {
    return { success: false, error: 'Invalid job price' }
  }

  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)
    const domain = await getTenantRedirectDomain(tenantId || (job as any).tenant_id)

    // Find or create Stripe customer (on the same Stripe account)
    const stripeCustomer = await findOrCreateStripeCustomer(customer, stripeSecretKey)

    // Calculate deposit: 50% + 3% fee
    const defaultDepositAmount = Math.round((job.price / 2) * 1.03 * 100) // In cents
    const { amountCents: depositAmountCents, testChargeCents } = resolveStripeChargeCents(
      defaultDepositAmount,
      'DEPOSIT'
    )
    const depositAmount = depositAmountCents / 100

    // Create checkout session for deposit
    const metadata: Record<string, string> = {
      job_id: job.id || '',
      phone_number: job.phone_number,
      payment_type: 'DEPOSIT',
      ...extraMetadata,
    }
    if (testChargeCents) {
      metadata.test_charge_cents = String(testChargeCents)
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `${job.service_type || 'Cleaning'} - DEPOSIT`,
              description: `50% deposit for ${job.service_type || 'cleaning'} service`,
            },
            unit_amount: depositAmountCents,
          },
          quantity: 1,
        },
      ],
      success_url: domain,
      cancel_url: domain,
      metadata,
    })

    console.log(`Created deposit session: ${session.id} for $${depositAmount.toFixed(2)}`)

    return {
      success: true,
      url: session.url || undefined,
      amount: depositAmount,
    }
  } catch (error) {
    console.error('Error creating deposit session:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Create a payment link for any custom dollar amount.
 * Used by the assistant to generate ad-hoc payment links for tenants.
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function createCustomPaymentLink(
  customer: Customer,
  amount: number,
  description: string,
  tenantId: string,
  stripeSecretKey: string,
  jobId?: string,
  currency: string = 'usd'
): Promise<{ success: boolean; url?: string; amount?: number; error?: string }> {
  currency = currency || 'usd'
  if (!customer.email) {
    return { success: false, error: 'Customer email required' }
  }

  if (!amount || amount <= 0) {
    return { success: false, error: 'Amount must be greater than $0' }
  }

  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)
    const domain = await getTenantRedirectDomain(tenantId)
    const stripeCustomer = await findOrCreateStripeCustomer(customer, stripeSecretKey)

    const defaultAmountCents = Math.round(amount * 100)
    const { amountCents, testChargeCents } = resolveStripeChargeCents(defaultAmountCents, 'CUSTOM')

    const metadata: Record<string, string> = {
      phone_number: customer.phone_number,
      payment_type: 'CUSTOM',
      custom_amount: amount.toFixed(2),
      description,
    }
    if (jobId) metadata.job_id = jobId
    if (testChargeCents) metadata.test_charge_cents = String(testChargeCents)

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: description || 'Payment',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: domain,
      cancel_url: domain,
      metadata,
    })

    console.log(`Created custom payment session: ${session.id} for $${(amountCents / 100).toFixed(2)}`)

    return {
      success: true,
      url: session.url || undefined,
      amount: amountCents / 100,
    }
  } catch (error) {
    console.error('Error creating custom payment session:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Create an add-on payment link for after-the-fact upgrades
 * stripeSecretKey is REQUIRED — must be the tenant's own Stripe key.
 */
export async function createAddOnPaymentLink(
  customer: Customer,
  job: Job,
  addOnAmount: number,
  addOns: AddOnKey[],
  stripeSecretKey: string,
  currency: string
): Promise<{ success: boolean; url?: string; amount?: number; error?: string }> {
  if (!customer.email) {
    return { success: false, error: 'Customer email required' }
  }

  if (!addOnAmount || addOnAmount <= 0) {
    return { success: false, error: 'Invalid add-on amount' }
  }

  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)
    const domain = await getTenantRedirectDomain((job as any).tenant_id)
    const stripeCustomer = await findOrCreateStripeCustomer(customer, stripeSecretKey)

    const defaultAmountWithFee = Math.round(addOnAmount * 1.03 * 100)
    const { amountCents: addOnAmountCents, testChargeCents } = resolveStripeChargeCents(
      defaultAmountWithFee,
      'ADDON'
    )
    const amountWithFee = addOnAmountCents / 100
    const label = addOns.length > 0
      ? addOns.map(addOn => getAddOnLabel(addOn)).join(', ')
      : 'Add-ons'

    const metadata: Record<string, string> = {
      job_id: job.id || '',
      phone_number: job.phone_number,
      payment_type: 'ADDON',
      add_on_amount: addOnAmount.toFixed(2),
      add_on_keys: addOns.join(','),
    }
    if (testChargeCents) {
      metadata.test_charge_cents = String(testChargeCents)
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomer.id,
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `${job.service_type || 'Cleaning'} - Add-ons`,
              description: label,
            },
            unit_amount: addOnAmountCents,
          },
          quantity: 1,
        },
      ],
      success_url: domain,
      cancel_url: domain,
      metadata,
    })

    console.log(`Created add-on session: ${session.id} for $${amountWithFee.toFixed(2)}`)

    return {
      success: true,
      url: session.url || undefined,
      amount: amountWithFee,
    }
  } catch (error) {
    console.error('Error creating add-on session:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Charge a customer's saved card on file (off-session).
 * Used for auto-charge on job completion and cancellation fees.
 */
export async function chargeCardOnFile(
  stripeSecretKey: string,
  stripeCustomerId: string,
  amountCents: number,
  metadata: Record<string, string>,
  currency: string
): Promise<{ success: boolean; paymentIntentId?: string; error?: string }> {
  try {
    const stripe = getStripeClientForTenant(stripeSecretKey)

    // Retrieve the customer's default payment method
    const customer = await stripe.customers.retrieve(stripeCustomerId)
    if (customer.deleted) {
      return { success: false, error: 'Stripe customer has been deleted' }
    }

    const defaultPm =
      customer.invoice_settings?.default_payment_method ||
      customer.default_source
    if (!defaultPm) {
      return { success: false, error: 'No payment method on file' }
    }

    const paymentMethodId = typeof defaultPm === 'string' ? defaultPm : defaultPm.id

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata,
    })

    console.log(`[Stripe] Off-session charge succeeded: ${paymentIntent.id} ($${(amountCents / 100).toFixed(2)})`)
    return { success: true, paymentIntentId: paymentIntent.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Stripe] Off-session charge failed: ${message}`)
    return { success: false, error: message }
  }
}

export type JobPricingEstimate = {
  basePrice: number
  addOnPrice: number
  totalPrice: number
  pricingAdjustmentPct: number
  pricingAdjustmentAmount: number
  baseHours: number
  addOnHours: number
  totalHours: number
  cleaners: number
  hoursPerCleaner: number
  cleanerPay: number
  addOns: AddOnKey[]
  membershipDiscount?: number
  membershipPlanName?: string
}

/**
 * Calculate price based on job details
 * Uses the Spotless pricing sheet for Standard/Deep cleanings,
 * with window adders applied afterward.
 */
export function calculateJobPrice(
  job: Partial<Job>,
  customer?: { bedrooms?: number; bathrooms?: number; square_footage?: number }
): number {
  return calculateJobEstimate(job, customer).totalPrice
}

/**
 * Synchronous job estimate using static pricing (for backwards compatibility)
 */
export function calculateJobEstimate(
  job: Partial<Job>,
  customer?: { bedrooms?: number; bathrooms?: number; square_footage?: number },
  cleanerPayPercentage?: number
): JobPricingEstimate {
  const basePrices: Record<string, number> = {
    'Standard cleaning': 150,
    'Deep cleaning': 250,
    'Move in/out': 300,
    'Move-in/out': 300,
    'Move in': 300,
    'Move out': 300,
  }

  const serviceTier = normalizeServiceTier(job.service_type)
  const pricingTier = serviceTier === 'move' ? 'deep' : serviceTier

  const overrides = getOverridesFromNotes(job.notes)
  const bedrooms = normalizeCount(
    overrides.bedrooms ??
      customer?.bedrooms ??
      (job as Record<string, unknown>).bedrooms
  )
  const bathrooms = normalizeBathroomCount(
    overrides.bathrooms ??
      customer?.bathrooms ??
      (job as Record<string, unknown>).bathrooms
  )
  const squareFootage = normalizeCount(
    overrides.squareFootage ??
      customer?.square_footage ??
      (job as Record<string, unknown>).square_footage ??
      (job as Record<string, unknown>).squareFootage
  )

  const baseRow = pricingTier && bedrooms && bathrooms
    ? getPricingRow(pricingTier, bedrooms, bathrooms, squareFootage)
    : null

  const fallbackBase = basePrices[job.service_type || 'Standard cleaning'] ?? 150
  const basePrice = baseRow?.price ?? fallbackBase
  const baseHours = baseRow?.labor_hours ?? 0
  const cleaners = baseRow?.cleaners ?? 1
  const baseHoursPerCleaner = baseRow?.hours_per_cleaner ?? (cleaners ? baseHours / cleaners : baseHours)

  const clientRate = baseHours > 0 ? basePrice / baseHours : 0
  const addOns = getAddOnsFromNotes(job.notes)

  let addOnHours = 0
  let addOnPrice = 0

  for (const addOnKey of addOns) {
    const def = getAddOnDefinition(addOnKey)
    if (!def) continue
    if (serviceTier && def.included_in?.includes(serviceTier)) {
      continue
    }

    const hours = def.minutes / 60
    addOnHours += hours

    if (typeof def.flat_price === 'number') {
      addOnPrice += def.flat_price
    } else {
      const multiplier = def.price_multiplier ?? 1
      addOnPrice += clientRate * hours * multiplier
    }
  }

  const totalHours = baseHours + addOnHours
  const hoursPerCleaner = cleaners ? totalHours / cleaners : totalHours
  const config = getClientConfig()
  const pricingAdjustmentPct = resolvePricingAdjustmentPct(job, config)
  const pricingAdjustmentAmount = roundCurrency((basePrice + addOnPrice) * (pricingAdjustmentPct / 100))
  const totalPrice = roundCurrency(basePrice + addOnPrice + pricingAdjustmentAmount)

  return {
    basePrice: roundCurrency(basePrice),
    addOnPrice: roundCurrency(addOnPrice),
    totalPrice,
    pricingAdjustmentPct,
    pricingAdjustmentAmount,
    baseHours: roundHours(baseHours),
    addOnHours: roundHours(addOnHours),
    totalHours: roundHours(totalHours),
    cleaners,
    hoursPerCleaner: roundHours(hoursPerCleaner || baseHoursPerCleaner),
    cleanerPay: cleanerPayPercentage
      ? roundCurrency(totalPrice * (cleanerPayPercentage / 100))
      : roundCurrency(totalHours * config.cleanerHourlyRate),
    addOns,
  }
}

/**
 * Async job estimate using database pricing (preferred for tenant-specific pricing)
 * Falls back to static pricing if no tenant-specific pricing exists
 */
export async function calculateJobEstimateAsync(
  job: Partial<Job>,
  customer?: { bedrooms?: number; bathrooms?: number; square_footage?: number },
  tenantId?: string,
  membershipId?: string
): Promise<JobPricingEstimate> {
  const basePrices: Record<string, number> = {
    'Standard cleaning': 150,
    'Deep cleaning': 250,
    'Move in/out': 300,
    'Move-in/out': 300,
    'Move in': 300,
    'Move out': 300,
  }

  const serviceTier = normalizeServiceTier(job.service_type)
  const pricingTier = serviceTier === 'move' ? 'deep' : serviceTier

  const overrides = getOverridesFromNotes(job.notes)
  const bedrooms = normalizeCount(
    overrides.bedrooms ??
      customer?.bedrooms ??
      (job as Record<string, unknown>).bedrooms
  )
  const bathrooms = normalizeBathroomCount(
    overrides.bathrooms ??
      customer?.bathrooms ??
      (job as Record<string, unknown>).bathrooms
  )
  const squareFootage = normalizeCount(
    overrides.squareFootage ??
      customer?.square_footage ??
      (job as Record<string, unknown>).square_footage ??
      (job as Record<string, unknown>).squareFootage
  )

  // Fetch pricing from database (with tenant-specific pricing)
  let baseRow: DbPricingRow | null = null
  if (pricingTier && bedrooms && bathrooms) {
    baseRow = await getPricingRowFromDb(pricingTier, bedrooms, bathrooms, squareFootage, tenantId)
  }

  // Also fetch addons from database
  const dbAddons = await getPricingAddons(tenantId)

  const fallbackBase = basePrices[job.service_type || 'Standard cleaning'] ?? 150
  const basePrice = baseRow?.price ?? fallbackBase
  const baseHours = baseRow?.labor_hours ?? 0
  const cleaners = baseRow?.cleaners ?? 1
  const baseHoursPerCleaner = baseRow?.hours_per_cleaner ?? (cleaners ? baseHours / cleaners : baseHours)

  const clientRate = baseHours > 0 ? basePrice / baseHours : 0
  const addOns = getAddOnsFromNotes(job.notes)

  let addOnHours = 0
  let addOnPrice = 0

  for (const addOnKey of addOns) {
    // First check database addons
    const dbAddon = dbAddons.find(a => a.addon_key === addOnKey)
    if (dbAddon) {
      // Check if included in this service tier
      if (serviceTier && dbAddon.included_in?.includes(serviceTier)) {
        continue
      }

      const hours = dbAddon.minutes / 60
      addOnHours += hours

      if (typeof dbAddon.flat_price === 'number' && dbAddon.flat_price !== null) {
        addOnPrice += dbAddon.flat_price
      } else {
        const multiplier = dbAddon.price_multiplier ?? 1
        addOnPrice += clientRate * hours * multiplier
      }
    } else {
      // Fall back to static addon definition
      const def = getAddOnDefinition(addOnKey)
      if (!def) continue
      if (serviceTier && def.included_in?.includes(serviceTier)) {
        continue
      }

      const hours = def.minutes / 60
      addOnHours += hours

      if (typeof def.flat_price === 'number') {
        addOnPrice += def.flat_price
      } else {
        const multiplier = def.price_multiplier ?? 1
        addOnPrice += clientRate * hours * multiplier
      }
    }
  }

  const totalHours = baseHours + addOnHours
  const hoursPerCleaner = cleaners ? totalHours / cleaners : totalHours
  const config = getClientConfig()
  const pricingAdjustmentPct = resolvePricingAdjustmentPct(job, config)
  const pricingAdjustmentAmount = roundCurrency((basePrice + addOnPrice) * (pricingAdjustmentPct / 100))
  const priceBeforeDiscount = roundCurrency(basePrice + addOnPrice + pricingAdjustmentAmount)

  // Apply membership discount if applicable
  let membershipDiscount = 0
  let membershipPlanName: string | undefined
  if (membershipId && tenantId) {
    try {
      const { getSupabaseServiceClient } = await import('./supabase')
      const db = getSupabaseServiceClient()
      const { data: membership } = await db
        .from('customer_memberships')
        .select('id, plan_id, service_plans!inner(name, discount_per_visit, discount_type)')
        .eq('id', membershipId)
        .eq('status', 'active')
        .single()

      if (membership) {
        const plan = membership.service_plans as any
        membershipPlanName = plan.name
        const discountValue = Number(plan.discount_per_visit) || 0
        if (plan.discount_type === 'percent') {
          membershipDiscount = roundCurrency(priceBeforeDiscount * (discountValue / 100))
        } else {
          membershipDiscount = roundCurrency(Math.min(discountValue, priceBeforeDiscount))
        }
      }
    } catch (err) {
      console.error('[Pricing] Membership discount lookup failed:', err)
    }
  }

  const totalPrice = roundCurrency(priceBeforeDiscount - membershipDiscount)

  // Use percentage-based cleaner pay if tenant has it configured
  let cleanerPay: number
  if (tenantId) {
    try {
      const { getTenantById } = await import('./tenant')
      const tenant = await getTenantById(tenantId)
      const pct = tenant?.workflow_config?.cleaner_pay_percentage
      cleanerPay = pct
        ? roundCurrency(totalPrice * (pct / 100))
        : roundCurrency(totalHours * config.cleanerHourlyRate)
    } catch {
      cleanerPay = roundCurrency(totalHours * config.cleanerHourlyRate)
    }
  } else {
    cleanerPay = roundCurrency(totalHours * config.cleanerHourlyRate)
  }

  return {
    basePrice: roundCurrency(basePrice),
    addOnPrice: roundCurrency(addOnPrice),
    totalPrice,
    pricingAdjustmentPct,
    pricingAdjustmentAmount,
    baseHours: roundHours(baseHours),
    addOnHours: roundHours(addOnHours),
    totalHours: roundHours(totalHours),
    cleaners,
    hoursPerCleaner: roundHours(hoursPerCleaner || baseHoursPerCleaner),
    cleanerPay,
    addOns,
    membershipDiscount: membershipDiscount > 0 ? membershipDiscount : undefined,
    membershipPlanName,
  }
}

/**
 * Async price calculation using database pricing
 */
export async function calculateJobPriceAsync(
  job: Partial<Job>,
  customer?: { bedrooms?: number; bathrooms?: number; square_footage?: number },
  tenantId?: string
): Promise<number> {
  const estimate = await calculateJobEstimateAsync(job, customer, tenantId)
  return estimate.totalPrice
}

function normalizeServiceTier(serviceType?: string | null): PricingTier {
  if (!serviceType) return 'standard'
  const lower = serviceType.toLowerCase()
  if (lower.includes('deep')) return 'deep'
  if (lower.includes('standard')) return 'standard'
  if (lower.includes('move')) return 'move'
  return 'standard'
}

function normalizeCount(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.round(num)
}

function normalizeBathroomCount(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.round(num * 2) / 2
}

function getPricingRow(
  tier: 'standard' | 'deep',
  bedrooms: number,
  bathrooms: number,
  squareFootage: number | null
): PricingRow | null {
  const rows = PRICING_TABLE[tier].filter(
    row => row.bedrooms === bedrooms && row.bathrooms === bathrooms
  )

  if (!rows.length) return null

  const sorted = [...rows].sort((a, b) => a.max_sq_ft - b.max_sq_ft)
  if (squareFootage && squareFootage > 0) {
    return sorted.find(row => row.max_sq_ft >= squareFootage) || sorted[sorted.length - 1]
  }

  return sorted[sorted.length - 1]
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100
}

function resolvePricingAdjustmentPct(job: Partial<Job>, config: ReturnType<typeof getClientConfig>): number {
  if (!config.features.dynamicPricing) {
    return 0
  }

  const raw = typeof job.pricing_adjustment_pct === 'number'
    ? job.pricing_adjustment_pct
    : Number(job.pricing_adjustment_pct)

  if (!Number.isFinite(raw)) {
    return 0
  }

  const maxDiscount = Number(process.env.DYNAMIC_PRICING_MAX_DISCOUNT_PCT || '10')
  const maxMarkup = Number(process.env.DYNAMIC_PRICING_MAX_MARKUP_PCT || '8')
  const min = Number.isFinite(maxDiscount) ? -Math.abs(maxDiscount) : -10
  const max = Number.isFinite(maxMarkup) ? Math.abs(maxMarkup) : 8

  return Math.min(Math.max(raw, min), max)
}

/**
 * Calculate deposit amount (50% + 3% processing fee)
 */
export function calculateDeposit(totalPrice: number): number {
  const halfPrice = totalPrice / 2
  const withFee = halfPrice * 1.03
  return Math.round(withFee * 100) / 100 // Round to cents
}

/**
 * Calculate final payment amount (remaining 50% + 3% processing fee)
 */
export function calculateFinalPayment(totalPrice: number): number {
  const halfPrice = totalPrice / 2
  const withFee = halfPrice * 1.03
  return Math.round(withFee * 100) / 100 // Round to cents
}
