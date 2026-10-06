import { BadRequestException } from '@nestjs/common';
import { DwrPaymentMode } from '@prisma/client';

import { DWR_ERRORS } from './dwr-error-codes';
import { CreateDwrLineDto } from './dto/create-dwr.dto';
import { narrowLine } from './dwr.service';

/** Builds a submitted line, so each test shows only what it is about. */
function line(over: Partial<CreateDwrLineDto>): CreateDwrLineDto {
  return {
    paymentMode: DwrPaymentMode.work_basis,
    ...over,
  } as CreateDwrLineDto;
}

function codeOf(error: unknown): string | undefined {
  const response = (error as BadRequestException).getResponse?.();
  return typeof response === 'object' && response !== null
    ? (response as { code?: string }).code
    : undefined;
}

describe('narrowLine — a measured line', () => {
  it('passes the six factors through for the server to multiply', () => {
    expect(
      narrowLine(line({ nos1: '2', length: '12.5', breadth: '3.75' }), 0),
    ).toEqual({
      paymentMode: 'work_basis',
      nos1: '2',
      nos2: undefined,
      length: '12.5',
      breadth: '3.75',
      depth: undefined,
      density: undefined,
    });
  });

  it('refuses a factor of 0, naming both the line and the factor', () => {
    // Named rather than counted. The fix is one field on one line, and "invalid quantity" sends the
    // person who hit it nowhere in particular.
    try {
      narrowLine(line({ nos1: '2', depth: '0' }), 4);
      fail('expected a refusal');
    } catch (error) {
      expect(codeOf(error)).toBe(DWR_ERRORS.factorZero);
      expect((error as Error).message).toContain('Line 5');
      expect((error as Error).message).toContain('depth');
      // And it says what to do instead, because the right action is non-obvious: omitting a
      // dimension is not the same as setting it to zero.
      expect((error as Error).message).toContain('omitted means 1');
    }
  });

  it('refuses a served quantity on a measured line', () => {
    try {
      narrowLine(line({ length: '4', servedQty: '1' }), 0);
      fail('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('servedQty');
    }
  });
});

describe('narrowLine — a presence-paid line', () => {
  const presence = (over: Partial<CreateDwrLineDto>) =>
    line({ paymentMode: DwrPaymentMode.day_basis, ...over });

  it('accepts a full day with no remark', () => {
    expect(narrowLine(presence({ servedQty: '1' }), 0)).toEqual({
      paymentMode: 'day_basis',
      servedQty: '1',
    });
  });

  it('accepts a zero day with a remark, because that is a fact and not an absence', () => {
    // FR-031. "The asset was there and performed nothing" is what many rows of the client's own
    // measurement sheets say — they read "-" — and it is a different fact from nobody having
    // recorded the day. Both have to be expressible.
    expect(
      narrowLine(presence({ servedQty: '0', remark: 'crane idle all day' }), 0),
    ).toEqual({ paymentMode: 'day_basis', servedQty: '0' });
  });

  it('refuses a short day with no remark', () => {
    // FR-030c. The shortfall is precisely what a client's deduction is argued from — the real bill
    // reads "30 % deduction Shoulder Slope, Supervisor Labour, Staff Not available" — so the reason
    // is captured when it is known rather than reconstructed at bill time by somebody guessing.
    try {
      narrowLine(presence({ servedQty: '0.7' }), 2);
      fail('expected a refusal');
    } catch (error) {
      expect(codeOf(error)).toBe(DWR_ERRORS.shortDayNeedsRemark);
      expect((error as Error).message).toContain('0.700');
      expect((error as Error).message).toContain('deduction');
    }
  });

  it('refuses a short day whose remark is only whitespace', () => {
    expect(() =>
      narrowLine(presence({ servedQty: '0.5', remark: '   ' }), 0),
    ).toThrow(BadRequestException);
  });

  it('refuses measurement factors, rather than ignoring them', () => {
    // The refusal is the requirement (FR-030b). Ignoring them would store factors on a line nothing
    // reads them for — and because all six default to 1, their product is 1, indistinguishable
    // from one day served. Any later code that started reading them would be right by coincidence
    // until one of them changed.
    try {
      narrowLine(presence({ servedQty: '1', nos1: '7', length: '7' }), 0);
      fail('expected a refusal');
    } catch (error) {
      expect(codeOf(error)).toBe(DWR_ERRORS.factorsOnPresenceLine);
      expect((error as Error).message).toContain('nos1');
      expect((error as Error).message).toContain('length');
      // It names what to remove, not just that something is wrong.
      expect((error as Error).message).toContain('days served');
    }
  });

  it('refuses a presence line with no served quantity at all', () => {
    expect(() => narrowLine(presence({}), 0)).toThrow(BadRequestException);
  });

  it('refuses a negative served quantity', () => {
    expect(() =>
      narrowLine(presence({ servedQty: '-1', remark: 'why' }), 0),
    ).toThrow(/negative/);
  });
});

describe('narrowLine — the line index in every refusal', () => {
  it('reports the line a reader can count to, not a zero-based one', () => {
    // A supervisor looking at a form counts from 1. An off-by-one here sends them to the wrong row
    // of a seventeen-line report, which is worse than no index at all because it looks precise.
    for (const [index, expected] of [
      [0, 'Line 1'],
      [16, 'Line 17'],
    ] as const) {
      try {
        narrowLine(line({ depth: '0' }), index);
        fail('expected a refusal');
      } catch (error) {
        expect((error as Error).message).toContain(expected);
      }
    }
  });
});
