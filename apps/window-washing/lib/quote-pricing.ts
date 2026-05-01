/**
 * Tenant-aware quote pricing engine.
 *
 * WinBros  → pane-based window tiers from pricebook.ts
 * House cleaning tenants → bed/bath tiers from pricing_tiers + pricing_addons tables
 *
 * Service categories:
 *   'standard'    → Standard / Deep / Extra Deep (3 tiers)
 *   'move_in_out' → Standard Move / Deep Move / White Glove Move (3 tiers)
 */

import { computeTierPrice, QUOTE_TIERS, QUOTE_ADDONS, type QuoteTier, type QuoteAddon } from './pricebook'
import { getWindowTiersFromDB } from './pricebook-db'
import { getSupabaseServiceClient } from './supabase'

// ── Types ────────────────────────────────────────────────────────────

export interface TierDefinition {
  key: string
  name: string
  tagline: string
  badge?: string
  included: string[]
  description: string
}

export interface AddonDefinition {
  key: string
  name: string
  description: string
  priceType: 'flat' | 'per_unit'
  price: number
  unit?: string
}

export interface TierPriceResult {
  price: number
  breakdown: { service: string; price: number }[]
  tier: string
}

export interface QuotePricingResult {
  tiers: TierDefinition[]
  tierPrices: Record<string, TierPriceResult>
  addons: AddonDefinition[]
  serviceType: 'window_cleaning' | 'house_cleaning'
}

// ── Standard House Cleaning Tier Definitions (2 tiers) ──────────────

const CLEANING_TIERS: TierDefinition[] = [
  {
    key: 'standard',
    name: 'Standard Clean',
    tagline: 'Fresh & tidy',
    included: [
      'kitchen_surfaces',
      'bathroom_sanitize',
      'vacuum_mop',
      'dusting',
      'trash_removal',
    ],
    description:
      'A thorough surface-level clean — kitchens, bathrooms, floors, dusting, and trash. Everything you need to keep your home looking great between deep cleans.',
  },
  {
    key: 'deep',
    name: 'Deep Clean',
    tagline: 'Most popular',
    badge: 'Best Value',
    included: [
      'kitchen_surfaces',
      'bathroom_sanitize',
      'vacuum_mop',
      'dusting',
      'trash_removal',
      'baseboards',
      'ceiling_fans',
      'light_fixtures',
      'window_sills',
      'inside_microwave',
      'inside_fridge',
      'inside_oven',
    ],
    description:
      'Everything in Standard plus baseboards, ceiling fans, light fixtures, window sills, inside microwave, inside fridge, and inside oven. A top-to-bottom refresh.',
  },
]

// ── Move-In/Move-Out Tier Definition (single all-inclusive tier) ─────

const MOVE_TIERS: TierDefinition[] = [
  {
    key: 'move',
    name: 'Move-Out Clean',
    tagline: 'Thorough & deposit-ready',
    included: [
      // Kitchen
      'kitchen_surfaces',
      'stovetop_clean',
      'inside_microwave',
      'cabinet_exteriors',
      'garbage_disposal',
      'inside_oven',
      'inside_fridge',
      'inside_dishwasher',
      'inside_cabinets',
      'range_hood',
      // Bathrooms
      'bathroom_sanitize',
      'shower_tub_scrub',
      'mirrors',
      'grout_scrubbing',
      // Whole home
      'vacuum_mop',
      'dusting',
      'trash_removal',
      'baseboards',
      'baseboards_hand_wipe',
      'ceiling_fans',
      'light_fixtures',
      'light_fixtures_detailed',
      'window_sills',
      'window_tracks',
      'light_switches',
      'door_knobs',
      'cobweb_removal',
      'wall_spot_cleaning',
      'closet_interiors',
      'behind_under_appliances',
    ],
    description:
      'A thorough move-out clean — every surface top to bottom. Kitchen appliances inside and out (oven, fridge, dishwasher, cabinets, range hood), bathrooms scrubbed including grout, all floors, baseboards, ceiling fans, light fixtures, window sills and tracks, closets, and wall spot cleaning. Deposit-ready.',
  },
]

