/**
 * service-scope.ts — Single source of truth for tier definitions
 *
 * Defines what tasks are included in each cleaning tier (standard, deep, move).
 * Every UI surface, pricing engine, and cleaner portal imports from here.
 */

// ---------------------------------------------------------------------------
// 1. Standard base tasks — included in EVERY cleaning (standard, deep, move)
//    These are NOT add-ons. They should never appear in paid addon lists.
// ---------------------------------------------------------------------------

export interface BaseTask {
  key: string
  label: string
}

export const STANDARD_BASE_TASKS: readonly BaseTask[] = [
  { key: 'kitchen_surfaces', label: 'Kitchen surfaces & countertops' },
  { key: 'bathroom_sanitize', label: 'Bathroom cleaning & sanitization' },
  { key: 'vacuum_mop', label: 'Vacuum & mop all floors' },
  { key: 'dusting', label: 'Dusting surfaces & furniture' },
  { key: 'trash_removal', label: 'Trash removal & bag replacement' },
] as const

// ---------------------------------------------------------------------------
// 2. Tier upgrades — additional addon keys each tier includes beyond standard
// ---------------------------------------------------------------------------

export const TIER_UPGRADES: Record<string, string[]> = {
  deep: [
    'inside_fridge',
    'inside_oven',
    'inside_microwave',
    'baseboards',
    'ceiling_fans',
    'light_fixtures',
    'window_sills',
  ],
  move: [
    'inside_fridge',
    'inside_oven',
    'inside_microwave',
    'inside_cabinets',
    'inside_dishwasher',
    'range_hood',
    'baseboards',
    'ceiling_fans',
    'light_fixtures',
    'window_sills',
    'wall_cleaning',
  ],
}

// ---------------------------------------------------------------------------
// 2b. Tenant-specific tier additions — merge with TIER_UPGRADES per-tenant
//     West Niagara (TJ) includes interior window cleaning (sills + glass) in
//     both standard and deep tiers — a scope-of-work differentiator, not an
//     upcharge. Every inclusion check + customer display must respect this.
// ---------------------------------------------------------------------------

export const TENANT_TIER_ADDITIONS: Record<string, Record<string, string[]>> = {
  'west-niagara': {
    standard: ['interior_windows'],
    deep: ['interior_windows'],
  },
  // Texas Nova (Patrick) — deep and move tiers include the standard HC
  // platform extras. Without this, baseboards/ceiling_fans/etc get
  // re-charged on top of the deep-tier base (root cause of Linda
  // Kingcade's $562 inflated quote; T7 fix 2026-04-20).
  'texas-nova': {
    deep: ['baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills', 'inside_microwave'],
    move: ['baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills', 'inside_microwave'],
  },
}

function getTenantAdditions(tier: string, tenantSlug?: string): string[] {
  if (!tenantSlug) return []
  return TENANT_TIER_ADDITIONS[tenantSlug]?.[tier] ?? []
}

// ---------------------------------------------------------------------------
// 3. Derived sets for fast lookups
// ---------------------------------------------------------------------------

export const STANDARD_BASE_KEYS: Set<string> = new Set(
  STANDARD_BASE_TASKS.map((t) => t.key)
)

// ---------------------------------------------------------------------------
// 4. isIncludedInTier — true if key is a base task, in the tier's upgrades,
//    or in the tenant's tier-specific additions.
// ---------------------------------------------------------------------------

export function isIncludedInTier(addonKey: string, tier: string, tenantSlug?: string): boolean {
  if (STANDARD_BASE_KEYS.has(addonKey)) return true
  const upgrades = TIER_UPGRADES[tier]
  if (upgrades?.includes(addonKey)) return true
  return getTenantAdditions(tier, tenantSlug).includes(addonKey)
}

// ---------------------------------------------------------------------------
// 5. Addon inclusion — normalize + decide whether an add-on adds charge
//    Handles both string[] and object formats.
// ---------------------------------------------------------------------------

export interface AddonObjectInput {
  key: string
  quantity?: number
  included?: boolean
  [k: string]: unknown
}

export type AddonInput = string | AddonObjectInput

