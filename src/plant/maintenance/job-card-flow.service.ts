import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AuditAction,
  AuditEntityType,
  JobCardPaymentMode,
  JobCardStatus,
  Permission,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  APPROVAL_RETURNED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
  type ApprovalRejectedEvent,
  type ApprovalReturnedEvent,
} from '../../approvals/approvals.service';
import { ACTION_JOB_CARD } from '../../approvals/default-chains';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { actorNamesFor } from '../../common/actor-name';
import { businessTodayIso } from '../../common/business-date';
import { CashPolicyService } from '../../common/cash/cash-policy';
import { inr } from '../../common/form-document';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { describeStoredFile } from '../../common/storage/file-type';
import { StorageService } from '../../common/storage/storage.service';
import { decodeBase64Upload } from '../../common/uploads';
import { webRoutes } from '../../common/web-routes';
import { assertInScope } from '../../settings/company-scope';
import {
  JobCardFinalBillDto,
  JobCardQuotationDto,
  RecordJobCardPaymentDto,
} from './dto/job-card-flow.dto';
import {
  EDITABLE_STATUSES,
  JOB_CARD_ERRORS,
  type JobCardEventKind,
  changedUnderneath,
  effectiveJobCardStatus,
  inStatus,
  noFile,
  notEditable,
  paise,
  quotationRequired,
  statusLabel,
  storeJobCardFile,
} from './job-card-workflow';

/** One line of a card's history, with the actor named. */
export interface JobCardEventView {
  id: string;
  kind: string;
  fromStatus: JobCardStatus | null;
  toStatus: JobCardStatus | null;
  remarks: string | null;
  detail: Prisma.JsonValue | null;
  actorUserId: string | null;
  actorName: string | null;
  at: Date;
}

export interface JobCardPaymentView {
  id: string;
  amount: number;
  paidOn: string;
  mode: JobCardPaymentMode;
  referenceNumber: string | null;
  remarks: string | null;
  proofFileName: string | null;
  hasProof: boolean;
  recordedByName: string | null;
  createdAt: Date;
}

export interface JobCardPaymentsView {
  status: JobCardStatus | null;
  billAmount: number | null;
  paidTotal: number;
  balance: number | null;
  payments: JobCardPaymentView[];
}

/** A file to send back, the shape `contentDispositionFor` and the controller expect. */
export interface JobCardFile {
  data: Buffer;
  filename: string;
  contentType: string;
}

/**
 * The job card's workflow after the card itself (039, 2026-10-21) — the client's five steps:
 *
 * 1. **Site** creates the card (`JobCardService.save`) and uploads the workshop's quotation here.
 * 2. **Site** submits it: an approval item goes to Head Office (`ACTION_JOB_CARD`, one level).
 * 3. **Head Office** approves it, or sends it back for correction with remarks, from the Approvals
 *    queue. The spine announces the decision; the handlers below move the card. Site corrects a
 *    returned card and resubmits it.
 * 4. **Site** uploads the workshop's final bill against the approved card.
 * 5. **Head Office** (`MAINTENANCE_PAY`) records payments against the bill, in parts if need be;
 *    the card is `paid` once they reach the bill amount. Overpaying is refused.
 *
 * Every step writes a `JobCardEvent` — the history the card screen shows — and the site-side and
 * payment steps an audit entry against `MAINTENANCE_JOB`, as the job's other changes do. The
 * spine's decisions are not audited again here; the spine audits its own.
 */
@Injectable()
export class JobCardFlowService {
  private readonly logger = new Logger(JobCardFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
    private readonly cash: CashPolicyService,
  ) {}

  // ── 1. Quotation ───────────────────────────────────────────────────────────

