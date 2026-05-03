/**
 * Database-backed Pricing System
 *
 * Reads pricing from the database (pricing_tiers and pricing_addons tables)
 * Falls back to static JSON if no tenant-specific pricing exists.
 */

import { getSupabaseClient } from './supabase'
import pricingDataFallback from './pricing-data.json'

export type PricingTier = 'standard' | 'deep' | 'move'

export type PricingRow = {
  id?: number
  tenant_id?: string
  service_type: string
  bedrooms: number
  bathrooms: number
  max_sq_ft: number
  price: number
  price_min: number | null
  price_max: number | null
  labor_hours: number
  cleaners: number
  hours_per_cleaner: number | null
}

export type PricingAddon = {
  id?: number
  tenant_id?: string
  addon_key: string
  label: string
  minutes: number
  flat_price: number | null
  price_multiplier: number
  included_in: string[] | null
  keywords: string[] | null
  active: boolean
}

/**
 * Get pricing tiers for a tenant from the database
 * Falls back to static JSON if no tenant-specific pricing exists
 */
export async function getPricingTiers(tenantId?: string): Promise<Record<string, PricingRow[]>> {
  try {
    const client = getSupabaseClient()

    let tId = tenantId
    if (!tId) {
      console.log('[pricing-db] No tenant ID provided, using fallback pricing')
      return pricingDataFallback as unknown as Record<string, PricingRow[]>
    }

    // Fetch pricing tiers from database
    const { data, error } = await client
      .from('pricing_tiers')
      .select('*')
      .eq('tenant_id', tId)
      .order('bedrooms', { ascending: true })
      .order('bathrooms', { ascending: true })
      .order('max_sq_ft', { ascending: true })

    if (error) {
      console.error('[pricing-db] Error fetching pricing tiers:', error)
      return pricingDataFallback as unknown as Record<string, PricingRow[]>
    }

    if (!data || data.length === 0) {
      console.log('[pricing-db] No pricing data for tenant, using fallback')
      return pricingDataFallback as unknown as Record<string, PricingRow[]>
    }

    // Group by service_type dynamically
    const grouped: Record<string, PricingRow[]> = {}
    for (const row of data) {
      const key = row.service_type
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(row)
    }

    return grouped
  } catch (error) {
    console.error('[pricing-db] Error:', error)
    return pricingDataFallback as unknown as Record<string, PricingRow[]>
  }
}

/**
 * Get add-ons for a tenant from the database
 */
export async function getPricingAddons(tenantId?: string): Promise<PricingAddon[]> {
  try {
    const client = getSupabaseClient()

    let tId = tenantId
    if (!tId) {
      console.log('[pricing-db] No tenant ID provided for addons, using defaults')
      return getDefaultAddons()
    }

    const { data, error } = await client
      .from('pricing_addons')
      .select('*')
      .eq('tenant_id', tId)
      .eq('active', true)

    if (error) {
      console.error('[pricing-db] Error fetching addons:', error)
      return getDefaultAddons()
    }

    if (!data) {
      return getDefaultAddons()
    }

    // Empty array means user deliberately deleted all addons — don't restore defaults.
    // Only fall back to defaults when no rows exist at all (fresh tenant).
    if (data.length === 0) {
      // Check if tenant has ANY addons (including inactive) to distinguish
      // "never initialized" from "user deleted all"
      const { count } = await client
        .from('pricing_addons')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tId)
      if (count === 0) return getDefaultAddons()
      return []
    }

    return data
  } catch (error) {
    console.error('[pricing-db] Error:', error)
    return getDefaultAddons()
  }
}

/**
 * Get a specific pricing row by bedrooms/bathrooms/service type
 */
