// lib/brain/learn.ts
// Self-improvement engine for the Osiris Brain.
// Analyzes real business outcomes, generates operational insights,
// and discovers new knowledge sources automatically.

import { getSupabaseServiceClient } from '../supabase'

// ── Learn from Operational Data ─────────────────────────────────────

/**
 * Analyze real Osiris data and generate Brain knowledge from it.
 * This turns YOUR business outcomes into searchable intelligence.
 * Called by the brain-learn cron (daily).
 */
export async function learnFromOperations(): Promise<number> {
  const client = getSupabaseServiceClient()
  let insightsGenerated = 0

  // 1. Learn from conversation outcomes (what SMS/VAPI approaches actually book)
  const { data: winPatterns } = await client
    .from('conversation_outcomes')
    .select('conversation_summary, outcome, outcome_reason, patterns, revenue, conversation_type')
    .eq('outcome', 'won')
    .order('scored_at', { ascending: false })
    .limit(50)

  if (winPatterns?.length) {
    const winInsight = winPatterns.map(w =>
      `[${w.conversation_type}] ${w.conversation_summary} — Result: BOOKED (${w.outcome_reason}). Revenue: $${w.revenue || 'unknown'}. Winning tactics: ${JSON.stringify(w.patterns?.winning_tactics || [])}`
    ).join('\n')

    await upsertOperationalInsight(client, 'winning_conversation_patterns', 'sales',
      `REAL DATA from Spotless Scrubbers — These conversation approaches actually resulted in bookings:\n\n${winInsight}`)
    insightsGenerated++
  }

  // 2. Learn from lost conversations (what to avoid)
  const { data: lossPatterns } = await client
    .from('conversation_outcomes')
    .select('conversation_summary, outcome_reason, patterns, conversation_type')
    .eq('outcome', 'lost')
    .order('scored_at', { ascending: false })
    .limit(30)

  if (lossPatterns?.length) {
    // Group by reason
    const reasons: Record<string, number> = {}
    for (const l of lossPatterns) {
      const r = l.outcome_reason || 'unknown'
      reasons[r] = (reasons[r] || 0) + 1
    }

    const lossInsight = `REAL DATA — Top reasons leads are lost at Spotless Scrubbers:\n` +
      Object.entries(reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `- ${reason}: ${count} occurrences`)
        .join('\n') +
      `\n\nSpecific losing signals from recent conversations:\n` +
      lossPatterns.slice(0, 10).map(l =>
        `[${l.conversation_type}] ${l.conversation_summary} — Lost because: ${l.outcome_reason}. Signals: ${JSON.stringify(l.patterns?.losing_signals || [])}`
      ).join('\n')

    await upsertOperationalInsight(client, 'losing_conversation_patterns', 'sales', lossInsight)
    insightsGenerated++
  }

  // 3. Learn from pricing data (what prices actually close)
  const { data: pricingData } = await client
    .from('jobs')
    .select('service_type, bedrooms, bathrooms, square_footage, price, status, pricing_strategy')
    .in('status', ['completed', 'scheduled', 'in_progress'])
    .not('price', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100)

  if (pricingData?.length) {
    // Calculate avg price by bedroom count
    const byBedroom: Record<number, number[]> = {}
    for (const j of pricingData) {
      if (j.bedrooms && j.price) {
        if (!byBedroom[j.bedrooms]) byBedroom[j.bedrooms] = []
        byBedroom[j.bedrooms].push(j.price)
      }
    }

    const pricingInsight = `REAL PRICING DATA from Spotless Scrubbers (jobs that actually booked and completed):\n\n` +
      Object.entries(byBedroom)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([beds, prices]) => {
          const avg = prices.reduce((a, b) => a + b, 0) / prices.length
          const min = Math.min(...prices)
          const max = Math.max(...prices)
          return `${beds} bedroom: avg $${avg.toFixed(0)}, range $${min}-$${max} (${prices.length} jobs)`
        })
        .join('\n') +
      `\n\nTotal completed jobs analyzed: ${pricingData.length}`

    await upsertOperationalInsight(client, 'real_pricing_data', 'pricing', pricingInsight)
    insightsGenerated++
  }

  // 4. Learn from customer scores (what segments are most valuable)
  const { data: scoreData } = await client
    .from('customer_scores')
    .select('segment, lead_score, lifetime_value, churn_risk')
    .order('lifetime_value', { ascending: false })
    .limit(200)

  if (scoreData?.length) {
    const segments: Record<string, { count: number; avgLTV: number; avgChurn: number }> = {}
    for (const s of scoreData) {
      if (!s.segment) continue
      if (!segments[s.segment]) segments[s.segment] = { count: 0, avgLTV: 0, avgChurn: 0 }
      segments[s.segment].count++
      segments[s.segment].avgLTV += s.lifetime_value || 0
      segments[s.segment].avgChurn += s.churn_risk || 0
    }

    const segmentInsight = `REAL CUSTOMER SEGMENT DATA from Spotless Scrubbers:\n\n` +
      Object.entries(segments)
        .map(([seg, data]) => {
          const avgLTV = data.count > 0 ? (data.avgLTV / data.count).toFixed(0) : '0'
          const avgChurn = data.count > 0 ? ((data.avgChurn / data.count) * 100).toFixed(0) : '0'
          return `${seg}: ${data.count} customers, avg LTV $${avgLTV}, churn risk ${avgChurn}%`
        })
        .join('\n')

    await upsertOperationalInsight(client, 'customer_segments', 'retention', segmentInsight)
    insightsGenerated++
  }

  // 5. Learn from Brain decision outcomes (what advice actually worked)
  const { data: decisions } = await client
    .from('brain_decisions')
    .select('decision_type, outcome, confidence, query_text, decision_text')
    .not('outcome', 'eq', 'pending')
    .order('created_at', { ascending: false })
    .limit(50)

  if (decisions?.length) {
    const positive = decisions.filter(d => d.outcome === 'positive')
    const negative = decisions.filter(d => d.outcome === 'negative')

    if (positive.length + negative.length > 5) {
      const selfReflection = `BRAIN SELF-REFLECTION — Analysis of past Brain decisions:\n\n` +
        `Positive outcomes: ${positive.length}/${decisions.length} (${((positive.length / decisions.length) * 100).toFixed(0)}%)\n` +
        `Negative outcomes: ${negative.length}/${decisions.length}\n\n` +
        (positive.length > 0 ? `Advice that WORKED:\n${positive.slice(0, 5).map(d => `- Q: "${d.query_text?.slice(0, 100)}" → A: "${d.decision_text?.slice(0, 150)}"`).join('\n')}\n\n` : '') +
        (negative.length > 0 ? `Advice that FAILED:\n${negative.slice(0, 5).map(d => `- Q: "${d.query_text?.slice(0, 100)}" → A: "${d.decision_text?.slice(0, 150)}"`).join('\n')}` : '')

      await upsertOperationalInsight(client, 'brain_self_reflection', 'general', selfReflection)
      insightsGenerated++
    }
  }

  console.log(`[Brain:Learn] Generated ${insightsGenerated} operational insights`)
  return insightsGenerated
}

