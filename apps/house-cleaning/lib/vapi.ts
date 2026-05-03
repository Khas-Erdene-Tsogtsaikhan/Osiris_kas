/**
 * VAPI Integration - Voice AI call transcript parsing
 * Multi-tenant version - requires Tenant parameter for outbound calls
 *
 * Extracts booking information from call transcripts using AI
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { extractJsonObject, safeJsonParse } from './json-utils'
import { extractPhoneFromVapiPayload, toE164 } from './phone-utils'
import type { Tenant } from './tenant'

export interface BookingInfo {
  firstName?: string
  lastName?: string
  phone?: string
  address?: string
  bedrooms?: number
  bathrooms?: number
  squareFootage?: number
  serviceType?: string
  requestedDate?: string
  requestedTime?: string
  notes?: string
  frequency?: string
  freeCouchCleaningRequested?: boolean | null
  // WinBros-specific fields (window cleaning, pressure washing, gutter cleaning)
  scope?: string | null // "exterior" | "interior" | "interior_and_exterior"
  planType?: string | null // "one_time" | "monthly" | "quarterly"
  pressureWashingSurfaces?: string[] | null // ["house_wash", "driveway", "patio", ...]
  areaSize?: string | null // "small" | "medium" | "large"
  conditionType?: string | null // "mold_mildew" | "general_cleanup"
  propertyType?: string | null // "single_story" | "two_story" | "larger_two_story"
  gutterConditions?: string | null // "heavy_clogging" | "none"
}

export interface VapiCallData {
  callId: string
  phone: string
  transcript: string
  duration: number
  outcome: 'booked' | 'not_booked' | 'voicemail'
  audioUrl?: string
}

/**
 * Extract booking information from a VAPI call transcript using AI
 * Uses universal AI keys (ANTHROPIC_API_KEY, OPENAI_API_KEY)
 */
export async function parseTranscript(transcript: string): Promise<BookingInfo> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  if (anthropicKey) {
    try {
      return await parseWithClaude(transcript)
    } catch (error) {
      console.error('Claude parsing error, trying OpenAI:', error)
    }
  }

  if (openaiKey) {
    try {
      return await parseWithOpenAI(transcript)
    } catch (error) {
      console.error('OpenAI parsing error:', error)
    }
  }

  // Fallback: basic regex parsing
  return parseWithRegex(transcript)
}

/**
 * Parse transcript using Claude
 */
