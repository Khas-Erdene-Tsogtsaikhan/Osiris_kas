/**
 * Customer Memory — personality JSONB built from chat history.
 *
 * OUTREACH-SPEC v1.0 Section 8.2.
 *
 * Refreshed lazily: when a cron or generator needs memory, it calls
 * `loadCustomerMemory`. If the memory is older than `STALE_HOURS` OR absent,
 * `buildCustomerMemory` re-scans the last 30 inbound/outbound messages
 * + jobs and writes a fresh row to `customer_memory`.
 *
 * Keep this dumb and deterministic. AI-generated summaries belong in the
 * message generator, not here. This is the scaffolding that FEEDS the
 * generator.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const STALE_HOURS = 48

export interface CustomerMemory {
  emojis_used: string[]
  casing_pattern: 'lower' | 'mixed' | 'formal'
  place_nickname?: string | null
  pets: Array<{ name?: string | null; type?: string | null }>
  kids: Array<{ name?: string | null; age?: string | null }>
  partner?: string | null
  inside_jokes: string[]
  known_objections: string[]
  last_excited_about?: string | null
  last_annoyed_about?: string | null
  /**
   * Raw phrases pulled from their messages that are safe to quote back as
   * a callback anchor (Pipeline C requires at least one of these to appear
   * in any generated message).
   */
  callback_anchors: string[]
  /** 0-1 signal of how "warm" their last exchange was. */
  warmth_signal: number
}

export function emptyMemory(): CustomerMemory {
  return {
    emojis_used: [],
    casing_pattern: 'mixed',
    pets: [],
    kids: [],
    inside_jokes: [],
    known_objections: [],
    callback_anchors: [],
    warmth_signal: 0.5,
  }
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu

const PET_RE = /\b(my|our)\s+(dog|cat|puppy|kitten|pup|pet)\s*(?:named?)?\s*([A-Za-z][A-Za-z\-']{1,20})?/i
const KID_RE = /\b(my|our)\s+(kid|kids|son|daughter|child|children|baby|twins)\b([^.]{0,60})?/i
const OBJECTION_RE = /\b(too\s+expensive|too\s+much|cant\s+afford|can't\s+afford|price\s+too|pricey|budget|not\s+in\s+my\s+budget|out\s+of\s+budget|already\s+have\s+a\s+cleaner|using\s+someone\s+else)\b/i
const EXCITEMENT_RE = /\b(excited|cant\s+wait|can't\s+wait|moving\s+in|party|baby\s+shower|renovation|kitchen\s+reno|new\s+house)\b/i

export function analyzeMessages(messages: Array<{ direction: string; content: string | null }>): CustomerMemory {
  const memory = emptyMemory()
  if (!messages?.length) return memory

  const inbound = messages.filter(m => m.direction === 'inbound' && m.content)

  // Casing pattern
  let lowerCount = 0, upperCount = 0, total = 0
  for (const m of inbound) {
    const txt = (m.content || '').replace(/[^a-zA-Z]/g, '')
    if (!txt) continue
    total++
    const upper = txt.replace(/[^A-Z]/g, '').length
    const lower = txt.replace(/[^a-z]/g, '').length
    if (upper === 0) lowerCount++
    else if (upper / (upper + lower) > 0.4) upperCount++
  }
  if (total > 2) {
    if (lowerCount / total > 0.7) memory.casing_pattern = 'lower'
    else if (upperCount / total > 0.3) memory.casing_pattern = 'formal'
  }

  // Emojis used
  const emojiSet = new Set<string>()
  for (const m of inbound) {
    const hits = (m.content || '').match(EMOJI_RE) || []
    for (const e of hits) emojiSet.add(e)
  }
  memory.emojis_used = Array.from(emojiSet).slice(0, 10)

  // Pets
  for (const m of inbound) {
    const match = (m.content || '').match(PET_RE)
    if (match) {
      memory.pets.push({ type: match[2]?.toLowerCase() ?? null, name: match[3] ?? null })
    }
  }

  // Kids
  for (const m of inbound) {
    const match = (m.content || '').match(KID_RE)
    if (match) {
      memory.kids.push({ name: null, age: match[3]?.trim() ?? null })
    }
  }

  // Objections
  for (const m of inbound) {
    const match = (m.content || '').match(OBJECTION_RE)
    if (match) memory.known_objections.push(match[0].toLowerCase())
  }

  // Excitement
  for (const m of inbound) {
    const match = (m.content || '').match(EXCITEMENT_RE)
    if (match) {
      memory.last_excited_about = match[0]
      break
    }
  }

  // Callback anchors — short quotable bits from their messages (2–6 words)
  const anchors: string[] = []
  for (const m of inbound) {
    const txt = (m.content || '').trim()
    if (!txt) continue
    const sentences = txt.split(/[.!?]+/).map(s => s.trim()).filter(Boolean)
    for (const s of sentences) {
      const words = s.split(/\s+/)
      if (words.length >= 2 && words.length <= 8 && s.length < 50) {
        anchors.push(s)
      }
    }
    if (anchors.length >= 8) break
  }
  memory.callback_anchors = Array.from(new Set(anchors)).slice(0, 8)

  // Warmth signal — proportion of inbound that was non-objection, non-terse
  const warm = inbound.filter(m => (m.content || '').length > 12 && !OBJECTION_RE.test(m.content || '')).length
  memory.warmth_signal = inbound.length ? Math.min(1, warm / inbound.length) : 0.5

  return memory
}

export async function buildCustomerMemory(
  client: SupabaseClient,
  tenantId: string,
  customerId: number,
): Promise<CustomerMemory> {
  const { data: messages } = await client
    .from('messages')
    .select('direction, content, timestamp')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .order('timestamp', { ascending: false })
    .limit(30)

  const memory = analyzeMessages(messages || [])

  // Upsert
  await client
    .from('customer_memory')
    .upsert({
      tenant_id: tenantId,
      customer_id: customerId,
      personality: memory,
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,customer_id' })

  return memory
}

export async function loadCustomerMemory(
  client: SupabaseClient,
  tenantId: string,
  customerId: number,
): Promise<CustomerMemory> {
  const { data } = await client
    .from('customer_memory')
    .select('personality, last_refreshed_at')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .maybeSingle()

  if (!data || !data.last_refreshed_at) {
    return buildCustomerMemory(client, tenantId, customerId)
  }

  const refreshedAt = new Date(data.last_refreshed_at)
  const ageHours = (Date.now() - refreshedAt.getTime()) / (1000 * 60 * 60)
  if (ageHours > STALE_HOURS) {
    return buildCustomerMemory(client, tenantId, customerId)
  }

  return { ...emptyMemory(), ...(data.personality as Partial<CustomerMemory>) }
}
