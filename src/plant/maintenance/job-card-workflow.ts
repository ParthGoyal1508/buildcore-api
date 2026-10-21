import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JobCardStatus, Prisma } from '@prisma/client';

import { StorageService } from '../../common/storage/storage.service';
import {
  assertAllowedFileType,
  compressImageUpload,
  DOCUMENT_TYPES,
} from '../../common/uploads';

/**
 * The job card's own workflow (039, 2026-10-21) — the pieces both `JobCardService` (the card's
 * fields) and `JobCardFlowService` (submit, decisions, bill, payment) need.
 *
 *     draft ──submit──▶ pending_approval ──approve──▶ approved ──final bill──▶ bill_uploaded ──payments ≥ bill──▶ paid
 *       ▲                    │      │
 *       │◀────reject─────────┘      └──return (sent for correction)──▶ returned ──resubmit──▶ pending_approval
 *
 * Site edits the card only in `draft` and `returned`; everything after submission is Head Office's.
 */

/** Refusals, in the module's error-code style. */
export const JOB_CARD_ERRORS = {
  notEditable: 'JOB_CARD_NOT_EDITABLE',
  notSaved: 'JOB_CARD_NOT_SAVED',
  notSubmittable: 'JOB_CARD_NOT_SUBMITTABLE',
  quotationRequired: 'JOB_CARD_QUOTATION_REQUIRED',
  notApproved: 'JOB_CARD_NOT_APPROVED',
  billLocked: 'JOB_CARD_BILL_LOCKED',
  billNotUploaded: 'JOB_CARD_BILL_NOT_UPLOADED',
  alreadyPaid: 'JOB_CARD_ALREADY_PAID',
  overpayment: 'JOB_CARD_OVERPAYMENT',
  paymentInFuture: 'JOB_CARD_PAYMENT_IN_FUTURE',
  concurrentChange: 'JOB_CARD_CHANGED',
} as const;

/** Where site may still change the card: before Head Office has it, and when it comes back. */
export const EDITABLE_STATUSES: readonly JobCardStatus[] = [
  JobCardStatus.draft,
  JobCardStatus.returned,
];

/** `JobCardEvent.kind` values. A string column, so a new kind needs no migration. */
export type JobCardEventKind =
  | 'created'
  | 'edited'
  | 'submitted'
  | 'returned'
  | 'resubmitted'
  | 'approved'
  | 'rejected'
  | 'bill_uploaded'
  | 'payment'
  | 'paid';

/**
 * Where a card stands, reading a card saved before 039 as a draft.
 *
 * Cards saved before the workflow existed have a number and a body but a null status. They are
 * drafts — nobody has submitted them — and are read as such rather than backfilled, so the
 * migration did not have to guess; the first write to such a card stores `draft`.
 * Null only for a job that has no card at all.
 */
export function effectiveJobCardStatus(job: {
  jobCardStatus: JobCardStatus | null;
  jobCardNo: string | null;
  card: Prisma.JsonValue | null;
}): JobCardStatus | null {
  if (job.jobCardStatus) return job.jobCardStatus;
  return job.jobCardNo || job.card ? JobCardStatus.draft : null;
}

/**
 * A `where` matching a card in `status`, including a pre-039 card whose null status reads as
 * `draft`. Used on every conditional update so two people moving one card at once cannot both win.
 */
export function inStatus(
  status: JobCardStatus,
): Prisma.MaintenanceJobWhereInput {
  return status === JobCardStatus.draft
    ? { OR: [{ jobCardStatus: status }, { jobCardStatus: null }] }
    : { jobCardStatus: status };
}

/** The 409 for editing a card that is with Head Office or past approval. */
export function notEditable(status: JobCardStatus | null): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: JOB_CARD_ERRORS.notEditable,
    message:
      `This job card is ${statusLabel(
        status,
      )} and can no longer be changed. A card can be ` +
      'edited while it is a draft or after Head Office sends it back for correction.',
  });
}

/** The 409 for a card someone else moved between our read and our write. */
export function changedUnderneath(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: JOB_CARD_ERRORS.concurrentChange,
    message:
      'Somebody else moved this job card while you were working on it. Reload it and try again.',
  });
}

const STATUS_LABELS: Record<JobCardStatus, string> = {
  draft: 'a draft',
  pending_approval: 'pending Head Office approval',
  returned: 'sent back for correction',
  approved: 'approved',
  bill_uploaded: 'billed',
  paid: 'paid',
};

export function statusLabel(status: JobCardStatus | null): string {
  return status ? STATUS_LABELS[status] : 'not yet saved';
}

/** Two-decimal money comparison, so 0.1 + 0.2 never overpays a bill. */
export const paise = (value: number | Prisma.Decimal): number =>
  Math.round(Number(value) * 100);

/**
 * Stores one uploaded file — the quotation, the final bill, a payment proof — the way every upload
 * here is stored (036 B4–B6): type from the bytes and on the document allow-list, a photo
 * compressed, the stored (detected) type kept beside the reference.
 */
export async function storeJobCardFile(
  storage: StorageService,
  companyId: string,
  bytes: Buffer,
  fileName: string | undefined,
  label: string,
): Promise<{ fileRef: string; fileName: string | null; contentType: string }> {
  const detected = assertAllowedFileType(
    bytes,
    DOCUMENT_TYPES,
    label,
  ).contentType;
  const image = await compressImageUpload(bytes, detected);
  const contentType = image?.main.contentType ?? detected;
  const data = image?.main.data ?? bytes;
  // A photo re-encoded to JPEG/WebP keeps its name but not its old extension.
  const storedName =
    fileName && image?.compressed && contentType !== detected
      ? `${fileName.replace(/\.[^./\\]+$/, '') || 'document'}.${
          contentType === 'image/webp' ? 'webp' : 'jpg'
        }`
      : fileName ?? null;
  const fileRef = await storage.put(
    `job-cards/${companyId}`,
    data,
    contentType,
  );
  return { fileRef, fileName: storedName, contentType };
}

/** 404 for a file the card does not have. */
export function noFile(what: string): NotFoundException {
  return new NotFoundException(`This job card has no ${what}.`);
}

/** 400 for a submission without the quotation. */
export function quotationRequired(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: JOB_CARD_ERRORS.quotationRequired,
    message:
      'Upload the workshop quotation and enter its amount before sending the job card to Head Office.',
  });
}
