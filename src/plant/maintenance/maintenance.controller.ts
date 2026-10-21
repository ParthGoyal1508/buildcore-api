import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';
import type { Response } from 'express';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  ConsumeSparePartDto,
  ReverseConsumptionDto,
} from '../spare-parts/dto/spare-part.dto';
import { SparePartsService } from '../spare-parts/spare-parts.service';
import {
  CloseMaintenanceJobDto,
  CreateMaintenanceJobDto,
  ListMaintenanceDto,
  UpdateMaintenanceJobDto,
} from './dto/maintenance.dto';
import { formFormatOf, sendForm } from '../../common/form-document';
import { contentDispositionFor } from '../../common/storage/file-type';
import {
  JobCardFinalBillDto,
  JobCardQuotationDto,
  RecordJobCardPaymentDto,
} from './dto/job-card-flow.dto';
import { JobCardDto } from './dto/job-card.dto';
import { JobCardFile, JobCardFlowService } from './job-card-flow.service';
import { JobCardService } from './job-card.service';
import { MaintenanceService } from './maintenance.service';

/**
 * Maintenance jobs (006 US5) and the parts consumed on them (US10), gated by
 * `MAINTENANCE`.
 *
 * Part consumption is routed here rather than under `/plant/spare-parts` because
 * that is what it is: a fact about a job. The catalogue and its receipts live on the
 * spare-parts controller, where a storekeeper looks for them.
 */