export async function getPricingRow(
  serviceType: PricingTier,
  bedrooms: number,
  bathrooms: number,
  squareFootage?: number | null,
  tenantId?: string
): Promise<PricingRow | null> {
  const tiers = await getPricingTiers(tenantId)
  const rows = tiers[serviceType] || []

  // Filter by bedrooms and bathrooms
  const matching = rows.filter(
    (row) => row.bedrooms === bedrooms && row.bathrooms === bathrooms
  )

  if (matching.length === 0) {
    // No exact match — find the closest tier that is >= requested (round UP)
    if (rows.length > 0) {
      // 1. Same bedrooms, next bathroom tier up (e.g. 3bed/1.5bath → 3bed/2bath)
      const sameBedHigherBath = rows
        .filter((r) => r.bedrooms === bedrooms && r.bathrooms >= bathrooms)
        .sort((a, b) => a.bathrooms - b.bathrooms)
      if (sameBedHigherBath.length > 0) {
        console.log(`[pricing-db] No exact match for ${bedrooms}bed/${bathrooms}bath — rounding up to ${sameBedHigherBath[0].bedrooms}bed/${sameBedHigherBath[0].bathrooms}bath ($${sameBedHigherBath[0].price})`)
        return sameBedHigherBath[0]
      }

      // 2. Same bedrooms, lower bathroom (e.g. 3bed/1bath when only 3bed/2bath exists)
      const sameBedLowerBath = rows
        .filter((r) => r.bedrooms === bedrooms)
        .sort((a, b) => Math.abs(a.bathrooms - bathrooms) - Math.abs(b.bathrooms - bathrooms))
      if (sameBedLowerBath.length > 0) {
        console.log(`[pricing-db] No exact match for ${bedrooms}bed/${bathrooms}bath — closest same-bed tier: ${sameBedLowerBath[0].bedrooms}bed/${sameBedLowerBath[0].bathrooms}bath ($${sameBedLowerBath[0].price})`)
        return sameBedLowerBath[0]
      }

      // 3. Next larger tier overall (higher bedrooms)
      const larger = rows
        .filter((r) => r.bedrooms >= bedrooms && r.bathrooms >= bathrooms)
        .sort((a, b) => {
          if (a.bedrooms !== b.bedrooms) return a.bedrooms - b.bedrooms
          return a.bathrooms - b.bathrooms
        })
      if (larger.length > 0) {
        console.log(`[pricing-db] No exact match for ${bedrooms}bed/${bathrooms}bath — next larger tier: ${larger[0].bedrooms}bed/${larger[0].bathrooms}bath ($${larger[0].price})`)
        return larger[0]
      }

      // 4. Last resort: largest available tier
      const sorted = [...rows].sort((a, b) => {
        if (b.bedrooms !== a.bedrooms) return b.bedrooms - a.bedrooms
        if (b.bathrooms !== a.bathrooms) return b.bathrooms - a.bathrooms
        return b.max_sq_ft - a.max_sq_ft
      })
      console.log(`[pricing-db] No close match for ${bedrooms}bed/${bathrooms}bath — using largest tier: ${sorted[0].bedrooms}bed/${sorted[0].bathrooms}bath ($${sorted[0].price})`)
      return sorted[0]
    }
    // No DB rows at all for this service type — use formula fallback
    const formulaStd = Math.max(100 * bedrooms + 35 * bathrooms, 200)
    const formulaDeep = Math.max(125 * bedrooms + 50 * bathrooms, 250)
    const price = serviceType === 'deep' ? formulaDeep : formulaStd
    const hours = Math.max(3, bedrooms * 0.75 + bathrooms * 0.5 + 1.5)
    const cleaners = bedrooms >= 3 ? 2 : 1
    console.warn(`⚠️ [PRICING FALLBACK] No pricing_tiers rows for ${bedrooms}bed/${bathrooms}bath ${serviceType} — using generic formula: $${price}. This likely means pricing tiers were never seeded for this tenant. Run admin onboard or insert manually.`)
    return { service_type: serviceType, bedrooms, bathrooms, max_sq_ft: 9999, price, price_min: price, price_max: price, labor_hours: Math.round(hours * 10) / 10, cleaners, hours_per_cleaner: Math.round((hours / cleaners) * 10) / 10 }
  }

  // Sort by max_sq_ft ascending
  const sorted = [...matching].sort((a, b) => a.max_sq_ft - b.max_sq_ft)

  // If square footage provided, find the appropriate tier
  if (squareFootage && squareFootage > 0) {
    const found = sorted.find((row) => row.max_sq_ft >= squareFootage)
    return found || sorted[sorted.length - 1]
  }

  // Default to largest tier
  return sorted[sorted.length - 1]
}

/**
 * Save pricing tiers for a tenant
 */
export async function savePricingTiers(
  tenantId: string,
  tiers: PricingRow[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = getSupabaseClient()

    // Delete existing pricing for this tenant
    const { error: deleteError } = await client
      .from('pricing_tiers')
      .delete()
      .eq('tenant_id', tenantId)

    if (deleteError) {
      console.error('[pricing-db] Error deleting existing pricing:', deleteError)
      return { success: false, error: 'Failed to update pricing' }
    }

    // Insert new pricing (strip DB-generated fields so Postgres auto-creates them)
    const tiersWithTenant = tiers.map(({ id, created_at, updated_at, ...rest }: any) => ({
      ...rest,
      tenant_id: tenantId,
    }))

    const { error: insertError } = await client
      .from('pricing_tiers')
      .insert(tiersWithTenant)

    if (insertError) {
      console.error('[pricing-db] Error inserting pricing:', insertError)
      return { success: false, error: 'Failed to save pricing' }
    }

    return { success: true }
  } catch (error) {
    console.error('[pricing-db] Error saving pricing:', error)
    return { success: false, error: 'Unexpected error' }
  }
}

