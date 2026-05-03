import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { extractJsonObject, safeJsonParse } from './json-utils'
import type { BookingInfo } from './vapi'
import type { Job, Customer } from './supabase'
import { getClientConfig } from './client-config'
import type { AddOnKey } from './pricing-config'

export type PricingInsight = {
  priceSensitivity: 'low' | 'medium' | 'high' | 'unknown'
  valueFocus: string[]
  recurringInterest: 'none' | 'possible' | 'strong'
  urgency: 'low' | 'medium' | 'high'
  recommendedAdjustmentPct: number
  strategy: 'discount' | 'value_stack' | 'premium' | 'standard'
  offerMessage?: string | null
  upsellAddOns?: AddOnKey[]
  downsellSuggestion?: string | null
  confidence: number
  reasoning: string
  model?: string
}

export type PricingInsightInput = {
  transcript: string
  bookingInfo?: BookingInfo
  job?: Partial<Job>
  customer?: Partial<Customer>
}

const ALLOWED_ADD_ONS: AddOnKey[] = [
  'inside_fridge',
  'inside_oven',
  'inside_cabinets',
  'windows_interior',
  'windows_exterior',
  'windows_both',
  'pet_fee',
]

export async function analyzePricingInsights(
  input: PricingInsightInput
): Promise<PricingInsight | null> {
  const config = getClientConfig()
  if (!config.features.dynamicPricing) {
    return null
  }

  const transcript = (input.transcript || '').trim()
  if (!transcript) {
    return null
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  if (anthropicKey) {
    try {
      return sanitizePricingInsight(await analyzeWithClaude(input))
    } catch (error) {
      console.error('Claude pricing insight error, trying OpenAI:', error)
    }
  }

  if (openaiKey) {
    try {
      return sanitizePricingInsight(await analyzeWithOpenAI(input))
    } catch (error) {
      console.error('OpenAI pricing insight error:', error)
    }
  }

  return sanitizePricingInsight(analyzeWithHeuristics(input))
}

function sanitizePricingInsight(insight: PricingInsight | null): PricingInsight | null {
  if (!insight) return null

  const maxDiscount = Number(process.env.DYNAMIC_PRICING_MAX_DISCOUNT_PCT || '10')
  const maxMarkup = Number(process.env.DYNAMIC_PRICING_MAX_MARKUP_PCT || '8')
  const minConfidence = Number(process.env.DYNAMIC_PRICING_MIN_CONFIDENCE || '0.6')

  const normalizedSensitivity = normalizeEnum(insight.priceSensitivity, [
    'low',
    'medium',
    'high',
    'unknown',
  ], 'unknown')
  const normalizedStrategy = normalizeEnum(insight.strategy, [
    'discount',
    'value_stack',
    'premium',
    'standard',
  ], 'standard')
  const normalizedRecurring = normalizeEnum(insight.recurringInterest, [
    'none',
    'possible',
    'strong',
  ], 'none')
  const normalizedUrgency = normalizeEnum(insight.urgency, [
    'low',
    'medium',
    'high',
  ], 'low')

  const min = Number.isFinite(maxDiscount) ? -Math.abs(maxDiscount) : -10
  const max = Number.isFinite(maxMarkup) ? Math.abs(maxMarkup) : 8

  const rawAdjustment = Number(insight.recommendedAdjustmentPct)
  const adjustment = Number.isFinite(rawAdjustment) ? Math.min(Math.max(rawAdjustment, min), max) : 0

  const confidence = Number.isFinite(insight.confidence)
    ? Math.min(Math.max(insight.confidence, 0), 1)
    : 0

  const allowAdjustment = confidence >= (Number.isFinite(minConfidence) ? minConfidence : 0.6)
  const safeAdjustment = allowAdjustment ? adjustment : 0

  const upsellAddOns = (insight.upsellAddOns || []).filter(addOn =>
    ALLOWED_ADD_ONS.includes(addOn)
  )

  const sanitized: PricingInsight = {
    ...insight,
    priceSensitivity: normalizedSensitivity,
    strategy: normalizedStrategy,
    recurringInterest: normalizedRecurring,
    urgency: normalizedUrgency,
    recommendedAdjustmentPct: safeAdjustment,
    confidence,
    upsellAddOns,
    valueFocus: Array.isArray(insight.valueFocus)
      ? insight.valueFocus.filter(value => typeof value === 'string')
      : [],
  }

  if (!sanitized.reasoning || sanitized.reasoning.length > 300) {
    sanitized.reasoning = sanitized.reasoning?.slice(0, 300) || 'No clear pricing signals detected.'
  }

  const reasoningLower = sanitized.reasoning.toLowerCase()
  if (/(zip|zipcode|postal|neighborhood|wealth|affluent|income|rich)/.test(reasoningLower)) {
    sanitized.recommendedAdjustmentPct = 0
    sanitized.strategy = 'value_stack'
    sanitized.offerMessage = null
    sanitized.confidence = Math.min(sanitized.confidence, 0.4)
    sanitized.reasoning = 'Pricing signals were not safe to use.'
  }

  return sanitized
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  if (typeof value !== 'string') {
    return fallback
  }
  const normalized = value.toLowerCase() as T
  return allowed.includes(normalized) ? normalized : fallback
}

async function analyzeWithClaude(input: PricingInsightInput): Promise<PricingInsight> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }
  if (apiKey.includes('\n') || apiKey.includes('\r') || apiKey !== apiKey.trim()) {
    throw new Error('ANTHROPIC_API_KEY contains invalid whitespace/line breaks')
  }

  const client = new Anthropic({ apiKey })
  const prompt = buildPricingPrompt(input)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  })

  const textContent = response.content.find(block => block.type === 'text')
  const jsonText = textContent?.type === 'text' ? textContent.text : '{}'
  const cleaned = jsonText.replace(/```json\n?|\n?```/g, '').trim()
  const candidate = extractJsonObject(cleaned)
  const parsed = safeJsonParse<PricingInsight>(candidate)

  if (!parsed.value) {
    throw new Error(`Failed to parse Claude pricing JSON: ${parsed.error || 'Unknown error'}`)
  }

  if (parsed.repaired) {
    console.warn('Repaired invalid JSON from Claude pricing output')
  }

  return { ...parsed.value, model: 'claude-haiku-4-5-20251001' }
}

