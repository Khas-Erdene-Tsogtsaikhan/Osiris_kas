/**
 * Intake state machine (T4 — 2026-04-20).
 *
 * Deterministically decides whether an inbound conversation has collected
 * enough facts to produce a quote. When yes, returns a directive for the
 * caller to fire the quote-generation path; when no, returns the single
 * gap to ask about next.
 *
 * This fixes the Natasha Jones stall where the agent asked for bedrooms then
 * bathrooms then stopped — the LLM prompt said "ask questions" but had no
 * post-condition to transition to "send quote." Now the state machine runs
 * on every AI turn and forces the transition.
 *
 * Required fields for a house-cleaning quote:
 *   - service_type      (standard | deep | move_in_out | airbnb | commercial | post_construction)
 *   - bedrooms          (integer, unless service is a specialized type)
 *   - bathrooms         (integer, same caveat)
 *   - address           (full street — city alone isn't enough for routing)
 *   - preferred_date    (any of "tomorrow", "this Friday", explicit ISO)
 *
 * Specialized services (commercial/post-construction/airbnb) don't need
 * bed/bath — they need a description of the space instead.
 */

import type { KnownCustomerInfo } from './auto-response'

export type ServiceCategory =
  | 'standard'
  | 'deep'
  | 'move_in_out'
  | 'airbnb'
  | 'commercial'
  | 'post_construction'

export interface IntakeSnapshot {
  service_type?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  address?: string | null
  preferred_date?: string | null
  space_description?: string | null
}

export type IntakeGap =
  | 'service_type'
  | 'bedrooms'
  | 'bathrooms'
  | 'address'
  | 'preferred_date'
  | 'space_description'

export interface IntakeDecision {
  complete: boolean
  gaps: IntakeGap[]
  nextQuestion: string | null
  /** The first missing gap callers should focus on when composing the next prompt. */
  focus: IntakeGap | null
}

const STANDARD_REQUIRED: IntakeGap[] = ['service_type', 'bedrooms', 'bathrooms', 'address', 'preferred_date']
const SPECIALIZED_REQUIRED: IntakeGap[] = ['service_type', 'address', 'space_description', 'preferred_date']

const SPECIALIZED_SERVICES = new Set<string>(['commercial', 'post_construction', 'post-construction', 'airbnb', 'airbnb-cleaning'])

function isSpecialized(service?: string | null): boolean {
  if (!service) return false
  return SPECIALIZED_SERVICES.has(service)
}

function present<K extends keyof IntakeSnapshot>(snap: IntakeSnapshot, field: K): boolean {
  const v = snap[field]
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (typeof v === 'number' && Number.isNaN(v)) return false
  return true
}

const QUESTIONS: Record<IntakeGap, string> = {
  service_type: 'What kind of clean are you looking for — standard, deep, or move-in/out?',
  bedrooms: 'How many bedrooms does your home have?',
  bathrooms: 'How many bathrooms (including half-baths)?',
  address: 'What is the full street address?',
  preferred_date: 'What day works best for your cleaning?',
  space_description: 'Roughly how big is the space and what shape is it in? (a quick sentence is fine)',
}

export function decideIntake(snapshot: IntakeSnapshot): IntakeDecision {
  const required = isSpecialized(snapshot.service_type) ? SPECIALIZED_REQUIRED : STANDARD_REQUIRED
  const gaps: IntakeGap[] = []

  for (const field of required) {
    if (!present(snapshot, field as keyof IntakeSnapshot)) gaps.push(field)
  }

  const complete = gaps.length === 0
  const focus = complete ? null : gaps[0]
  const nextQuestion = focus ? QUESTIONS[focus] : null

  return { complete, gaps, nextQuestion, focus }
}

/**
 * Merge known facts from multiple sources (form submission, customer record,
 * known-info from retargeting payload) into a single snapshot for the state
 * machine. Later sources override earlier when both are present.
 */
export function buildIntakeSnapshot(
  formData: Record<string, unknown> | null | undefined,
  customer: { address?: string | null; bedrooms?: number | null; bathrooms?: number | null } | null | undefined,
  knownInfo: KnownCustomerInfo | null | undefined,
): IntakeSnapshot {
  const fd = formData ?? {}
  return {
    service_type:
      (fd.service_type as string) ||
      (fd.serviceType as string) ||
      (knownInfo?.serviceType as string) ||
      null,
    bedrooms:
      (typeof fd.bedrooms === 'number' ? fd.bedrooms : null) ??
      customer?.bedrooms ??
      knownInfo?.bedrooms ??
      null,
    bathrooms:
      (typeof fd.bathrooms === 'number' ? fd.bathrooms : null) ??
      customer?.bathrooms ??
      knownInfo?.bathrooms ??
      null,
    address:
      (fd.address as string) ||
      customer?.address ||
      knownInfo?.address ||
      null,
    preferred_date:
      (fd.preferred_date as string) ||
      (fd.preferredDate as string) ||
      null,
    space_description:
      (fd.message as string) ||
      (fd.notes as string) ||
      (fd.space_description as string) ||
      null,
  }
}
