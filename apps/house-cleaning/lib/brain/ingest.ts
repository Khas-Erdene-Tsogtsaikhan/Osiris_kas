// lib/brain/ingest.ts
// YouTube content ingestion: fetch video metadata, transcripts, chunk, and store.

import { getSupabaseServiceClient } from '../supabase'
import { CHUNK_CONFIG, DOMAIN_CLASSIFICATION_PROMPT } from './types'
import type { KnowledgeDomain } from './types'

// ── YouTube Transcript Fetching ─────────────────────────────────────

interface TranscriptSegment {
  text: string
  duration: number
  offset: number
  lang?: string
}

async function fetchTranscript(videoId: string): Promise<TranscriptSegment[]> {
  const { YoutubeTranscript } = await import('youtube-transcript')
  return YoutubeTranscript.fetchTranscript(videoId)
}

// ── YouTube Data API (metadata) ─────────────────────────────────────

interface YouTubeSearchItem {
  videoId: string
  title: string
  publishedAt: string
}

/**
 * List all video IDs from a YouTube channel using the Data API v3.
 * Requires YOUTUBE_API_KEY env var.
 */
export async function listChannelVideos(channelId: string): Promise<YouTubeSearchItem[]> {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not configured')

  const videos: YouTubeSearchItem[] = []
  let pageToken = ''

  do {
    const params = new URLSearchParams({
      part: 'snippet',
      channelId,
      maxResults: '50',
      order: 'date',
      type: 'video',
      key: apiKey,
    })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`)
    if (!res.ok) {
      const err = await res.text()
      console.error('[Brain:Ingest] YouTube search API error:', res.status, err)
      break
    }

    const data = await res.json()
    for (const item of data.items || []) {
      if (item.id?.videoId) {
        videos.push({
          videoId: item.id.videoId,
          title: item.snippet?.title || '',
          publishedAt: item.snippet?.publishedAt || '',
        })
      }
    }

    pageToken = data.nextPageToken || ''
  } while (pageToken)

  console.log(`[Brain:Ingest] Found ${videos.length} videos for channel ${channelId}`)
  return videos
}

/**
 * Fetch detailed metadata for a batch of video IDs.
 */
export async function fetchVideoDetails(videoIds: string[]): Promise<Record<string, {
  viewCount: number
  likeCount: number
  commentCount: number
  duration: string
  description: string
}>> {
  const apiKey = process.env.YOUTUBE_API_KEY
  if (!apiKey) return {}

  const results: Record<string, any> = {}

  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50)
    const params = new URLSearchParams({
      part: 'statistics,contentDetails,snippet',
      id: batch.join(','),
      key: apiKey,
    })

    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`)
    if (!res.ok) continue

    const data = await res.json()
    for (const item of data.items || []) {
      results[item.id] = {
        viewCount: parseInt(item.statistics?.viewCount || '0', 10),
        likeCount: parseInt(item.statistics?.likeCount || '0', 10),
        commentCount: parseInt(item.statistics?.commentCount || '0', 10),
        duration: item.contentDetails?.duration || '',
        description: item.snippet?.description || '',
      }
    }
  }

  return results
}

/**
 * Parse ISO 8601 duration (PT1H23M45S) to seconds.
 */
function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  return (parseInt(match[1] || '0') * 3600) +
         (parseInt(match[2] || '0') * 60) +
         (parseInt(match[3] || '0'))
}

// ── Queue a Channel for Ingestion ───────────────────────────────────

/**
 * Add a YouTube channel to the ingestion queue.
 * Discovers all videos and creates brain_sources rows for each.
 */
export async function queueChannel(channelId: string, channelName: string): Promise<number> {
  const client = getSupabaseServiceClient()

  const videos = await listChannelVideos(channelId)
  if (!videos.length) return 0

  const details = await fetchVideoDetails(videos.map(v => v.videoId))

  let queued = 0
  for (const video of videos) {
    const meta = details[video.videoId]

    const { data: existing } = await client
      .from('brain_sources')
      .select('id')
      .eq('video_id', video.videoId)
      .maybeSingle()

    if (existing) continue

    const { error } = await client
      .from('brain_sources')
      .insert({
        source_type: 'youtube_video',
        channel_id: channelId,
        channel_name: channelName,
        video_id: video.videoId,
        video_title: video.title,
        video_description: meta?.description || null,
        video_url: `https://www.youtube.com/watch?v=${video.videoId}`,
        published_at: video.publishedAt || null,
        view_count: meta?.viewCount || null,
        like_count: meta?.likeCount || null,
        comment_count: meta?.commentCount || null,
        duration_seconds: meta?.duration ? parseDuration(meta.duration) : null,
        title: video.title,
        author: channelName,
        status: 'queued',
      })

    if (!error) queued++
  }

  console.log(`[Brain:Ingest] Queued ${queued} new videos from ${channelName}`)
  return queued
}