// ── Auto-Discover New Content ───────────────────────────────────────

/**
 * Search for new cleaning business videos from tracked channels.
 * Re-queries YouTube for any videos we haven't seen yet.
 * Also discovers new channels from search.
 */
export async function discoverNewContent(): Promise<number> {
  const client = getSupabaseServiceClient()
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return 0

  // Get existing channels we track
  const { data: channels } = await client
    .from('brain_sources')
    .select('channel_id, channel_name')
    .eq('source_type', 'youtube_channel')

  let discovered = 0

  // Check each channel for new videos we haven't seen
  for (const ch of channels || []) {
    if (!ch.channel_id) continue

    try {
      // Get latest videos from channel
      const params = new URLSearchParams({
        part: 'snippet',
        channelId: ch.channel_id,
        maxResults: '10',
        order: 'date',
        type: 'video',
        key: apiKey,
      })

      const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
      if (!res.ok) continue

      const data = await res.json()
      for (const item of data.items || []) {
        const videoId = item.id?.videoId
        if (!videoId) continue

        // Check if we already have this video
        const { data: existing } = await client
          .from('brain_sources')
          .select('id')
          .eq('video_id', videoId)
          .maybeSingle()

        if (existing) continue

        // New video found — queue it
        const { error } = await client
          .from('brain_sources')
          .insert({
            source_type: 'youtube_video',
            channel_id: ch.channel_id,
            channel_name: ch.channel_name,
            video_id: videoId,
            video_title: item.snippet?.title || '',
            video_url: `https://www.youtube.com/watch?v=${videoId}`,
            published_at: item.snippet?.publishedAt || null,
            title: item.snippet?.title || '',
            author: ch.channel_name,
            status: 'queued',
          })

        if (!error) {
          discovered++
          console.log(`[Brain:Discover] New video: ${item.snippet?.title} (${ch.channel_name})`)
        }
      }

      // Rate limit between channels
      await new Promise(r => setTimeout(r, 1000))
    } catch (err) {
      console.error(`[Brain:Discover] Error checking ${ch.channel_name}:`, err)
    }
  }

  // Also search for new cleaning business content we might be missing
  try {
    const searchTerms = [
      'cleaning business tips 2026',
      'how to scale cleaning company',
      'cleaning business automation',
      'hiring cleaners tips',
      'cleaning business pricing strategy',
    ]
    // Pick a random search term each run to diversify
    const term = searchTerms[Math.floor(Math.random() * searchTerms.length)]

    const params = new URLSearchParams({
      part: 'snippet',
      q: term,
      maxResults: '5',
      order: 'viewCount',
      type: 'video',
      key: apiKey,
    })

    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
    if (res.ok) {
      const data = await res.json()
      for (const item of data.items || []) {
        const videoId = item.id?.videoId
        if (!videoId) continue

        const { data: existing } = await client
          .from('brain_sources')
          .select('id')
          .eq('video_id', videoId)
          .maybeSingle()

        if (existing) continue

        const { error } = await client
          .from('brain_sources')
          .insert({
            source_type: 'youtube_video',
            channel_id: item.snippet?.channelId || null,
            channel_name: item.snippet?.channelTitle || null,
            video_id: videoId,
            video_title: item.snippet?.title || '',
            video_url: `https://www.youtube.com/watch?v=${videoId}`,
            published_at: item.snippet?.publishedAt || null,
            title: item.snippet?.title || '',
            author: item.snippet?.channelTitle || '',
            status: 'queued',
          })

        if (!error) {
          discovered++
          console.log(`[Brain:Discover] Found via search: ${item.snippet?.title}`)
        }
      }
    }
  } catch (err) {
    console.error('[Brain:Discover] Search discovery error:', err)
  }

  console.log(`[Brain:Discover] Discovered ${discovered} new videos`)
  return discovered
}

