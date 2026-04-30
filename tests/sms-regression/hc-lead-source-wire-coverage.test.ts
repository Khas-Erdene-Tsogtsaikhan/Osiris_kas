/**
 * Lead-source wire-coverage regression — the test that would have caught
 * the Build 2 wire-gap (La Monica + Charles/Cory/Thomas, 2026-04-30).
 *
 * Premise: every HC webhook that (a) creates a `leads` row AND (b) sends
 * an outbound SMS to a fresh lead MUST also call `wireFollowupsAfterOutbound`,
 * otherwise the v2 cutover gate cancels the legacy follow-up and the
 * customer never gets a chase.
 *
 * Three checks:
 *   1. Each entry in REGISTRY (the known lead-entry paths) has both
 *      sendSMS() and wireFollowupsAfterOutbound() in the source.
 *   2. Each declared sendSMS `source:` label is actually present in the
 *      file (catches typos / regressions where the label drifts).
 *   3. Discovery check: every webhook route that creates a leads row AND
 *      calls sendSMS must appear in REGISTRY. If someone adds a new lead
 *      webhook (or a new lead path inside an existing webhook), this fails
 *      until the registry is updated AND wire is wired.
 *
 * Plan: ~/.claude/plans/a-remeber-i-said-drifting-manatee.md (Build 3)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join } from 'path'

interface LeadEntry {
  /** Human-readable description for test output */
  description: string
  /** Path relative to repo root */
  file: string
  /** sendSMS `source:` labels expected in this file (e.g. 'website_lead_auto') */
  expected_sources: string[]
  /** True for webhooks that send to fresh leads (must wire ghost chase) */
  must_call_wire: boolean
}

const REPO_ROOT = resolve(__dirname, '../..')

/**
 * The canonical registry of HC webhook entry points that touch fresh leads.
 *
 * If you add a new lead-source webhook, add it here AND wire
 * `wireFollowupsAfterOutbound()` after every successful sendSMS that
 * targets a fresh lead. Otherwise the v2 cutover gate will silently
 * swallow the legacy follow-up and the customer will get no follow-up.
 */
const REGISTRY: LeadEntry[] = [
  {
    description: 'Website lead webhook (intro + upfront-quote sends)',
    file: 'apps/house-cleaning/app/api/webhooks/website/[slug]/route.ts',
    expected_sources: ['website_lead_auto', 'website_lead_quote'],
    must_call_wire: true,
  },
  {
    description: 'Meta lead webhook (Lead Ad form first-touch)',
    file: 'apps/house-cleaning/app/api/webhooks/meta/[slug]/route.ts',
    expected_sources: ['meta_lead_auto'],
    must_call_wire: true,
  },
  {
    description: 'OpenPhone webhook AI response (existing-lead + assigned-lead)',
    file: 'apps/house-cleaning/app/api/webhooks/openphone/route.ts',
    // OpenPhone webhook uses sendSMS without our internal lead-source labels
    // (the "lead source" is implicit — the inbound came from OpenPhone).
    expected_sources: [],
    must_call_wire: true,
  },
]

const REGISTERED_FILES = new Set(REGISTRY.map(e => e.file.replace(/\\/g, '/')))

function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8')
}

describe('Lead-source wire-coverage (Build 3 regression)', () => {
  for (const entry of REGISTRY) {
    describe(entry.description, () => {
      const src = readSource(entry.file)

      if (entry.must_call_wire) {
        it('calls wireFollowupsAfterOutbound', () => {
          expect(
            src,
            `${entry.file} must call wireFollowupsAfterOutbound after every fresh-lead sendSMS — see Build 3 plan`,
          ).toMatch(/wireFollowupsAfterOutbound\s*\(/)
        })

        it('imports wireFollowupsAfterOutbound', () => {
          const importPattern = /(import\s+\{[^}]*wireFollowupsAfterOutbound[^}]*\}|await\s+import\s*\(\s*['"][^'"]*services\/followups\/wire['"])/
          expect(
            src,
            `${entry.file} must import wireFollowupsAfterOutbound (static or dynamic)`,
          ).toMatch(importPattern)
        })
      }

      it('contains a sendSMS call (sanity — file is actually a send site)', () => {
        expect(src).toMatch(/sendSMS\s*\(/)
      })

      for (const source of entry.expected_sources) {
        it(`uses sendSMS source label "${source}"`, () => {
          const re = new RegExp(`source\\s*:\\s*['"\`]${source}['"\`]`)
          expect(src, `${entry.file} should label sendSMS calls with source "${source}"`).toMatch(re)
        })
      }
    })
  }

  it('every webhook that creates a lead row + sends SMS is in the REGISTRY', () => {
    // Walk every route.ts under apps/house-cleaning/app/api/webhooks/.
    // Any file that calls .from('leads').insert AND sendSMS must be registered.
    const webhooksDir = resolve(REPO_ROOT, 'apps/house-cleaning/app/api/webhooks')
    const offenders: string[] = []

    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) {
          walk(full)
        } else if (name === 'route.ts') {
          const rel = full.replace(REPO_ROOT, '').replace(/^[/\\]/, '').replace(/\\/g, '/')
          const src = readFileSync(full, 'utf-8')
          const insertsLead = /\.from\(\s*['"]leads['"]\s*\)\s*\.insert\b/.test(src)
          const sendsSMS = /sendSMS\s*\(/.test(src)
          if (insertsLead && sendsSMS && !REGISTERED_FILES.has(rel)) {
            offenders.push(rel)
          }
        }
      }
    }

    walk(webhooksDir)

    expect(
      offenders,
      `Found webhook(s) that create a lead row + send SMS but are NOT in the wire-coverage REGISTRY:\n` +
        offenders.map(f => `  - ${f}`).join('\n') +
        `\nAdd them to REGISTRY in this test, and wire wireFollowupsAfterOutbound() after every fresh-lead sendSMS.`,
    ).toEqual([])
  })
})
