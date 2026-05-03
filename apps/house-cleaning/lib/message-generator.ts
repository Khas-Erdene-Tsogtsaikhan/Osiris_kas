/**
 * Message Generator — the Humanity Engine's writing pipeline.
 *
 * OUTREACH-SPEC v1.0 Section 8. Produces a single message for a pipeline
 * stage, voiced as the tenant owner, referencing real customer history,
 * and auto-lints the output. Returns a template fallback if AI fails or
 * the linter rejects 3x.
 *
 * Exported `generateOutreachMessage` is the high-level API every cron uses.
 * It is pluggable: tests inject a fake `llmCall` to avoid hitting Anthropic.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { lintMessage, type LintResult } from './message-linter'
import type { Pipeline, Variant } from './ab-testing'
import type { CustomerMemory } from './customer-memory'
import { loadCustomerMemory } from './customer-memory'

export type Channel = 'sms' | 'email' | 'mms'

export interface TenantVoiceProfile {
  owner_name?: string
  owner_age?: number
  owner_vibe?: string
  emoji_set?: string[]
  never_says?: string[]
  always_says?: string[]
  signature?: string
  voice_samples?: string[]
}

export interface GenerationInput {
  client: SupabaseClient
  tenantId: string
  tenantName: string
  voiceProfile: TenantVoiceProfile
  customerId: number
  customerFirstName?: string | null
  pipeline: Pipeline
  stage: number
  variant: Variant
  channel: Channel
  /** Used by Pipeline B stage 3 to include a tenant-capped discount. */
  offerPct?: number
  /** Quote link, used by Pipeline B. */
  quoteUrl?: string
  /** Override for tests. */
  llmCall?: LLMCallFn
  /** Override for tests — skip memory DB call. */
  preloadedMemory?: CustomerMemory
  /** Model override. Default: Haiku for all except Post-Quote stage 1 (Sonnet). */
  model?: string
}

export interface GenerationResult {
  text: string
  lintResult: LintResult
  fallback: boolean
  modelUsed: string
}

export type LLMCallFn = (args: {
  model: string
  system: string
  user: string
  maxTokens: number
}) => Promise<string>

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const SONNET_MODEL = 'claude-sonnet-4-6'

const MAX_RETRIES = 3

function modelForStage(pipeline: Pipeline, stage: number, override?: string): string {
  if (override) return override
  if (pipeline === 'post_quote' && stage === 1) return SONNET_MODEL
  return HAIKU_MODEL
}

/** Default LLM caller using Anthropic SDK. Tests pass their own. */
async function defaultLlmCall(args: { model: string; system: string; user: string; maxTokens: number }): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: 'user', content: args.user }],
  })

  const content = response.content[0]
  if (!content || content.type !== 'text') throw new Error('No text in AI response')
  return content.text.trim()
}

function buildSystemPrompt(voice: TenantVoiceProfile, pipeline: Pipeline, stage: number, channel: Channel): string {
  const owner = voice.owner_name || 'the owner'
  const vibe = voice.owner_vibe || 'casual, friendly, human'
  const never = voice.never_says?.length ? voice.never_says.join(', ') : 'none'
  const always = voice.always_says?.length ? voice.always_says.join(', ') : 'none'
  const emojis = voice.emoji_set?.length ? voice.emoji_set.join(' ') : '(none)'
  const samples = voice.voice_samples?.length
    ? voice.voice_samples.slice(0, 5).map((s, i) => `Sample ${i + 1}: "${s}"`).join('\n')
    : '(no samples yet — use the vibe description)'

  const channelLine = channel === 'email'
    ? 'Write an EMAIL. Keep it under 600 chars. Subject line on line 1, blank line, then body.'
    : channel === 'mms'
    ? 'Write a short MMS caption. Under 200 chars. Image will be attached separately.'
    : 'Write an SMS. Under 160 chars if possible. No subject line.'

  return [
    `You write in the voice of ${owner}, the owner of a cleaning business.`,
    `Vibe: ${vibe}.`,
    `Emojis you might use: ${emojis}. Use 0-3 per message, never spammy.`,
    `NEVER use these phrases: ${never}.`,
    `Natural phrases you might say: ${always}.`,
    `Signature: ${voice.signature ?? ''}`,
    '',
    'Voice samples (mimic tone, do NOT copy phrases verbatim):',
    samples,
    '',
    channelLine,
    '',
    'Rules:',
    '- One text, not a thread.',
    '- Casual lowercase is fine. Minor typos are fine — more human.',
    '- NEVER sound like marketing. NEVER say "dear", "valued customer", "exclusive offer", "limited time", "book now!", or "we\'ve upgraded".',
    '- Reference one concrete thing from the customer\'s history below if provided.',
    '- No emojis in a row. No triple punctuation.',
    `- Pipeline: ${pipeline}, Stage: ${stage}.`,
  ].join('\n')
}