@ApiTags('Plant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.MAINTENANCE)
@Controller('plant/maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly spareParts: SparePartsService,
    private readonly jobCards: JobCardService,
    private readonly jobCardFlow: JobCardFlowService,
  ) {}

  @Get('job-card/prefill')
  @ApiOperation({
    summary: "A new job card's equipment details, filled from the machine",
    description:
      'Name, asset code, registration, make/model, meter reading, operator and location — ' +
      'for the form to show as soon as a machine is chosen.',
  })
  async jobCardPrefill(
    @UserEntity() caller: AuthenticatedUser,
    @Query('equipmentId') equipmentId: string,
  ) {
    if (!equipmentId) throw new BadRequestException('equipmentId is required');
    return this.jobCards.prefill(caller, equipmentId);
  }

  @Get(':id/job-card.:format')
  @ApiOperation({ summary: 'The job card as PDF, Excel or Word' })
  async jobCardDocument(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ) {
    const kind = formFormatOf(format, ['pdf', 'xlsx', 'docx']);
    if (!kind)
      throw new BadRequestException('Format must be pdf, xlsx or docx');
    sendForm(res, await this.jobCards.document(caller, id, kind));
  }

  @Get(':id/job-card')
  @ApiOperation({ summary: "The job's maintenance job card" })
  async jobCard(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.jobCards.get(caller, id);
  }

  @Put(':id/job-card')
  @ApiOperation({
    summary: 'Save the job card',
    description: 'Numbered from the job card series (JC-0001) the first time.',
  })
  async saveJobCard(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() card: JobCardDto,
    @Ip() ipAddress: string,
  ) {
    return this.jobCards.save(caller, id, card, ipAddress);
  }

  // ── The job card's workflow (039): quotation → Head Office → final bill → payment ──

  @Put(':id/job-card/quotation')
  @ApiOperation({
    summary:
      "Set the workshop's quotation amount, and upload or replace its file",
    description:
      'Required to submit, not to save a draft. Only while the card is a draft or sent back ' +
      'for correction (409 JOB_CARD_NOT_EDITABLE otherwise).',
  })
  async saveQuotation(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: JobCardQuotationDto,
    @Ip() ipAddress: string,
  ) {
    return this.jobCardFlow.saveQuotation(caller, id, dto, ipAddress);
  }

  @Post(':id/job-card/submit')
  @ApiOperation({
    summary:
      'Send the job card to Head Office for approval, or resubmit it after correction',
    description:
      '400 JOB_CARD_QUOTATION_REQUIRED without the quotation file and amount; 409 ' +
      'JOB_CARD_NOT_SUBMITTABLE unless the card is a draft or sent back for correction.',
  })
  async submitJobCard(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ipAddress: string,
  ) {
    return this.jobCardFlow.submit(caller, id, ipAddress);
  }

  @Post(':id/job-card/final-bill')
  @ApiOperation({
    summary: "Upload the workshop's final bill against an approved job card",
    description:
      'Replaceable until the first payment is recorded (409 JOB_CARD_BILL_LOCKED after).',
  })
  async uploadFinalBill(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: JobCardFinalBillDto,
    @Ip() ipAddress: string,
  ) {
    return this.jobCardFlow.uploadFinalBill(caller, id, dto, ipAddress);
  }

  @Get(':id/job-card/payments')
  @RequirePermissions(Permission.MAINTENANCE, Permission.MAINTENANCE_PAY)
  @ApiOperation({
    summary: "The final bill's payments, the paid total and the balance",
  })
  async jobCardPayments(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.jobCardFlow.payments(caller, id);
  }

  @Post(':id/job-card/payments')
  @RequirePermissions(Permission.MAINTENANCE_PAY)
  @ApiOperation({
    summary: 'Record a payment against the final bill (Head Office)',
    description:
      'Part payments allowed; the card becomes `paid` when they reach the bill. 400 ' +
      'JOB_CARD_OVERPAYMENT beyond the balance. Cash needs CASH_ENTRY and is refused while the ' +
      'company hides cash.',
  })
  async recordJobCardPayment(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RecordJobCardPaymentDto,
    @Ip() ipAddress: string,
  ) {
    return this.jobCardFlow.recordPayment(caller, id, dto, ipAddress);
  }

  @Get(':id/job-card/history')
  @RequirePermissions(Permission.MAINTENANCE, Permission.MAINTENANCE_PAY)
  @ApiOperation({
    summary: 'Who did what to the job card, and when — oldest first',
  })
  async jobCardHistory(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.jobCardFlow.history(caller, id);
  }

  @Get(':id/job-card/quotation/file')
  @RequirePermissions(Permission.MAINTENANCE, Permission.MAINTENANCE_PAY)
  @ApiOperation({ summary: 'Download the quotation' })
  async quotationFile(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    sendFile(res, await this.jobCardFlow.quotationFile(caller, id));
  }

  @Get(':id/job-card/final-bill/file')
  @RequirePermissions(Permission.MAINTENANCE, Permission.MAINTENANCE_PAY)
  @ApiOperation({ summary: 'Download the final bill' })
  async finalBillFile(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    sendFile(res, await this.jobCardFlow.finalBillFile(caller, id));
  }

  @Get(':id/job-card/payments/:paymentId/proof')
  @RequirePermissions(Permission.MAINTENANCE, Permission.MAINTENANCE_PAY)
  @ApiOperation({ summary: "Download a payment's proof" })
  async paymentProof(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Res() res: Response,
  ) {
    sendFile(res, await this.jobCardFlow.paymentProof(caller, id, paymentId));
  }

  @Get()
  @ApiOperation({
    summary: 'Paginated maintenance jobs',
    description:
      'Open jobs first — the list exists to answer "what is down now".',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListMaintenanceDto,
  ) {
    return this.maintenance.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One job, with parts cost, labour and verified service bills',
  })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.maintenance.findOne(caller, id);
  }

  @Get(':id/parts')
  @ApiOperation({
    summary: 'Parts consumed on this job',
    description:
      'Each movement carries the rate in force when it happened, never the rate now.',
  })
  async listParts(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.spareParts.listMovements(caller, { maintenanceJobId: id });
  }

  @Post()
  @ApiOperation({
    summary: 'Open a job',
    description:
      'Sets the machine to `under_maintenance` in the same transaction (FR-002). ' +
      '409 if it already has an open job.',
  })
  async create(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CreateMaintenanceJobDto,
    @Ip() ipAddress: string,
  ) {
    const job = await this.maintenance.create(caller, dto, ipAddress);
    // Opened from the job card form (2026-10-15): the card is saved, and numbered, with it.
    if (dto.card) await this.jobCards.save(caller, job.id, dto.card, ipAddress);
    return job;
  }

  @Post(':id/parts')
  @ApiOperation({
    summary: 'Consume a spare part against this job',
    description:
      "Valued at the part's weighted average rate now, and that rate is frozen onto " +
      'the movement. 400 with `availableStock` if it would take stock below zero; ' +
      '409 if the job is closed. An incompatible part is flagged, never blocked.',
  })
  async consumePart(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConsumeSparePartDto,
    @Ip() ipAddress: string,
  ) {
    return this.spareParts.consume(caller, id, dto, ipAddress);
  }

  @Delete('parts/:movementId')
  @ApiOperation({
    summary: 'Reverse a part consumption',
    description:
      "Restores stock at the original rate and reduces the job's parts cost, in " +
      'one transaction. A reason is required (FR-019).',
  })
  async reversePart(
    @UserEntity() caller: AuthenticatedUser,
    @Param('movementId') movementId: string,
    @Body() dto: ReverseConsumptionDto,
    @Ip() ipAddress: string,
  ) {
    return this.spareParts.reverseConsumption(
      caller,
      movementId,
      dto,
      ipAddress,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a job',
    description: '`partsCost` is not settable — it accrues from consumption.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMaintenanceJobDto,
    @Ip() ipAddress: string,
  ) {
    return this.maintenance.update(caller, id, dto, ipAddress);
  }

  @Patch(':id/close')
  @ApiOperation({
    summary: 'Close a job',
    description:
      'Returns the machine to `active` and discharges any linked service schedule, ' +
      'moving its last-done and next-due readings forward.',
  })
  async close(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CloseMaintenanceJobDto,
    @Ip() ipAddress: string,
  ) {
    return this.maintenance.close(caller, id, dto, ipAddress);
  }
}

/** A stored job card file, under its own name and type — never cached. */
function sendFile(res: Response, file: JobCardFile) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', contentDispositionFor(file.filename));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.data);
}
