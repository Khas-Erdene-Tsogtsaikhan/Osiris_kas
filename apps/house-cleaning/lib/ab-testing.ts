/**
 * A/B Testing — variant selection + template lookup.
 *
 * OUTREACH-SPEC v1.0 Section 9. Deterministic split: variant = customerId % 2.
 * The statistical wiring + nightly rollup lives in SQL (ab_results MV +
 * outreach-audit cron). This file is just the hot-path helpers that crons
 * use at send time.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type Variant = 'a' | 'b'
export type Pipeline = 'pre_quote' | 'post_quote' | 'retargeting'

export interface MessageTemplate {
  id: number
  tenant_id: string | null // null = global
  pipeline: Pipeline
  stage: number
  variant: Variant
  prompt_template: string
  status: 'active' | 'retired'
}

/** Deterministic 50/50 split based on customer id. */
export function pickVariant(customerId: number): Variant {
  return customerId % 2 === 0 ? 'a' : 'b'
}

/**
 * Fetch the active template for a (tenant, pipeline, stage, variant). Falls
 * back to the global template (tenant_id IS NULL) if the tenant has no override.
 */
export async function getActiveTemplate(
  client: SupabaseClient,
  opts: { tenantId: string; pipeline: Pipeline; stage: number; variant: Variant },
): Promise<MessageTemplate | null> {
  const { data: tenantSpecific } = await client
    .from('message_templates')
    .select('id, tenant_id, pipeline, stage, variant, prompt_template, status')
    .eq('tenant_id', opts.tenantId)
    .eq('pipeline', opts.pipeline)
    .eq('stage', opts.stage)
    .eq('variant', opts.variant)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  if (tenantSpecific) return tenantSpecific as MessageTemplate

  const { data: global } = await client
    .from('message_templates')
    .select('id, tenant_id, pipeline, stage, variant, prompt_template, status')
    .is('tenant_id', null)
    .eq('pipeline', opts.pipeline)
    .eq('stage', opts.stage)
    .eq('variant', opts.variant)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()

  return (global as MessageTemplate | null) ?? null
}
