/**
 * Generate and send a professional Stripe invoice after quote approval.
 * Called from the Stripe webhook after a client picks a tier and saves their card.
 */

import { getStripeClientForTenant, findOrCreateStripeCustomer } from './stripe-client'
import { getSupabaseServiceClient } from './supabase'
import { getQuotePricing } from './quote-pricing'
import { isEffectivelyIncluded } from './service-scope'

type StoredAddon = string | { key: string; quantity?: number; included?: boolean; label?: string; price?: number; custom?: boolean }

interface QuoteData {
  id: number
  tenant_id: string
  customer_id?: number | null
  customer_name?: string | null
  customer_email?: string | null
  customer_address?: string | null
  selected_tier?: string | null
  selected_addons?: StoredAddon[] | null
  total?: number | null
  subtotal?: number | null
  discount?: number | null
  deposit_amount?: number | null
  custom_base_price?: number | null
  service_category?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
}

export async function generateQuoteInvoice(
  jobId: number,
  quote: QuoteData,
  tenant: { id: string; slug: string; name: string; business_name?: string | null; stripe_secret_key?: string | null; currency?: string | null },
  currency = 'usd'
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  const serviceClient = getSupabaseServiceClient()

  // Idempotency: check if invoice already sent for this job
  const { data: existingJob } = await serviceClient
    .from('jobs')
    .select('invoice_sent, stripe_invoice_id')
    .eq('id', jobId)
    .single()

  if (existingJob?.invoice_sent) {
    console.log(`[QuoteInvoice] Invoice already sent for job ${jobId} — skipping`)
    return { success: true, invoiceId: existingJob.stripe_invoice_id }
  }

  // Must have customer email to send invoice
  if (!quote.customer_email) {
    console.warn(`[QuoteInvoice] No customer email for job ${jobId} — cannot send invoice`)
    return { success: false, error: 'No customer email' }
  }

  // Must have tenant's Stripe key
  if (!tenant.stripe_secret_key) {
    console.warn(`[QuoteInvoice] No Stripe key for tenant ${tenant.slug} — cannot create invoice`)
    return { success: false, error: 'No Stripe key configured' }
  }

  const stripe = getStripeClientForTenant(tenant.stripe_secret_key)

  try {
    // Get or create Stripe customer (on the tenant's own Stripe account)
    const stripeCustomer = await findOrCreateStripeCustomer(
      {
        email: quote.customer_email,
        first_name: quote.customer_name?.split(' ')[0] || undefined,
        last_name: quote.customer_name?.split(' ').slice(1).join(' ') || undefined,
        address: quote.customer_address || undefined,
        phone_number: '',
      },
      tenant.stripe_secret_key
    )

    // Get pricing details for tier/addon labels
    const selectedTier = quote.selected_tier || 'standard'
    const selectedAddons = quote.selected_addons || []
    const serviceCategory = (quote.service_category === 'move_in_out' ? 'move_in_out' : 'standard') as 'standard' | 'move_in_out'

    const pricing = await getQuotePricing(
      tenant.id,
      tenant.slug,
      { squareFootage: quote.sqft, bedrooms: quote.bedrooms, bathrooms: quote.bathrooms },
      serviceCategory
    )

    // Find tier definition for the selected tier
    const tierDef = pricing.tiers.find(t => t.key === selectedTier)
    const tierPrice = pricing.tierPrices[selectedTier]
    const tierName = tierDef?.name || selectedTier
    const tierAmount = quote.custom_base_price != null
      ? Number(quote.custom_base_price)
      : (tierPrice?.price || Number(quote.total) || 0)

    // Create invoice
    const businessName = tenant.business_name || tenant.name
    const invoice = await stripe.invoices.create({
      customer: stripeCustomer.id,
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: false, // Don't auto-send emails or auto-charge
      metadata: {
        job_id: String(jobId),
        quote_id: String(quote.id),
        source: 'quote_approval',
      },
    })

    const resolvedCurrency = tenant.currency || currency || 'usd'

    // Main line item: tier name + business name + address
    await stripe.invoiceItems.create({
      customer: stripeCustomer.id,
      invoice: invoice.id,
      amount: Math.round(tierAmount * 100),
      currency: resolvedCurrency,
      description: `${tierName} — ${businessName}${quote.customer_address ? ` — ${quote.customer_address}` : ''}`,
    })

    // Add-on line items. Billable: charged as-is. Included: shown on invoice at
    // $0 with "Included" note so the customer sees the value they're getting.
    const hasCustomPriceInv = quote.custom_base_price != null
    for (const rawAddon of selectedAddons) {
      const key = typeof rawAddon === 'string' ? rawAddon : rawAddon.key
      const explicitIncluded = typeof rawAddon === 'string' ? undefined : rawAddon.included
      const included = isEffectivelyIncluded({ key, included: explicitIncluded }, selectedTier, hasCustomPriceInv, tenant.slug)
      const addonDef = pricing.addons.find((a) => a.key === key)
      const label = addonDef?.name || (typeof rawAddon !== 'string' ? rawAddon.label : undefined) || key
      const refPrice = addonDef?.price ?? (typeof rawAddon !== 'string' ? rawAddon.price ?? 0 : 0)
      if (included) {
        if (refPrice > 0) {
          await stripe.invoiceItems.create({
            customer: stripeCustomer.id,
            invoice: invoice.id,
            amount: 0,
            currency: resolvedCurrency,
            description: `${label} (${refPrice > 0 ? `$${refPrice.toFixed(0)} value — ` : ''}Included in package)`,
          })
        }
      } else if (refPrice > 0) {
        await stripe.invoiceItems.create({
          customer: stripeCustomer.id,
          invoice: invoice.id,
          amount: Math.round(refPrice * 100),
          currency: resolvedCurrency,
          description: label,
        })
      }
    }

    // Discount line item (negative amount)
    const discount = Number(quote.discount) || 0
    if (discount > 0) {
      await stripe.invoiceItems.create({
        customer: stripeCustomer.id,
        invoice: invoice.id,
        amount: -Math.round(discount * 100),
        currency: resolvedCurrency,
        description: 'Discount applied',
      })
    }

    // Finalize to generate hosted URL with line-item breakdown
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id)

    // Do NOT mark paid — invoice stays open as a viewable breakdown.
    // Actual payment is collected via card-on-file charge when job completes.

    // Update job record
    await serviceClient
      .from('jobs')
      .update({
        stripe_invoice_id: finalizedInvoice.id,
        invoice_sent: true,
      })
      .eq('id', jobId)

    console.log(`[QuoteInvoice] Invoice ${finalizedInvoice.id} created and sent for job ${jobId}`)

    return { success: true, invoiceId: finalizedInvoice.id }
  } catch (error) {
    console.error(`[QuoteInvoice] Failed to create invoice for job ${jobId}:`, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
