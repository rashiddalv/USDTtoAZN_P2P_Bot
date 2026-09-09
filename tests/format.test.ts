import { describe, expect, it } from 'vitest';
import {
  formatCompact,
  formatInt,
  formatPaymentMethods,
  formatPercentShort,
  shortPaymentName,
} from '../src/utils/format.js';

describe('compact formatting', () => {
  it('formatCompact', () => {
    expect(formatCompact(250)).toBe('250');
    expect(formatCompact(534.2)).toBe('534');
    expect(formatCompact(1234)).toBe('1.2k');
    expect(formatCompact(470_359.83)).toBe('470k');
    expect(formatCompact(1_300_000)).toBe('1.3M');
  });

  it('formatInt groups with non-breaking spaces', () => {
    expect(formatInt(1500)).toBe('1\u00a0500');
    expect(formatInt(891)).toBe('891');
  });

  it('formatPercentShort', () => {
    expect(formatPercentShort(0.863)).toBe('86%');
    expect(formatPercentShort(null)).toBe('n/a');
  });

  it('shortens Binance payment names', () => {
    expect(shortPaymentName('Kapital Bank Instant')).toBe('Kapital');
    expect(shortPaymentName('M10 - Instant')).toBe('M10');
    expect(shortPaymentName('Leobank')).toBe('Leobank');
    expect(formatPaymentMethods(['Kapital Bank Instant', 'M10 - Instant'])).toBe('Kapital, M10');
    expect(formatPaymentMethods(['A', 'B', 'C', 'D'])).toBe('A, B, C +1');
    expect(formatPaymentMethods([])).toBe('n/a');
  });
});
