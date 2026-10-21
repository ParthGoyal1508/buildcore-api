import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ApprovalService } from '../approvals/approvals.service';
import {
  ACTION_ATTENDANCE_EXCEPTION,
  ACTION_DWR,
  ACTION_REIMBURSEMENT_CLAIM,
  ENTITY_BILL_PACKAGE,
} from '../approvals/default-chains';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import { describeStoredFile } from '../common/storage/file-type';
import { PunchService } from '../hr/punch/punch.service';
import { callerFrom } from '../hr/caller-context';
import { LettersService } from '../letters/letters.service';
import { ReimbursementsAdminService } from '../payroll/reimbursements-admin/reimbursements-admin.service';
import { BillPackageViewBuilder } from '../projects/billing/package/bill-package-view.builder';
import { DwrService } from '../projects/dwr/dwr.service';

/** One file an approver can open. `key` is opaque to the client: it is only sent back. */
export interface ApprovalFile {
  key: string;
  name: string;
  mimeType: string;
}

const BILL_KEY = 'bill';
const LETTER_KEY = 'letter';
const PHOTO_KEY = 'photo';
const RECEIPT_KEY = 'receipt';

/**
 * The files behind an item waiting for approval, readable from the Approvals page (2026-10-20:
 * "when we were approving we were not seeing any attachment that the user has uploaded").
 *
 * Outside the spine on purpose. The spine never dereferences `(entityType, entityId)` (research.md
 * §1); this module does, by asking each owning module through a method of its own, and the spine is
 * asked only the one thing it knows — whether this viewer may see the item
 * (`ApprovalService.mayViewFiles`). That check stands in for the module's own permission, so an
 * approver who holds the chain's level but not the module's permission can still read what they
 * are deciding.
 *
 * Covered: DWR attachments, the bill package's PDF, the letter under approval, and a flagged
 * punch's selfie. Every other item type has no files and lists none.
 */
@Injectable()
export class ApprovalFilesService {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly dwr: DwrService,
    private readonly billViews: BillPackageViewBuilder,
    private readonly letters: LettersService,
    private readonly punches: PunchService,
    private readonly claims: ReimbursementsAdminService,
  ) {}

  async list(
    viewer: AuthenticatedUser,
    entityType: string,
    entityId: string,
  ): Promise<ApprovalFile[]> {
    await this.authorise(viewer, entityType, entityId);
    const ctx = rlsContextFor(viewer);

    if (entityType === ACTION_DWR) {
      return (await this.dwr.attachmentsOf(ctx, entityId)).map((a) => ({
        key: a.id,
        name: a.fileName,
        mimeType: a.mimeType,
      }));
    }
    if (entityType === ENTITY_BILL_PACKAGE) {
      return [
        { key: BILL_KEY, name: 'Bill (PDF)', mimeType: 'application/pdf' },
      ];
    }
    if (entityType === ACTION_REIMBURSEMENT_CLAIM) {
      return (await this.claims.hasReceipt(this.callerOf(viewer), entityId))
        ? [{ key: RECEIPT_KEY, name: 'Receipt', mimeType: 'application/pdf' }]
        : [];
    }
    if (entityType === ACTION_ATTENDANCE_EXCEPTION) {
      // A punch without a capture (an admin correction) must not offer a file that then 404s.
      return (await this.punches.hasExceptionPhoto(ctx, entityId))
        ? [{ key: PHOTO_KEY, name: 'Punch selfie', mimeType: 'image/jpeg' }]
        : [];
    }
    // Letter approvals are keyed by each letter kind's own action type, which is configurable, so
    // the letters module is asked whether this is one of its letters rather than matched on a name.
    return (await this.letters.hasApprovalDocument(
      viewer,
      entityId,
      entityType,
    ))
      ? [{ key: LETTER_KEY, name: 'Letter (PDF)', mimeType: 'application/pdf' }]
      : [];
  }

  async file(
    viewer: AuthenticatedUser,
    entityType: string,
    entityId: string,
    key: string,
  ): Promise<{ data: Buffer; filename: string; contentType: string }> {
    await this.authorise(viewer, entityType, entityId);
    const ctx = rlsContextFor(viewer);

    if (entityType === ACTION_DWR) {
      // Only an attachment of *this* report: `readAttachment` takes any id in the company.
      const attachments = await this.dwr.attachmentsOf(ctx, entityId);
      const attachment = attachments.find((a) => a.id === key);
      if (!attachment) throw new NotFoundException('File not found');
      const { data, mimeType } = await this.dwr.readAttachment(ctx, key);
      return { data, filename: attachment.fileName, contentType: mimeType };
    }
    if (entityType === ENTITY_BILL_PACKAGE && key === BILL_KEY) {
      const { bytes, filename } = await this.billViews.pdfFor(ctx, entityId);
      return { data: bytes, filename, contentType: 'application/pdf' };
    }
    if (entityType === ACTION_ATTENDANCE_EXCEPTION && key === PHOTO_KEY) {
      const data = await this.punches.exceptionPhoto(ctx, entityId);
      if (!data) throw new NotFoundException('File not found');
      return describe(data, 'punch-selfie');
    }
    if (entityType === ACTION_REIMBURSEMENT_CLAIM && key === RECEIPT_KEY) {
      return this.claims.receipt(this.callerOf(viewer), entityId);
    }
    if (key === LETTER_KEY) {
      const data = await this.letters.approvalDocument(
        viewer,
        entityId,
        entityType,
      );
      if (data)
        return { data, filename: 'letter.pdf', contentType: 'application/pdf' };
    }
    throw new NotFoundException('File not found');
  }

  /** The module services' own caller shape; no request here, so no address to record. */
  private callerOf(viewer: AuthenticatedUser) {
    return callerFrom(viewer, { ip: '' } as never);
  }

  private async authorise(
    viewer: AuthenticatedUser,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    if (!(await this.approvals.mayViewFiles(entityType, entityId, viewer))) {
      throw new ForbiddenException(
        'You are not an approver of this item, so its files are not available to you.',
      );
    }
  }
}

function describe(data: Buffer, fallbackName: string) {
  const { filename, contentType } = describeStoredFile({
    bytes: data,
    storedName: null,
    storedType: null,
    fallbackName,
  });
  return { data, filename, contentType };
}