async function parseWithClaude(transcript: string): Promise<BookingInfo> {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  // Check for malformed API key (line breaks, extra whitespace)
  if (apiKey.includes('\n') || apiKey.includes('\r') || apiKey !== apiKey.trim()) {
    throw new Error('ANTHROPIC_API_KEY contains invalid whitespace/line breaks')
  }

  try {
    const client = new Anthropic({ apiKey })
    const currentDate = new Date().toISOString().split('T')[0]

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: `Extract booking information from this cleaning service phone call transcript.

IMPORTANT: Today's date is ${currentDate} (YYYY-MM-DD format).
When the customer says "tomorrow", "next week", "next Monday", etc., calculate the date relative to today.

CRITICAL: If the customer mentions MULTIPLE dates or changes their mind during the call, use ONLY the FINAL/LAST date they confirmed. Look for phrases like "actually", "wait", "change that", "no make it", "instead" - these indicate the customer is correcting themselves. Always extract the most recent date mentioned at the end of the conversation.

CRITICAL: Even if the date/time is vague (like "this week", "sometime Thursday", "in the morning"), STILL extract your best guess. "Thursday" = the upcoming Thursday from today. "Morning" = "09:00 AM". "Afternoon" = "01:00 PM". "This week" = the next available weekday. DO NOT leave requestedDate or requestedTime as null if the customer mentioned ANY time preference, even loosely.

CRITICAL: Extract the address even if incomplete. "Calabasas" is a valid address. "on Elm Street" is a valid address. Partial is better than null.

Return a JSON object with these fields (use null for missing info):
- firstName: customer's first name
- lastName: customer's last name
- address: full street address
- bedrooms: number of bedrooms (integer) — house cleaning calls only
- bathrooms: number of bathrooms (allow .5 increments) — house cleaning calls only
- squareFootage: square footage (integer)
- serviceType: For house cleaning calls use "Standard cleaning", "Deep cleaning", or "Move in/out". For window/exterior calls use "window_cleaning", "pressure_washing", or "gutter_cleaning"
- requestedDate: date in YYYY-MM-DD format (calculate from today if relative, use FINAL date if customer changes)
- requestedTime: time in HH:MM AM/PM format
- notes: any special requests, add-ons (inside fridge/oven/cabinets, windows, screens, construction residue), pet info, access instructions
- frequency: "One-time", "Weekly", "Bi-weekly", or "Monthly"
- freeCouchCleaningRequested: true if customer explicitly wants to redeem the free couch cleaning for this booking, false if they explicitly decline, null if not mentioned or they want to save it for later
- scope: for window cleaning — "exterior", "interior", or "interior_and_exterior" (null if not window cleaning)
- planType: "one_time", "monthly", or "quarterly" (null if not mentioned)
- pressureWashingSurfaces: for pressure washing — array of surfaces like ["house_wash", "driveway", "patio", "sidewalk", "deck", "fence", "pool_deck", "retaining_wall", "stone"] (null if not pressure washing)
- areaSize: for pressure washing — "small", "medium", or "large" (null if not pressure washing)
- conditionType: for pressure washing — "mold_mildew" or "general_cleanup" (null if not pressure washing)
- propertyType: for gutter cleaning — "single_story", "two_story", or "larger_two_story" (null if not gutter cleaning)
- gutterConditions: for gutter cleaning — "heavy_clogging" or "none" (null if not gutter cleaning)

TRANSCRIPT:
${transcript}

Respond with ONLY the JSON object, no other text.`
        }
      ],
    })

    const textContent = response.content.find(block => block.type === 'text')
    const jsonText = textContent?.type === 'text' ? textContent.text : '{}'

    // Clean the response (remove markdown code blocks if present)
    const cleaned = jsonText.replace(/```json\n?|\n?```/g, '').trim()
    const candidate = extractJsonObject(cleaned)
    const parsed = safeJsonParse<BookingInfo>(candidate)

    if (!parsed.value) {
      throw new Error(`Failed to parse Claude JSON: ${parsed.error || 'Unknown error'}`)
    }

    if (parsed.repaired) {
      console.warn('Repaired invalid JSON from Claude output')
    }

    return parsed.value
  } catch (error) {
    // Log detailed error information
    console.error('Claude parsing error:', error)
    if (error instanceof Error) {
      console.error('Error message:', error.message)
      console.error('Error stack:', error.stack)
    }
    throw error
  }
}

/**
 * Parse transcript using OpenAI
 */