async function analyzeWithOpenAI(input: PricingInsightInput): Promise<PricingInsight> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured')
  }
  if (apiKey.includes('\n') || apiKey.includes('\r') || apiKey !== apiKey.trim()) {
    throw new Error('OPENAI_API_KEY contains invalid whitespace/line breaks')
  }

  const client = new OpenAI({ apiKey })
  const prompt = buildPricingPrompt(input)

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You analyze transcripts and return JSON only.'
      },
      {
        role: 'user',
        content: prompt
      },
    ],
  })

  const jsonText = response.choices[0]?.message?.content || '{}'
  const candidate = extractJsonObject(jsonText)
  const parsed = safeJsonParse<PricingInsight>(candidate)

  if (!parsed.value) {
    throw new Error(`Failed to parse OpenAI pricing JSON: ${parsed.error || 'Unknown error'}`)
  }

  if (parsed.repaired) {
    console.warn('Repaired invalid JSON from OpenAI pricing output')
  }

  return { ...parsed.value, model: 'gpt-4o' }
}

function buildPricingPrompt(input: PricingInsightInput): string {
  const maxDiscount = Number(process.env.DYNAMIC_PRICING_MAX_DISCOUNT_PCT || '10')
  const maxMarkup = Number(process.env.DYNAMIC_PRICING_MAX_MARKUP_PCT || '8')
  const min = Number.isFinite(maxDiscount) ? -Math.abs(maxDiscount) : -10
  const max = Number.isFinite(maxMarkup) ? Math.abs(maxMarkup) : 8

  const bookingSummary = [
    input.bookingInfo?.serviceType ? `Service: ${input.bookingInfo.serviceType}` : null,
    input.bookingInfo?.requestedDate ? `Requested date: ${input.bookingInfo.requestedDate}` : null,
    input.bookingInfo?.requestedTime ? `Requested time: ${input.bookingInfo.requestedTime}` : null,
    input.bookingInfo?.frequency ? `Frequency: ${input.bookingInfo.frequency}` : null,
  ].filter(Boolean).join('\n')

  return `You are an internal pricing assistant for a cleaning service.

Goal: infer how price-sensitive the customer is from the transcript and recommend a small pricing adjustment.
Hard rules:
- Do NOT use protected characteristics or proxies (zip code, neighborhood wealth, race, gender, age, etc.).
- Only use explicit price signals (budget, discount requests), urgency, flexibility, and service complexity.
- Keep recommendedAdjustmentPct between ${min} and ${max}.
- If unclear, return recommendedAdjustmentPct = 0 and strategy = "value_stack" or "standard".
- Provide messaging guidance that adds value without sounding defensive.

Return JSON only with:
{
  "priceSensitivity": "low" | "medium" | "high" | "unknown",
  "valueFocus": [strings],
  "recurringInterest": "none" | "possible" | "strong",
  "urgency": "low" | "medium" | "high",
  "recommendedAdjustmentPct": number,
  "strategy": "discount" | "value_stack" | "premium" | "standard",
  "offerMessage": string or null,
  "upsellAddOns": [${ALLOWED_ADD_ONS.map(item => `"${item}"`).join(', ')}],
  "downsellSuggestion": string or null,
  "confidence": number (0-1),
  "reasoning": string
}

Booking summary:
${bookingSummary || 'No structured booking info provided.'}

Transcript:
${input.transcript}
`
}

