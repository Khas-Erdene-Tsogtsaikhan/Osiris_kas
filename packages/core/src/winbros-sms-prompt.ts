// Stub — full implementation lives in apps/window-washing/lib/winbros-sms-prompt.ts.
// The tag-detection helpers below are generic across tenants and are exported here
// because packages/core/src/auto-response.ts imports them via the sibling './winbros-sms-prompt'
// path, which always resolves to this file (not the per-app override).
export function buildWinBrosJobNotes(..._args: unknown[]) { return '' }
export function parseNaturalDate(..._args: unknown[]) { return null }

export interface EscalationResult {
  shouldEscalate: boolean
  reasons: string[]
}

export function detectEscalation(
  aiResponse: string,
  _conversationHistory?: Array<{ role: 'client' | 'assistant'; content: string }>,
  customerMessage?: string,
): EscalationResult {
  const reasons: string[] = []

  const tagPattern = /\[ESCALATE:(\w+)\]/g
  let match
  while ((match = tagPattern.exec(aiResponse)) !== null) {
    reasons.push(match[1])
  }

  if (/\[OUT_OF_AREA\]/.test(aiResponse)) {
    reasons.push('out_of_area')
  }

  if (reasons.length === 0 && customerMessage) {
    const msg = customerMessage.toLowerCase()
    const escalationPhrases = [
      /\brefund\b/,
      /\bcancel\b/,
      /\bsue\b/,
      /\blawyer\b/,
      /\bbbb\b/,
      /\bbetter business bureau\b/,
      /\breport you\b/,
      /\bscam\b/,
    ]
    if (escalationPhrases.some(p => p.test(msg))) {
      reasons.push('customer_escalation_keyword')
    }
  }

  return { shouldEscalate: reasons.length > 0, reasons }
}

export function stripEscalationTags(response: string): string {
  return response
    .replace(/\s*\[ESCALATE:\w+\]\s*/g, '')
    .replace(/\s*\[OUT_OF_AREA\]\s*/g, '')
    .replace(/\s*\[BOOKING_COMPLETE\]\s*/g, '')
    .replace(/\s*\[SCHEDULE_READY\]\s*/g, '')
    .trim()
}

export function detectScheduleReady(aiResponse: string): boolean {
  return aiResponse.includes('[SCHEDULE_READY]')
}

export function detectBookingComplete(aiResponse: string): boolean {
  return aiResponse.includes('[BOOKING_COMPLETE]')
}
