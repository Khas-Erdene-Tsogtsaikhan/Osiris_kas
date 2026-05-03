import { getSupabaseServiceClient } from "./supabase"
import type { Tenant } from "./tenant"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StoredConversation {
  id: string
  tenant_id: string
  user_id: number
  title: string
  messages: Array<{ role: string; content: string }>
  summary: string | null
  keywords: string | null
  message_count: number
  tool_usage: Record<string, number>
  created_at: string
  updated_at: string
}

export interface ConversationSummary {
  id: string
  title: string
  message_count: number
  updated_at: string
}

export interface MemoryFact {
  id: number
  category: string
  fact: string
  confidence: number
  times_reinforced: number
  created_at: string
}

interface EpisodeSummary {
  id: string
  title: string
  summary: string
  keywords: string
  updated_at: string
  relevance: number
}

// ─── Feature Flag ───────────────────────────────────────────────────────────

export function hasAssistantMemory(tenant: Tenant | null): boolean {
  if (!tenant) return false
  return tenant.workflow_config?.use_assistant_memory === true
}

// ─── Conversation CRUD ──────────────────────────────────────────────────────

export async function saveConversation(
  tenantId: string,
  userId: number,
  conversationId: string,
  title: string,
  messages: Array<{ role: string; content: string }>,
  toolUsage?: Record<string, number>
): Promise<void> {
  const client = getSupabaseServiceClient()

  const { error } = await client
    .from("assistant_conversations")
    .upsert(
      {
        id: conversationId,
        tenant_id: tenantId,
        user_id: userId,
        title: title.slice(0, 100),
        messages,
        message_count: messages.length,
        tool_usage: toolUsage || {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )

  if (error) {
    console.error("[Memory] Failed to save conversation:", error)
  }
}

export async function loadConversations(
  tenantId: string,
  userId: number,
  limit = 50
): Promise<ConversationSummary[]> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from("assistant_conversations")
    .select("id, title, message_count, updated_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[Memory] Failed to load conversations:", error)
    return []
  }

  return data || []
}

export async function loadConversation(
  conversationId: string
): Promise<StoredConversation | null> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from("assistant_conversations")
    .select("*")
    .eq("id", conversationId)
    .single()

  if (error) {
    console.error("[Memory] Failed to load conversation:", error)
    return null
  }

  return data
}

export async function deleteConversation(
  conversationId: string
): Promise<void> {
  const client = getSupabaseServiceClient()

  const { error } = await client
    .from("assistant_conversations")
    .delete()
    .eq("id", conversationId)

  if (error) {
    console.error("[Memory] Failed to delete conversation:", error)
  }
}

// ─── Semantic Memory (Facts) ────────────────────────────────────────────────