async function parseWithOpenAI(transcript: string): Promise<BookingInfo> {
  const apiKey = process.env.OPENAI_API_KEY

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured')
  }

  // Check for malformed API key
  if (apiKey.includes('\n') || apiKey.includes('\r') || apiKey !== apiKey.trim()) {
    throw new Error('OPENAI_API_KEY contains invalid whitespace/line breaks')
  }

  try {
    const client = new OpenAI({ apiKey })
    const currentDate = new Date().toISOString().split('T')[0]

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You extract booking information from cleaning service phone call transcripts.

IMPORTANT: Today's date is ${currentDate} (YYYY-MM-DD format).
When the customer says "tomorrow", "next week", "next Monday", etc., calculate the date relative to today.

CRITICAL: If the customer mentions MULTIPLE dates or changes their mind during the call, use ONLY the FINAL/LAST date they confirmed. Look for phrases like "actually", "wait", "change that", "no make it", "instead" - these indicate the customer is correcting themselves. Always extract the most recent date mentioned at the end of the conversation.

Return a JSON object with these fields (use null for missing info):
- firstName, lastName, address, bedrooms (house cleaning only), bathrooms (allow .5, house cleaning only), squareFootage
- serviceType: For house cleaning use "Standard cleaning", "Deep cleaning", or "Move in/out". For window/exterior use "window_cleaning", "pressure_washing", or "gutter_cleaning"
- requestedDate (YYYY-MM-DD, calculate from today if relative, use FINAL date if changed), requestedTime (HH:MM AM/PM)
- notes (include add-ons like inside fridge/oven/cabinets, windows, screens, construction residue), frequency
- freeCouchCleaningRequested (true if they want to redeem the free couch cleaning for this booking, false if they explicitly decline, null if not mentioned or they want to save it for later)
- scope: for window cleaning — "exterior", "interior", or "interior_and_exterior" (null otherwise)
- planType: "one_time", "monthly", or "quarterly" (null if not mentioned)
- pressureWashingSurfaces: for pressure washing — array like ["house_wash", "driveway", "patio", "sidewalk", "deck", "fence", "pool_deck", "retaining_wall", "stone"] (null otherwise)
- areaSize: for pressure washing — "small", "medium", or "large" (null otherwise)
- conditionType: for pressure washing — "mold_mildew" or "general_cleanup" (null otherwise)
- propertyType: for gutter cleaning — "single_story", "two_story", or "larger_two_story" (null otherwise)
- gutterConditions: for gutter cleaning — "heavy_clogging" or "none" (null otherwise)`
        },
        {
          role: 'user',
          content: `Extract booking info from this transcript:\n\n${transcript}`
        }
      ],
    })

    const jsonText = response.choices[0]?.message?.content || '{}'
    const candidate = extractJsonObject(jsonText)
    const parsed = safeJsonParse<BookingInfo>(candidate)

    if (!parsed.value) {
      throw new Error(`Failed to parse OpenAI JSON: ${parsed.error || 'Unknown error'}`)
    }

    if (parsed.repaired) {
      console.warn('Repaired invalid JSON from OpenAI output')
    }

    return parsed.value
  } catch (error) {
    console.error('OpenAI parsing error:', error)
    if (error instanceof Error) {
      console.error('Error message:', error.message)
      console.error('Error stack:', error.stack)
    }
    throw error
  }
}

/**
 * Basic regex-based parsing as fallback
 */
function parseWithRegex(transcript: string): BookingInfo {
  const info: BookingInfo = {}
  const notes: string[] = []

  // Try to extract common patterns
  const lowerTranscript = transcript.toLowerCase()

  // Service type
  if (lowerTranscript.includes('deep clean')) {
    info.serviceType = 'Deep cleaning'
  } else if (lowerTranscript.includes('move in') || lowerTranscript.includes('move out')) {
    info.serviceType = 'Move in/out'
  } else if (lowerTranscript.includes('standard') || lowerTranscript.includes('regular')) {
    info.serviceType = 'Standard cleaning'
  }

  // Bedrooms
  const bedroomMatch = transcript.match(/(\d+)\s*(?:bed(?:room)?s?|br)/i)
  if (bedroomMatch) {
    info.bedrooms = parseInt(bedroomMatch[1])
  }

  // Bathrooms
  const bathroomMatch = transcript.match(/(\d+(?:\.\d+)?)\s*(?:bath(?:room)?s?|ba)/i)
  if (bathroomMatch) {
    info.bathrooms = parseFloat(bathroomMatch[1])
  }

  // Square footage
  const sqftMatch = transcript.match(/(\d{3,5})\s*(?:sq(?:uare)?\.?\s*(?:ft|feet)?|sqft)/i)
  if (sqftMatch) {
    info.squareFootage = parseInt(sqftMatch[1])
  }

  if (/inside\s+(the\s+)?fridge|clean\s+fridge|fridge\s+interior/i.test(transcript)) {
    notes.push('inside fridge')
  }
  if (/inside\s+(the\s+)?oven|clean\s+oven|oven\s+interior/i.test(transcript)) {
    notes.push('inside oven')
  }
  if (/inside\s+(the\s+)?cabinet|inside\s+cabinet|inside\s+cupboard/i.test(transcript)) {
    notes.push('inside cabinets')
  }
  if (/windows?/i.test(transcript)) {
    notes.push('windows')
  }
  if (/\b(pet|pets|dog|dogs|cat|cats|puppy|puppies|kitten|kittens)\b/i.test(transcript)) {
    notes.push('pet')
  }

  if (notes.length > 0) {
    info.notes = notes.join(', ')
  }

  // Date extraction — convert spoken dates to YYYY-MM-DD
  const today = new Date()
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

  // "tomorrow"
  if (/\btomorrow\b/i.test(transcript)) {
    const d = new Date(today)
    d.setDate(d.getDate() + 1)
    info.requestedDate = d.toISOString().split('T')[0]
  }

  // "next Monday", "this Thursday", etc.
  if (!info.requestedDate) {
    const dayMatch = transcript.match(/\b(?:next|this|coming)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)
    if (dayMatch) {
      const targetDay = dayNames.indexOf(dayMatch[1].toLowerCase())
      if (targetDay >= 0) {
        const d = new Date(today)
        const currentDay = d.getDay()
        let diff = targetDay - currentDay
        if (diff <= 0) diff += 7
        d.setDate(d.getDate() + diff)
        info.requestedDate = d.toISOString().split('T')[0]
      }
    }
  }

  // "March 15", "March 15th", "3/15"
  if (!info.requestedDate) {
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
    const monthMatch = transcript.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i)
    if (monthMatch) {
      const month = monthNames.indexOf(monthMatch[1].toLowerCase())
      const day = parseInt(monthMatch[2])
      const d = new Date(today.getFullYear(), month, day)
      if (d < today) d.setFullYear(d.getFullYear() + 1)
      info.requestedDate = d.toISOString().split('T')[0]
    }
  }

  // Time extraction — "2pm", "2:00 PM", "at 10", "morning", "afternoon"
  const timeMatch = transcript.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i)
  if (timeMatch) {
    let h = parseInt(timeMatch[1])
    const m = timeMatch[2] || '00'
    const period = timeMatch[3].replace(/\./g, '').toUpperCase()
    if (period === 'PM' && h < 12) h += 12
    if (period === 'AM' && h === 12) h = 0
    info.requestedTime = `${String(h).padStart(2, '0')}:${m}`
  } else if (/\bmorning\b/i.test(lowerTranscript)) {
    info.requestedTime = '09:00'
  } else if (/\bafternoon\b/i.test(lowerTranscript)) {
    info.requestedTime = '13:00'
  } else if (/\bevening\b/i.test(lowerTranscript)) {
    info.requestedTime = '17:00'
  }

  // Name extraction — "my name is X" or "I'm X"
  const nameMatch = transcript.match(/(?:my name is|I'm|I am|this is)\s+([A-Z][a-z]+)/i)
  if (nameMatch && !info.firstName) {
    info.firstName = nameMatch[1]
  }

  // Address extraction — street number + street name pattern
  const addrMatch = transcript.match(/\b(\d{2,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Road|Rd|Way|Court|Ct|Place|Pl|Circle|Cir))\b/i)
  if (addrMatch && !info.address) {
    info.address = addrMatch[1]
  }

  const couchRequest = detectFreeCouchCleaningRequest(transcript)
  if (couchRequest !== null) {
    info.freeCouchCleaningRequested = couchRequest
  }

  return info
}

export function detectFreeCouchCleaningRequest(transcript: string): boolean | null {
  if (!transcript) return null

  const couchMatch = /\b(couch|sofa|sectional|loveseat|upholstery)\b/i
  if (!couchMatch.test(transcript)) {
    return null
  }

  const declinePatterns: RegExp[] = [
    /\b(no|nope|nah)\b[\s\S]{0,40}\b(couch|sofa|sectional|loveseat|upholstery)\b/i,
    /\b(don't|do not|dont)\b[\s\S]{0,40}\b(want|need)\b[\s\S]{0,40}\b(couch|sofa|sectional|loveseat|upholstery)\b/i,
    /\b(not interested|not right now|maybe later|later on|another time)\b/i,
  ]

  for (const pattern of declinePatterns) {
    if (pattern.test(transcript)) {
      return false
    }
  }

  const acceptPatterns: RegExp[] = [
    /\b(yes|yeah|yep|sure|please|ok|okay|sounds good)\b[\s\S]{0,40}\b(couch|sofa|sectional|loveseat|upholstery)\b/i,
    /\b(couch|sofa|sectional|loveseat|upholstery)\b[\s\S]{0,40}\b(yes|yeah|yep|sure|please|ok|okay)\b/i,
    /\b(add|include|redeem|use|claim|want|need)\b[\s\S]{0,40}\b(couch|sofa|sectional|loveseat|upholstery)\b/i,
    /\b(couch|sofa|sectional|loveseat|upholstery)\b[\s\S]{0,40}\b(add|include|redeem|use|claim|want|need)\b/i,
  ]

  for (const pattern of acceptPatterns) {
    if (pattern.test(transcript)) {
      return true
    }
  }

  return null
}

/**
 * Extract call data from VAPI webhook payload
 */
export function extractVapiCallData(payload: Record<string, unknown>): VapiCallData | null {
  try {
    // VAPI webhook structure can vary, handle common patterns
    const message = (payload.message as Record<string, unknown>) || payload
    const call = (message.call as Record<string, unknown>) || (payload.call as Record<string, unknown>) || message
    const analysis = message.analysis && typeof message.analysis === 'object'
      ? (message.analysis as Record<string, unknown>)
      : null
    const artifact = message.artifact && typeof message.artifact === 'object'
      ? (message.artifact as Record<string, unknown>)
      : null

    // Extract phone number
    let phone = extractPhoneFromVapiPayload(payload)
    if (!phone && call.customer && typeof call.customer === 'object') {
      const customer = call.customer as Record<string, unknown>
      if (typeof customer.number === 'string') {
        phone = customer.number
      }
    }

    // Extract transcript
    let transcript = ''
    if (message.transcript && typeof message.transcript === 'string') {
      transcript = message.transcript
    } else if (call.transcript && typeof call.transcript === 'string') {
      transcript = call.transcript
    } else if (artifact) {
      if (artifact.transcript && typeof artifact.transcript === 'string') {
        transcript = artifact.transcript
      } else if (Array.isArray(artifact.messages)) {
        transcript = buildTranscriptFromMessages(artifact.messages)
      }
    } else if (message.messages && Array.isArray(message.messages)) {
      // Construct transcript from messages array
      transcript = buildTranscriptFromMessages(message.messages)
    } else if (Array.isArray(call.messages)) {
      transcript = buildTranscriptFromMessages(call.messages)
    }

    if (!transcript && analysis && typeof analysis.summary === 'string') {
      transcript = analysis.summary
    }

    // Extract call ID - try multiple locations
    let callId =
      (call.id as string) ||
      (call.callId as string) ||
      (message.callId as string) ||
      (message.id as string) ||
      ''

    // Try to extract from transport.callSid in artifact.variables
    if (!callId && artifact) {
      const variables = artifact.variables as Record<string, unknown> | undefined
      if (variables) {
        const transport = variables.transport as Record<string, unknown> | undefined
        if (transport && typeof transport.callSid === 'string') {
          callId = transport.callSid
        }
      }
    }

    // Try to extract from recording URL as last resort
    if (!callId && artifact) {
      const recordingUrl = artifact.recordingUrl as string | undefined
      if (recordingUrl) {
        // Extract UUID from URL like https://storage.vapi.ai/019c228d-7b83-711c-9f88-011d3bd4f72c-...
        const match = recordingUrl.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
        if (match) {
          callId = match[1]
        }
      }
    }

    // Extract duration
    const durationSeconds =
      coerceNumber(call.duration) ??
      coerceNumber(call.durationSeconds) ??
      coerceNumber(call.duration_seconds) ??
      coerceNumber(message.duration) ??
      coerceNumber(message.durationSeconds) ??
      coerceNumber(message.duration_seconds)

    const durationMs =
      coerceNumber(call.durationMs) ??
      coerceNumber(call.duration_ms) ??
      coerceNumber(message.durationMs) ??
      coerceNumber(message.duration_ms)

    const duration = durationSeconds ?? (durationMs ? durationMs / 1000 : 0)

    // Extract audio URL
    const audioUrl = (call.recordingUrl as string) || (message.recordingUrl as string)

    // Determine outcome
    let outcome: 'booked' | 'not_booked' | 'voicemail' = 'not_booked'
    const status = (call.status as string) || (message.status as string) || ''
    const endedReason = (call.endedReason as string) || (message.endedReason as string) || ''
    const successEvaluation = analysis?.successEvaluation
    const summary = typeof analysis?.summary === 'string' ? analysis.summary : ''

    if (endedReason.includes('voicemail') || status.includes('voicemail')) {
      outcome = 'voicemail'
    } else if (
      successEvaluation === true ||
      successEvaluation === 'true' ||
      status.includes('book') ||
      transcript.toLowerCase().includes('book') ||
      transcript.toLowerCase().includes('schedule') ||
      summary.toLowerCase().includes('booked') ||
      summary.toLowerCase().includes('scheduled')
    ) {
      outcome = 'booked'
    }

    return {
      callId,
      phone,
      transcript,
      duration,
      outcome,
      audioUrl,
    }
  } catch (error) {
    console.error('Error extracting VAPI call data:', error)
    return null
  }
}

function buildTranscriptFromMessages(messages: unknown[]): string {
  const lines: string[] = []
  for (const item of messages) {
    if (typeof item === 'string') {
      if (item.trim()) {
        lines.push(item.trim())
      }
      continue
    }
    if (!item || typeof item !== 'object') {
      continue
    }
    const message = item as Record<string, unknown>
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    const content =
      typeof message.content === 'string'
        ? message.content
        : typeof message.message === 'string'
          ? message.message
          : typeof message.text === 'string'
            ? message.text
            : ''

    const text = content.trim()
    if (text) {
      lines.push(`${role}: ${text}`)
    }
  }
  return lines.join('\n')
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return null
}

/**
 * Format date and time for SMS confirmation
 */
export function formatDateTimeForSMS(date: string | null, time: string | null): string {
  if (!date) return 'TBD'

  try {
    const dateObj = new Date(date)
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }
    const formattedDate = dateObj.toLocaleDateString('en-US', options)

    if (time) {
      return `${formattedDate}, ${time}`
    }
    return formattedDate
  } catch {
    return date + (time ? ` ${time}` : '')
  }
}

/**
 * Initiate an outbound call via VAPI
 * Backwards compatible - can be called with:
 * - (phoneNumber, customerName, context, leadId) - old pattern
 * - (tenant, phoneNumber, customerName, context) - new pattern
 */
export async function initiateOutboundCall(
  tenantOrPhone: Tenant | string,
  phoneOrName: string,
  nameOrContext?: string | { leadId?: string; jobId?: string },
  contextOrLeadId?: { leadId?: string; jobId?: string } | string
): Promise<{ success: boolean; callId?: string; error?: string }> {
  // Determine if called with tenant or without (backwards compat)
  let tenant: Tenant | null
  let phoneNumber: string
  let customerName: string
  let context: { leadId?: string; jobId?: string } | undefined

  if (typeof tenantOrPhone === 'string') {
    // Old calling pattern is no longer supported — tenant must be provided
    console.error('[vapi] initiateOutboundCall called without tenant object — caller must pass tenant as first argument')
    return { success: false, error: 'Tenant must be provided as first argument (old string-based calling pattern is removed)' }
  } else {
    // New calling pattern: initiateOutboundCall(tenant, phoneNumber, customerName, context?)
    tenant = tenantOrPhone
    phoneNumber = phoneOrName
    customerName = typeof nameOrContext === 'string' ? nameOrContext : ''
    context = typeof contextOrLeadId === 'object' ? contextOrLeadId : undefined
  }

  if (!tenant) {
    console.error('No tenant found - cannot initiate outbound call')
    return { success: false, error: 'No tenant configured' }
  }

  try {
    // Check if tenant has VAPI configured
    if (!tenant.workflow_config.use_vapi_outbound) {
      console.log(`[${tenant.slug}] VAPI outbound calls disabled in workflow config`)
      return { success: false, error: 'VAPI outbound calls disabled for this tenant' }
    }

    // Get required API keys from tenant
    const vapiApiKey = tenant.vapi_api_key
    if (!vapiApiKey) {
      console.error(`[${tenant.slug}] VAPI API key not configured`)
      return { success: false, error: 'VAPI API key not configured' }
    }

    const outboundPhoneId = tenant.vapi_phone_id
    if (!outboundPhoneId) {
      console.error(`[${tenant.slug}] VAPI phone ID not configured`)
      return { success: false, error: 'VAPI phone ID not configured' }
    }

    // Use outbound assistant ID if available, fall back to inbound assistant ID
    const assistantId = tenant.vapi_outbound_assistant_id || tenant.vapi_assistant_id
    if (!assistantId) {
      console.error(`[${tenant.slug}] VAPI assistant ID not configured (neither outbound nor inbound)`)
      return { success: false, error: 'VAPI assistant ID not configured' }
    }

    // Normalize phone number to E.164 format
    const normalizedPhone = toE164(phoneNumber)
    if (!normalizedPhone) {
      console.error(`[${tenant.slug}] Invalid phone number format:`, phoneNumber)
      return { success: false, error: 'Invalid phone number format' }
    }

    // Safety net: skip outbound calls to numbers that already have an active job
    // This prevents calling customers who are already booked/assigned regardless of lead status
    try {
      const { getSupabaseServiceClient } = await import('./supabase')
      const svc = getSupabaseServiceClient()
      const { data: customerWithActiveJob } = await svc
        .from('customers')
        .select('id, jobs!inner(id, status)')
        .eq('tenant_id', tenant.id)
        .eq('phone_number', normalizedPhone)
        .in('jobs.status', ['pending', 'scheduled', 'in_progress'])
        .limit(1)
        .maybeSingle()

      if (customerWithActiveJob) {
        console.log(`[${tenant.slug}] Blocking outbound call — active job exists for ${normalizedPhone} (customer ${customerWithActiveJob.id})`)
        return { success: false, error: 'Customer already has an active job — outbound call blocked' }
      }
    } catch (err) {
      // Don't block the call if the safety check itself fails — log and continue
      console.warn(`[${tenant.slug}] Active-job safety check failed, proceeding with call:`, err)
    }

    // Build metadata from context
    const metadata: Record<string, string> = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    }
    if (context?.leadId) {
      metadata.leadId = context.leadId
    }
    if (context?.jobId) {
      metadata.jobId = context.jobId
    }

    // Make the API call to VAPI
    console.log(`[${tenant.slug}] Initiating outbound call via VAPI:`, {
      phoneNumber: normalizedPhone,
      customerName,
      assistantId,
      outboundPhoneId,
    })

    const controller = new AbortController()
    const fetchTimeout = setTimeout(() => controller.abort(), 15_000)
    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${vapiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: outboundPhoneId,
        assistantId: assistantId,
        customer: {
          number: normalizedPhone,
          name: customerName,
        },
        metadata,
      }),
      signal: controller.signal,
    })
    clearTimeout(fetchTimeout)

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[${tenant.slug}] VAPI API error:`, response.status, errorText)
      return {
        success: false,
        error: `VAPI API error: ${response.status} - ${errorText}`,
      }
    }

    const data = await response.json()
    console.log(`[${tenant.slug}] VAPI outbound call initiated successfully:`, data)

    return {
      success: true,
      callId: data.id || data.callId,
    }
  } catch (error) {
    console.error(`[${tenant.slug}] Error initiating outbound call:`, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}
