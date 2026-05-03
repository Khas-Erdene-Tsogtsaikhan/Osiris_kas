/**
 * Cold-lead follow-up cadence templates (T5 — 2026-04-20).
 *
 * Three stages for prospects who received initial outbound and never replied.
 * Cadence: +4h, +1d, +3d. Cadence cancels on any inbound reply, any job
 * creation, any human takeover, or escalation.
 *
 * The templates are intentionally low-pressure and short — SMS norms. Never
 * mention discounts (ZERO price authority). Never promise email follow-up.
 *
 * Templates are tenant-aware: they pull the tenant's SDR persona + business
 * name short form so "Hi from Sarah at Spotless" reads naturally. WinBros is
 * excluded upstream (RETARGETING_EXCLUDED_TENANTS in cron-hours-guard).
 */

import type { Tenant } from './tenant'

export type ColdFollowupStage = 1 | 2 | 3

export interface ColdFollowupContext {
  tenant: Pick<Tenant, 'business_name_short' | 'business_name' | 'sdr_persona' | 'slug'>
  firstName?: string | null
}

function businessName(t: ColdFollowupContext['tenant']): string {
  return t.business_name_short || t.business_name || 'us'
}

function persona(t: ColdFollowupContext['tenant']): string {
  return t.sdr_persona || 'Sarah'
}

function name(ctx: ColdFollowupContext): string {
  return (ctx.firstName || '').trim() || 'there'
}

export function coldFollowupStage1(ctx: ColdFollowupContext): string {
  // +4h — light check-in
  return `Hi ${name(ctx)}, ${persona(ctx.tenant)} here from ${businessName(ctx.tenant)}. Just circling back — any questions I can answer to get your cleaning booked?`
}

export function coldFollowupStage2(ctx: ColdFollowupContext): string {
  // +1d — offer a smaller ask (just timing)
  return `Hey ${name(ctx)}, no pressure — just checking in. If now isn't the right time, totally cool. Happy to share our rates whenever you're ready. Just reply back when it works for you.`
}

export function coldFollowupStage3(ctx: ColdFollowupContext): string {
  // +3d — final, polite
  return `Last check-in from me, ${name(ctx)}. If you'd like to get on our schedule just reply and I'll set you up. Otherwise no worries — we're here when you need us.`
}

export function templateForStage(stage: ColdFollowupStage, ctx: ColdFollowupContext): string {
  switch (stage) {
    case 1: return coldFollowupStage1(ctx)
    case 2: return coldFollowupStage2(ctx)
    case 3: return coldFollowupStage3(ctx)
  }
}

/**
 * Minimum hours since the last agent message for each stage to be eligible.
 * Used by the cron query and the template gate.
 */
export const COLD_FOLLOWUP_MIN_HOURS: Record<ColdFollowupStage, number> = {
  1: 4,
  2: 24,
  3: 72,
}