export async function extractAndStoreFacts(
  tenantId: string,
  userId: number,
  conversationId: string,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    // Only process the last 6 messages (3 exchanges)
    const recentMessages = messages.slice(-6)
    const transcript = recentMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: [{
        type: "text" as const,
        text: `You are a fact extraction engine for a business assistant. Extract key facts from this conversation between a business owner and their AI assistant.

Return ONLY a JSON array of objects, each with:
- "category": one of "user_preference", "business_pattern", "customer_note", "workflow_preference", "general"
- "fact": a concise statement (1 sentence max)
- "confidence": 0.0 to 1.0

Only extract genuinely useful, durable facts that would help the assistant in future conversations. Examples:
- "Owner prefers to assign Johnny for deep cleans" (workflow_preference, 0.9)
- "Customer Sarah Johnson lives at 123 Oak St" (customer_note, 0.8)
- "Owner checks today's summary every morning" (business_pattern, 0.7)
- "Owner prefers deposit links over card-on-file" (user_preference, 0.8)

If no meaningful facts can be extracted, return [].
Do NOT extract trivial greetings or one-off questions.`,
        cache_control: { type: "ephemeral" as const },
      }],
      messages: [{ role: "user", content: transcript }],
    })

    const text =
      response.content[0].type === "text" ? response.content[0].text : ""

    // Parse JSON from response
    let facts: Array<{ category: string; fact: string; confidence: number }> =
      []
    try {
      const match = text.match(/\[[\s\S]*\]/)
      if (match) {
        facts = JSON.parse(match[0])
      }
    } catch {
      console.warn("[Memory] Failed to parse facts JSON:", text)
      return
    }

    if (facts.length === 0) return

    const client = getSupabaseServiceClient()

    // Load existing facts for deduplication
    const { data: existingFacts } = await client
      .from("assistant_memory_facts")
      .select("id, fact, times_reinforced")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .eq("active", true)

    for (const newFact of facts) {
      if (!newFact.fact || !newFact.category) continue

      // Check for similar existing facts using simple string comparison
      // (pg_trgm similarity would be ideal but we do a simple check here)
      const similar = existingFacts?.find((existing) => {
        const a = existing.fact.toLowerCase()
        const b = newFact.fact.toLowerCase()
        // Simple overlap check: if >60% of words match, consider it a duplicate
        const wordsA = new Set(a.split(/\s+/))
        const wordsB = new Set(b.split(/\s+/))
        const intersection = [...wordsA].filter((w) => wordsB.has(w))
        const union = new Set([...wordsA, ...wordsB])
        return intersection.length / union.size > 0.5
      })

      if (similar) {
        // Reinforce existing fact
        await client
          .from("assistant_memory_facts")
          .update({
            times_reinforced: similar.times_reinforced + 1,
            last_reinforced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", similar.id)

        console.log(`[Memory] Reinforced fact #${similar.id}: "${similar.fact}"`)
      } else {
        // Insert new fact
        await client.from("assistant_memory_facts").insert({
          tenant_id: tenantId,
          user_id: userId,
          category: newFact.category,
          fact: newFact.fact,
          confidence: Math.min(1, Math.max(0, newFact.confidence || 0.8)),
          source_conversation_id: conversationId,
        })

        console.log(`[Memory] New fact: "${newFact.fact}" (${newFact.category})`)
      }
    }
  } catch (err) {
    console.error("[Memory] Fact extraction error:", err)
  }
}

export async function getActiveMemoryFacts(
  tenantId: string,
  userId: number
): Promise<MemoryFact[]> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from("assistant_memory_facts")
    .select("id, category, fact, confidence, times_reinforced, created_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("active", true)
    .order("times_reinforced", { ascending: false })
    .limit(30)

  if (error) {
    console.error("[Memory] Failed to load facts:", error)
    return []
  }

  return data || []
}

// ─── Episodic Memory (Conversation Recall) ──────────────────────────────────

export async function summarizeConversation(
  conversationId: string,
  messages: Array<{ role: string; content: string }>
): Promise<{ summary: string; keywords: string } | null> {
  if (messages.length < 2) return null

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n")

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `Summarize this business assistant conversation in 2-3 sentences. Focus on: what was discussed, what actions were taken, and any decisions made.

Also extract 5-10 search keywords (comma-separated) that someone might use to find this conversation later.

Return ONLY JSON: {"summary": "...", "keywords": "customer, pricing, Sarah Johnson, deep clean, Tuesday"}`,
      messages: [{ role: "user", content: transcript }],
    })

    const text =
      response.content[0].type === "text" ? response.content[0].text : ""

    try {
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])

        // Update the conversation with summary + keywords
        const client = getSupabaseServiceClient()
        await client
          .from("assistant_conversations")
          .update({
            summary: parsed.summary,
            keywords: parsed.keywords,
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId)

        console.log(`[Memory] Summarized conversation ${conversationId}: "${parsed.summary?.slice(0, 80)}..."`)

        return parsed
      }
    } catch {
      console.warn("[Memory] Failed to parse summary JSON:", text)
    }

    return null
  } catch (err) {
    console.error("[Memory] Summarization error:", err)
    return null
  }
}

