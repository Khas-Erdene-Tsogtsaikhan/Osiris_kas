// lib/brain/index.ts
// Osiris Brain — Core query engine.
// Retrieves relevant knowledge chunks via vector similarity,
// combines with business context, and uses Claude to reason.

import { getSupabaseServiceClient } from '../supabase'
import { generateEmbedding } from './embed'
import type { BrainQueryOptions, BrainAnswer, MatchedChunk } from './types'

/**
 * Ask the Brain a question. Returns a reasoned answer backed by
 * cleaning industry knowledge and (optionally) live business context.
 *
 * This is the primary interface — VAPI, SMS responder, crons, and
 * the dashboard all call this function.
 */
export async function queryBrain(opts: BrainQueryOptions): Promise<BrainAnswer> {
  const {
    question,
    tenantId,
    domain,
    maxChunks = 8,
    minSimilarity = 0.55,
    businessContext = {},
    decisionType,
    triggeredBy,
  } = opts

  // 1. Embed the question
  const embedding = await generateEmbedding(question)
  if (!embedding) {
    return fallbackAnswer('Could not generate embedding for question')
  }

  // 2. Retrieve relevant knowledge chunks
  const client = getSupabaseServiceClient()

  // Try hybrid search (vector + keyword) first, fall back to vector-only
  let matches: unknown[] | null = null
  let error: { message: string } | null = null

  const hybridResult = await client.rpc('match_brain_chunks_hybrid', {
    query_text: question,
    query_embedding: embedding,
    match_count: maxChunks,
    filter_domain: domain || null,
    keyword_weight: 0.3,
    semantic_weight: 0.7,
  })

  if (hybridResult.error) {
    // Hybrid RPC might not exist yet — fall back to vector-only
    console.warn('[Brain] Hybrid search unavailable, using vector-only:', hybridResult.error.message)
    const vectorResult = await client.rpc('match_brain_chunks', {
      query_embedding: embedding,
      match_threshold: minSimilarity,
      match_count: maxChunks,
      filter_domain: domain || null,
    })
    matches = vectorResult.data
    error = vectorResult.error
  } else {
    matches = hybridResult.data
    error = hybridResult.error
  }

  if (error) {
    console.error('[Brain] Similarity search failed:', error.message)
    return fallbackAnswer('Knowledge retrieval failed')
  }

  const chunks = (matches || []) as MatchedChunk[]

  // 3. Build context for Claude
  const knowledgeContext = chunks.length > 0
    ? chunks.map((c, i) =>
        `[Source ${i + 1}: ${c.channel_name || 'Unknown'} — "${c.video_title || 'Untitled'}" (${c.domain})]\n${c.chunk_text}`
      ).join('\n\n---\n\n')
    : 'No relevant knowledge found in the database. Answer from general cleaning business expertise.'

  const businessCtxStr = Object.keys(businessContext).length > 0
    ? `\n\nBusiness context:\n${JSON.stringify(businessContext, null, 2)}`
    : ''

  // 4. Ask Claude to reason
  const answer = await reasonWithClaude(question, knowledgeContext, businessCtxStr)

  // 5. Log the decision (fire-and-forget)
  const decisionId = await logDecision(client, {
    tenantId: tenantId || null,
    queryText: question,
    queryContext: businessContext,
    decisionText: answer.answer,
    reasoning: answer.reasoning,
    confidence: answer.confidence,
    chunkIds: chunks.map(c => c.id),
    sourceIds: [...new Set(chunks.map(c => c.source_id))],
    decisionType: decisionType || null,
    triggeredBy: triggeredBy || null,
  })

  return { ...answer, sources: chunks.map(c => ({
    videoTitle: c.video_title,
    channelName: c.channel_name,
    chunkText: c.chunk_text.slice(0, 200),
    similarity: c.similarity,
  })), decisionId }
}

// ── Claude Reasoning ────────────────────────────────────────────────

