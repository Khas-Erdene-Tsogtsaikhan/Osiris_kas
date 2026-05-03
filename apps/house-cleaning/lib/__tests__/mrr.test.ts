import { describe, it, expect } from 'vitest'
import { computeMrr, mrrAsOf, computeMrrTrend, CADENCE_FACTOR, type RecurringSeries } from '../mrr'

describe('computeMrr', () => {
  it('sums weekly / bi-weekly / monthly with correct factors, excludes one-time', () => {
    const series: RecurringSeries[] = [
      { id: 1, price: 150, frequency: 'weekly' },
      { id: 2, price: 150, frequency: 'weekly' },
      { id: 3, price: 200, frequency: 'bi-weekly' },
      { id: 4, price: 300, frequency: 'monthly' },
      { id: 5, price: 400, frequency: 'one-time' }, // excluded
      { id: 6, price: 500, frequency: 'every-3-weeks' }, // unknown cadence, excluded
    ]

    const expected = 2 * 150 * CADENCE_FACTOR.weekly
      + 200 * CADENCE_FACTOR['bi-weekly']
      + 300 * CADENCE_FACTOR.monthly
    const { mrr, activeCount } = computeMrr(series)
    // Helper rounds, so allow 1 dollar tolerance
    expect(mrr).toBeGreaterThanOrEqual(Math.round(expected) - 1)
    expect(mrr).toBeLessThanOrEqual(Math.round(expected) + 1)
    expect(activeCount).toBe(4)
  })

  it('excludes paused series', () => {
    const series: RecurringSeries[] = [
      { id: 1, price: 150, frequency: 'weekly' },
      { id: 2, price: 300, frequency: 'monthly', paused_at: '2026-04-01T00:00:00Z' },
    ]
    const { mrr, activeCount } = computeMrr(series)
    expect(activeCount).toBe(1)
    expect(mrr).toBe(Math.round(150 * CADENCE_FACTOR.weekly))
  })

  it('returns zero for empty input', () => {
    expect(computeMrr([])).toEqual({ mrr: 0, activeCount: 0 })
  })

  it('ignores rows with null price', () => {
    const series: RecurringSeries[] = [
      { id: 1, price: null, frequency: 'weekly' },
      { id: 2, price: 0, frequency: 'monthly' },
    ]
    expect(computeMrr(series)).toEqual({ mrr: 0, activeCount: 0 })
  })

  it('dedupes by customer_id — one customer with many scheduled occurrences counts once', () => {
    // Simulates the Cedar Rapids data shape: the extend-recurring-jobs cron
    // materializes 30+ future rows per customer. Each row is "a recurring job"
    // at $200 monthly — the customer is ONE series, not 30.
    const series: RecurringSeries[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      customer_id: 'cust-a',
      price: 200,
      frequency: 'monthly',
    }))
    const { mrr, activeCount } = computeMrr(series)
    expect(activeCount).toBe(1)
    expect(mrr).toBe(200)
  })

  it('paused on any row for a customer excludes that customer', () => {
    const series: RecurringSeries[] = [
      { id: 1, customer_id: 'cust-a', price: 200, frequency: 'monthly' },
      { id: 2, customer_id: 'cust-a', price: 200, frequency: 'monthly', paused_at: '2026-01-01T00:00:00Z' },
      { id: 3, customer_id: 'cust-b', price: 150, frequency: 'weekly' },
    ]
    const { mrr, activeCount } = computeMrr(series)
    expect(activeCount).toBe(1)
    expect(mrr).toBe(Math.round(150 * CADENCE_FACTOR.weekly))
  })
})

describe('mrrAsOf', () => {
  it('only counts series created on or before the as-of date', () => {
    const series: RecurringSeries[] = [
      { id: 1, price: 100, frequency: 'monthly', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, price: 200, frequency: 'monthly', created_at: '2026-05-01T00:00:00Z' },
    ]
    // As of end of February — only the January one counts
    const feb = new Date('2026-02-28T23:59:59Z')
    expect(mrrAsOf(series, feb)).toBe(100)
    // As of end of May — both count
    const may = new Date('2026-05-31T23:59:59Z')
    expect(mrrAsOf(series, may)).toBe(300)
  })

  it('excludes series paused at or before the as-of date', () => {
    const series: RecurringSeries[] = [
      {
        id: 1,
        price: 100,
        frequency: 'monthly',
        created_at: '2026-01-01T00:00:00Z',
        paused_at: '2026-03-15T00:00:00Z',
      },
    ]
    const mar = new Date('2026-03-31T23:59:59Z')
    expect(mrrAsOf(series, mar)).toBe(0)
    const feb = new Date('2026-02-28T23:59:59Z')
    expect(mrrAsOf(series, feb)).toBe(100)
  })
})

describe('computeMrrTrend', () => {
  it('returns N points in chronological order with MoM growth', () => {
    const series: RecurringSeries[] = [
      { id: 1, price: 100, frequency: 'monthly', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, price: 200, frequency: 'monthly', created_at: '2026-03-01T00:00:00Z' },
      { id: 3, price: 400, frequency: 'monthly', created_at: '2026-05-01T00:00:00Z' },
    ]
    // Simulate "now" = 2026-06-15. Last 6 months: Jan..Jun.
    const now = new Date(2026, 5, 15) // JS months are 0-indexed
    const trend = computeMrrTrend(series, 6, now)

    expect(trend).toHaveLength(6)
    expect(trend[0].month).toBe('2026-01')
    expect(trend[5].month).toBe('2026-06')

    // January: 100, Feb: 100, Mar: 300, Apr: 300, May: 700, Jun: 700
    expect(trend[0].mrr).toBe(100)
    expect(trend[1].mrr).toBe(100)
    expect(trend[2].mrr).toBe(300)
    expect(trend[3].mrr).toBe(300)
    expect(trend[4].mrr).toBe(700)
    expect(trend[5].mrr).toBe(700)

    // First point has null growth; subsequent compute off prior
    expect(trend[0].momGrowth).toBeNull()
    expect(trend[1].momGrowth).toBe(0)
    expect(trend[2].momGrowth).toBe(200) // +200% from 100 → 300
    expect(trend[5].momGrowth).toBe(0)
  })
})
