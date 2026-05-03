export type BrandMode = 'spotless' | 'figueroa' | 'winbros' | string // extensible for future brands

export interface ClientConfig {
  businessName: string
  businessNameShort: string
  sdrPersona: string
  tagline: string
  foundedYear?: number
  serviceArea: string
  services: string[]
  frequencies: string[]
  cleanerHourlyRate: number
  depositPercent: number
  processingFeePct: number
  domain: string
  reviewLink?: string
  brandMode: BrandMode
  // Brand-specific phone/assistant IDs
  openphonePhoneId?: string
  vapiPhoneId?: string
  vapiAssistantId?: string
  features: {
    ghl: boolean
    connecteam: boolean
    hubspot: boolean
    docusign: boolean
    freeCouchCleaning: boolean
    dynamicPricing: boolean
    vapiInbound: boolean  // Accept inbound VAPI calls
    vapiOutbound: boolean // Make outbound VAPI calls (for GHL leads)
    // WinBros-specific features
    housecallPro: boolean  // Housecall Pro integration
    weatherBriefings: boolean  // Include weather in crew briefings
    highValueAlerts: boolean  // Alert on high-value jobs ($1,000+)
    serviceRadiusValidation: boolean  // Validate jobs within service radius
    crewPerformanceTracking: boolean  // Track upsells, tips, reviews per crew
  }
}

function parseList(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

export function getClientConfig(brandOverride?: BrandMode): ClientConfig {
  // Use override if provided, otherwise fall back to env vars
  const brandMode = brandOverride || (process.env.BRAND_MODE || process.env.DEPLOYMENT_MODE || 'spotless') as BrandMode

  // Brand-specific workflow defaults
  const isFigueroa = brandMode === 'figueroa'
  const isWinBros = brandMode === 'winbros'

  // Get brand-specific phone numbers and assistant IDs
  // Format: OPENPHONE_PHONE_ID_SPOTLESS, OPENPHONE_PHONE_ID_FIGUEROA, etc.
  const brandUpper = brandMode.toUpperCase()
  const openphonePhoneId =
    process.env[`OPENPHONE_PHONE_ID_${brandUpper}`] ||
    process.env.OPENPHONE_PHONE_NUMBER_ID  // Fallback to global

  const vapiPhoneId =
    process.env[`VAPI_PHONE_ID_${brandUpper}`] ||
    process.env.VAPI_OUTBOUND_PHONE_ID  // Fallback to global

  const vapiAssistantId =
    process.env[`VAPI_ASSISTANT_ID_${brandUpper}`] ||
    process.env.VAPI_GHL_ASSISTANT_ID ||
    process.env.VAPI_ASSISTANT_ID  // Fallback to global

  return {
    businessName: process.env.BUSINESS_NAME || 'Spotless Scrubbers',
    businessNameShort: process.env.BUSINESS_NAME_SHORT || 'Spotless',
    sdrPersona: process.env.SDR_PERSONA || 'Mary',
    tagline: process.env.BUSINESS_TAGLINE || '',
    foundedYear: process.env.FOUNDED_YEAR
      ? parseInt(process.env.FOUNDED_YEAR, 10)
      : undefined,
    serviceArea: process.env.SERVICE_AREA || 'Los Angeles',
    services: parseList(
      process.env.SERVICES,
      'Standard cleaning,Deep clean,Move-In/Move-Out'
    ),
    frequencies: parseList(
      process.env.FREQUENCIES,
      'One-time,Weekly,Every other week,Monthly'
    ),
    cleanerHourlyRate: parseFloat(process.env.CLEANER_HOURLY_RATE || '25'),
    depositPercent: parseFloat(process.env.DEPOSIT_PERCENT || '50'),
    processingFeePct: parseFloat(process.env.PROCESSING_FEE_PCT || '3'),
    // CRITICAL: never fall back to VERCEL_URL — that's the per-deployment
    // hostname (e.g. osiris-house-cleaning-abc123-mrspotlessonemils-projects
    // .vercel.app) and looks like a phishing link to customers receiving an
    // SMS quote URL. Always anchor to the production canonical domain.
    domain: process.env.NEXT_PUBLIC_DOMAIN
      || process.env.NEXT_PUBLIC_APP_URL
      || process.env.NEXT_PUBLIC_SITE_URL
      || (process.env.NODE_ENV === 'production' ? 'https://cleanmachine.live' : 'http://localhost:3000'),
    reviewLink: process.env.REVIEW_LINK,
    brandMode,
    openphonePhoneId,
    vapiPhoneId,
    vapiAssistantId,
    features: {
      ghl: process.env.ENABLE_GHL === 'true' || isFigueroa || isWinBros,
      connecteam: process.env.ENABLE_CONNECTEAM === 'true' && !isWinBros, // WinBros uses HCP instead
      hubspot: process.env.ENABLE_HUBSPOT === 'true' || isFigueroa,
      docusign: process.env.ENABLE_DOCUSIGN === 'true' || isFigueroa,
      freeCouchCleaning: process.env.ENABLE_FREE_COUCH_CLEANING === 'true' && !isWinBros,
      dynamicPricing: process.env.ENABLE_DYNAMIC_PRICING === 'true',
      // Workflow flags - Figueroa uses outbound only, Spotless uses inbound
      vapiInbound: process.env.ENABLE_VAPI_INBOUND !== 'false' && !isFigueroa,
      vapiOutbound: process.env.ENABLE_VAPI_OUTBOUND !== 'false',
      // WinBros-specific features
      housecallPro: process.env.ENABLE_HOUSECALL_PRO === 'true' || isWinBros,
      weatherBriefings: process.env.ENABLE_WEATHER_BRIEFINGS === 'true' || isWinBros,
      highValueAlerts: process.env.ENABLE_HIGH_VALUE_ALERTS === 'true' || isWinBros,
      serviceRadiusValidation: process.env.ENABLE_SERVICE_RADIUS_VALIDATION === 'true' || isWinBros,
      crewPerformanceTracking: process.env.ENABLE_CREW_PERFORMANCE_TRACKING === 'true' || isWinBros,
    },
  }
}
