import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Permission, SignedCopySubject } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../../auth/authenticated-user';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { UserEntity } from '../../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { rlsContextFor } from '../../../common/prisma/rls-context';
import { resolveCompanyId } from '../../../settings/company-scope';
import { BillPaymentsService } from './bill-payments.service';
import { RecordPaymentDto, UploadSignedCopyDto } from './dto/bill-payment.dto';
import { SignedCopiesService } from './signed-copies.service';

/**
 * What was paid, and what came back signed (028 FR-020, FR-021).
 *
 * `PROJECT_FINANCIALS` on every route, like the bills themselves: a payment is money leaving, and
 * somebody entitled to record a day's work is not thereby entitled to see what the company has paid
 * its subcontractors.
 *
 * Paths are literals under `projects/`, so this controller must be registered **before**
 * `ProjectsController` — otherwise `GET projects/:id` answers every one of them 404 as though the
 * data were missing. `route-shadowing.spec.ts` asserts the ordering rather than trusting this note.
 */
@ApiTags('Projects — payments and acknowledgements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.PROJECT_FINANCIALS)
@Controller()
export class BillPaymentsController {
  constructor(
    private readonly payments: BillPaymentsService,
    private readonly signedCopies: SignedCopiesService,
  ) {}

  // ── Payments ─────────────────────────────────────────────────────────────

  @Post('projects/ra-bills/:raBillId/payments')
  @ApiOperation({
    summary: 'Record a payment against a certified bill',
    description:
      'Partial payments are the normal case. Outstanding is **derived** — certified less the sum ' +
      'of payments — and no balance is stored anywhere, so correcting a payment corrects the ' +
      'figure.\n\n' +
      'Refused on an uncertified bill: there is no agreed amount to pay against, and money paid ' +
      'before certification is an advance, recovered through the bill package’s adjustments.',
  })
  @ApiResponse({
    status: 409,
    description:
      '`PAYMENT_BILL_NOT_CERTIFIED`, or `PAYMENT_EXCEEDS_CERTIFIED` where the total paid would ' +
      'pass what was certified.',
  })
  async recordPayment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('raBillId') raBillId: string,
    @Body() dto: RecordPaymentDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.payments.record(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      raBillId,
      dto,
      { userId: caller.id },
    );
  }

  @Delete('projects/ra-bill-payments/:paymentId')
  @ApiOperation({
    summary: 'Remove a payment recorded in error',
    description:
      'The only correction route. A payment is never edited in place — the record of what left and ' +
      'when is the point of it.',
  })
  async removePayment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('paymentId') paymentId: string,
  ) {
    await this.payments.remove(rlsContextFor(caller), paymentId);
    return { removed: true };
  }

  @Get('projects/ra-bills/:raBillId/outstanding')
  @ApiOperation({
    summary: 'What one bill is owed',
    description:
      'Certified, paid and outstanding, with every payment behind it. `outstandingAmount` is ' +
      'computed on this read and stored nowhere.',
  })
  async billOutstanding(
    @UserEntity() caller: AuthenticatedUser,
    @Param('raBillId') raBillId: string,
  ) {
    return this.payments.outstandingForBill(rlsContextFor(caller), raBillId);
  }

  @Get('projects/subcontractors/:partnerId/outstanding')
  @ApiOperation({
    summary: 'What one subcontractor is owed, across their bills',
    description:
      'Across bills, not per bill, because that is the question actually asked. Reached through ' +
      'the work order, which is where `partnerId` lives — a bill with no work order cannot be ' +
      'attributed to a subcontractor and is absent rather than guessed at.',
  })
  async subcontractorOutstanding(
    @UserEntity() caller: AuthenticatedUser,
    @Param('partnerId') partnerId: string,
  ) {
    return this.payments.outstandingForSubcontractor(
      rlsContextFor(caller),
      partnerId,
    );
  }

  // ── Signed copies ────────────────────────────────────────────────────────

  @Post('projects/ra-bills/:raBillId/signed-copy')
  @ApiOperation({
    summary: 'File the countersigned copy of a bill',
    description:
      'The arrival of the copy **acknowledges the bill** — `acknowledgedAt` is set from the date ' +
      'it was received, not from the clock. A file in a list cannot answer "which bills are ' +
      'unacknowledged", which is the only question anybody asks of it.\n\n' +
      'The first copy sets the date; a later replacement scan does not move it.',
  })
  async uploadBillSignedCopy(
    @UserEntity() caller: AuthenticatedUser,
    @Param('raBillId') raBillId: string,
    @Body() dto: UploadSignedCopyDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.signedCopies.upload(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      SignedCopySubject.ra_bill,
      raBillId,
      {
        data: Buffer.from(dto.data, 'base64'),
        fileName: dto.fileName,
        receivedOn: dto.receivedOn,
      },
      { userId: caller.id },
    );
  }

  @Post('projects/bill-package-debits/:debitId/signed-copy')
  @ApiOperation({
    summary: 'File the countersigned copy of a debit note',
    description:
      'Acknowledgement for a debit is the latest copy’s `receivedOn`, derived rather than stored a ' +
      'second time: a debit note is one row of a register with no lifecycle of its own.',
  })
  async uploadDebitSignedCopy(
    @UserEntity() caller: AuthenticatedUser,
    @Param('debitId') debitId: string,
    @Body() dto: UploadSignedCopyDto,
    @Query('companyId') companyId?: string,
  ) {
    return this.signedCopies.upload(
      rlsContextFor(caller),
      resolveCompanyId(caller, companyId),
      SignedCopySubject.debit_note,
      debitId,
      {
        data: Buffer.from(dto.data, 'base64'),
        fileName: dto.fileName,
        receivedOn: dto.receivedOn,
      },
      { userId: caller.id },
    );
  }

  @Get('projects/ra-bills/:raBillId/signed-copies')
  @ApiOperation({ summary: 'Every copy filed against a bill' })
  async listBillSignedCopies(
    @UserEntity() caller: AuthenticatedUser,
    @Param('raBillId') raBillId: string,
  ) {
    return this.signedCopies.list(
      rlsContextFor(caller),
      SignedCopySubject.ra_bill,
      raBillId,
    );
  }

  @Get('projects/bill-package-debits/:debitId/signed-copies')
  @ApiOperation({ summary: 'Every copy filed against a debit note' })
  async listDebitSignedCopies(
    @UserEntity() caller: AuthenticatedUser,
    @Param('debitId') debitId: string,
  ) {
    return this.signedCopies.list(
      rlsContextFor(caller),
      SignedCopySubject.debit_note,
      debitId,
    );
  }

  @Get('projects/signed-copies/:copyId/file')
  @ApiOperation({ summary: 'Download a signed copy' })
  async downloadSignedCopy(
    @UserEntity() caller: AuthenticatedUser,
    @Param('copyId') copyId: string,
    @Res() res: Response,
  ) {
    const { data, mimeType, contentDisposition } = await this.signedCopies.read(
      rlsContextFor(caller),
      copyId,
    );

    // The real type, not `application/octet-stream`: a browser cannot render what it has not been
    // told, and serving every document as opaque bytes is why a PDF once opened in a text editor.
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', contentDisposition);
    // Without this a cross-origin caller cannot read the name off a `fetch` — a blob URL carries
    // none of its own.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(data);
  }
}