  /**
   * Sets the quotation amount and, when a file is sent, replaces the quotation file. Allowed only
   * while the card is site's to change, as the card itself is.
   */
  async saveQuotation(
    caller: AuthenticatedUser,
    jobId: string,
    dto: JobCardQuotationDto,
    ipAddress: string,
  ) {
    const job = await this.job(caller, jobId);
    const status = effectiveJobCardStatus(job);
    if (!status) throw notSaved();
    if (!EDITABLE_STATUSES.includes(status)) throw notEditable(status);

    const stored = dto.file
      ? await storeJobCardFile(
          this.storage,
          job.companyId,
          decodeBase64Upload(dto.file, 'The quotation'),
          dto.fileName,
          'The quotation',
        )
      : null;
    const fields = [
      ...(paise(dto.amount) !== paise(job.quotationAmount ?? 0)
        ? ['quotationAmount']
        : []),
      ...(stored ? ['quotationFile'] : []),
    ];
    try {
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const updated = await tx.maintenanceJob.updateMany({
          where: { id: jobId, ...inStatus(status) },
          data: {
            jobCardStatus: status,
            quotationAmount: new Prisma.Decimal(dto.amount),
            ...(stored
              ? {
                  quotationFileRef: stored.fileRef,
                  quotationFileName: stored.fileName,
                  quotationContentType: stored.contentType,
                }
              : {}),
          },
        });
        if (updated.count === 0) throw changedUnderneath();
        if (fields.length > 0) {
          await this.event(tx, job, caller.id, 'edited', status, status, {
            detail: { fields, quotationAmount: dto.amount },
          });
        }
      });
    } catch (error) {
      if (stored)
        await this.storage.deleteMany([stored.fileRef]).catch(() => undefined);
      throw error;
    }
    // The superseded file is removed only once the new one is the card's.
    if (stored && job.quotationFileRef) {
      await this.storage
        .deleteMany([job.quotationFileRef])
        .catch(() => undefined);
    }
    await this.audit(caller, job.companyId, jobId, ipAddress, {
      quotationAmount: dto.amount,
      quotationFileReplaced: stored !== null,
    });
    return { status, quotationAmount: dto.amount };
  }

  // ── 2. Submit / resubmit ───────────────────────────────────────────────────

  /**
   * Sends the card to Head Office: from `draft` a fresh approval item; from `returned` the same
   * item again (a new round of it).
   *
   * **Resubmission by somebody other than the person who submitted.** The spine's `resubmit` is
   * the originator's alone, but a job card is the site's, not one person's: the in-charge who
   * raised it may be on leave when Head Office sends it back. So when the caller is not the
   * originator, the returned item is abandoned and a fresh one submitted with the caller as its
   * originator. Nothing is lost — the earlier round's decisions stay on the abandoned item, and
   * this card's own history records the return and the resubmission either way. When the caller
   * *is* the originator, the spine's `resubmit` is used, so the queue shows it as round 2.
   *
   * A returned item already resubmitted from the Approvals screen (the spine's own route) is
   * pending again while this card still reads `returned`; resubmitting here then only catches the
   * card up rather than raising a second item.
   */
  async submit(caller: AuthenticatedUser, jobId: string, ipAddress: string) {
    const job = await this.job(caller, jobId);
    const status = effectiveJobCardStatus(job);
    if (!status) throw notSaved();
    if (!EDITABLE_STATUSES.includes(status)) {
      throw new ConflictException({
        statusCode: 409,
        code: JOB_CARD_ERRORS.notSubmittable,
        message: `This job card is ${statusLabel(
          status,
        )}; only a draft or a card sent back for correction can be submitted.`,
      });
    }
    if (
      !job.quotationFileRef ||
      !job.quotationAmount ||
      paise(job.quotationAmount) <= 0
    ) {
      throw quotationRequired();
    }

    const resubmitting = status === JobCardStatus.returned;
    const subject = `Job card ${job.jobCardNo ?? ''} · ${job.equipment.code} ${
      job.equipment.name
    } · ₹${inr(Number(job.quotationAmount))} quotation`.replace(/\s+/g, ' ');
    const submission = {
      companyId: job.companyId,
      actionType: ACTION_JOB_CARD,
      entityType: ACTION_JOB_CARD,
      entityId: job.id,
      originatorUserId: caller.id,
      subject,
      href: webRoutes.plantMaintenanceJobCard(job.id),
      viewPermission: Permission.MAINTENANCE,
    };

    let instanceId: string;
    // False only when catching up with an item already resubmitted elsewhere: that item is not
    // ours to close if the card then fails to move.
    let raised = true;
    if (!resubmitting) {
      instanceId = (await this.approvals.submit(submission)).instanceId;
    } else {
      const current = await this.approvals.stateOfSystem(
        ACTION_JOB_CARD,
        job.id,
        job.companyId,
      );
      if (current?.state === 'pending') {
        instanceId = current.instanceId;
        raised = false;
      } else if (
        current?.state === 'returned' &&
        current.originatorUserId === caller.id
      ) {
        instanceId = (
          await this.approvals.resubmit(
            ACTION_JOB_CARD,
            job.id,
            job.companyId,
            caller.id,
            caller,
          )
        ).instanceId;
      } else {
        await this.approvals.abandon(
          ACTION_JOB_CARD,
          job.id,
          job.companyId,
          'Job card resubmitted by another site user; raised afresh.',
        );
        instanceId = (await this.approvals.submit(submission)).instanceId;
      }
    }

    const to = JobCardStatus.pending_approval;
    try {
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const updated = await tx.maintenanceJob.updateMany({
          where: { id: job.id, ...inStatus(status) },
          data: {
            jobCardStatus: to,
            jobCardApprovalItemId: instanceId,
            jobCardReturnRemarks: null,
          },
        });
        if (updated.count === 0) throw changedUnderneath();
        await this.event(
          tx,
          job,
          caller.id,
          resubmitting ? 'resubmitted' : 'submitted',
          status,
          to,
          { detail: { quotationAmount: Number(job.quotationAmount) } },
        );
      });
    } catch (error) {
      // The item was raised and the card did not move. Close the item rather than leave Head
      // Office deciding on a card that does not say it is waiting for them.
      if (raised) {
        await this.approvals
          .abandon(
            ACTION_JOB_CARD,
            job.id,
            job.companyId,
            'The submission failed to save.',
          )
          .catch(() => undefined);
      }
      throw error;
    }
    await this.audit(caller, job.companyId, job.id, ipAddress, {
      jobCardStatus: { from: status, to },
      approvalInstanceId: instanceId,
    });
    return { status: to, approvalInstanceId: instanceId };
  }

  // ── 3. Head Office's decision, from the spine ──────────────────────────────

  /**
   * Sent for correction: the card is site's again, with Head Office's remarks on it.
   *
   * Idempotent like every spine handler here — the status is the guard, so a redelivered event
   * changes nothing — and never throws, because a throw takes down delivery for every listener.
   */
  @OnEvent(APPROVAL_RETURNED_EVENT)
  async onApprovalReturned(event: ApprovalReturnedEvent): Promise<void> {
    if (event.entityType !== ACTION_JOB_CARD) return;
    await this.decided(event.entityId, event.companyId, 'returned', {
      to: JobCardStatus.returned,
      remarks: event.reason,
      actorUserId: event.actorUserId,
    });
  }

  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_JOB_CARD) return;
    const latest = await this.latestDecision(event);
    await this.decided(event.entityId, event.companyId, 'approved', {
      to: JobCardStatus.approved,
      remarks: latest?.reason ?? null,
      actorUserId: latest?.actorUserId ?? null,
    });
  }

  /**
   * Rejected outright (the queue offers it beside Return). The client's flow has no "rejected"
   * end — a job card is a repair that still has to happen — so a rejected card goes back to
   * **draft** with the reason shown to site as its remarks. Site can change the quotation (another
   * workshop, a cheaper repair) and submit afresh; the rejected item is finished, so that
   * submission raises a new one.
   */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_JOB_CARD) return;
    const latest = await this.latestDecision(event);
    await this.decided(event.entityId, event.companyId, 'rejected', {
      to: JobCardStatus.draft,
      remarks: latest?.reason ?? null,
      actorUserId: latest?.actorUserId ?? null,
    });
  }

  // ── 4. Final bill ──────────────────────────────────────────────────────────

  /**
   * Site uploads the workshop's final bill once Head Office has approved the card. It may be
   * replaced (a wrong scan, a corrected bill) until the first payment is recorded against it;
   * after that the bill is what money has been paid against, and stays.
   */
  async uploadFinalBill(
    caller: AuthenticatedUser,
    jobId: string,
    dto: JobCardFinalBillDto,
    ipAddress: string,
  ) {
    const job = await this.job(caller, jobId);
    const status = effectiveJobCardStatus(job);
    const replacing = status === JobCardStatus.bill_uploaded;
    if (status !== JobCardStatus.approved && !replacing) {
      throw new ConflictException({
        statusCode: 409,
        code: JOB_CARD_ERRORS.notApproved,
        message: `This job card is ${statusLabel(
          status,
        )}. The final bill is uploaded once Head Office has approved the card.`,
      });
    }
    if (replacing && job.jobCardPayments.length > 0) throw billLocked();

    const stored = await storeJobCardFile(
      this.storage,
      job.companyId,
      decodeBase64Upload(dto.file, 'The final bill'),
      dto.fileName,
      'The final bill',
    );
    const to = JobCardStatus.bill_uploaded;
    try {
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const updated = await tx.maintenanceJob.updateMany({
          where: {
            id: jobId,
            jobCardStatus: status,
            // Checked again inside the write: a payment recorded meanwhile locks the bill.
            ...(replacing ? { jobCardPayments: { none: {} } } : {}),
          },
          data: {
            jobCardStatus: to,
            finalBillNumber: dto.billNumber.trim(),
            finalBillDate: new Date(`${dto.billDate.slice(0, 10)}T00:00:00Z`),
            finalBillAmount: new Prisma.Decimal(dto.amount),
            finalBillFileRef: stored.fileRef,
            finalBillFileName: stored.fileName,
            finalBillContentType: stored.contentType,
            finalBillUploadedAt: new Date(),
            finalBillUploadedBy: caller.id,
          },
        });
        if (updated.count === 0) throw changedUnderneath();
        await this.event(tx, job, caller.id, 'bill_uploaded', status, to, {
          detail: {
            billNumber: dto.billNumber.trim(),
            amount: dto.amount,
            ...(replacing ? { replaced: true } : {}),
          },
        });
      });
    } catch (error) {
      await this.storage.deleteMany([stored.fileRef]).catch(() => undefined);
      throw error;
    }
    if (job.finalBillFileRef) {
      await this.storage
        .deleteMany([job.finalBillFileRef])
        .catch(() => undefined);
    }
    await this.audit(caller, job.companyId, jobId, ipAddress, {
      jobCardStatus: { from: status, to },
      finalBill: { billNumber: dto.billNumber.trim(), amount: dto.amount },
    });
    return { status: to };
  }

  // ── 5. Payment ─────────────────────────────────────────────────────────────

  /**
   * Records one payment against the final bill. Part payments are allowed; the card becomes
   * `paid` when they reach the bill. More than the balance is refused rather than recorded as an
   * advance, because nothing downstream knows what to do with money paid beyond a bill.
   *
   * The card's row is locked for the check and the insert, so two payments recorded at once cannot
   * both pass the balance check.
   *
   * Cash (038): `CashEntryInterceptor` already refuses `mode: cash` from a caller without
   * `CASH_ENTRY` and from everyone while the company hides cash; the service checks hiding again so
   * no other route into this method can record hidden cash.
   */
  async recordPayment(
    caller: AuthenticatedUser,
    jobId: string,
    dto: RecordJobCardPaymentDto,
    ipAddress: string,
  ) {
    const job = await this.job(caller, jobId);
    if (dto.mode === JobCardPaymentMode.cash) {
      await this.cash.assertCashAllowed(job.companyId);
    }
    if (dto.paidOn.slice(0, 10) > businessTodayIso()) {
      throw new BadRequestException({
        statusCode: 400,
        code: JOB_CARD_ERRORS.paymentInFuture,
        message: 'A payment cannot be dated in the future.',
      });
    }

    const proof = dto.proofFile
      ? await storeJobCardFile(
          this.storage,
          job.companyId,
          decodeBase64Upload(dto.proofFile, 'The payment proof'),
          dto.proofFileName,
          'The payment proof',
        )
      : null;

    let result: { paymentId: string; status: JobCardStatus; balance: number };
    try {
      result = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "plant"."MaintenanceJob" WHERE "id" = ${jobId} FOR UPDATE
          `;
          const current = await tx.maintenanceJob.findUniqueOrThrow({
            where: { id: jobId },
            select: {
              jobCardStatus: true,
              finalBillAmount: true,
              jobCardPayments: { select: { amount: true } },
            },
          });
          if (current.jobCardStatus === JobCardStatus.paid) {
            throw new ConflictException({
              statusCode: 409,
              code: JOB_CARD_ERRORS.alreadyPaid,
              message: 'This job card is already paid in full.',
            });
          }
          if (
            current.jobCardStatus !== JobCardStatus.bill_uploaded ||
            current.finalBillAmount === null
          ) {
            throw new ConflictException({
              statusCode: 409,
              code: JOB_CARD_ERRORS.billNotUploaded,
              message: `This job card is ${statusLabel(
                current.jobCardStatus,
              )}. Payment is recorded once site has uploaded the final bill.`,
            });
          }
          const bill = paise(current.finalBillAmount);
          const paidBefore = current.jobCardPayments.reduce(
            (sum, p) => sum + paise(p.amount),
            0,
          );
          const paying = paise(dto.amount);
          if (paidBefore + paying > bill) {
            throw new BadRequestException({
              statusCode: 400,
              code: JOB_CARD_ERRORS.overpayment,
              message: `That is more than the bill's balance of ₹${inr(
                (bill - paidBefore) / 100,
              )}. Record no more than what is still owed.`,
            });
          }

          const payment = await tx.jobCardPayment.create({
            data: {
              companyId: job.companyId,
              maintenanceJobId: jobId,
              amount: new Prisma.Decimal(dto.amount),
              paidOn: new Date(`${dto.paidOn.slice(0, 10)}T00:00:00Z`),
              mode: dto.mode,
              referenceNumber: dto.referenceNumber?.trim() || null,
              remarks: dto.remarks?.trim() || null,
              proofFileRef: proof?.fileRef ?? null,
              proofFileName: proof?.fileName ?? null,
              proofContentType: proof?.contentType ?? null,
              recordedByUserId: caller.id,
            },
          });
          const status = JobCardStatus.bill_uploaded;
          await this.event(tx, job, caller.id, 'payment', status, status, {
            remarks: dto.remarks?.trim() || null,
            detail: {
              paymentId: payment.id,
              amount: dto.amount,
              mode: dto.mode,
              referenceNumber: dto.referenceNumber?.trim() || null,
            },
          });

          const settled = paidBefore + paying >= bill;
          if (settled) {
            await tx.maintenanceJob.update({
              where: { id: jobId },
              data: { jobCardStatus: JobCardStatus.paid },
            });
            await this.event(
              tx,
              job,
              caller.id,
              'paid',
              status,
              JobCardStatus.paid,
              {
                detail: { amount: bill / 100 },
              },
            );
          }
          return {
            paymentId: payment.id,
            status: settled ? JobCardStatus.paid : status,
            balance: (bill - paidBefore - paying) / 100,
          };
        },
      );
    } catch (error) {
      if (proof)
        await this.storage.deleteMany([proof.fileRef]).catch(() => undefined);
      throw error;
    }

    await this.audit(caller, job.companyId, jobId, ipAddress, {
      payment: { id: result.paymentId, amount: dto.amount, mode: dto.mode },
      ...(result.status === JobCardStatus.paid
        ? {
            jobCardStatus: {
              from: JobCardStatus.bill_uploaded,
              to: JobCardStatus.paid,
            },
          }
        : {}),
    });
    return result;
  }

  /** The bill's payments with the paid total and balance — without cash while it is hidden. */
  async payments(
    caller: AuthenticatedUser,
    jobId: string,
  ): Promise<JobCardPaymentsView> {
    const job = await this.job(caller, jobId);
    const cashHidden = await this.cash.isHidden(job.companyId);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.jobCardPayment.findMany({
          where: {
            maintenanceJobId: jobId,
            ...(cashHidden ? { mode: { not: JobCardPaymentMode.cash } } : {}),
          },
          orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
        }),
    );
    const names = await actorNamesFor(
      this.prisma,
      rows.map((r) => r.recordedByUserId),
    );
    const paid = rows.reduce((sum, r) => sum + paise(r.amount), 0);
    const bill =
      job.finalBillAmount === null ? null : paise(job.finalBillAmount);
    return {
      status: effectiveJobCardStatus(job),
      billAmount: bill === null ? null : bill / 100,
      paidTotal: paid / 100,
      balance: bill === null ? null : (bill - paid) / 100,
      payments: rows.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        paidOn: r.paidOn.toISOString().slice(0, 10),
        mode: r.mode,
        referenceNumber: r.referenceNumber,
        remarks: r.remarks,
        proofFileName: r.proofFileName,
        hasProof: r.proofFileRef !== null,
        recordedByName: names.get(r.recordedByUserId) ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  // ── History and files ──────────────────────────────────────────────────────

  /**
   * Who did what to the card, oldest first. Covers Head Office's approve / return / reject as well
   * (written by the handlers above), so the screen needs no second history from the spine. A cash
   * payment's line is left out while the company hides cash (038).
   */
  async history(
    caller: AuthenticatedUser,
    jobId: string,
  ): Promise<JobCardEventView[]> {
    const job = await this.job(caller, jobId);
    const cashHidden = await this.cash.isHidden(job.companyId);
    const events = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.jobCardEvent.findMany({
          where: { maintenanceJobId: jobId },
          orderBy: { createdAt: 'asc' },
        }),
    );
    const visible = events.filter(
      (e) =>
        !(
          cashHidden &&
          e.kind === 'payment' &&
          (e.detail as { mode?: string } | null)?.mode ===
            JobCardPaymentMode.cash
        ),
    );
    const names = await actorNamesFor(
      this.prisma,
      visible.map((e) => e.actorUserId),
    );
    return visible.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      remarks: e.remarks,
      detail: e.detail,
      actorUserId: e.actorUserId,
      actorName: e.actorUserId ? names.get(e.actorUserId) ?? null : null,
      at: e.createdAt,
    }));
  }

  async quotationFile(
    caller: AuthenticatedUser,
    jobId: string,
  ): Promise<JobCardFile> {
    const job = await this.job(caller, jobId);
    if (!job.quotationFileRef) throw noFile('quotation');
    return this.file(
      job.quotationFileRef,
      job.quotationFileName,
      job.quotationContentType,
      `Quotation ${job.jobCardNo ?? job.id}`,
    );
  }

  async finalBillFile(
    caller: AuthenticatedUser,
    jobId: string,
  ): Promise<JobCardFile> {
    const job = await this.job(caller, jobId);
    if (!job.finalBillFileRef) throw noFile('final bill');
    return this.file(
      job.finalBillFileRef,
      job.finalBillFileName,
      job.finalBillContentType,
      `Final bill ${job.jobCardNo ?? job.id}`,
    );
  }

  async paymentProof(
    caller: AuthenticatedUser,
    jobId: string,
    paymentId: string,
  ): Promise<JobCardFile> {
    const job = await this.job(caller, jobId);
    const payment = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.jobCardPayment.findFirst({
          where: { id: paymentId, maintenanceJobId: jobId },
        }),
    );
    // A hidden cash payment does not exist (038), so its proof answers 404 like a missing one.
    if (
      !payment?.proofFileRef ||
      (payment.mode === JobCardPaymentMode.cash &&
        (await this.cash.isHidden(job.companyId)))
    ) {
      throw new NotFoundException('Payment proof not found.');
    }
    return this.file(
      payment.proofFileRef,
      payment.proofFileName,
      payment.proofContentType,
      `Payment proof ${job.jobCardNo ?? job.id}`,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async job(caller: AuthenticatedUser, jobId: string) {
    const job = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.maintenanceJob.findUnique({
        where: { id: jobId },
        include: {
          equipment: { select: { code: true, name: true } },
          jobCardPayments: { select: { id: true } },
        },
      }),
    );
    if (!job) throw new NotFoundException('Maintenance job not found');
    assertInScope(caller, job, 'Maintenance job');
    return job;
  }

  private event(
    tx: Prisma.TransactionClient,
    job: { id: string; companyId: string },
    actorUserId: string | null,
    kind: JobCardEventKind,
    fromStatus: JobCardStatus | null,
    toStatus: JobCardStatus | null,
    extra: { remarks?: string | null; detail?: Prisma.InputJsonValue } = {},
  ) {
    return tx.jobCardEvent.create({
      data: {
        companyId: job.companyId,
        maintenanceJobId: job.id,
        kind,
        fromStatus,
        toStatus,
        remarks: extra.remarks ?? null,
        detail: extra.detail,
        actorUserId,
      },
    });
  }

  /**
   * Moves a card off `pending_approval` on a spine decision and records it. The status is the
   * guard, so a redelivered event, or a decision on an item this card has already moved past,
   * changes nothing. Logged, never thrown.
   */
  private async decided(
    jobId: string,
    companyId: string,
    kind: JobCardEventKind,
    outcome: {
      to: JobCardStatus;
      remarks: string | null;
      actorUserId: string | null;
    },
  ): Promise<void> {
    try {
      await withRlsContext(this.prisma, { isSuperAdmin: true }, async (tx) => {
        const updated = await tx.maintenanceJob.updateMany({
          where: {
            id: jobId,
            companyId,
            jobCardStatus: JobCardStatus.pending_approval,
          },
          data: {
            jobCardStatus: outcome.to,
            jobCardReturnRemarks:
              outcome.to === JobCardStatus.approved ? null : outcome.remarks,
          },
        });
        if (updated.count === 0) return;
        await this.event(
          tx,
          { id: jobId, companyId },
          outcome.actorUserId,
          kind,
          JobCardStatus.pending_approval,
          outcome.to,
          { remarks: outcome.remarks },
        );
      });
    } catch (error) {
      this.logger.error(
        `Could not mark job card ${jobId} ${kind}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Who decided, and why — the spine's payload carries neither for approve and reject. */
  private async latestDecision(event: ApprovalCompletedEvent) {
    try {
      const view = await this.approvals.stateOfSystem(
        event.entityType,
        event.entityId,
        event.companyId,
      );
      return view?.latestDecision ?? null;
    } catch {
      return null;
    }
  }

  private async file(
    ref: string,
    storedName: string | null,
    storedType: string | null,
    fallbackName: string,
  ): Promise<JobCardFile> {
    const data = await this.storage.get(ref);
    return {
      data,
      ...describeStoredFile({
        bytes: data,
        storedName,
        storedType,
        fallbackName: fallbackName.replace(/[^A-Za-z0-9._-]+/g, '-'),
      }),
    };
  }

  private audit(
    caller: AuthenticatedUser,
    companyId: string,
    jobId: string,
    ipAddress: string,
    changes: Prisma.InputJsonValue,
  ) {
    return this.auditLog.record({
      entityType: AuditEntityType.MAINTENANCE_JOB,
      action: AuditAction.UPDATE,
      entityId: jobId,
      accountId: caller.id,
      companyId,
      ipAddress,
      changes,
    });
  }
}

function notSaved(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: JOB_CARD_ERRORS.notSaved,
    message: 'Save the job card first.',
  });
}

function billLocked(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: JOB_CARD_ERRORS.billLocked,
    message:
      'A payment has already been recorded against this bill, so it can no longer be replaced.',
  });
}