// ── VAPI & SMS Transcript Ingestion ─────────────────────────────────

/**
 * Ingest successful VAPI call transcripts as Brain knowledge.
 * These are gold — 40% conversion rate. The Brain should learn
 * exactly what the AI says on calls that lead to bookings.
 */
export async function ingestVapiTranscripts(): Promise<number> {
  const client = getSupabaseServiceClient()
  let ingested = 0

  // Get VAPI call messages that resulted in booked jobs
  // Look for conversations where we have both the transcript and a positive outcome
  const { data: winningCalls } = await client
    .from('conversation_outcomes')
    .select('id, conversation_text, conversation_summary, patterns, revenue, source_phone, scored_at')
    .eq('conversation_type', 'vapi_call')
    .eq('outcome', 'won')
    .order('scored_at', { ascending: false })
    .limit(50)

  for (const call of winningCalls || []) {
    if (!call.conversation_text || call.conversation_text.length < 100) continue

    const title = `vapi_winning_call_${call.id}`

    // Check if already ingested
    const { data: existing } = await client
      .from('brain_sources')
      .select('id')
      .eq('title', title)
      .maybeSingle()

    if (existing) continue

    // Create source
    const { data: source, error: srcErr } = await client
      .from('brain_sources')
      .insert({
        source_type: 'manual',
        title,
        author: 'Spotless Scrubbers VAPI (real call)',
        status: 'completed',
        transcript_raw: call.conversation_text,
        metadata: {
          type: 'vapi_winning_call',
          revenue: call.revenue,
          phone: call.source_phone,
          patterns: call.patterns,
          summary: call.conversation_summary,
        },
      })
      .select('id')
      .single()

    if (srcErr || !source) continue

    // Chunk the transcript (VAPI transcripts can be long)
    const chunks = chunkText(call.conversation_text, 3000, 300)
    const enrichedChunks = chunks.map((text, i) => ({
      source_id: source.id,
      chunk_index: i,
      chunk_text: `[REAL WINNING VAPI CALL — This exact conversation led to a booking${call.revenue ? ` worth $${call.revenue}` : ''}]\n${call.conversation_summary ? `Summary: ${call.conversation_summary}\n` : ''}Transcript:\n${text}`,
      token_count: Math.ceil(text.length / 4),
      domain: 'sales' as const,
      sub_topics: ['vapi', 'phone_sales', 'winning_call', 'real_data'],
    }))

    const { error: chunkErr } = await client
      .from('brain_chunks')
      .insert(enrichedChunks)

    if (!chunkErr) {
      ingested++
      console.log(`[Brain:Learn] Ingested winning VAPI call ${call.id}`)
    }
  }

  console.log(`[Brain:Learn] Ingested ${ingested} VAPI winning call transcripts`)
  return ingested
}

