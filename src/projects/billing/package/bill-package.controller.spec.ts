import { BadRequestException } from '@nestjs/common';

import { BillPackageController } from './bill-package.controller';

/**
 * Certify files the certified copy for either direction (2026-10-14).
 *
 * On a bill to the client it is the client bill's certificate, as before. On a subcontractor's it
 * is a **signed copy of the RA bill**, received today, under the package's own company — the
 * existing store, whose first copy also acknowledges the bill.
 */
describe('certifying with a certified copy', () => {
  const caller = { id: 'u-1', companyId: 'co-caller', permissions: [] };

  function controller(view: Record<string, unknown>) {
    const calls = {
      certify: [] as unknown[],
      attach: [] as unknown[],
      upload: [] as unknown[][],
      reread: 0,
    };
    const packages = {
      certify: async (...args: unknown[]) => {
        calls.certify.push(args);
        return view;
      },
      companyOf: async () => 'co-package',
      view: async () => {
        calls.reread += 1;
        return { ...view, certifiedCopy: { kind: 'filed' } };
      },
    };
    const clientBills = {
      attachCertificate: async (...args: unknown[]) => {
        calls.attach.push(args);
      },
    };
    const signedCopies = {
      upload: async (...args: unknown[]) => {
        calls.upload.push(args);
        return {};
      },
    };
    const subject = new BillPackageController(
      packages as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      clientBills as never,
      signedCopies as never,
      {} as never,
    );
    return { subject, calls };
  }

  const data = Buffer.from('%PDF-1.4 certified').toString('base64');

  it('files a subcontractor’s as a signed copy of its RA bill, received today', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T09:30:00Z'));
    try {
      const { subject, calls } = controller({
        raBillId: 'ra-1',
        clientBillId: null,
      });
      const result = await subject.certify(caller as never, 'pkg-1', {
        certifiedAmount: '1000.00',
        certificateData: data,
        certificateFileName: 'RA-03 certified.pdf',
      });

      expect(calls.attach).toHaveLength(0);
      expect(calls.upload).toHaveLength(1);
      const [, companyId, subjectType, subjectId, file, actor] =
        calls.upload[0];
      // The package's company, not the caller's.
      expect(companyId).toBe('co-package');
      expect(subjectType).toBe('ra_bill');
      expect(subjectId).toBe('ra-1');
      expect(file).toMatchObject({
        fileName: 'RA-03 certified.pdf',
        receivedOn: '2026-10-14',
      });
      expect((file as { data: Buffer }).data.toString()).toBe(
        '%PDF-1.4 certified',
      );
      expect(actor).toEqual({ userId: 'u-1' });
      // The response is read again so it carries the copy just filed.
      expect(calls.reread).toBe(1);
      expect(result).toMatchObject({ certifiedCopy: { kind: 'filed' } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('files a client’s as the client bill’s certificate, as before', async () => {
    const { subject, calls } = controller({
      raBillId: null,
      clientBillId: 'cb-1',
    });
    await subject.certify(caller as never, 'pkg-1', {
      certifiedAmount: '1000.00',
      certificateData: data,
    });
    expect(calls.upload).toHaveLength(0);
    // No lines posted: certified as one figure.
    expect(calls.certify[0]).toEqual([
      expect.anything(),
      'u-1',
      'pkg-1',
      { certifiedAmount: '1000.00', remarks: null, lines: null },
    ]);
    expect(calls.attach[0]).toEqual([
      expect.anything(),
      'cb-1',
      { data: expect.any(Buffer), fileName: 'certificate' },
    ]);
  });

  it('files nothing and reads nothing again when no copy was sent', async () => {
    const { subject, calls } = controller({
      raBillId: 'ra-1',
      clientBillId: null,
    });
    await subject.certify(caller as never, 'pkg-1', {
      certifiedAmount: '1000.00',
    });
    expect(calls.upload).toHaveLength(0);
    expect(calls.attach).toHaveLength(0);
    expect(calls.reread).toBe(0);
  });
});

/**
 * Reading a certified copy (2026-10-15): a workbook is read, anything else comes back unreadable
 * with every line listed for manual entry — never a failed request.
 */
describe('reading a certified copy', () => {
  const caller = { id: 'u-1', companyId: 'co-1', permissions: [] };
  const lines = [
    {
      lineId: 'l-1',
      boqNo: '1.1',
      description: 'Filling pot-holes',
      unit: 'Sqm',
      billedQty: 100,
      rate: 250,
    },
  ];

  function controller(read: (data: Buffer) => Promise<unknown>) {
    const packages = {
      certifiedCopyLines: async () => ({ lines, quotedPercentage: 0.05 }),
    };
    return new BillPackageController(
      packages as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { read } as never,
    );
  }

  it('says a PDF cannot be read, and lists the lines for manual entry', async () => {
    let opened = false;
    const subject = controller(async () => {
      opened = true;
      return [];
    });
    const result = await subject.readCertifiedCopy(caller as never, 'pkg-1', {
      data: Buffer.from('%PDF-1.4 certified').toString('base64'),
      fileName: 'RA-04.pdf',
    });
    expect(opened).toBe(false);
    expect(result).toMatchObject({
      readable: false,
      reason: expect.stringMatching(/PDF/),
      quotedPercentage: 0.05,
    });
    expect(result.lines[0]).toMatchObject({
      lineId: 'l-1',
      certifiedQty: null,
    });
  });

  it('without a file, returns the lines alone for manual entry', async () => {
    const subject = controller(async () => {
      throw new Error('not opened');
    });
    const result = await subject.readCertifiedCopy(
      caller as never,
      'pkg-1',
      {},
    );
    expect(result).toMatchObject({ readable: false, reason: null });
    expect(result.lines).toHaveLength(1);
  });

  it('turns a workbook the reader refuses into a reason, not an error', async () => {
    const subject = controller(async () => {
      throw new BadRequestException({
        statusCode: 400,
        message:
          'This workbook opened but contains no sheets with any content.',
      });
    });
    const result = await subject.readCertifiedCopy(caller as never, 'pkg-1', {
      data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString('base64'),
      fileName: 'RA-04.xlsx',
    });
    expect(result.readable).toBe(false);
    expect(result.reason).toMatch(/no sheets with any content/);
  });

  it('reads a workbook', async () => {
    const subject = controller(async () => [
      {
        name: 'Abstract',
        rows: [
          { rowNumber: 1, cells: ['Item No', 'Certified Qty'] },
          { rowNumber: 2, cells: [1.1, 95] },
        ],
      },
    ]);
    const result = await subject.readCertifiedCopy(caller as never, 'pkg-1', {
      data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString('base64'),
      fileName: 'renamed.bin',
    });
    expect(result.readable).toBe(true);
    expect(result.lines[0]).toMatchObject({
      certifiedQty: 95,
      source: { sheet: 'Abstract', row: 2 },
    });
  });
});
