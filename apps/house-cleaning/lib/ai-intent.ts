/**
 * AI Intent Detection
 * Analyzes SMS messages to detect booking intent
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export interface IntentAnalysis {
  hasBookingIntent: boolean
  confidence: 'high' | 'medium' | 'low'
  extractedInfo: {
    serviceType?: string
    preferredDate?: string
    preferredTime?: string
    address?: string
    name?: string
  }
  reason: string
}

/**
 * Analyze SMS message for booking intent using AI
 */
export async function analyzeBookingIntent(
  message: string,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>
): Promise<IntentAnalysis> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  if (anthropicKey) {
    try {
      return await analyzeWithClaude(message, conversationHistory)
    } catch (error) {
      console.error('[AI Intent] Claude analysis failed, trying OpenAI:', error)
    }
  }

  if (openaiKey) {
    try {
      return await analyzeWithOpenAI(message, conversationHistory)
    } catch (error) {
      console.error('[AI Intent] OpenAI analysis failed:', error)
    }
  }

  // Fallback to keyword-based detection
  return analyzeWithKeywords(message)
}

/**
 * Analyze with Claude
 */
async function analyzeWithClaude(
  message: string,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>
): Promise<IntentAnalysis> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const historyContext = conversationHistory?.length
    ? `\nPrevious conversation:\n${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}\n`
    : ''

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `Analyze this SMS message to determine if the sender wants to book a cleaning service.
${historyContext}
Current message: "${message}"

Return JSON with:
{
  "hasBookingIntent": boolean (true if they want cleaning/quote/booking),
  "confidence": "high" | "medium" | "low",
  "extractedInfo": {
    "serviceType": string or null,
    "preferredDate": string or null,
    "preferredTime": string or null,
    "address": string or null,
    "name": string or null
  },
  "reason": "brief explanation"
}

Examples of booking intent:
- "I need a cleaning" → true
- "Can I get a quote?" → true
- "Looking for house cleaners" → true
- "What are your rates?" → true
- "Do you service 90210?" → true

Examples of NO booking intent:
- "Wrong number" → false
- "Stop texting me" → false
- "Thanks for the service" (past tense) → false
- "Ok" or "K" alone → false
- Random spam → false

Return ONLY the JSON object.`
      }
    ],
  })

  const textContent = response.content.find(block => block.type === 'text')
  const jsonText = textContent?.type === 'text' ? textContent.text : '{}'
  const cleaned = jsonText.replace(/```json\n?|\n?```/g, '').trim()

  try {
    return JSON.parse(cleaned) as IntentAnalysis
  } catch {
    console.error('[AI Intent] Failed to parse Claude response:', cleaned)
    return {
      hasBookingIntent: false,
      confidence: 'low',
      extractedInfo: {},
      reason: 'Failed to parse AI response'
    }
  }
}

/**
 * Analyze with OpenAI
 */
async function analyzeWithOpenAI(
  message: string,
  conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>
): Promise<IntentAnalysis> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const historyContext = conversationHistory?.length
    ? `\nPrevious conversation:\n${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}\n`
    : ''

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You analyze SMS messages to detect booking intent for a cleaning service.
Return JSON with hasBookingIntent, confidence (high/medium/low), extractedInfo, and reason.
Booking intent = wants cleaning, quote, booking, rates, service area inquiry.
NOT booking intent = wrong number, stop messages, past tense thanks, spam.`
      },
      {
        role: 'user',
        content: `${historyContext}Current message: "${message}"`
      }
    ],
  })

  const jsonText = response.choices[0]?.message?.content || '{}'

  try {
    return JSON.parse(jsonText) as IntentAnalysis
  } catch {
    console.error('[AI Intent] Failed to parse OpenAI response:', jsonText)
    return {
      hasBookingIntent: false,
      confidence: 'low',
      extractedInfo: {},
      reason: 'Failed to parse AI response'
    }
  }
}

/**
 * Fallback keyword-based analysis
 */
function analyzeWithKeywords(message: string): IntentAnalysis {
  const lowerMessage = message.toLowerCase()

  // Negative keywords - definitely not booking intent
  const negativeKeywords = [
    'wrong number',
    'stop',
    'unsubscribe',
    'remove me',
    'don\'t text',
    'dont text',
    'spam',
    'leave me alone',
  ]

  for (const keyword of negativeKeywords) {
    if (lowerMessage.includes(keyword)) {
      return {
        hasBookingIntent: false,
        confidence: 'high',
        extractedInfo: {},
        reason: `Contains negative keyword: ${keyword}`
      }
    }
  }

  // Positive keywords - likely booking intent
  const positiveKeywords = [
    'cleaning',
    'clean my',
    'house clean',
    'home clean',
    'maid',
    'quote',
    'estimate',
    'price',
    'pricing',
    'rates',
    'cost',
    'book',
    'schedule',
    'appointment',
    'available',
    'service',
    'need help',
    'looking for',
  ]

  for (const keyword of positiveKeywords) {
    if (lowerMessage.includes(keyword)) {
      return {
        hasBookingIntent: true,
        confidence: 'medium',
        extractedInfo: {},
        reason: `Contains booking keyword: ${keyword}`
      }
    }
  }

  // Question patterns often indicate interest
  if (lowerMessage.includes('?') && lowerMessage.length > 10) {
    return {
      hasBookingIntent: true,
      confidence: 'low',
      extractedInfo: {},
      reason: 'Contains question, possible inquiry'
    }
  }

  // Default: no intent detected
  return {
    hasBookingIntent: false,
    confidence: 'low',
    extractedInfo: {},
    reason: 'No booking keywords detected'
  }
}

/**
 * Quick check for obvious non-booking messages
 * Use this before calling the full AI analysis to save API calls
 * NOTE: Be conservative - "yes", "no", "sure" could be responses to follow-up questions
 */
export function isObviouslyNotBooking(message: string): boolean {
  const lowerMessage = message.toLowerCase().trim()

  // Very short messages with no content
  if (lowerMessage.length < 2) return true

  // Only skip truly meaningless acknowledgments
  // NOTE: Don't skip "yes", "no", "sure" - these could be responses to our questions!
  const meaninglessAcknowledgments = ['ok', 'k', 'kk', 'thanks', 'thx', 'ty', 'cool', 'great', 'okay', 'np', 'got it']
  if (meaninglessAcknowledgments.includes(lowerMessage)) return true

  // Obvious opt-outs
  if (lowerMessage === 'stop' || lowerMessage === 'unsubscribe') return true

  return false
}