// Move-specific add-ons (optional extras beyond the base move clean)
const MOVE_ADDON_KEYS = [
  'windows_exterior',
  'windows_interior',
  'garage_sweep',
  'patio_balcony',
  'inside_washer_dryer',
  'pet_hair_removal',
  'blinds',
  'full_wall_washing',
  'exhaust_fans',
]

// Base cleaning services included in every standard tier (not chargeable addons)
const BASE_SERVICES: Record<string, string> = {
  kitchen_surfaces: 'Kitchen counters, sink & appliance exteriors',
  bathroom_sanitize: 'Bathroom deep sanitize (tub, toilet, vanity)',
  vacuum_mop: 'Vacuum & mop all floors',
  dusting: 'Dust all surfaces & furniture',
  trash_removal: 'Empty trash & replace liners',
}

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Determine if a tenant is a window cleaning business (WinBros) or house cleaning.
 */
export function isWindowCleaningTenant(tenantSlug: string): boolean {
  return tenantSlug === 'winbros'
}

/**
 * Get quote tiers, prices, and addons for a tenant.
 * serviceCategory determines which tier set to return for house cleaning.
 */
export async function getQuotePricing(
  tenantId: string,
  tenantSlug: string,
  params: {
    squareFootage?: number | null
    bedrooms?: number | null
    bathrooms?: number | null
  },
  serviceCategory: 'standard' | 'move_in_out' = 'standard'
): Promise<QuotePricingResult> {
  if (isWindowCleaningTenant(tenantSlug)) {
    return getWindowCleaningPricing(params.squareFootage, tenantId)
  }
  return getHouseCleaningPricing(tenantId, params, serviceCategory)
}

// ── Window Cleaning (WinBros) ────────────────────────────────────────

async function getWindowCleaningPricing(squareFootage?: number | null, tenantId?: string): Promise<QuotePricingResult> {
  const windowTiers = tenantId ? await getWindowTiersFromDB(tenantId) : undefined
  const tierPrices: Record<string, TierPriceResult> = {
    good: computeTierPrice('good', squareFootage, windowTiers),
    better: computeTierPrice('better', squareFootage, windowTiers),
    best: computeTierPrice('best', squareFootage, windowTiers),
  }

  // Set actual sqft-based prices on interior/track_detailing add-ons
  // (they show $0 in the static list because their price depends on sqft)
  const betterBreakdown = tierPrices.better.breakdown
  const interiorPrice = betterBreakdown.find(b => b.service === 'Interior Window Cleaning')?.price || 0
  const trackPrice = betterBreakdown.find(b => b.service === 'Track Detailing')?.price || 0

  const addonsWithPrices = (QUOTE_ADDONS as AddonDefinition[]).map(addon => {
    if (addon.key === 'interior' && interiorPrice > 0) return { ...addon, price: interiorPrice }
    if (addon.key === 'track_detailing' && trackPrice > 0) return { ...addon, price: trackPrice }
    return addon
  })

  return {
    tiers: QUOTE_TIERS as TierDefinition[],
    tierPrices,
    addons: addonsWithPrices,
    serviceType: 'window_cleaning',
  }
}

// ── House Cleaning (Spotless / Cedar Rapids / etc.) ───────────────────

