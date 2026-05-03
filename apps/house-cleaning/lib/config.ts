import type { SystemConfig } from "./types"

/**
 * OSIRIS × WinBros System Configuration
 * 
 * These values should match the operational guidelines from the contract.
 * Modify these values to adjust system behavior.
 */
export const systemConfig: SystemConfig = {
  booking_rules: {
    rate_per_labor_hour: 150, // $150 per labor hour
    production_hours_per_day: 8, // 8-hour production days
    daily_target_per_crew: 1200, // $1,200 per crew per day target
    min_job_value: 100, // Minimum job value for automation
    max_distance_minutes: 50, // Never schedule jobs more than 50 minutes from shop
    high_value_threshold: 1000, // Jobs > $1,000 escalate to ops
  },
  team_assignment: {
    initial_window_minutes: 10, // First broadcast window
    urgent_window_minutes: 3, // Urgent follow-up window
    escalation_timeout_minutes: 10, // Time to escalate after urgent ping
  },
  lead_followup: {
    initial_text_delay_minutes: 0, // Immediate text on form lead
    first_call_delay_minutes: 10, // If no reply in 10 minutes, call
    double_call_delay_minutes: 5, // If no answer, double call
    second_text_delay_minutes: 5, // Text again if no answer
    final_call_delay_minutes: 10, // Final call attempt
  },
  business_hours: {
    start: "09:00",
    end: "17:00",
    timezone: "America/Chicago",
  },
}

/**
 * Check if current time is within business hours
 */
export function isBusinessHours(): boolean {
  const now = new Date()
  const { start, end, timezone } = systemConfig.business_hours

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  const currentTime = formatter.format(now)
  return currentTime >= start && currentTime < end
}

/**
 * Upsell pricing table
 * Prices should be managed in Supabase for easy updates
 */
export const upsellPrices: Record<string, number> = {
  "gutter cleaning": 150,
  "screen cleaning": 75,
  "pressure wash add": 120,
  "solar panel clean": 200,
  "track cleaning": 50,
  "hard water treatment": 100,
  "skylight cleaning": 80,
}

/**
 * Get upsell price by type
 */
export function getUpsellPrice(type: string): number {
  const normalizedType = type.toLowerCase().trim()
  return upsellPrices[normalizedType] || 0
}

/**
 * Google Review incentive amount
 */
export const GOOGLE_REVIEW_INCENTIVE = 10 // $10 per review

/**
 * Integration endpoints with proper environment variable mapping
 */
export const integrations = {
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
  housecallPro: {
    apiKey: process.env.HOUSECALL_PRO_API_KEY || "",
    companyId: process.env.HOUSECALL_PRO_COMPANY_ID || "",
  },
  openPhone: {
    apiKey: process.env.OPENPHONE_API_KEY || "",
    phoneIdWinbros: process.env.OPENPHONE_PHONE_ID_WINBROS || "",
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    controlBotToken: process.env.TELEGRAM_CONTROL_BOT_TOKEN || "",
  },
  vapi: {
    apiKey: process.env.VAPI_API_KEY || "",
    assistantIdWinbros: process.env.VAPI_ASSISTANT_ID_WINBROS || "",
    phoneIdWinbros: process.env.VAPI_PHONE_ID_WINBROS || "",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  },
  qstash: {
    token: process.env.QSTASH_TOKEN || "",
    url: process.env.QSTASH_URL || "",
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
  },
  ai: {
    openaiKey: process.env.OPENAI_API_KEY || "",
    anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  },
  admin: {
    ownerPhone: process.env.OWNER_PHONE || "",
    adminEmail: process.env.ADMIN_EMAIL || "",
  },
}

/**
 * Check if an integration is configured
 */
export function isIntegrationConfigured(
  integration: keyof typeof integrations
): boolean {
  const config = integrations[integration]
  return Object.values(config).every((value) => value !== "")
}

/**
 * Get list of configured/missing integrations
 */
export function getIntegrationStatus(): Record<string, boolean> {
  return {
    supabase: isIntegrationConfigured("supabase"),
    housecallPro: isIntegrationConfigured("housecallPro"),
    openPhone: isIntegrationConfigured("openPhone"),
    telegram: isIntegrationConfigured("telegram"),
    vapi: isIntegrationConfigured("vapi"),
    stripe: isIntegrationConfigured("stripe"),
    qstash: isIntegrationConfigured("qstash"),
    ai: isIntegrationConfigured("ai"),
  }
}
