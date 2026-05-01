export const KNOWN_LEAD_SOURCES = [
  "Website",
  "Google",
  "Google LSA",
  "Google Ads",
  "Referral",
  "Facebook",
  "Instagram",
  "Nextdoor",
  "Yelp",
  "Thumbtack",
  "Angi",
  "Door Hanger",
  "Yard Sign",
  "Repeat Customer",
] as const

export type KnownLeadSource = typeof KNOWN_LEAD_SOURCES[number]

export function isKnownLeadSource(value: string | null | undefined): value is KnownLeadSource {
  return !!value && (KNOWN_LEAD_SOURCES as readonly string[]).includes(value)
}

// Allowed values for leads.source DB CHECK constraint (see scripts/23-expand-lead-sources.sql).
export const LEAD_SOURCE_DB_ENUMS = [
  "housecall_pro",
  "ghl",
  "meta",
  "vapi",
  "sms",
  "website",
  "manual",
  "phone",
  "sam",
  "google_lsa",
  "thumbtack",
  "google",
  "email",
  "angi",
] as const

export type LeadSourceDbEnum = typeof LEAD_SOURCE_DB_ENUMS[number]

interface UtmInput {
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
}

interface InferredLeadSource {
  display: KnownLeadSource
  dbEnum: LeadSourceDbEnum
}

const PAID_MEDIUMS = new Set(["cpc", "paid", "paidsearch", "paid_search", "ad", "ads", "ppc", "display"])

function lc(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

/**
 * Infer the marketing-attribution source from utm_* tags on a website form post.
 * Returns null if no utm hint matches — caller should fall back to "Website" / "website".
 *
 * Why: a customer who clicks a Google LSA link and fills the website form is technically
 * a "website" intake but should be attributed to LSA for ROI math.
 */
export function inferLeadSourceFromUtm(input: UtmInput): InferredLeadSource | null {
  const src = lc(input.utm_source)
  const med = lc(input.utm_medium)
  const camp = lc(input.utm_campaign)

  // Google Local Service Ads — most specific, check first
  if (src === "lsa" || med === "lsa" || camp.includes("lsa") || src === "googlelsa" || src === "google_lsa") {
    return { display: "Google LSA", dbEnum: "google_lsa" }
  }

  // Google Ads (paid search) vs Google organic
  if (src === "google" || src === "googleads" || src === "google_ads") {
    if (PAID_MEDIUMS.has(med) || src === "googleads" || src === "google_ads") {
      return { display: "Google Ads", dbEnum: "google" }
    }
    return { display: "Google", dbEnum: "google" }
  }

  if (src === "facebook" || src === "fb" || src === "meta") {
    return { display: "Facebook", dbEnum: "meta" }
  }

  if (src === "instagram" || src === "ig") {
    return { display: "Instagram", dbEnum: "meta" }
  }

  if (src === "thumbtack") {
    return { display: "Thumbtack", dbEnum: "thumbtack" }
  }

  if (src === "angi" || src === "angies" || src === "angieslist") {
    return { display: "Angi", dbEnum: "angi" }
  }

  if (src === "yelp") {
    return { display: "Yelp", dbEnum: "website" }
  }

  if (src === "nextdoor") {
    return { display: "Nextdoor", dbEnum: "website" }
  }

  if (src === "referral" || med === "referral") {
    return { display: "Referral", dbEnum: "website" }
  }

  return null
}