function buildUserPrompt(opts: {
  firstName: string
  memory: CustomerMemory
  pipeline: Pipeline
  stage: number
  offerPct?: number
  quoteUrl?: string
  stageIntent: string
}): string {
  const lines: string[] = []
  lines.push(`Customer: ${opts.firstName || 'there'}`)

  if (opts.memory.callback_anchors?.length) {
    lines.push(`Recent things they said: ${opts.memory.callback_anchors.slice(0, 3).map(a => `"${a}"`).join(', ')}`)
  }
  if (opts.memory.pets?.length) {
    const pet = opts.memory.pets[0]
    lines.push(`They mentioned a pet: ${pet.type ?? 'pet'}${pet.name ? ` named ${pet.name}` : ''}`)
  }
  if (opts.memory.kids?.length) {
    lines.push(`They mentioned kids.`)
  }
  if (opts.memory.last_excited_about) {
    lines.push(`Last excited about: ${opts.memory.last_excited_about}`)
  }
  if (opts.memory.known_objections?.length) {
    lines.push(`Known objections: ${opts.memory.known_objections.slice(0, 2).join(', ')} — DON'T mention these directly, just be mindful.`)
  }

  lines.push('')
  lines.push(`Stage intent: ${opts.stageIntent}`)
  if (opts.offerPct) lines.push(`Offer: ${opts.offerPct}% off, 7-day deadline`)
  if (opts.quoteUrl) lines.push(`Include this link naturally: ${opts.quoteUrl}`)
  lines.push('')
  lines.push('Write the message. Only the message — no preamble, no "Here you go:".')

  return lines.join('\n')
}

const STAGE_INTENTS: Record<string, string> = {
  'pre_quote:1': 'Friendly first nudge. Ask ONE specific thing you need to quote (bed/bath, address, service type). 4 hours since last message.',
  'pre_quote:2': 'Soft urgency — schedule filling up. Ask the same info-unblocking question. 1 day since stage 1.',
  'pre_quote:3': 'Warm last-ask, no pressure, "text anytime". 3 days since stage 2.',
  'post_quote:1': 'They got the quote, 7 min ago, no reply. Just a quick "did you see it?" — casual, no pressure. CRITICAL: read their last message and answer if they asked something.',
  'post_quote:2': 'Value-add. What\'s included in the quote. Offer to tweak the scope if something\'s off. 4h after stage 1.',
  'post_quote:3': 'Close with an offer. Tenant-capped discount. 7-day deadline. 1 day after stage 2.',
  'post_quote:4': 'Last chance. "Slot\'s coming off the books tomorrow." 3 days after stage 3.',
  'retargeting:1': 'Gentle check-in. No offer. Reference their chat history. 30+ days since last touch.',
  'retargeting:2': 'Different theme. Seasonal or what\'s new. Still no offer.',
  'retargeting:3': 'Offer. 15% off or free add-on, 7-day deadline.',
}