export interface NormalizedAddon extends AddonObjectInput {
  key: string
  quantity: number
  included: boolean
}

/**
 * isEffectivelyIncluded — single source of truth for "is this add-on $0?"
 * Resolution order (most specific first):
 *   1. Explicit flag on the addon object (included: true/false)
 *   2. Custom-priced quote → default to included (locked total)
 *   3. Tiered quote → included if the key is a base task or tier upgrade
 */
export function isEffectivelyIncluded(
  addon: { key: string; included?: boolean },
  tier: string,
  hasCustomPrice: boolean,
  tenantSlug?: string
): boolean {
  if (addon.included === true) return true
  if (addon.included === false) return false
  if (hasCustomPrice) return true
  return isIncludedInTier(addon.key, tier, tenantSlug)
}

/**
 * normalizeAddon — turn any input shape into { key, quantity, included } with
 * the correct default so every call site agrees.
 */
export function normalizeAddon(
  raw: AddonInput,
  tier: string,
  hasCustomPrice: boolean,
  tenantSlug?: string
): NormalizedAddon {
  if (typeof raw === 'string') {
    return {
      key: raw,
      quantity: 1,
      included: isEffectivelyIncluded({ key: raw }, tier, hasCustomPrice, tenantSlug),
    }
  }
  const key = raw.key
  const quantity = Math.max(1, Math.floor(raw.quantity ?? 1))
  const included = isEffectivelyIncluded(raw, tier, hasCustomPrice, tenantSlug)
  return { key, quantity, included }
}

/**
 * normalizeAddons — bulk variant.
 */
export function normalizeAddons(
  raws: AddonInput[],
  tier: string,
  hasCustomPrice: boolean,
  tenantSlug?: string
): NormalizedAddon[] {
  return raws.map((r) => normalizeAddon(r, tier, hasCustomPrice, tenantSlug))
}

/**
 * getPaidAddons — legacy helper, now routed through isEffectivelyIncluded.
 * Filters out base tasks, tier-included items, and anything marked included.
 */
export function getPaidAddons<T extends AddonInput>(
  selectedAddons: T[],
  tier: string,
  hasCustomPrice: boolean = false,
  tenantSlug?: string
): T[] {
  return selectedAddons.filter((addon) => {
    const obj =
      typeof addon === 'string'
        ? { key: addon }
        : { key: addon.key, included: addon.included }
    return !isEffectivelyIncluded(obj, tier, hasCustomPrice, tenantSlug)
  })
}

// ---------------------------------------------------------------------------
// 6. getBaseChecklist — returns base checklist items for cleaner portal
//    Includes standard base tasks + tier upgrade items with labels
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  key: string
  label: string
  source: 'base' | 'tier_upgrade'
}

/** Addon key → human-readable label for tier upgrades shown in cleaner checklists */
const UPGRADE_LABELS: Record<string, string> = {
  inside_fridge: 'Inside fridge',
  inside_oven: 'Inside oven',
  inside_microwave: 'Inside microwave',
  inside_cabinets: 'Inside cabinets',
  inside_dishwasher: 'Inside dishwasher',
  range_hood: 'Range hood',
  baseboards: 'Baseboards',
  ceiling_fans: 'Ceiling fans',
  light_fixtures: 'Light fixtures',
  window_sills: 'Window sills',
  wall_cleaning: 'Wall cleaning',
  interior_windows: 'Interior windows (sills & glass)',
}

export function getBaseChecklist(tier: string, tenantSlug?: string): ChecklistItem[] {
  const items: ChecklistItem[] = STANDARD_BASE_TASKS.map((t) => ({
    key: t.key,
    label: t.label,
    source: 'base' as const,
  }))

  const seen = new Set<string>()
  const pushUpgrade = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    items.push({
      key,
      label: UPGRADE_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      source: 'tier_upgrade' as const,
    })
  }

  const upgrades = TIER_UPGRADES[tier]
  if (upgrades) {
    for (const key of upgrades) pushUpgrade(key)
  }
  for (const key of getTenantAdditions(tier, tenantSlug)) pushUpgrade(key)

  return items
}
