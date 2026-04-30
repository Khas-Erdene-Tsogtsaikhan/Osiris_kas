#!/usr/bin/env tsx
/**
 * v2 ORPHAN backfill — recover fresh leads from the last N hours that got
 * an AI intro SMS but no followup.ghost_chase task scheduled (because the
 * wire-up was missed at the original entry point).
 *
 * This is the one-shot recovery for the 2026-04-30 incident: La Monica
 * (Spotless website lead) + Charles/Cory/Thomas (Meta leads) + any other
 * orphans accumulated since the v2 flag flip on 2026-04-29. After Build 3
 * deploys, the wire-check-net cron handles new orphans automatically; this
 * script is for the catch-up window prior to that.
 *
 * Differs from v2-backfill-ghosted-leads.ts (retargeting backfill for past
 * customers) — this is for FRESH leads in active flow.
 *
 * Action: For each orphan, schedule the 6-step ghost chase. Honors all of
 * the wire helper's hard gates: v2-enabled tenant, no unsubscribe, no human
 * takeover, no existing pending chase.
 *
 * Modes:
 *   default (DRY-RUN)             — counts + samples, no DB writes
 *   ORPHAN_LIVE=true              — actually wire orphans
 *   ORPHAN_TENANT=slug            — limit to one tenant (default: all four HC)
 *   ORPHAN_LOOKBACK_HOURS=N       — message lookback (default 48)
 *   ORPHAN_MAX_PER_RUN=N          — cap (default 100)
 *
 * Usage:
 *   pnpm tsx scripts/v2-orphan-leads-backfill.ts
 *   ORPHAN_LIVE=true pnpm tsx scripts/v2-orphan-leads-backfill.ts
 *   ORPHAN_TENANT=spotless-scrubbers ORPHAN_LIVE=true pnpm tsx scripts/v2-orphan-leads-backfill.ts
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const LIVE = process.env.ORPHAN_LIVE === 'true'
const TENANT_SLUG = process.env.ORPHAN_TENANT || ''
const LOOKBACK_HOURS = parseInt(process.env.ORPHAN_LOOKBACK_HOURS || '48', 10)
const MAX_PER_RUN = parseInt(process.env.ORPHAN_MAX_PER_RUN || '100', 10)

const HC_TENANT_SLUGS = ['spotless-scrubbers', 'cedar-rapids', 'west-niagara', 'texas-nova']

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const GHOST_CHASE_CADENCE = [
  { step: 1, offset_minutes: 7 },
  { step: 2, offset_minutes: 60 },
  { step: 3, offset_minutes: 24 * 60 },
  { step: 4, offset_minutes: 48 * 60 },
  { step: 5, offset_minutes: 96 * 60 },
  { step: 6, offset_minutes: 120 * 60 },
]

interface OrphanCandidate {
  customer_id: number
  tenant_id: string
  tenant_slug: string
  first_name: string | null
  phone_number: string | null
  first_msg_at: string
  first_msg_source: string | null
  active_lead_id: number | null
  active_quote_id: number | null
}

async function findOrphans(slugs: string[]): Promise<OrphanCandidate[]> {
  const cutoffIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60_000).toISOString()
  const candidates: OrphanCandidate[] = []

  // Tenant filter
  const { data: tenants, error: tenantsErr } = await supabase
    .from('tenants')
    .select('id, slug, workflow_config')
    .in('slug', slugs)
  if (tenantsErr || !tenants) {
    console.error('Failed to fetch tenants:', tenantsErr?.message)
    return []
  }

  for (const tenant of tenants) {
    const v2Enabled = !!(tenant.workflow_config as Record<string, unknown> | null)?.followup_rebuild_v2_enabled
    if (!v2Enabled) {
      console.log(`[${tenant.slug}] v2 disabled — skipping`)
      continue
    }

    // Pull AI-generated outbound messages in the lookback window
    const { data: msgs, error: msgErr } = await supabase
      .from('messages')
      .select('id, customer_id, source, created_at')
      .eq('tenant_id', tenant.id)
      .eq('direction', 'outbound')
      .eq('ai_generated', true)
      .gte('created_at', cutoffIso)
      .not('customer_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(500)
    if (msgErr) {
      console.error(`[${tenant.slug}] message query failed:`, msgErr.message)
      continue
    }
    if (!msgs || msgs.length === 0) {
      console.log(`[${tenant.slug}] no recent ai-generated outbound messages`)
      continue
    }

    // Dedup by customer
    const firstByCustomer = new Map<number, { id: string; source: string | null; created_at: string }>()
    for (const m of msgs) {
      const cid = m.customer_id as number
      if (!firstByCustomer.has(cid)) {
        firstByCustomer.set(cid, { id: m.id, source: m.source, created_at: m.created_at })
      }
    }

    console.log(`[${tenant.slug}] ${firstByCustomer.size} customers with recent AI outbound — checking for orphans`)

    for (const [customerId, first] of firstByCustomer.entries()) {
      // Check customer state
      const { data: cust } = await supabase
        .from('customers')
        .select('id, first_name, phone_number, unsubscribed_at, sms_opt_out, auto_response_paused, auto_response_disabled, human_takeover_until, manual_takeover_at')
        .eq('id', customerId)
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      if (!cust) continue
      if (cust.unsubscribed_at || cust.sms_opt_out) continue
      if (cust.auto_response_disabled) continue
      if (cust.auto_response_paused) continue
      if (cust.human_takeover_until && new Date(cust.human_takeover_until).getTime() > Date.now()) continue
      if (cust.manual_takeover_at) {
        const ageMs = Date.now() - new Date(cust.manual_takeover_at).getTime()
        if (ageMs < 30 * 60_000) continue
      }

      // Skip if a ghost chase is already pending
      const { count: pendingCount } = await supabase
        .from('scheduled_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('task_type', 'followup.ghost_chase')
        .eq('status', 'pending')
        .filter('payload->>customer_id', 'eq', String(customerId))
      if ((pendingCount || 0) > 0) continue

      // Resolve active entity (prefer quote)
      const { data: quote } = await supabase
        .from('quotes')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('customer_id', customerId)
        .in('status', ['sent', 'viewed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      let activeLeadId: number | null = null
      if (!quote?.id) {
        const { data: lead } = await supabase
          .from('leads')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('customer_id', customerId)
          .in('status', ['new', 'contacted', 'qualifying'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        activeLeadId = lead?.id ?? null
      }

      if (!quote?.id && !activeLeadId) continue

      candidates.push({
        customer_id: customerId,
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        first_name: cust.first_name,
        phone_number: cust.phone_number,
        first_msg_at: first.created_at,
        first_msg_source: first.source,
        active_lead_id: activeLeadId,
        active_quote_id: quote?.id ?? null,
      })

      if (candidates.length >= MAX_PER_RUN) break
    }
    if (candidates.length >= MAX_PER_RUN) break
  }

  return candidates
}

async function scheduleOrphanChase(c: OrphanCandidate): Promise<{ scheduled: number; errors: string[] }> {
  const errors: string[] = []
  let scheduled = 0
  const ghostStartedAt = new Date()
  const entityType = c.active_quote_id ? 'quote' : 'lead'
  const entityId = (c.active_quote_id ?? c.active_lead_id) as number

  for (const step of GHOST_CHASE_CADENCE) {
    const runAt = new Date(ghostStartedAt.getTime() + step.offset_minutes * 60_000).toISOString()
    const taskKey = `gc:${entityType}:${entityId}:${step.step}`
    const { error } = await supabase.from('scheduled_tasks').upsert({
      tenant_id: c.tenant_id,
      task_type: 'followup.ghost_chase',
      task_key: taskKey,
      scheduled_for: runAt,
      payload: {
        entity_type: entityType,
        entity_id: entityId,
        customer_id: c.customer_id,
        step_index: step.step,
        ghost_started_at: ghostStartedAt.toISOString(),
        phone: c.phone_number,
      },
      status: 'pending',
      max_attempts: 2,
    }, { onConflict: 'tenant_id,task_key' })
    if (error) {
      errors.push(`step ${step.step}: ${error.message}`)
    } else {
      scheduled += 1
    }
  }

  if (scheduled > 0) {
    await supabase.from('system_events').insert({
      tenant_id: c.tenant_id,
      source: 'ghost-chase',
      event_type: 'GHOST_CHASE_SCHEDULED',
      message: `Ghost chase backfilled (${entityType}#${entityId}, customer ${c.customer_id})`,
      customer_id: String(c.customer_id),
      metadata: {
        scheduled,
        total: GHOST_CHASE_CADENCE.length,
        backfill_run: true,
        run_label: 'orphan_backfill_20260430',
        first_msg_source: c.first_msg_source,
        first_msg_at: c.first_msg_at,
      },
    })
  }

  return { scheduled, errors }
}

async function main() {
  const slugs = TENANT_SLUG ? [TENANT_SLUG] : HC_TENANT_SLUGS
  console.log(`\n========== v2 Orphan Leads Backfill ==========`)
  console.log(`Mode: ${LIVE ? 'LIVE' : 'DRY-RUN'}`)
  console.log(`Tenants: ${slugs.join(', ')}`)
  console.log(`Lookback: ${LOOKBACK_HOURS}h`)
  console.log(`Max per run: ${MAX_PER_RUN}`)
  console.log(`==============================================\n`)

  const orphans = await findOrphans(slugs)
  console.log(`\nFound ${orphans.length} orphan(s) total`)

  // Group by tenant
  const byTenant = new Map<string, OrphanCandidate[]>()
  for (const o of orphans) {
    const arr = byTenant.get(o.tenant_slug) || []
    arr.push(o)
    byTenant.set(o.tenant_slug, arr)
  }
  for (const [slug, arr] of byTenant.entries()) {
    console.log(`  ${slug}: ${arr.length}`)
  }

  if (orphans.length === 0) {
    console.log('\nNo orphans to enroll. Exiting.')
    return
  }

  console.log('\nSample (first 10):')
  for (const o of orphans.slice(0, 10)) {
    const entity = o.active_quote_id ? `quote#${o.active_quote_id}` : `lead#${o.active_lead_id}`
    console.log(`  ${o.tenant_slug} customer#${o.customer_id} (${o.first_name || '?'}) ${entity} | first msg ${o.first_msg_at} via ${o.first_msg_source}`)
  }

  if (!LIVE) {
    console.log(`\n[DRY-RUN] No changes made. Re-run with ORPHAN_LIVE=true to enroll.`)
    return
  }

  console.log(`\n[LIVE] Scheduling ghost chase for ${orphans.length} orphan(s)...`)
  let scheduled = 0
  let failed = 0
  for (const o of orphans) {
    const res = await scheduleOrphanChase(o)
    if (res.scheduled > 0) {
      scheduled += 1
      const entity = o.active_quote_id ? `quote#${o.active_quote_id}` : `lead#${o.active_lead_id}`
      console.log(`  ✓ ${o.tenant_slug} customer#${o.customer_id} ${entity} (${res.scheduled}/6 steps)`)
    } else {
      failed += 1
      console.error(`  ✗ ${o.tenant_slug} customer#${o.customer_id} — errors: ${res.errors.join('; ')}`)
    }
  }

  console.log(`\nDone. Scheduled chase for ${scheduled} customer(s); ${failed} failure(s).`)
}

main().catch(err => {
  console.error('Backfill crashed:', err)
  process.exit(1)
})