async function getHouseCleaningPricing(
  tenantId: string,
  params: { bedrooms?: number | null; bathrooms?: number | null; squareFootage?: number | null },
  serviceCategory: 'standard' | 'move_in_out'
): Promise<QuotePricingResult> {
  const supabase = getSupabaseServiceClient()

  // Fetch pricing tiers for this tenant
  const { data: pricingTiers } = await supabase
    .from('pricing_tiers')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('service_type')
    .order('bedrooms')
    .order('bathrooms')

  // Fetch addons for this tenant
  const { data: pricingAddons } = await supabase
    .from('pricing_addons')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('active', true)
    .order('addon_key')

  const bedrooms = params.bedrooms || 2
  const bathrooms = params.bathrooms || 1
  const bedbathLabel = `${bedrooms} bed / ${bathrooms} bath`

  if (serviceCategory === 'move_in_out') {
    return buildMoveInOutPricing(pricingTiers || [], pricingAddons || [], bedrooms, bathrooms, bedbathLabel)
  }

  return buildStandardPricing(pricingTiers || [], pricingAddons || [], bedrooms, bathrooms, bedbathLabel)
}

// ── Standard Cleaning Pricing (3 tiers) ──────────────────────────────

// Formula-based pricing fallback when DB has no rows for a tenant
function formulaPrice(serviceType: 'standard' | 'deep', bedrooms: number, bathrooms: number): number {
  if (serviceType === 'standard') {
    return Math.max(100 * bedrooms + 35 * bathrooms, 200)
  }
  // deep / move
  return Math.max(125 * bedrooms + 50 * bathrooms, 250)
}

function buildStandardPricing(
  pricingTiers: Array<{ service_type: string; bedrooms: number; bathrooms: string; price: string; labor_hours: string; cleaners: number; max_sq_ft: number }>,
  pricingAddons: Array<{ addon_key: string; label: string; flat_price: string }>,
  bedrooms: number,
  bathrooms: number,
  bedbathLabel: string,
): QuotePricingResult {
  const standardPrice = findPricingRow(pricingTiers, 'standard', bedrooms, bathrooms)
  const deepPrice = findPricingRow(pricingTiers, 'deep', bedrooms, bathrooms)

  // Use DB price if available, otherwise fall back to formula
  const stdPriceValue = standardPrice?.price ?? (() => { console.warn(`⚠️ [PRICING FALLBACK] No DB tier for ${bedrooms}bed/${bathrooms}bath standard — using formula. Seed pricing_tiers!`); return formulaPrice('standard', bedrooms, bathrooms) })()
  const deepPriceValue = deepPrice?.price ?? (() => { console.warn(`⚠️ [PRICING FALLBACK] No DB tier for ${bedrooms}bed/${bathrooms}bath deep — using formula. Seed pricing_tiers!`); return formulaPrice('deep', bedrooms, bathrooms) })()

  const tierPrices: Record<string, TierPriceResult> = {
    standard: {
      price: stdPriceValue,
      breakdown: buildCleaningBreakdown('standard', standardPrice || { price: stdPriceValue }, pricingAddons),
      tier: bedbathLabel,
    },
    deep: {
      price: deepPriceValue,
      breakdown: buildCleaningBreakdown('deep', deepPrice || { price: deepPriceValue }, pricingAddons),
      tier: bedbathLabel,
    },
  }

  // Build selectable addons
  const addons: AddonDefinition[] = pricingAddons.map(a => ({
    key: a.addon_key,
    name: a.label,
    description: getAddonDescription(a.addon_key),
    priceType: 'flat' as const,
    price: Number(a.flat_price) || 0,
    unit: undefined,
  }))

  return {
    tiers: CLEANING_TIERS,
    tierPrices,
    addons,
    serviceType: 'house_cleaning',
  }
}

// ── Move-In/Move-Out Pricing (3 tiers) ──────────────────────────────

