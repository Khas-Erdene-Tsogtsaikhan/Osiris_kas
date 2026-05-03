/**
 * Extract appointment datetime corrections from operator-origin SMS.
 *
 * Why: when a human operator (e.g., TJ at West Niagara) corrects an appointment
 * via the shared OpenPhone inbox ("Sorry we meant Wed 11am"), the agent needs
 * to know the booking time changed. Without this extractor, the correction
 * lives only in conversation history — when the agent re-engages 15 min later,
 * the `jobs.scheduled_at` still has the old time and the agent reverts to it.
 *
 * Flow:
 *   1. `looksLikeDatetimeCorrection()` — cheap regex pre-filter, skip if false
 *   2. `extractDatetimeCorrection()` — Haiku structured extraction
 *   3. Caller applies UPSERT to `jobs.scheduled_at` if confidence > 0.7
 *
 * Cost: Haiku is ~$0.25/1M input tokens, ~$1.25/1M output. Average cost per
 * extraction ~ $0.0003. We only call Haiku on messages that pass the regex
 * pre-filter, so volume is low.
 *
 * Incident: West Niagara (Paige Elizabeth), 2026-04-20. TJ corrected Tue 9am
 * to Wed 11am; AI reverted to Tue 9am on the next turn.
 */

import Anthropic from '@anthropic-ai/sdk'

const DAY_OF_WEEK_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|today|tomorrow)\b/i
const TIME_PATTERN = /\b(1[0-2]|0?[1-9])(?::[0-5]\d)?\s?(?:am|pm|a\.m\.|p\.m\.)\b/i
const CORRECTION_PHRASES = /\b(actually|sorry|wait|meant|correction|change|instead|not|reschedule|move)\b/i

/**
 * Cheap regex pre-filter. Only Haiku-extract messages that plausibly mention
 * a day + time (with or without a correction word). Keeps per-message cost
 * negligible on non-datetime operator messages ("ok thanks", "on my way").
 */
export function looksLikeDatetimeCorrection(content: string): boolean {
  if (!content || content.length < 4) return false
  const hasDayOrTime = DAY_OF_WEEK_PATTERN.test(content) || TIME_PATTERN.test(content)
  // Either day+time combo OR an explicit correction phrase with either.
  if (!hasDayOrTime) return false
  return true
}

export interface DatetimeCorrection {
  hasChange: boolean
  newDatetimeIso: string | null
  confidence: number // 0..1
  reasoning: string
}

const EXTRACTION_SYSTEM_PROMPT = `You are a structured extractor for appointment datetime corrections in SMS messages from cleaning business staff to customers.

Your job: given one short SMS from the STAFF to the CUSTOMER, decide whether it communicates a new/updated appointment time, and if so extract that datetime.

Return JSON ONLY, matching this shape:
{
  "hasChange": boolean,
  "newDatetimeIso": string | null,   // ISO 8601 in the tenant's local timezone, e.g. "2026-04-22T11:00:00"
  "confidence": number,              // 0..1, your confidence the extraction is correct
  "reasoning": string                // 1 short sentence of why
}

Rules:
- Only set hasChange=true when the staff is communicating a specific new appointment time to the customer. Pleasantries, confirmations of existing times, and unrelated chat → hasChange=false.
- If the message references a day but no time (e.g., "see you Thursday"), set hasChange=false (not specific enough).
- "Tomorrow" and "today" should be resolved against the reference date provided.
- If there's ambiguity about AM vs PM, prefer the most likely business-hours interpretation (8am–7pm).
- Never invent a time. If confidence < 0.5, return hasChange=false.
- Output ONLY the JSON object, no prose, no code fences.`

/**
 * Extract datetime correction from an operator-origin SMS.
 *
 * @param content   The SMS text the operator sent to the customer.
 * @param timezone  IANA tz (e.g., "America/Toronto"). Used to anchor relative dates.
 * @param referenceDate Anchor for "tomorrow"/"today" resolution (defaults to now).
 */
export async function extractDatetimeCorrection(
  content: string,
  timezone: string = 'America/Chicago',
  referenceDate: Date = new Date(),
): Promise<DatetimeCorrection> {
  const empty: DatetimeCorrection = { hasChange: false, newDatetimeIso: null, confidence: 0, reasoning: 'pre-filter miss' }
  if (!looksLikeDatetimeCorrection(content)) return empty

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { ...empty, reasoning: 'ANTHROPIC_API_KEY missing' }

  try {
    const client = new Anthropic({ apiKey })
    const reference = referenceDate.toISOString()

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `TIMEZONE: ${timezone}\nREFERENCE_DATE: ${reference}\n\nSTAFF SMS: "${content}"\n\nReturn the JSON object.`,
        },
      ],
    })

    const block = response.content.find(b => b.type === 'text')
    if (!block || block.type !== 'text') return empty

    // Strip any accidental code fences
    const raw = block.text.trim().replace(/^```json\s*|\s*```$/g, '')
    const parsed = JSON.parse(raw) as Partial<DatetimeCorrection>

    return {
      hasChange: !!parsed.hasChange,
      newDatetimeIso: parsed.newDatetimeIso ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: parsed.reasoning || '',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    return { ...empty, reasoning: `extraction_error: ${msg}` }
  }
}
