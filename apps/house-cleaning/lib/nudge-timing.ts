/**
 * Timing helper for the overnight-catchup nudge.
 *
 * Lead arrives at 11 PM tenant-local → first SMS fires immediately → stage-2
 * follow-up doesn't fire for 24h → lead stays ghosted overnight.
 *
 * This helper computes a send time that is:
 *   - at least +120 minutes from now, AND
 *   - inside the tenant's personal hours (9 AM – 9 PM local)
 *
 * If now + 120m already lands in the quiet window, we push to 9 AM local
 * the following morning.
 */

const PERSONAL_HOUR_START = 9
const PERSONAL_HOUR_END = 21
const DEFAULT_LEAD_MIN = 120

function localParts(when: Date, tz: string): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(when)
  const get = (t: string) => fmt.find((p) => p.type === t)?.value ?? '0'
  const rawHour = Number(get('hour'))
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: rawHour === 24 ? 0 : rawHour,
  }
}

/**
 * Build a UTC Date that, when formatted in `tz`, reads {year}-{month}-{day}
 * {targetHour}:00:00. Works across DST boundaries because we take one
 * correction pass: start with a naive UTC guess, measure the actual local
 * hour, then shift by the difference.
 */
function atLocalHourUtc(year: number, month: number, day: number, targetHour: number, tz: string): Date {
  // Naive UTC guess at that wall-clock time
  let utc = new Date(Date.UTC(year, month - 1, day, targetHour, 0, 0))
  const actual = localParts(utc, tz)
  const hourDiff = targetHour - actual.hour
  utc = new Date(utc.getTime() + hourDiff * 3_600_000)
  return utc
}

export interface NudgeTimingInput {
  /** Usually `new Date()`; pass explicitly in tests. */
  now: Date
  /** IANA timezone like `America/Los_Angeles`. Defaults to America/Chicago. */
  timezone: string
  /** How many minutes minimum to wait (default 120 = 2h). */
  minMinutes?: number
}

/**
 * Compute when to fire the overnight-catchup nudge.
 *
 *  - If `now + minMinutes` is inside personal hours → return that.
 *  - If it's before 9 AM local → bump to 9 AM local (same day).
 *  - If it's at/after 9 PM local → bump to 9 AM local (next day).
 */
export function computeNudgeSendTime(input: NudgeTimingInput): Date {
  const { now, timezone } = input
  const minMinutes = input.minMinutes ?? DEFAULT_LEAD_MIN
  const candidate = new Date(now.getTime() + minMinutes * 60_000)
  const { year, month, day, hour } = localParts(candidate, timezone)

  if (hour >= PERSONAL_HOUR_START && hour < PERSONAL_HOUR_END) {
    return candidate
  }

  if (hour < PERSONAL_HOUR_START) {
    // Same local day, at 9 AM
    return atLocalHourUtc(year, month, day, PERSONAL_HOUR_START, timezone)
  }

  // hour >= PERSONAL_HOUR_END — next local day at 9 AM. Add 24h to the
  // candidate, read the local day of THAT moment (handles DST + month rolls),
  // then snap to 9 AM of that day.
  const tomorrow = new Date(candidate.getTime() + 24 * 60 * 60_000)
  const t = localParts(tomorrow, timezone)
  return atLocalHourUtc(t.year, t.month, t.day, PERSONAL_HOUR_START, timezone)
}