// ── Process Queued Videos ───────────────────────────────────────────

/**
 * Process queued brain_sources: fetch transcript, chunk, classify, store.
 * Called by the brain-ingest cron.
 */
export async function processQueuedSources(limit: number = 10): Promise<number> {
  const client = getSupabaseServiceClient()

  const { data: sources, error } = await client
    .from('brain_sources')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error || !sources?.length) return 0

  let processed = 0

  for (const source of sources) {
    await client
      .from('brain_sources')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', source.id)

    try {
      if (!source.video_id) {
        await client.from('brain_sources').update({ status: 'skipped', error_message: 'No video_id' }).eq('id', source.id)
        continue
      }

      // 1. Fetch transcript
      const segments = await fetchTranscript(source.video_id)
      if (!segments?.length) {
        await client.from('brain_sources').update({
          status: 'failed',
          error_message: 'No transcript available',
          updated_at: new Date().toISOString(),
        }).eq('id', source.id)
        continue
      }

      // 2. Combine into raw transcript
      const rawTranscript = segments.map(s => s.text).join(' ')

      // 3. Chunk the transcript
      const chunks = chunkTranscript(segments)

      // 4. Classify domains with AI (batch for efficiency)
      const domains = await classifyChunkDomains(chunks.map(c => c.text))

      // 5. Insert chunks
      const chunkRows = chunks.map((chunk, i) => ({
        source_id: source.id,
        chunk_index: i,
        chunk_text: chunk.text,
        token_count: Math.ceil(chunk.text.length / 4),
        timestamp_start: chunk.timestampStart,
        timestamp_end: chunk.timestampEnd,
        domain: domains[i] || 'general',
        sub_topics: [],
      }))

      const { error: insertErr } = await client
        .from('brain_chunks')
        .insert(chunkRows)

      if (insertErr) {
        console.error(`[Brain:Ingest] Chunk insert error for ${source.video_id}:`, insertErr.message)
        await client.from('brain_sources').update({
          status: 'failed',
          error_message: insertErr.message,
          updated_at: new Date().toISOString(),
        }).eq('id', source.id)
        continue
      }

      // 6. Mark source as completed
      await client.from('brain_sources').update({
        status: 'completed',
        transcript_raw: rawTranscript,
        updated_at: new Date().toISOString(),
      }).eq('id', source.id)

      processed++
      console.log(`[Brain:Ingest] Processed: ${source.video_title} (${chunks.length} chunks)`)

      // Rate limit: wait between videos to avoid YouTube blocking
      await new Promise(r => setTimeout(r, 2000))

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Brain:Ingest] Error processing ${source.video_id}:`, message)
      await client.from('brain_sources').update({
        status: 'failed',
        error_message: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq('id', source.id)
    }
  }

  return processed
}

// ── Transcript Chunking ─────────────────────────────────────────────

interface TranscriptChunk {
  text: string
  timestampStart: number
  timestampEnd: number
}

function chunkTranscript(segments: TranscriptSegment[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let currentText = ''
  let currentStart = segments[0]?.offset || 0
  let currentEnd = 0

  for (const seg of segments) {
    const candidate = currentText ? `${currentText} ${seg.text}` : seg.text

    if (candidate.length > CHUNK_CONFIG.maxChars && currentText.length > 0) {
      chunks.push({
        text: currentText.trim(),
        timestampStart: currentStart,
        timestampEnd: currentEnd,
      })

      const overlapStart = currentText.length - CHUNK_CONFIG.overlapChars
      if (overlapStart > 0) {
        currentText = currentText.slice(overlapStart) + ' ' + seg.text
      } else {
        currentText = seg.text
      }
      currentStart = seg.offset
    } else {
      currentText = candidate
    }
    currentEnd = seg.offset + seg.duration
  }

  if (currentText.trim()) {
    chunks.push({
      text: currentText.trim(),
      timestampStart: currentStart,
      timestampEnd: currentEnd,
    })
  }

  return chunks
}

// ── Domain Classification ───────────────────────────────────────────

async function classifyChunkDomains(chunkTexts: string[]): Promise<(KnowledgeDomain | null)[]> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) return chunkTexts.map(() => 'general')

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    const numberedChunks = chunkTexts
      .map((text, i) => `[${i}] ${text.slice(0, 300)}`)
      .join('\n\n')

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `${DOMAIN_CLASSIFICATION_PROMPT}\n\nClassify each numbered chunk below. Return ONLY a JSON array of domain strings, one per chunk.\n\n${numberedChunks}`,
      }],
    })

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\[[\s\S]*\]/)
    if (match) {
      const domains = JSON.parse(match[0]) as string[]
      return domains.map(d => d as KnowledgeDomain)
    }
  } catch (err) {
    console.error('[Brain:Ingest] Domain classification failed:', err)
  }

  return chunkTexts.map(() => 'general')
}