/**
 * Ingest winning SMS conversation threads as Brain knowledge.
 * These show exactly what text messaging approach books customers.
 */
export async function ingestWinningSmsConversations(): Promise<number> {
  const client = getSupabaseServiceClient()
  let ingested = 0

  const { data: winningConvos } = await client
    .from('conversation_outcomes')
    .select('id, conversation_text, conversation_summary, patterns, revenue, source_phone, scored_at')
    .eq('conversation_type', 'sms')
    .eq('outcome', 'won')
    .order('scored_at', { ascending: false })
    .limit(50)

  for (const convo of winningConvos || []) {
    if (!convo.conversation_text || convo.conversation_text.length < 50) continue

    const title = `sms_winning_convo_${convo.id}`

    const { data: existing } = await client
      .from('brain_sources')
      .select('id')
      .eq('title', title)
      .maybeSingle()

    if (existing) continue

    const { data: source, error: srcErr } = await client
      .from('brain_sources')
      .insert({
        source_type: 'manual',
        title,
        author: 'Spotless Scrubbers SMS (real conversation)',
        status: 'completed',
        transcript_raw: convo.conversation_text,
        metadata: {
          type: 'sms_winning_conversation',
          revenue: convo.revenue,
          phone: convo.source_phone,
          patterns: convo.patterns,
          summary: convo.conversation_summary,
        },
      })
      .select('id')
      .single()

    if (srcErr || !source) continue

    const chunkText_content = `[REAL WINNING SMS CONVERSATION — This exact text thread led to a booking${convo.revenue ? ` worth $${convo.revenue}` : ''}]\n${convo.conversation_summary ? `Summary: ${convo.conversation_summary}\nWinning tactics: ${JSON.stringify(convo.patterns?.winning_tactics || [])}\n` : ''}Full conversation:\n${convo.conversation_text}`

    const { error: chunkErr } = await client
      .from('brain_chunks')
      .insert({
        source_id: source.id,
        chunk_index: 0,
        chunk_text: chunkText_content,
        token_count: Math.ceil(chunkText_content.length / 4),
        domain: 'sales',
        sub_topics: ['sms', 'text_sales', 'winning_conversation', 'real_data'],
      })

    if (!chunkErr) {
      ingested++
      console.log(`[Brain:Learn] Ingested winning SMS convo ${convo.id}`)
    }
  }

  console.log(`[Brain:Learn] Ingested ${ingested} winning SMS conversations`)
  return ingested
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Simple text chunker for long transcripts */
function chunkText(text: string, maxChars: number = 3000, overlap: number = 300): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxChars))
    start += maxChars - overlap
  }
  return chunks
}

/**
 * Store an operational insight as a brain_source + brain_chunk.
 * These are tagged as 'manual' source type to distinguish from YouTube.
 * Upserts by title so insights get refreshed, not duplicated.
 */
async function upsertOperationalInsight(
  client: ReturnType<typeof getSupabaseServiceClient>,
  slug: string,
  domain: string,
  content: string
): Promise<void> {
  const title = `operational_insight_${slug}`

  // Check if insight source exists
  const { data: existing } = await client
    .from('brain_sources')
    .select('id')
    .eq('title', title)
    .eq('source_type', 'manual')
    .maybeSingle()

  let sourceId: number

  if (existing) {
    // Update existing
    sourceId = existing.id
    await client
      .from('brain_sources')
      .update({
        transcript_raw: content,
        updated_at: new Date().toISOString(),
        status: 'completed',
      })
      .eq('id', sourceId)

    // Delete old chunks to replace with fresh data
    await client
      .from('brain_chunks')
      .delete()
      .eq('source_id', sourceId)
  } else {
    // Create new source
    const { data: newSource, error } = await client
      .from('brain_sources')
      .insert({
        source_type: 'manual',
        title,
        author: 'Osiris Brain (self-generated)',
        status: 'completed',
        transcript_raw: content,
      })
      .select('id')
      .single()

    if (error || !newSource) {
      console.error('[Brain:Learn] Failed to create insight source:', error?.message)
      return
    }
    sourceId = newSource.id
  }

  // Insert as a single chunk (operational insights are already concise)
  await client
    .from('brain_chunks')
    .insert({
      source_id: sourceId,
      chunk_index: 0,
      chunk_text: content,
      token_count: Math.ceil(content.length / 4),
      domain,
      sub_topics: [slug],
      is_operational: true,
      // embedded_at left null — the brain-embed cron will pick it up
    })

  console.log(`[Brain:Learn] Updated insight: ${slug} (${domain})`)
}
