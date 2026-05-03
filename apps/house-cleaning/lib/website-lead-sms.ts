/**
 * First-touch SMS builder for website-lead webhooks.
 *
 * Both the root `app/` and `apps/house-cleaning` webhooks call this to
 * produce the initial outbound text, keeping the copy in one place.
 *
 * Voice rules (OUTREACH-SPEC Section 8):
 *   - sound like a text from the owner, not Mailchimp
 *   - no "get you a quote right away!" / no double-bang endings
 *   - contractions are fine
 *   - "bed/bath" reads friendlier than "bedrooms and bathrooms"
 */

const SPECIALIZED_SERVICE_TYPES = new Set([
  'commercial',
  'post_construction',
  'airbnb',
  'airbnb-cleaning',
])

export interface FirstTouchSMSInput {
  firstName: string
  sdrName: string
  businessName: string
  serviceType: string
  friendlyService: string
  bedrooms: number | null
  bathrooms: number | null
  address: string
  estimatedPrice: number | null
  promo: { price: number; firstSms: string } | null
}

export function isSpecializedServiceType(serviceType: string): boolean {
  return SPECIALIZED_SERVICE_TYPES.has(serviceType)
}

/**
 * Short, friendly catchup nudge for leads that haven't replied after the first
 * auto-SMS. Fired ~2 hours later (or at next-morning 9 AM if overnight).
 *
 * Intentionally brief and non-sales. If the lead truly ghosted, stage-2 of the
 * existing follow-up cadence handles the next touch 24h later.
 */
export function buildOvernightNudge(firstName: string, sdrName: string): string {
  return `Hey ${firstName}, it's ${sdrName} again — still want that quote? Send me the address + bed/bath and I'll pull pricing together real quick.`
}

export function buildFirstTouchSMS(input: FirstTouchSMSInput): string {
  const {
    firstName,
    sdrName,
    businessName,
    serviceType,
    friendlyService,
    bedrooms,
    bathrooms,
    address,
    estimatedPrice,
    promo,
  } = input

  const hasAddress = !!address && address.trim().length > 0
  const intro = `Hey ${firstName}, it's ${sdrName} from ${businessName}.`

  if (promo) {
    // Never pass promo.firstSms through verbatim — marketing templates can carry
    // banned phrases ("Limited time offer!", "exclusive", etc). Keep our own copy.
    if (bedrooms && bathrooms && hasAddress) {
      return `${intro} Got your $${promo.price} clean request — ${bedrooms} bed / ${bathrooms} bath at ${address}. Locking it in now.`
    }
    if (bedrooms && bathrooms) {
      return `${intro} Got your $${promo.price} clean request — ${bedrooms} bed / ${bathrooms} bath. What's the address and I'll get it confirmed?`
    }
    return `${intro} Got your $${promo.price} clean request. What's the address + bed/bath and I'll get it confirmed?`
  }

  if (isSpecializedServiceType(serviceType)) {
    return `${intro} Thanks for reaching out about ${friendlyService} — mind sharing the address and rough size? I'll put together a custom quote.`
  }

  if (bedrooms && bathrooms && hasAddress) {
    return `${intro} Got ${bedrooms} bed / ${bathrooms} bath at ${address}. Sending pricing your way in a sec.`
  }

  if (bedrooms && bathrooms && estimatedPrice) {
    return `${intro} Got ${bedrooms} bed / ${bathrooms} bath — around $${estimatedPrice} for a standard clean. What's the address and I'll send your options?`
  }

  if (bedrooms && bathrooms) {
    return `${intro} Got ${bedrooms} bed / ${bathrooms} bath. What's the address and I'll send pricing over?`
  }

  if (estimatedPrice) {
    return `${intro} Thanks for checking pricing for ${friendlyService} — what's the address + how many bed/bath? I'll get you exact options.`
  }

  return `${intro} Thanks for reaching out about ${friendlyService}. What's the address + how many bed/bath and I'll send pricing over?`
}