async function reasonWithClaude(
  question: string,
  knowledgeContext: string,
  businessContext: string
): Promise<{ answer: string; reasoning: string; confidence: number }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return { answer: 'AI service unavailable', reasoning: '', confidence: 0 }
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: [{ type: 'text', text: `You are the Osiris Brain — an expert autonomous AI that runs cleaning businesses.
You have deep knowledge of the cleaning industry from top coaches and operators.
You make decisions that maximize profit, customer satisfaction, and operational efficiency.

Your knowledge base contains real advice from successful cleaning business owners and coaches.
Use it to inform your answers, but adapt the advice to the specific situation.

ALWAYS return a JSON object with exactly these fields:
{
  "answer": "Direct, actionable answer to the question. Be specific and practical.",
  "reasoning": "Brief explanation of WHY this is the right approach, citing which sources informed your thinking.",
  "confidence": 0.0-1.0 (how confident you are based on the available knowledge)
}

If the knowledge base doesn't cover the question well, say so honestly and give your best answer with lower confidence.`, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `KNOWLEDGE BASE:\n${knowledgeContext}\n${businessContext}\n\nQUESTION: ${question}`,
      }],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        answer: parsed.answer || text,
        reasoning: parsed.reasoning || '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      }
    }

    return { answer: text, reasoning: '', confidence: 0.5 }
  } catch (err) {
    console.error('[Brain] Claude reasoning failed:', err)
    return { answer: 'Reasoning failed — try again', reasoning: '', confidence: 0 }
  }
}

// ── Decision Logging ────────────────────────────────────────────────

async function logDecision(
  client: ReturnType<typeof getSupabaseServiceClient>,
  data: {
    tenantId: string | null
    queryText: string
    queryContext: Record<string, unknown>
    decisionText: string
    reasoning: string
    confidence: number
    chunkIds: number[]
    sourceIds: number[]
    decisionType: string | null
    triggeredBy: string | null
  }
): Promise<number | null> {
  try {
    const { data: row, error } = await client
      .from('brain_decisions')
      .insert({
        tenant_id: data.tenantId,
        query_text: data.queryText,
        query_context: data.queryContext,
        decision_text: data.decisionText,
        reasoning: data.reasoning,
        confidence: data.confidence,
        chunk_ids: data.chunkIds,
        source_ids: data.sourceIds,
        outcome: 'pending',
        decision_type: data.decisionType,
        triggered_by: data.triggeredBy,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[Brain] Decision log failed:', error.message)
      return null
    }
    return row?.id || null
  } catch {
    return null
  }
}

/**
 * Record the outcome of a Brain decision (feedback loop).
 */
export async function recordDecisionOutcome(
  decisionId: number,
  outcome: 'positive' | 'negative' | 'neutral',
  details: Record<string, unknown> = {}
): Promise<void> {
  const client = getSupabaseServiceClient()
  await client
    .from('brain_decisions')
    .update({
      outcome,
      outcome_details: details,
      outcome_recorded_at: new Date().toISOString(),
    })
    .eq('id', decisionId)
}

// ── Helpers ─────────────────────────────────────────────────────────

function fallbackAnswer(reason: string): BrainAnswer {
  return {
    answer: reason,
    reasoning: '',
    confidence: 0,
    sources: [],
    decisionId: null,
  }
}

// ── Quick Knowledge Stats ───────────────────────────────────────────

export async function getBrainStats(): Promise<{
  totalSources: number
  completedSources: number
  totalChunks: number
  embeddedChunks: number
  totalDecisions: number
  domainBreakdown: Record<string, number>
}> {
  const client = getSupabaseServiceClient()

  const [sources, completed, chunks, embedded, decisions] = await Promise.all([
    client.from('brain_sources').select('id', { count: 'exact', head: true }),
    client.from('brain_sources').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    client.from('brain_chunks').select('id', { count: 'exact', head: true }),
    client.from('brain_chunks').select('id', { count: 'exact', head: true }).not('embedded_at', 'is', null),
    client.from('brain_decisions').select('id', { count: 'exact', head: true }),
  ])

  const { data: domainData } = await client
    .from('brain_chunks')
    .select('domain')

  const domainBreakdown: Record<string, number> = {}
  for (const row of domainData || []) {
    const d = row.domain || 'unclassified'
    domainBreakdown[d] = (domainBreakdown[d] || 0) + 1
  }

  return {
    totalSources: sources.count || 0,
    completedSources: completed.count || 0,
    totalChunks: chunks.count || 0,
    embeddedChunks: embedded.count || 0,
    totalDecisions: decisions.count || 0,
    domainBreakdown,
  }
}
