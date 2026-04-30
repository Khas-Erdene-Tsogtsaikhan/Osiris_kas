/**
 * Build 3 regression — website + Meta webhook wire-up gap.
 *
 * Bug: La Monica Jones (Spotless website lead, 2026-04-30 11:56 AM PT) and
 * Charles Lewis / Cory Gordon / Thomas Stephenson (Meta leads) all received
 * an AI intro SMS but no `followup.ghost_chase` task was ever scheduled
 * because the wire-up was only present in the OpenPhone webhook AI paths,
 * not the website or Meta webhook paths.
 *
 * This file validates that:
 *   1. wireFollowupsAfterOutbound creates 6 ghost-chase rows when called
 *      with an activeLeadId (the website + Meta webhook scenario).
 *   2. Calling the same wire twice is idempotent (no duplicate rows).
 *   3. The wire helper noops cleanly when the tenant is not v2-enabled
 *      (so accidentally wiring a non-v2 tenant is harmless).
 *
 * Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md (Build 3)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock scheduler with a real task store so we can assert dedup ───────
const taskStore: Array<{ tenantId: string; task_type: string; task_key: string; payload: any; status: string }> = []

const mockScheduleTask = vi.fn(async (input: any) => {
  // Mirror real scheduleTask behavior: task_key uniqueness via upsert
  const existing = taskStore.find(t => t.tenantId === input.tenantId && t.task_key === input.taskKey)
  if (existing) {
    existing.payload = input.payload
    existing.status = 'pending'
    return { success: true, taskId: 'reused' }
  }
  taskStore.push({
    tenantId: input.tenantId,
    task_type: input.taskType,
    task_key: input.taskKey,
    payload: input.payload,
    status: 'pending',
  })
  return { success: true, taskId: `task-${taskStore.length}` }
})

vi.mock('@/lib/scheduler', () => ({
  scheduleTask: (...args: any[]) => mockScheduleTask(...(args as [any])),
  cancelTask: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/lib/openphone', () => ({ sendSMS: vi.fn().mockResolvedValue({ success: true }) }))
vi.mock('@/lib/system-events', () => ({ logSystemEvent: vi.fn().mockResolvedValue(undefined) }))

const customerStore: any[] = []
function fakeChain(table: string) {
  let op: 'select' | 'update' = 'select'
  let mutData: any = null
  const matchers: Array<(r: any) => boolean> = []
  const builder: any = {
    eq(f: string, v: any) { matchers.push(r => r[f] === v); return builder },
    is(f: string, v: any) { matchers.push(r => (v === null ? r[f] == null : r[f] === v)); return builder },
    in(f: string, vs: any[]) { matchers.push(r => vs.includes(r[f])); return builder },
    not() { return builder },
    order() { return builder },
    limit() { return builder },
    select() { return builder },
    update(d: any) { op = 'update'; mutData = d; return builder },
    filter() { return builder },
    maybeSingle: async () => {
      const all = (table === 'customers' ? customerStore : []).filter(r => matchers.every(m => m(r)))
      if (op === 'update') for (const r of all) Object.assign(r, mutData)
      return { data: all[0] || null, error: null }
    },
    single: async () => builder.maybeSingle(),
    then: (resolve: any) => {
      const all = (table === 'customers' ? customerStore : []).filter(r => matchers.every(m => m(r)))
      if (op === 'update') for (const r of all) Object.assign(r, mutData)
      return resolve({ data: all, error: null })
    },
  }
  return builder
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({ from: (t: string) => fakeChain(t) }),
  getSupabaseClient: () => ({ from: (t: string) => fakeChain(t) }),
}))

import { wireFollowupsAfterOutbound } from '../../apps/house-cleaning/lib/services/followups/wire'

const TENANT_V2_ON = {
  id: 'tenant-spotless',
  slug: 'spotless-scrubbers',
  workflow_config: { followup_rebuild_v2_enabled: true },
}
const TENANT_V2_OFF = {
  id: 'tenant-cedar',
  slug: 'cedar-rapids',
  workflow_config: { followup_rebuild_v2_enabled: false },
}
const LA_MONICA = { id: 20963, phone_number: '+19515883385' }
const LA_MONICA_LEAD_ID = 5362

beforeEach(() => {
  taskStore.length = 0
  customerStore.length = 0
  customerStore.push({
    id: LA_MONICA.id,
    tenant_id: TENANT_V2_ON.id,
    first_name: 'Lamonica',
    phone_number: LA_MONICA.phone_number,
    unsubscribed_at: null,
    sms_opt_out: false,
    auto_response_paused: false,
    auto_response_disabled: false,
    human_takeover_until: null,
    manual_takeover_at: null,
  })
  mockScheduleTask.mockClear()
})

describe('Build 3 — website webhook wire-gap regression (La Monica)', () => {
  it('schedules 6 ghost-chase rows when website webhook calls wire after first-touch SMS', async () => {
    const res = await wireFollowupsAfterOutbound({
      tenant: TENANT_V2_ON,
      customer: LA_MONICA,
      quoteJustSent: false,
      activeLeadId: LA_MONICA_LEAD_ID,
      source: 'website_lead_auto',
    })
    expect(res.scheduled).toBe(true)
    expect(res.entity_type).toBe('lead')
    expect(res.reason).toBe('lead_chase_scheduled')
    const ghostTasks = taskStore.filter(t => t.task_type === 'followup.ghost_chase')
    expect(ghostTasks.length).toBe(6)
    // task_keys must be unique per step
    const keys = new Set(ghostTasks.map(t => t.task_key))
    expect(keys.size).toBe(6)
    // All 6 keys must reference the same lead entity
    for (const t of ghostTasks) {
      expect(t.task_key).toMatch(/^gc:lead:5362:[1-6]$/)
      expect(t.payload.entity_type).toBe('lead')
      expect(t.payload.entity_id).toBe(LA_MONICA_LEAD_ID)
      expect(t.payload.customer_id).toBe(LA_MONICA.id)
    }
  })

  it('is idempotent — calling twice produces the same 6 rows, not 12', async () => {
    await wireFollowupsAfterOutbound({
      tenant: TENANT_V2_ON,
      customer: LA_MONICA,
      quoteJustSent: false,
      activeLeadId: LA_MONICA_LEAD_ID,
      source: 'website_lead_auto',
    })
    await wireFollowupsAfterOutbound({
      tenant: TENANT_V2_ON,
      customer: LA_MONICA,
      quoteJustSent: false,
      activeLeadId: LA_MONICA_LEAD_ID,
      source: 'website_lead_auto',
    })
    const ghostTasks = taskStore.filter(t => t.task_type === 'followup.ghost_chase')
    expect(ghostTasks.length).toBe(6)
  })

  it('noops cleanly when the tenant is NOT v2-enabled', async () => {
    const res = await wireFollowupsAfterOutbound({
      tenant: TENANT_V2_OFF,
      customer: LA_MONICA,
      quoteJustSent: false,
      activeLeadId: LA_MONICA_LEAD_ID,
      source: 'website_lead_auto',
    })
    expect(res.scheduled).toBe(false)
    expect(res.reason).toBe('v2_disabled')
    expect(taskStore.length).toBe(0)
  })
})

describe('Build 3 — Meta webhook wire-gap regression (Charles)', () => {
  it('schedules 6 ghost-chase rows after Meta webhook first-touch SMS', async () => {
    const charlesId = 20979
    const charlesLeadId = 5367
    customerStore.push({
      id: charlesId,
      tenant_id: TENANT_V2_ON.id,
      first_name: 'Charles',
      phone_number: '+18178962140',
      unsubscribed_at: null,
      sms_opt_out: false,
      auto_response_paused: false,
      auto_response_disabled: false,
      human_takeover_until: null,
      manual_takeover_at: null,
    })

    const res = await wireFollowupsAfterOutbound({
      tenant: TENANT_V2_ON,
      customer: { id: charlesId, phone_number: '+18178962140' },
      quoteJustSent: false,
      activeLeadId: charlesLeadId,
      source: 'meta_lead_auto',
    })
    expect(res.scheduled).toBe(true)
    expect(res.entity_type).toBe('lead')
    const ghostTasks = taskStore.filter(t => t.task_type === 'followup.ghost_chase' && t.payload.customer_id === charlesId)
    expect(ghostTasks.length).toBe(6)
    expect(ghostTasks.every(t => t.payload.entity_id === charlesLeadId)).toBe(true)
  })
})

describe('Build 3 — wire is safe to call when no entity available', () => {
  it('returns no_eligible_entity when neither lead nor quote provided (does not crash)', async () => {
    const res = await wireFollowupsAfterOutbound({
      tenant: TENANT_V2_ON,
      customer: LA_MONICA,
      quoteJustSent: false,
      source: 'website_lead_auto',
    })
    expect(res.scheduled).toBe(false)
    expect(res.reason).toBe('no_eligible_entity')
    expect(taskStore.length).toBe(0)
  })
})