/**
 * Save add-ons for a tenant
 */
export async function savePricingAddons(
  tenantId: string,
  addons: PricingAddon[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = getSupabaseClient()

    // Delete existing addons for this tenant
    const { error: deleteError } = await client
      .from('pricing_addons')
      .delete()
      .eq('tenant_id', tenantId)

    if (deleteError) {
      console.error('[pricing-db] Error deleting existing addons:', deleteError)
      return { success: false, error: 'Failed to update addons' }
    }

    // Insert new addons (strip DB-generated fields so Postgres auto-creates them)
    const addonsWithTenant = addons.map(({ id, created_at, updated_at, ...rest }: any) => ({
      ...rest,
      tenant_id: tenantId,
    }))

    const { error: insertError } = await client
      .from('pricing_addons')
      .insert(addonsWithTenant)

    if (insertError) {
      console.error('[pricing-db] Error inserting addons:', insertError)
      return { success: false, error: 'Failed to save addons' }
    }

    return { success: true }
  } catch (error) {
    console.error('[pricing-db] Error saving addons:', error)
    return { success: false, error: 'Unexpected error' }
  }
}

/**
 * Default add-ons (fallback when no tenant-specific data)
 */
function getDefaultAddons(): PricingAddon[] {
  return [
    {
      addon_key: 'inside_fridge',
      label: 'Inside fridge',
      minutes: 30,
      flat_price: null,
      price_multiplier: 1,
      included_in: ['deep', 'move'],
      keywords: ['inside fridge', 'fridge interior', 'clean fridge'],
      active: true,
    },
    {
      addon_key: 'inside_oven',
      label: 'Inside oven',
      minutes: 30,
      flat_price: null,
      price_multiplier: 1,
      included_in: ['deep', 'move'],
      keywords: ['inside oven', 'oven interior', 'clean oven'],
      active: true,
    },
    {
      addon_key: 'inside_cabinets',
      label: 'Inside cabinets',
      minutes: 60,
      flat_price: null,
      price_multiplier: 1,
      included_in: ['move'],
      keywords: ['inside cabinets', 'cabinet interior'],
      active: true,
    },
    {
      addon_key: 'windows_interior',
      label: 'Interior windows',
      minutes: 30,
      flat_price: 50,
      price_multiplier: 1,
      included_in: null,
      keywords: ['interior windows', 'inside windows'],
      active: true,
    },
    {
      addon_key: 'windows_exterior',
      label: 'Exterior windows',
      minutes: 60,
      flat_price: 100,
      price_multiplier: 1,
      included_in: null,
      keywords: ['exterior windows', 'outside windows'],
      active: true,
    },
    {
      addon_key: 'windows_both',
      label: 'Interior + exterior windows',
      minutes: 90,
      flat_price: 150,
      price_multiplier: 1,
      included_in: null,
      keywords: ['both windows', 'all windows'],
      active: true,
    },
    {
      addon_key: 'pet_fee',
      label: 'Pet fee',
      minutes: 0,
      flat_price: 25,
      price_multiplier: 1,
      included_in: null,
      keywords: ['pet', 'pets', 'dog', 'cat'],
      active: true,
    },
  ]
}

/**
 * Initialize pricing for a tenant from the default JSON
 * Call this when a new tenant is created or to reset to defaults
 */
export async function initializeTenantPricing(
  tenantId: string
): Promise<{ success: boolean; error?: string }> {
  const fallback = pricingDataFallback as { standard: PricingRow[]; deep: PricingRow[] }

  // Convert fallback to pricing rows with service_type
  const allTiers: PricingRow[] = [
    ...fallback.standard.map((row) => ({ ...row, service_type: 'standard' })),
    ...fallback.deep.map((row) => ({ ...row, service_type: 'deep' })),
  ]

  const tiersResult = await savePricingTiers(tenantId, allTiers)
  if (!tiersResult.success) {
    return tiersResult
  }

  const addonsResult = await savePricingAddons(tenantId, getDefaultAddons())
  return addonsResult
}
