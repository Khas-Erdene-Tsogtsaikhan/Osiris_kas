// lib/brain/embed.ts
// Embedding generation for Brain knowledge chunks.
// Uses OpenAI text-embedding-3-small (same as conversation-scoring.ts).

import { getSupabaseServiceClient } from '../supabase'

const EMBEDDING_MODEL = 'text-embedding-3-small'
const BATCH_SIZE = 20
const TIMEOUT_MS = 15_000

/**
 * Generate an embedding vector for a single text string.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('[Brain:Embed] No OPENAI_API_KEY — skipping embedding')
    return null
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      console.error('[Brain:Embed] API error:', res.status, await res.text())
      return null
    }

    const data = await res.json()
    return data.data?.[0]?.embedding || null
  } catch (err) {
    console.error('[Brain:Embed] Failed:', err)
    return null
  }
}

/**
 * Generate embeddings for multiple texts in a single API call.
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<(number[] | null)[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('[Brain:Embed] No OPENAI_API_KEY — skipping batch embedding')
    return texts.map(() => null)
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts.map(t => t.slice(0, 8000)),
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      console.error('[Brain:Embed] Batch API error:', res.status)
      return texts.map(() => null)
    }

    const data = await res.json()
    const embeddings: (number[] | null)[] = texts.map(() => null)
    for (const item of data.data || []) {
      embeddings[item.index] = item.embedding
    }
    return embeddings
  } catch (err) {
    console.error('[Brain:Embed] Batch failed:', err)
    return texts.map(() => null)
  }
}

/**
 * Embed all un-embedded brain_chunks. Called by the brain-embed cron.
 * Processes in batches of BATCH_SIZE. Returns count of newly embedded chunks.
 */
export async function embedPendingChunks(limit: number = 200): Promise<number> {
  const client = getSupabaseServiceClient()

  const { data: chunks, error } = await client
    .from('brain_chunks')
    .select('id, chunk_text')
    .is('embedded_at', null)
    .order('id', { ascending: true })
    .limit(limit)

  if (error || !chunks?.length) {
    if (error) console.error('[Brain:Embed] Fetch error:', error.message)
    return 0
  }

  console.log(`[Brain:Embed] Embedding ${chunks.length} pending chunks`)
  let embedded = 0

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const texts = batch.map(c => c.chunk_text)
    const embeddings = await generateEmbeddingsBatch(texts)

    for (let j = 0; j < batch.length; j++) {
      if (!embeddings[j]) continue

      const { error: updateErr } = await client
        .from('brain_chunks')
        .update({
          embedding: embeddings[j] as any,
          embedded_at: new Date().toISOString(),
        })
        .eq('id', batch[j].id)

      if (!updateErr) embedded++
    }

    // Brief pause between batches to respect rate limits
    if (i + BATCH_SIZE < chunks.length) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  console.log(`[Brain:Embed] Embedded ${embedded}/${chunks.length} chunks`)
  return embedded
}
