import { Injectable, NotFoundException } from '@nestjs/common';
import { SignedCopySubject } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import {
  contentDispositionFor,
  detectContentType,
} from '../../../common/storage/file-type';
import { StorageService } from '../../../common/storage/storage.service';

export interface SignedCopyView {
  id: string;
  subjectType: SignedCopySubject;
  subjectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  receivedOn: string;
  uploadedAt: string;
}

/**
 * The countersigned document coming back (028 FR-020).
 *
 * ## Acknowledgement is a state, not a file in a list
 *
 * This is the decision the requirement turns on. Filing the signed PDF would make the copy
 * *findable*; it would not answer the only question anybody asks of it — **which bills are still
 * unacknowledged** — because answering that from a list of files means opening them.
 *
 * So the file goes in `SignedCopy` and the fact goes on the subject. For a bill that is
 * `RABill.acknowledgedAt`, which `BillPaymentsService`'s outstanding views already carry, so an
 * unacknowledged bill is visible beside what is owed on it rather than in a separate report.
 *
 * For a **debit note** the state is derived from the copy itself rather than stored a second time:
 * `acknowledgedOn` is the latest copy's `receivedOn`. A debit note is one row of a register with no
 * lifecycle of its own, and a column that could only ever hold what a join already answers is a
 * column that will one day disagree with it.
 *
 * ## The date is when it was received, not when it was scanned
 *
 * `receivedOn` is supplied, not taken from the clock. A copy signed on site on Tuesday and scanned
 * on Friday was acknowledged on Tuesday, and that is the date a payment term runs from.
 *
 * ## The pattern is `DWRAttachment`'s, down to the content type
 *
 * Bytes through `StorageService`, name stored as the uploader spelled it, type detected from the
 * **bytes** rather than from the caller's claim. A browser told `application/octet-stream` offers a
 * download instead of opening the document somebody wants to look at, and a caller's content type
 * is a guess made from a file extension.
 */
@Injectable()
export class SignedCopiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Files a signed copy and acknowledges its subject. */
  async upload(
    ctx: RlsContext,
    companyId: string,
    subjectType: SignedCopySubject,
    subjectId: string,
    input: { data: Buffer; fileName: string; receivedOn: string },
    actor: { userId: string | null },
  ): Promise<SignedCopyView> {
    const receivedOn = new Date(
      `${input.receivedOn.slice(0, 10)}T00:00:00.000Z`,
    );

    await this.assertSubjectExists(ctx, subjectType, subjectId);

    const mimeType =
      detectContentType(input.data)?.contentType ?? 'application/octet-stream';
    const fileRef = await this.storage.put(
      `signed-copies/${companyId}`,
      input.data,
      mimeType,
    );

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const created = await tx.signedCopy.create({
        data: {
          companyId,
          subjectType,
          subjectId,
          fileRef,
          fileName: input.fileName,
          mimeType,
          sizeBytes: input.data.length,
          receivedOn,
          uploadedByUserId: actor.userId,
        },
      });

      if (subjectType === SignedCopySubject.ra_bill) {
        // **The state, which is the point of FR-020.** Conditional on `null` so the *first* copy
        // establishes the acknowledgement date: a second copy filed later — a replacement scan, a
        // better photograph — must not move the date a retention period is already running from.
        await tx.rABill.updateMany({
          where: { id: subjectId, acknowledgedAt: null },
          data: { acknowledgedAt: receivedOn },
        });
      }

      return toView(created);
    });
  }

  /** Every copy filed against one document, newest first. */
  async list(
    ctx: RlsContext,
    subjectType: SignedCopySubject,
    subjectId: string,
  ): Promise<SignedCopyView[]> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const rows = await tx.signedCopy.findMany({
        where: { subjectType, subjectId },
        orderBy: { receivedOn: 'desc' },
      });
      return rows.map(toView);
    });
  }

  /** Reads a copy back, named and typed so a browser can open it. */
  async read(
    ctx: RlsContext,
    copyId: string,
  ): Promise<{ data: Buffer; mimeType: string; contentDisposition: string }> {
    const copy = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.signedCopy.findFirst({
        where: { id: copyId },
        select: { fileRef: true, fileName: true, mimeType: true },
      }),
    );
    if (!copy) throw new NotFoundException('Signed copy not found');

    return {
      data: await this.storage.get(copy.fileRef),
      mimeType: copy.mimeType,
      // `contentDispositionFor` rather than a hand-built header: a file name carrying a character
      // outside latin1 makes `setHeader` throw `ERR_INVALID_CHAR`, which is a 500 on a download —
      // a defect this repository shipped and fixed on 2026-10-04.
      contentDisposition: contentDispositionFor(copy.fileName),
    };
  }

  /**
   * Refuses a copy filed against a document that does not exist in this company.
   *
   * `subjectId` is a bare id with no foreign key behind it — the two subjects are different tables,
   * so no relation can be declared — which means **nothing but this check** stands between a typo
   * and a signed contract filed against nothing, discoverable only by the person who later cannot
   * find it.
   */
  private async assertSubjectExists(
    ctx: RlsContext,
    subjectType: SignedCopySubject,
    subjectId: string,
  ): Promise<void> {
    const found = await withRlsContext(this.prisma, ctx, (tx) =>
      subjectType === SignedCopySubject.ra_bill
        ? tx.rABill.findFirst({
            where: { id: subjectId },
            select: { id: true },
          })
        : tx.billPackageDebit.findFirst({
            where: { id: subjectId },
            select: { id: true },
          }),
    );
    if (!found) {
      throw new NotFoundException(
        subjectType === SignedCopySubject.ra_bill
          ? 'RA bill not found'
          : 'Debit not found',
      );
    }
  }
}

function toView(copy: {
  id: string;
  subjectType: SignedCopySubject;
  subjectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  receivedOn: Date;
  uploadedAt: Date;
}): SignedCopyView {
  return {
    id: copy.id,
    subjectType: copy.subjectType,
    subjectId: copy.subjectId,
    fileName: copy.fileName,
    mimeType: copy.mimeType,
    sizeBytes: copy.sizeBytes,
    receivedOn: copy.receivedOn.toISOString().slice(0, 10),
    uploadedAt: copy.uploadedAt.toISOString(),
  };
}