function buildMoveInOutPricing(
  pricingTiers: Array<{ service_type: string; bedrooms: number; bathrooms: string; price: string; labor_hours: string; cleaners: number; max_sq_ft: number }>,
  pricingAddons: Array<{ addon_key: string; label: string; flat_price: string }>,
  bedrooms: number,
  bathrooms: number,
  bedbathLabel: string,
): QuotePricingResult {
  // Single all-inclusive move price from DB (no addon stacking)
  // Falls back to deep * 1.15 if no move rows exist yet
  const moveRow = findPricingRow(pricingTiers, 'move', bedrooms, bathrooms)
  const deepPrice = findPricingRow(pricingTiers, 'deep', bedrooms, bathrooms)
  const baseDeepPrice = deepPrice?.price ?? formulaPrice('deep', bedrooms, bathrooms)
  const movePrice = moveRow?.price || Math.round(baseDeepPrice * 1.15)

  const tierPrices: Record<string, TierPriceResult> = {
    move: {
      price: movePrice,
      breakdown: buildMoveBreakdown(movePrice),
      tier: bedbathLabel,
    },
  }

  // Move-specific optional add-ons
  const moveAddons: AddonDefinition[] = MOVE_ADDON_KEYS
    .map(key => {
      const dbAddon = pricingAddons.find(a => a.addon_key === key)
      if (dbAddon) {
        return {
          key: dbAddon.addon_key,
          name: dbAddon.label,
          description: getAddonDescription(dbAddon.addon_key),
          priceType: 'flat' as const,
          price: Number(dbAddon.flat_price) || 0,
          unit: undefined,
        }
      }
      // Fallback for addons not yet in the DB
      const fallbacks: Record<string, { name: string; price: number }> = {
        windows_exterior: { name: 'Exterior Window Washing', price: 75 },
        windows_interior: { name: 'Interior Window Cleaning', price: 60 },
        garage_sweep: { name: 'Garage Sweep & Cobwebs', price: 50 },
        patio_balcony: { name: 'Patio / Balcony Cleaning', price: 50 },
        inside_washer_dryer: { name: 'Inside Washer & Dryer', price: 50 },
        pet_hair_removal: { name: 'Pet Hair Deep Removal', price: 40 },
        blinds: { name: 'Blinds / Shutters Deep Clean', price: 40 },
        full_wall_washing: { name: 'Full Wall Washing', price: 200 },
        exhaust_fans: { name: 'Exhaust Fans Removed & Cleaned', price: 25 },
      }
      const fb = fallbacks[key]
      if (!fb) return null
      return {
        key,
        name: fb.name,
        description: getAddonDescription(key),
        priceType: 'flat' as const,
        price: fb.price,
        unit: undefined,
      }
    })
    .filter((a): a is AddonDefinition => a !== null)

  return {
    tiers: MOVE_TIERS,
    tierPrices,
    addons: moveAddons,
    serviceType: 'house_cleaning',
  }
}

// ── Shared Helpers ───────────────────────────────────────────────────

function findPricingRow(
  tiers: Array<{ service_type: string; bedrooms: number; bathrooms: string; price: string; labor_hours: string; cleaners: number; max_sq_ft: number }>,
  serviceType: string,
  bedrooms: number,
  bathrooms: number
): { price: number; labor_hours: number; cleaners: number } | null {
  // Round up half baths to next full bath so we never undercharge
  // e.g. 2.5 baths → charges the 3 bath price
  const roundedBathrooms = Math.ceil(bathrooms)

  // Find exact match first
  const exact = tiers.find(
    t => t.service_type === serviceType && t.bedrooms === bedrooms && Number(t.bathrooms) === roundedBathrooms
  )
  if (exact) {
    // Round to whole dollars so the quote page matches what the voice/SMS
    // surfaces speak ($Intl with maximumFractionDigits:0). Without this, a
    // pricing_tiers row of 362.50 surfaces as "$363" on the call but
    // "$362.50" on the quote page — the customer notices.
    return { price: Math.round(Number(exact.price)), labor_hours: Number(exact.labor_hours), cleaners: exact.cleaners }
  }

  // Find closest match (same service type, closest bed/bath)
  const sametype = tiers.filter(t => t.service_type === serviceType)
  if (sametype.length === 0) return null

  // Sort by distance to requested bed/bath
  const sorted = sametype.sort((a, b) => {
    const distA = Math.abs(a.bedrooms - bedrooms) + Math.abs(Number(a.bathrooms) - roundedBathrooms)
    const distB = Math.abs(b.bedrooms - bedrooms) + Math.abs(Number(b.bathrooms) - roundedBathrooms)
    return distA - distB
  })

  const best = sorted[0]
  return { price: Math.round(Number(best.price)), labor_hours: Number(best.labor_hours), cleaners: best.cleaners }
}