export async function getRelevantEpisodes(
  tenantId: string,
  userId: number,
  currentQuery: string,
  limit = 3
): Promise<EpisodeSummary[]> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client.rpc("search_episodic_memory", {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_query: currentQuery,
    p_limit: limit,
  })

  if (error) {
    console.error("[Memory] Episodic search error:", error)
    return []
  }

  return data || []
}

// ─── Self-Improvement Stats ─────────────────────────────────────────────────

export async function recordToolUsage(
  tenantId: string,
  userId: number,
  toolName: string
): Promise<void> {
  const client = getSupabaseServiceClient()
  const statKey = `tool:${toolName}`

  // Try upsert with increment
  const { data: existing } = await client
    .from("assistant_memory_stats")
    .select("id, stat_value")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("stat_key", statKey)
    .maybeSingle()

  if (existing) {
    await client
      .from("assistant_memory_stats")
      .update({
        stat_value: existing.stat_value + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
  } else {
    await client.from("assistant_memory_stats").insert({
      tenant_id: tenantId,
      user_id: userId,
      stat_key: statKey,
      stat_value: 1,
    })
  }
}

export async function getUsageStats(
  tenantId: string,
  userId: number
): Promise<Record<string, number>> {
  const client = getSupabaseServiceClient()

  const { data, error } = await client
    .from("assistant_memory_stats")
    .select("stat_key, stat_value")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .order("stat_value", { ascending: false })
    .limit(20)

  if (error) {
    console.error("[Memory] Failed to load stats:", error)
    return {}
  }

  const stats: Record<string, number> = {}
  for (const row of data || []) {
    stats[row.stat_key] = row.stat_value
  }
  return stats
}

// ─── System Prompt Memory Context Builder ───────────────────────────────────

export async function buildMemoryContext(
  tenantId: string,
  userId: number,
  currentMessages: Array<{ role: string; content: string }>
): Promise<string> {
  try {
    // 1. Load all active facts
    const facts = await getActiveMemoryFacts(tenantId, userId)

    // 2. If this is a new or early conversation, retrieve episodic context
    let episodes: EpisodeSummary[] = []
    if (currentMessages.length <= 2) {
      const firstUserMessage =
        currentMessages.find((m) => m.role === "user")?.content || ""
      if (firstUserMessage) {
        episodes = await getRelevantEpisodes(
          tenantId,
          userId,
          firstUserMessage,
          3
        )
      }
    }

    // 3. Load usage stats
    const stats = await getUsageStats(tenantId, userId)

    // Build context string
    let context = ""

    if (facts.length > 0) {
      context += "\n\n## YOUR MEMORY\nYou have persistent memory across conversations. Use these remembered facts naturally — don't announce that you're using memory unless asked.\n"
      context += "\n### Things I Remember\n"
      for (const fact of facts) {
        const reinforced =
          fact.times_reinforced > 0 ? ` (confirmed ${fact.times_reinforced + 1}x)` : ""
        context += `- ${fact.fact}${reinforced}\n`
      }
    }

    if (episodes.length > 0) {
      context += "\n### Recent Conversations\n"
      for (const ep of episodes) {
        const daysAgo = Math.floor(
          (Date.now() - new Date(ep.updated_at).getTime()) / 86400000
        )
        const timeLabel = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`
        context += `- (${timeLabel}) ${ep.summary}\n`
      }
    }

    // Top 3 most-used tools for proactive awareness
    const topTools = Object.entries(stats)
      .filter(([k]) => k.startsWith("tool:"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k.replace("tool:", ""))

    if (topTools.length > 0) {
      context += `\n### User Patterns\nMost-used features: ${topTools.join(", ")}\n`
    }

    return context
  } catch (err) {
    console.error("[Memory] Failed to build memory context:", err)
    return ""
  }
}