function analyzeWithHeuristics(input: PricingInsightInput): PricingInsight {
  const lower = input.transcript.toLowerCase()
  const priceSensitiveSignals = [
    'budget',
    'afford',
    'cheap',
    'cheapest',
    'expensive',
    'too much',
    'cost',
    'price',
    'quote',
    'discount',
    'deal',
  ]
  const premiumSignals = [
    'asap',
    'urgent',
    'today',
    'tomorrow',
    'premium',
    'top quality',
    'white glove',
    'luxury',
  ]
  const recurringSignals = ['weekly', 'biweekly', 'every other week', 'monthly', 'recurring']

  const priceSensitive = priceSensitiveSignals.some(term => lower.includes(term))
  const premium = premiumSignals.some(term => lower.includes(term))
  const recurring = recurringSignals.some(term => lower.includes(term))

  let recommendedAdjustmentPct = 0
  let strategy: PricingInsight['strategy'] = 'standard'
  let priceSensitivity: PricingInsight['priceSensitivity'] = 'unknown'
  let offerMessage: string | null = null

  if (priceSensitive) {
    priceSensitivity = 'high'
    strategy = 'value_stack'
    recommendedAdjustmentPct = 0
    offerMessage = recurring
      ? 'Highlight value of recurring service: consistent quality, priority scheduling, satisfaction guarantee. Do NOT reduce the price.'
      : 'Build value: satisfaction guarantee, background-checked cleaners, insured and bonded, professional supplies. Do NOT reduce the price.'
  } else if (premium) {
    priceSensitivity = 'low'
    strategy = 'premium'
    recommendedAdjustmentPct = 5
    offerMessage = 'We can prioritize quality and thoroughness for your service.'
  } else {
    priceSensitivity = 'medium'
    strategy = 'value_stack'
    offerMessage = 'We focus on consistent, high-quality results and clear communication.'
  }

  return {
    priceSensitivity,
    valueFocus: priceSensitive ? ['budget'] : premium ? ['quality'] : ['value'],
    recurringInterest: recurring ? 'strong' : 'none',
    urgency: premium ? 'high' : 'low',
    recommendedAdjustmentPct,
    strategy,
    offerMessage,
    upsellAddOns: [],
    downsellSuggestion: priceSensitive ? 'Escalate to owner if customer keeps pushing on price. Do NOT reduce price or scope.' : null,
    confidence: priceSensitive || premium ? 0.65 : 0.4,
    reasoning: priceSensitive
      ? 'Customer mentioned pricing or budget sensitivity.'
      : premium
        ? 'Customer expressed urgency or premium quality expectations.'
        : 'No strong pricing signals detected.',
    model: 'heuristic',
  }
}