function buildCleaningBreakdown(
  tierKey: string,
  basePrice: { price: number } | null,
  _addons: Array<{ addon_key: string; label: string; flat_price: string }>,
  includedAddons?: Array<{ addon_key: string; label: string; flat_price: string }>
): { service: string; price: number }[] {
  const breakdown: { service: string; price: number }[] = []

  // Base cleaning service
  const tierNames: Record<string, string> = {
    standard: 'Standard Cleaning',
    deep: 'Deep Cleaning',
    extra_deep: 'Deep Cleaning (base)',
  }
  breakdown.push({ service: tierNames[tierKey] || 'Cleaning', price: Number(basePrice?.price) || 0 })

  // Base services included free
  if (tierKey === 'standard') {
    Object.values(BASE_SERVICES).forEach(svc => {
      breakdown.push({ service: svc, price: 0 })
    })
  } else if (tierKey === 'deep') {
    Object.values(BASE_SERVICES).forEach(svc => {
      breakdown.push({ service: svc, price: 0 })
    })
    breakdown.push({ service: 'Baseboards', price: 0 })
    breakdown.push({ service: 'Ceiling Fans', price: 0 })
    breakdown.push({ service: 'Light Fixtures', price: 0 })
    breakdown.push({ service: 'Window Sills', price: 0 })
    breakdown.push({ service: 'Inside Microwave', price: 0 })
  }

  // Premium included addons (for extra_deep)
  if (includedAddons && includedAddons.length > 0) {
    for (const addon of includedAddons) {
      breakdown.push({ service: addon.label, price: Number(addon.flat_price) || 0 })
    }
  }

  return breakdown
}

function buildMoveBreakdown(
  basePrice: number,
): { service: string; price: number }[] {
  const breakdown: { service: string; price: number }[] = []

  breakdown.push({ service: 'Move-Out Clean', price: basePrice })

  // All included services at $0 (single all-inclusive tier)
  const moveIncludedServices = [
    'Kitchen surfaces, stovetop & microwave interior',
    'Inside oven, fridge, dishwasher & all cabinets',
    'Range hood degreased',
    'Cabinet & drawer exteriors',
    'Behind & under appliances',
    'Bathroom full scrub (toilet, tub, shower, vanity)',
    'Bathroom grout scrubbing',
    'All floors vacuumed & mopped',
    'Baseboards detailed hand-wipe',
    'Ceiling fans & light fixtures (detailed)',
    'Window sills & window tracks',
    'Light switches, door knobs & outlet covers',
    'Cobweb removal',
    'Closet interiors swept',
    'Wall spot cleaning (scuffs & fingerprints)',
  ]

  for (const svc of moveIncludedServices) {
    breakdown.push({ service: svc, price: 0 })
  }

  return breakdown
}

