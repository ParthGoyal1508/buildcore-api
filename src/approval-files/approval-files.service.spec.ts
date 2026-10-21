import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { ApprovalFilesService } from './approval-files.service';

describe('ApprovalFilesService', () => {
  const viewer = {
    id: 'u-1',
    companyId: 'co-1',
    permissions: [],
    selectedCompanyId: null,
  } as never;

  function build(mayView = true) {
    const approvals = { mayViewFiles: jest.fn().mockResolvedValue(mayView) };
    const dwr = {
      attachmentsOf: jest
        .fn()
        .mockResolvedValue([
          { id: 'att-1', fileName: 'pour.jpg', mimeType: 'image/jpeg' },
        ]),
      readAttachment: jest
        .fn()
        .mockResolvedValue({ data: Buffer.from('x'), mimeType: 'image/jpeg' }),
    };
    const billViews = {
      pdfFor: jest.fn().mockResolvedValue({
        bytes: Buffer.from('%PDF'),
        filename: 'bill.pdf',
      }),
    };
    const letters = {
      hasApprovalDocument: jest.fn().mockResolvedValue(false),
      approvalDocument: jest.fn().mockResolvedValue(null),
    };
    const punches = {
      hasExceptionPhoto: jest.fn().mockResolvedValue(true),
      exceptionPhoto: jest.fn(),
    };
    const service = new ApprovalFilesService(
      approvals as never,
      dwr as never,
      billViews as never,
      letters as never,
      punches as never,
      { hasReceipt: jest.fn().mockResolvedValue(true) } as never,
    );
    return { service, dwr, letters };
  }

  it('refuses someone who may neither decide the item nor read its history', async () => {
    const { service, dwr } = build(false);
    await expect(service.list(viewer, 'dwr', 'dwr-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(dwr.attachmentsOf).not.toHaveBeenCalled();
  });

  it('lists a DWR’s attachments', async () => {
    const { service } = build();
    await expect(service.list(viewer, 'dwr', 'dwr-1')).resolves.toEqual([
      { key: 'att-1', name: 'pour.jpg', mimeType: 'image/jpeg' },
    ]);
  });

  it('serves only an attachment of the report under approval', async () => {
    const { service, dwr } = build();
    await expect(
      service.file(viewer, 'dwr', 'dwr-1', 'att-of-another-report'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(dwr.readAttachment).not.toHaveBeenCalled();
  });

  it('offers a bill package’s PDF and the punch selfie', async () => {
    const { service } = build();
    await expect(service.list(viewer, 'bill_package', 'p-1')).resolves.toEqual([
      expect.objectContaining({ key: 'bill' }),
    ]);
    await expect(
      service.list(viewer, 'attendance_exception', 'punch-1'),
    ).resolves.toEqual([expect.objectContaining({ key: 'photo' })]);
  });

  it('lists nothing for an item type with no files', async () => {
    const { service } = build();
    await expect(service.list(viewer, 'payroll_run', 'run-1')).resolves.toEqual(
      [],
    );
  });
});