function templateFallback(opts: {
  firstName: string
  pipeline: Pipeline
  stage: number
  tenantName: string
  voice: TenantVoiceProfile
  offerPct?: number
  quoteUrl?: string
}): string {
  const name = opts.firstName || 'there'
  const sig = opts.voice.signature ? `\n${opts.voice.signature}` : ''
  const biz = opts.tenantName

  const key = `${opts.pipeline}:${opts.stage}` as keyof typeof STAGE_INTENTS
  switch (key) {
    case 'pre_quote:1':
      return `hey ${name}, just following up on your cleaning request. can you share bed/bath/address so I can send a quote?${sig}`
    case 'pre_quote:2':
      return `hey ${name}, schedule\'s filling up — want me to put that quote together? just need bed/bath/address.${sig}`
    case 'pre_quote:3':
      return `hey ${name}, last nudge from me. if it\'s not the right time, no worries — text anytime.${sig}`
    case 'post_quote:1':
      return `hey ${name}, did you get a chance to look at the quote? happy to answer any Qs.${sig}`
    case 'post_quote:2':
      return `hey ${name} — just to add, the quote covers everything from top-to-bottom. if you want to tweak the scope, let me know.${sig}`
    case 'post_quote:3':
      return `hey ${name}, running a ${opts.offerPct ?? 10}% off if you lock it in this week. ${opts.quoteUrl ? `quote: ${opts.quoteUrl}` : ''}${sig}`
    case 'post_quote:4':
      return `hey ${name}, last nudge — the slot comes off the books tomorrow. want me to keep it?${sig}`
    case 'retargeting:1':
      return `hey ${name}, ${biz} here — just checking in. hope things are well.${sig}`
    case 'retargeting:2':
      return `hey ${name}, it\'s been a minute — still here when you\'re ready for a reset.${sig}`
    case 'retargeting:3':
      return `hey ${name} — sending a 15% off just for you, good for 7 days if you want to grab a slot.${sig}`
    default:
      return `hey ${name}, just wanted to check in.${sig}`
  }
}

/**
 * Generate an outreach message. Runs the LLM up to MAX_RETRIES times; if
 * linter still rejects, returns a template fallback so the caller still has
 * something to send.
 */
export async function generateOutreachMessage(input: GenerationInput): Promise<GenerationResult> {
  const llm = input.llmCall ?? defaultLlmCall
  const memory = input.preloadedMemory
    ?? await loadCustomerMemory(input.client, input.tenantId, input.customerId)
  const firstName = (input.customerFirstName || 'there').trim() || 'there'
  const model = modelForStage(input.pipeline, input.stage, input.model)

  const stageKey = `${input.pipeline}:${input.stage}`
  const stageIntent = STAGE_INTENTS[stageKey] || 'Friendly check-in.'

  const system = buildSystemPrompt(input.voiceProfile, input.pipeline, input.stage, input.channel)
  const user = buildUserPrompt({
    firstName,
    memory,
    pipeline: input.pipeline,
    stage: input.stage,
    offerPct: input.offerPct,
    quoteUrl: input.quoteUrl,
    stageIntent,
  })

  const bannedFromProfile = input.voiceProfile.never_says ?? []

  let lastFailures: LintResult['failures'] = []
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let text: string
    try {
      text = await llm({ model, system, user, maxTokens: 400 })
    } catch (err) {
      lastFailures = [{ rule: 'empty_message', detail: `llm error: ${(err as Error).message}` }]
      continue
    }

    const lint = lintMessage({
      text,
      pipeline: input.pipeline,
      channel: input.channel,
      firstName,
      tenantBannedPhrases: bannedFromProfile,
      callbackAnchors: memory.callback_anchors,
    })

    if (lint.ok) {
      return { text, lintResult: lint, fallback: false, modelUsed: model }
    }
    lastFailures = lint.failures
  }

  // All attempts failed — fall back to template (not AI) and re-lint it.
  const fallbackText = templateFallback({
    firstName,
    pipeline: input.pipeline,
    stage: input.stage,
    tenantName: input.tenantName,
    voice: input.voiceProfile,
    offerPct: input.offerPct,
    quoteUrl: input.quoteUrl,
  })

  const fallbackLint = lintMessage({
    text: fallbackText,
    pipeline: input.pipeline,
    channel: input.channel,
    firstName,
    tenantBannedPhrases: bannedFromProfile,
    // Pipeline C callback check is disabled for the template fallback
    callbackAnchors: input.pipeline === 'retargeting' ? undefined : memory.callback_anchors,
  })

  return {
    text: fallbackText,
    lintResult: fallbackLint.ok
      ? fallbackLint
      : { ok: false, failures: [...fallbackLint.failures, ...lastFailures] },
    fallback: true,
    modelUsed: model,
  }
}