function getAddonDescription(key: string): string {
  const descriptions: Record<string, string> = {
    inside_fridge: 'Full interior fridge cleaning — shelves, drawers, and door compartments',
    inside_oven: 'Interior oven deep clean — racks, walls, and door glass',
    inside_cabinets: 'Wipe down all cabinet interiors — shelves and doors',
    inside_microwave: 'Interior microwave cleaning and degreasing',
    inside_dishwasher: 'Deep clean dishwasher interior, filter, and door',
    range_hood: 'Degrease range hood, exhaust fan, and filter',
    baseboards: 'Detailed wipe-down of all baseboards throughout the home',
    blinds: 'Clean all blinds and shutters — dust and wipe each slat',
    ceiling_fans: 'Dust and wipe all ceiling fan blades',
    light_fixtures: 'Clean light fixtures and chandeliers',
    wall_cleaning: 'Spot clean walls — remove scuffs, marks, and fingerprints',
    window_sills: 'Clean all window sills and ledges',
    windows_interior: 'Interior window glass cleaning throughout the home',
    windows_exterior: 'Exterior window glass cleaning — all accessible windows',
    windows_both: 'Complete interior and exterior window cleaning',
    pet_fee: 'Additional cleaning for homes with pets — extra hair and dander removal',
    pet_hair_removal: 'Deep pet hair removal from carpets, furniture, and upholstery',
    laundry: 'One load of laundry — wash, dry, and fold',
    dishes: 'Load and run dishwasher or hand-wash dishes',
    change_sheets: 'Strip and replace bed linens on all beds',
    garage_sweep: 'Sweep and tidy garage floor with cobweb removal',
    patio_balcony: 'Sweep and wipe down patio or balcony surfaces',
    carpet_steam: 'Professional carpet steam cleaning — whole home',
    inside_washer_dryer: 'Deep clean inside washer drum and dryer lint trap area',
    full_wall_washing: 'Full wall washing — every wall, floor to ceiling',
    mineral_deposit_removal: 'Mineral deposit and hard water stain removal',
    mold_mildew_treatment: 'Mold and mildew treatment in bathrooms and wet areas',
    exhaust_fans: 'Remove and clean all exhaust fans',
    baseboards_hand_wipe: 'Detailed hand-wipe of all baseboards throughout home',
    light_fixtures_detailed: 'Detailed cleaning of all light fixtures and chandeliers',
    cabinet_exteriors: 'Wipe down all cabinet and drawer exteriors',
    garbage_disposal: 'Clean garbage disposal area and surrounding surfaces',
    light_switches: 'Clean all light switches and outlet covers',
    stovetop_clean: 'Deep clean stovetop, burners, and drip pans',
    shower_tub_scrub: 'Deep scrub shower and bathtub surfaces',
    mirrors: 'Clean all mirrors throughout the home',
    door_knobs: 'Clean and sanitize all door knobs and handles',
    cobweb_removal: 'Remove cobwebs from corners and ceilings',
    closet_interiors: 'Sweep and wipe closet interiors',
    wall_spot_cleaning: 'Spot clean walls — remove scuffs and fingerprints',
    window_tracks: 'Clean all window tracks and channels',
    grout_scrubbing: 'Scrub bathroom tile grout',
    behind_under_appliances: 'Clean behind and under major appliances',
  }
  return descriptions[key] || ''
}

/**
 * Compute the total price for a quote approval (server-side validation).
 */
export async function computeQuoteTotal(
  tenantId: string,
  tenantSlug: string,
  selectedTier: string,
  selectedAddons: string[],
  params: {
    squareFootage?: number | null
    bedrooms?: number | null
    bathrooms?: number | null
  },
  serviceCategory: 'standard' | 'move_in_out' = 'standard'
): Promise<{ subtotal: number; breakdown: { service: string; price: number }[] }> {
  const pricing = await getQuotePricing(tenantId, tenantSlug, params, serviceCategory)

  // Backward compat: old 3-tier move keys → single tier
  const tierKeyMap: Record<string, string> = {
    move_good: 'move',
    move_better: 'move',
    move_best: 'move',
  }
  const effectiveTier = tierKeyMap[selectedTier] || selectedTier
  const tierPrice = pricing.tierPrices[effectiveTier]

  if (!tierPrice) {
    throw new Error(`Invalid tier: ${selectedTier}`)
  }

  let subtotal = tierPrice.price

  // Add selected addon prices (only those not already included in the tier)
  const tier = pricing.tiers.find(t => t.key === effectiveTier)
  for (const addonKey of selectedAddons) {
    if (tier?.included.includes(addonKey)) continue // Skip — already in tier
    const addon = pricing.addons.find(a => a.key === addonKey)
    if (addon && addon.price > 0) {
      subtotal += addon.price
    }
  }

  return { subtotal, breakdown: tierPrice.breakdown }
}
