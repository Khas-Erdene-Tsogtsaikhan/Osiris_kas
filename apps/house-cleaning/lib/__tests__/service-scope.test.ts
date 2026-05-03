import { describe, it, expect } from 'vitest'
import {
  STANDARD_BASE_TASKS,
  STANDARD_BASE_KEYS,
  TIER_UPGRADES,
  isIncludedInTier,
  getPaidAddons,
  getBaseChecklist,
} from '../service-scope'

describe('service-scope', () => {
  describe('STANDARD_BASE_TASKS', () => {
    it('has exactly 5 base tasks', () => {
      expect(STANDARD_BASE_TASKS).toHaveLength(5)
    })

    it('contains all standard cleaning tasks', () => {
      const keys = STANDARD_BASE_TASKS.map(t => t.key)
      expect(keys).toContain('kitchen_surfaces')
      expect(keys).toContain('bathroom_sanitize')
      expect(keys).toContain('vacuum_mop')
      expect(keys).toContain('dusting')
      expect(keys).toContain('trash_removal')
    })

    it('each task has key and label', () => {
      for (const task of STANDARD_BASE_TASKS) {
        expect(task.key).toBeTruthy()
        expect(task.label).toBeTruthy()
      }
    })
  })

  describe('STANDARD_BASE_KEYS', () => {
    it('is a Set matching STANDARD_BASE_TASKS keys', () => {
      expect(STANDARD_BASE_KEYS.size).toBe(5)
      for (const task of STANDARD_BASE_TASKS) {
        expect(STANDARD_BASE_KEYS.has(task.key)).toBe(true)
      }
    })
  })

  describe('TIER_UPGRADES', () => {
    it('has entries for deep and move', () => {
      expect(TIER_UPGRADES.deep).toBeDefined()
      expect(TIER_UPGRADES.move).toBeDefined()
    })

    it('has no entry for standard (no upgrades)', () => {
      expect(TIER_UPGRADES.standard).toBeUndefined()
    })

    it('deep includes fridge, oven, microwave, baseboards', () => {
      expect(TIER_UPGRADES.deep).toContain('inside_fridge')
      expect(TIER_UPGRADES.deep).toContain('inside_oven')
      expect(TIER_UPGRADES.deep).toContain('baseboards')
    })

    it('move includes everything in deep plus cabinets, dishwasher', () => {
      expect(TIER_UPGRADES.move).toContain('inside_fridge')
      expect(TIER_UPGRADES.move).toContain('inside_cabinets')
      expect(TIER_UPGRADES.move).toContain('inside_dishwasher')
    })
  })

  describe('isIncludedInTier', () => {
    it('base tasks are included in every tier', () => {
      expect(isIncludedInTier('kitchen_surfaces', 'standard')).toBe(true)
      expect(isIncludedInTier('kitchen_surfaces', 'deep')).toBe(true)
      expect(isIncludedInTier('kitchen_surfaces', 'move')).toBe(true)
      expect(isIncludedInTier('vacuum_mop', 'standard')).toBe(true)
    })

    it('deep upgrades are included in deep, not standard', () => {
      expect(isIncludedInTier('inside_fridge', 'deep')).toBe(true)
      expect(isIncludedInTier('inside_fridge', 'standard')).toBe(false)
    })

    it('move upgrades are included in move, not standard or deep', () => {
      expect(isIncludedInTier('inside_cabinets', 'move')).toBe(true)
      expect(isIncludedInTier('inside_cabinets', 'standard')).toBe(false)
      expect(isIncludedInTier('inside_cabinets', 'deep')).toBe(false)
    })

    it('paid-only add-ons are not included in any tier', () => {
      expect(isIncludedInTier('blinds', 'standard')).toBe(false)
      expect(isIncludedInTier('blinds', 'deep')).toBe(false)
      expect(isIncludedInTier('blinds', 'move')).toBe(false)
      expect(isIncludedInTier('pet_fee', 'standard')).toBe(false)
    })

    it('handles unknown tier gracefully', () => {
      expect(isIncludedInTier('kitchen_surfaces', 'unknown')).toBe(true) // base task
      expect(isIncludedInTier('inside_fridge', 'unknown')).toBe(false)
    })

    it('West Niagara: interior_windows is included in standard and deep (not other tenants)', () => {
      expect(isIncludedInTier('interior_windows', 'standard', 'west-niagara')).toBe(true)
      expect(isIncludedInTier('interior_windows', 'deep', 'west-niagara')).toBe(true)
      // Other tenants: never included
      expect(isIncludedInTier('interior_windows', 'standard', 'spotless-scrubbers')).toBe(false)
      expect(isIncludedInTier('interior_windows', 'deep', 'cedar-rapids')).toBe(false)
      // No tenant context: never included (backward compat)
      expect(isIncludedInTier('interior_windows', 'standard')).toBe(false)
      expect(isIncludedInTier('interior_windows', 'deep')).toBe(false)
    })
  })

  describe('getPaidAddons', () => {
    it('filters out base tasks from string array', () => {
      const selected = ['kitchen_surfaces', 'blinds', 'vacuum_mop', 'pet_fee']
      const paid = getPaidAddons(selected, 'standard')
      expect(paid).toEqual(['blinds', 'pet_fee'])
    })

    it('filters out base tasks from object array', () => {
      const selected = [
        { key: 'kitchen_surfaces', quantity: 1 },
        { key: 'blinds', quantity: 1 },
        { key: 'inside_fridge', quantity: 1 },
      ]
      const paid = getPaidAddons(selected, 'standard')
      expect(paid).toEqual([
        { key: 'blinds', quantity: 1 },
        { key: 'inside_fridge', quantity: 1 },
      ])
    })

    it('for deep tier, also filters out tier upgrades', () => {
      const selected = [
        { key: 'kitchen_surfaces', quantity: 1 },
        { key: 'blinds', quantity: 1 },
        { key: 'inside_fridge', quantity: 1 },
      ]
      const paid = getPaidAddons(selected, 'deep')
      expect(paid).toEqual([{ key: 'blinds', quantity: 1 }])
    })

    it('returns empty array for empty input', () => {
      expect(getPaidAddons([], 'standard')).toEqual([])
    })

    it('returns all items if none are included', () => {
      const selected = ['blinds', 'pet_fee', 'windows_interior']
      const paid = getPaidAddons(selected, 'standard')
      expect(paid).toEqual(selected)
    })

    // THE BREE BUG: this test prevents regression
    it('Bree scenario — correctly filters standard tasks from her quote addons', () => {
      const breeAddons = [
        { key: 'kitchen_surfaces', quantity: 1 },
        { key: 'bathroom_sanitize', quantity: 1 },
        { key: 'vacuum_mop', quantity: 1 },
        { key: 'dusting', quantity: 1 },
        { key: 'trash_removal', quantity: 1 },
        { key: 'blinds', quantity: 1 },
        { key: 'ceiling_fans', quantity: 1 },
        { key: 'inside_oven', quantity: 1 },
      ]
      const paid = getPaidAddons(breeAddons, 'standard')
      expect(paid.map(a => a.key)).toEqual(['blinds', 'ceiling_fans', 'inside_oven'])
    })
  })

  describe('getBaseChecklist', () => {
    it('standard tier returns only base tasks', () => {
      const items = getBaseChecklist('standard')
      expect(items.length).toBe(5)
      expect(items.every(i => i.source === 'base')).toBe(true)
    })

    it('deep tier returns base tasks + upgrades', () => {
      const items = getBaseChecklist('deep')
      const baseTasks = items.filter(i => i.source === 'base')
      const upgrades = items.filter(i => i.source === 'tier_upgrade')
      expect(baseTasks.length).toBe(5)
      expect(upgrades.length).toBe(TIER_UPGRADES.deep.length)
    })

    it('all items have key, label, and source', () => {
      for (const item of getBaseChecklist('move')) {
        expect(item.key).toBeTruthy()
        expect(item.label).toBeTruthy()
        expect(['base', 'tier_upgrade']).toContain(item.source)
      }
    })

    it('West Niagara: interior_windows appears on standard and deep checklists', () => {
      const std = getBaseChecklist('standard', 'west-niagara')
      expect(std.some((i) => i.key === 'interior_windows' && i.label === 'Interior windows (sills & glass)')).toBe(true)

      const deep = getBaseChecklist('deep', 'west-niagara')
      expect(deep.some((i) => i.key === 'interior_windows')).toBe(true)
      // window_sills (existing deep upgrade) still present — no dedup required, the keys are distinct
      expect(deep.some((i) => i.key === 'window_sills')).toBe(true)

      // Other tenants: interior_windows NOT in checklist
      const spotless = getBaseChecklist('standard', 'spotless-scrubbers')
      expect(spotless.some((i) => i.key === 'interior_windows')).toBe(false)
    })
  })
})
