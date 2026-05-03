/**
 * Global kill switch for retargeting / win-back outbound.
 *
 * Dominic disabled retargeting on 2026-04-22 after a West Niagara audit showed
 * cold-followup firing against customers with `pending` jobs + `admin_disabled`
 * retargeting flags. While the eligibility fix is in progress, any cron or
 * queued task that would send outreach to a past customer must consult this
 * before sending.
 *
 * To re-enable: remove `RETARGETING_DISABLED=true` from Vercel env and
 * redeploy (or set it to anything other than `true`).
 */
export function isRetargetingPaused(): boolean {
  return (process.env.RETARGETING_DISABLED || '').toLowerCase() === 'true'
}
