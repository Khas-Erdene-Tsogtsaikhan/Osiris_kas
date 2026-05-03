/**
 * Fallback area-code → IANA timezone resolver.
 *
 * Every tenant should have `tenants.timezone` set explicitly. This is the
 * safety net for when the column is null or we only have a phone number
 * without a tenant context (e.g., deciding whether to queue a cold-outreach
 * send for a prospect scraped by SAM).
 *
 * Coverage is intentionally limited to the US/CA markets we serve today
 * (LA, Cedar Rapids, West Niagara, Morton IL, Texas). Unknown area codes
 * fall back to America/Chicago (midpoint, and the default the system uses
 * elsewhere in the codebase).
 */

const AREA_CODE_TO_TZ: Record<string, string> = {
  // California (Spotless — LA County and surrounds)
  '213': 'America/Los_Angeles',
  '310': 'America/Los_Angeles',
  '323': 'America/Los_Angeles',
  '424': 'America/Los_Angeles',
  '562': 'America/Los_Angeles',
  '626': 'America/Los_Angeles',
  '657': 'America/Los_Angeles',
  '661': 'America/Los_Angeles',
  '714': 'America/Los_Angeles',
  '747': 'America/Los_Angeles',
  '805': 'America/Los_Angeles',
  '818': 'America/Los_Angeles',
  '909': 'America/Los_Angeles',
  '949': 'America/Los_Angeles',

  // Iowa (Cedar Rapids)
  '319': 'America/Chicago',
  '515': 'America/Chicago',
  '641': 'America/Chicago',
  '712': 'America/Chicago',
  '563': 'America/Chicago',

  // Illinois (WinBros — Morton/Peoria)
  '309': 'America/Chicago',
  '217': 'America/Chicago',
  '224': 'America/Chicago',
  '312': 'America/Chicago',
  '618': 'America/Chicago',
  '630': 'America/Chicago',
  '708': 'America/Chicago',
  '773': 'America/Chicago',
  '815': 'America/Chicago',
  '847': 'America/Chicago',
  '872': 'America/Chicago',
  '779': 'America/Chicago',

  // Texas (Texas Nova — Houston area)
  '713': 'America/Chicago',
  '281': 'America/Chicago',
  '346': 'America/Chicago',
  '832': 'America/Chicago',
  '409': 'America/Chicago',
  '936': 'America/Chicago',
  '979': 'America/Chicago',
  '210': 'America/Chicago',
  '214': 'America/Chicago',
  '254': 'America/Chicago',
  '361': 'America/Chicago',
  '430': 'America/Chicago',
  '432': 'America/Chicago',
  '469': 'America/Chicago',
  '512': 'America/Chicago',
  '682': 'America/Chicago',
  '737': 'America/Chicago',
  '806': 'America/Chicago',
  '817': 'America/Chicago',
  '830': 'America/Chicago',
  '903': 'America/Chicago',
  '915': 'America/Denver', // El Paso is Mountain
  '940': 'America/Chicago',
  '945': 'America/Chicago',
  '956': 'America/Chicago',
  '972': 'America/Chicago',

  // Ontario — Niagara region (West Niagara)
  '289': 'America/Toronto',
  '365': 'America/Toronto',
  '416': 'America/Toronto',
  '437': 'America/Toronto',
  '647': 'America/Toronto',
  '905': 'America/Toronto',
  '548': 'America/Toronto',
  '226': 'America/Toronto',
  '519': 'America/Toronto',
  '613': 'America/Toronto',
  '705': 'America/Toronto',
  '807': 'America/Toronto',
}

const DIGITS_ONLY = /[^0-9]/g

/**
 * Extract the North American area code from a phone number.
 * Accepts E.164 (+1AAANNNNNNN), bare 10-digit, 11-digit with leading 1, or
 * anything with punctuation. Returns null if it's not a recognizable NANP number.
 */
export function extractAreaCode(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = String(phone).replace(DIGITS_ONLY, '')
  // Strip country code '1' if present
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (local.length !== 10) return null
  return local.slice(0, 3)
}

/**
 * Resolve a phone number to an IANA timezone. Falls back to America/Chicago
 * (the system-wide default) when the area code is unknown.
 */
export function timezoneFromPhone(phone: string | null | undefined, fallback = 'America/Chicago'): string {
  const code = extractAreaCode(phone)
  if (!code) return fallback
  return AREA_CODE_TO_TZ[code] || fallback
}

/**
 * Resolve with an explicit tenant-level timezone taking precedence. This is
 * the recommended entry point for send-layer logic.
 */
export function resolveTimezone(opts: {
  tenantTimezone?: string | null
  phone?: string | null
  fallback?: string
}): string {
  if (opts.tenantTimezone && opts.tenantTimezone.trim()) return opts.tenantTimezone
  return timezoneFromPhone(opts.phone, opts.fallback || 'America/Chicago')
}

/**
 * Business-hours window (9am–9pm local) check against a given IANA timezone.
 * Kept here so callers can make the decision without loading a full tenant row.
 */
export function isWithinQuietHoursWindow(timezone: string, now: Date = new Date(), openHour = 9, closeHour = 21): boolean {
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now)
    // Intl sometimes returns "24" for midnight; clamp.
    const hour = Math.min(23, Math.max(0, parseInt(hourStr, 10) || 0))
    return hour >= openHour && hour < closeHour
  } catch {
    // Invalid IANA — fail OPEN (allow send). Prevents a typo in tenant config
    // from silently queuing every message forever.
    return true
  }
}

/**
 * Compute the next ISO timestamp when sending is allowed in the given tz
 * (i.e., today at openHour if currently before openHour, otherwise tomorrow
 * at openHour). Used to schedule queue rows.
 */
export function nextAllowedSendAt(timezone: string, now: Date = new Date(), openHour = 9): Date {
  // We need "the next 10am local". Simplest correct approach: format current
  // local date parts in tz, build the target, and if it's in the past push to tomorrow.
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now)

    const p: Record<string, string> = {}
    for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value

    const localNow = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00`)
    const localTarget = new Date(`${p.year}-${p.month}-${p.day}T${String(openHour).padStart(2, '0')}:00:00`)

    // If current local hour is past the open hour, roll to tomorrow
    if (parseInt(p.hour, 10) >= openHour) {
      localTarget.setDate(localTarget.getDate() + 1)
    }

    // Map back to UTC via offset difference
    const offsetMs = localNow.getTime() - now.getTime()
    return new Date(localTarget.getTime() - offsetMs)
  } catch {
    // Unknown tz — just return 1 hour from now as a safe fallback
    return new Date(now.getTime() + 60 * 60 * 1000)
  }
}
