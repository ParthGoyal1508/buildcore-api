import { BadRequestException } from '@nestjs/common';

import * as ExcelJS from 'exceljs';

import { createPrismaMock } from '../../settings/testing/prisma-mock';
import { RagService, currentMonth, financialYearMonths } from './rag.service';

describe('financialYearMonths', () => {
  it('runs April to March', () => {
    const months = financialYearMonths('2025-26');
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2025-04');
    expect(months[11]).toBe('2026-03');
  });

  it('crosses the calendar year in the right place', () => {
    const months = financialYearMonths('2025-26');
    expect(months[8]).toBe('2025-12');
    expect(months[9]).toBe('2026-01');
  });

  it('rejects a label that is not a single financial year', () => {
    // `2025-27` would silently be treated as starting in 2025 by a looser parser,
    // and the caller would get twelve months back for a span they asked two years of.
    expect(() => financialYearMonths('2025-27')).toThrow(BadRequestException);
  });

  it('rejects a malformed label', () => {
    expect(() => financialYearMonths('2025')).toThrow(BadRequestException);
    expect(() => financialYearMonths('not-a-year')).toThrow(
      BadRequestException,
    );
  });

  it('handles a century rollover', () => {
    const months = financialYearMonths('2099-00');
    expect(months[0]).toBe('2099-04');
    expect(months[11]).toBe('2100-03');
  });
});

describe('currentMonth', () => {
  it('is the calendar month of the given instant', () => {
    expect(currentMonth(new Date('2026-09-03T00:00:00Z'))).toBe('2026-09');
    expect(currentMonth(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});

describe('RAG cell colouring rule', () => {
  // The rule the service applies per cell, asserted directly on the comparison it
  // uses. A month later than the current one is not yet due, so it is gray rather
  // than missing — colouring it red would put every contractor permanently in breach
  // for the remainder of the financial year.
  const thisMonth = currentMonth(new Date('2026-09-03T00:00:00Z'));

  it('treats later months as future', () => {
    expect('2026-10' > thisMonth).toBe(true);
    expect('2027-03' > thisMonth).toBe(true);
  });

  it('does not treat the current or earlier months as future', () => {
    expect('2026-09' > thisMonth).toBe(false);
    expect('2026-08' > thisMonth).toBe(false);
    expect('2026-04' > thisMonth).toBe(false);
  });
});

describe('RagService.exportXlsx (036 N6)', () => {
  it('writes one row per contractor with each month as a word', async () => {
    const prisma = createPrismaMock({
      contractorProfile: {
        findMany: jest.fn(async () => [
          { id: 'cp-1', vendor: { name: 'Dummy Labour Test Firm' } },
        ]),
      },
      monthlyCompliance: {
        findMany: jest.fn(async () => [
          {
            id: 'mc-1',
            contractorProfileId: 'cp-1',
            month: '2025-04',
            status: 'verified',
          },
        ]),
      },
    });
    const service = new RagService(prisma as never);
    const caller = { id: 'u1', companyId: 'c1', permissions: [] } as never;
    const { buffer, filename } = await service.exportXlsx(caller, '2025-26');
    expect(filename).toBe('RAG_Matrix_2025-26.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('Contractor');
    expect(ws.getRow(1).getCell(2).value).toBe('April 2025');
    expect(ws.getRow(2).getCell(1).value).toBe('Dummy Labour Test Firm');
    expect(ws.getRow(2).getCell(2).value).toBe('Verified');
    // May 2025 is in the past and has no filing.
    expect(ws.getRow(2).getCell(3).value).toBe('Missing');
  });
});
