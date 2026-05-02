/**
 * Stripe email sanitization regression test
 *
 * Triggered by 2026-05-02 Cedar Rapids customer crrental01@gmail.com payment failure:
 * "Stripe customer lookup failed. Stripe customer create failed. Invalid email address."
 *
 * Hidden control characters (newlines, zero-width chars, tabs) in customer.email
 * are not visible in logs/UI but are rejected by Stripe's customers.create. The
 * fix sanitizes at the Stripe boundary so payment flows recover instead of dying.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const TEST_KEY = 'sk_test_dummy_key_for_sanitizer_tests'

let listMock: ReturnType<typeof vi.fn>
let createMock: ReturnType<typeof vi.fn>

vi.mock('stripe', () => {
  class StripeMock {
    customers = {
      list: (...args: unknown[]) => listMock(...args),
      create: (...args: unknown[]) => createMock(...args),
    }
  }
  return { default: StripeMock }
})

describe('Stripe email sanitization at customer-create boundary', () => {
  beforeEach(async () => {
    vi.resetModules()
    listMock = vi.fn().mockResolvedValue({ data: [] })
    createMock = vi.fn().mockResolvedValue({ id: 'cus_test_sanitized' })
  })

  const cleanCases: Array<[string, string]> = [
    ['plain', 'crrental01@gmail.com'],
    ['trailing newline', 'crrental01@gmail.com\n'],
    ['leading whitespace', '   crrental01@gmail.com'],
    ['embedded tab', 'crrental01@\tgmail.com'],
    ['carriage return', 'crrental01@gmail.com\r'],
    ['zero-width space', 'crrental01@gmail.com​'],
    ['BOM', '﻿crrental01@gmail.com'],
    ['mixed case', 'CRRental01@Gmail.COM'],
  ]

  for (const [label, raw] of cleanCases) {
    it(`createStripeCustomer normalizes "${label}" before calling Stripe`, async () => {
      const { createStripeCustomer } = await import('@/lib/stripe-client')
      await createStripeCustomer({ email: raw, phone_number: '+15551112222' }, TEST_KEY)

      expect(createMock).toHaveBeenCalledTimes(1)
      const callArg = createMock.mock.calls[0][0]
      expect(callArg.email).toBe('crrental01@gmail.com')
    })

    it(`findOrCreateStripeCustomer uses normalized email for lookup ("${label}")`, async () => {
      const { findOrCreateStripeCustomer } = await import('@/lib/stripe-client')
      await findOrCreateStripeCustomer({ email: raw, phone_number: '+15551112222' }, TEST_KEY)

      expect(listMock).toHaveBeenCalledTimes(1)
      const listArg = listMock.mock.calls[0][0]
      expect(listArg.email).toBe('crrental01@gmail.com')
    })
  }

  it('createStripeCustomer drops malformed email rather than passing junk to Stripe', async () => {
    const { createStripeCustomer } = await import('@/lib/stripe-client')
    await createStripeCustomer({ email: 'not-an-email', phone_number: '+15551112222' }, TEST_KEY)

    const callArg = createMock.mock.calls[0][0]
    expect(callArg.email).toBeUndefined()
    expect(callArg.phone).toBe('+15551112222')
  })

  it('findOrCreateStripeCustomer falls back to create-without-email on unrecoverable input', async () => {
    const { findOrCreateStripeCustomer } = await import('@/lib/stripe-client')
    await findOrCreateStripeCustomer({ email: 'still-not-an-email', phone_number: '+15551112222' }, TEST_KEY)

    expect(listMock).not.toHaveBeenCalled()
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0][0].email).toBeUndefined()
  })

  it('returns existing Stripe customer on lookup hit using sanitized email', async () => {
    listMock.mockResolvedValueOnce({ data: [{ id: 'cus_existing_match' }] })
    const { findOrCreateStripeCustomer } = await import('@/lib/stripe-client')
    const result = await findOrCreateStripeCustomer(
      { email: '  crrental01@gmail.com\n', phone_number: '+15551112222' },
      TEST_KEY
    )

    expect(result.id).toBe('cus_existing_match')
    expect(createMock).not.toHaveBeenCalled()
    expect(listMock.mock.calls[0][0].email).toBe('crrental01@gmail.com')
  })

  it('preserves the original throw contract when email is entirely missing', async () => {
    const { findOrCreateStripeCustomer } = await import('@/lib/stripe-client')
    await expect(
      findOrCreateStripeCustomer({ phone_number: '+15551112222' }, TEST_KEY)
    ).rejects.toThrow('Cannot create Stripe customer without email')
  })
})
