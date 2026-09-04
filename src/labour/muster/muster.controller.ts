import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import {
  AddMusterLineDto,
  BulkAddGangDto,
  CaptureMusterDto,
  ListMustersDto,
  OpenMusterDto,
  ReturnMusterDto,
} from './dto/muster.dto';
import { MusterService } from './muster.service';

@ApiTags('Labour')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.DAILY_WORKER_REGISTRY)
@Controller('labour/musters')
export class MusterController {
  constructor(private readonly musters: MusterService) {}

  @Get()
  @ApiOperation({
    summary: 'Muster list / approval queue',
    description:
      'Defaults to submitted, oldest first, with flag counts on each row (US4).',
  })
  async findAll(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListMustersDto,
  ) {
    return this.musters.findAll(caller, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Muster detail with per-line applicable rate' })
  async findOne(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.musters.findOne(caller, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Open a draft muster session',
    description:
      'Validates GPS against the site geofence; a violation or low accuracy is ' +
      'flagged, never rejected (FR-013).',
  })
  async open(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: OpenMusterDto,
    @Ip() ip: string,
  ) {
    return this.musters.open(caller, dto, ip);
  }

  @Post('capture')
  @ApiOperation({
    summary: 'Atomically capture and submit a whole muster (offline drain)',
    description:
      'Opens, marks every worker, and submits in one transaction — the path the ' +
      'frontend replays when a queued offline muster drains (FR-018).',
  })
  async capture(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CaptureMusterDto,
    @Ip() ip: string,
  ) {
    return this.musters.capture(caller, dto, ip);
  }

  @Post(':id/lines')
  @ApiOperation({ summary: 'Mark a worker on a draft muster' })
  async addLine(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddMusterLineDto,
    @Ip() ip: string,
  ) {
    return this.musters.addLine(caller, id, dto, ip);
  }

  @Post(':id/lines/bulk')
  @ApiOperation({ summary: 'Mark a whole gang on a draft muster (FR-027/AC8)' })
  async bulkAdd(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: BulkAddGangDto,
    @Ip() ip: string,
  ) {
    return this.musters.bulkAddGang(caller, id, dto, ip);
  }

  @Patch(':id/submit')
  @ApiOperation({
    summary: 'Submit a muster',
    description:
      'Every line needs a photo (FR-010); a second muster for the same site and ' +
      'date is rejected with 409 (FR-016).',
  })
  async submit(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.musters.submit(caller, id, ip);
  }

  @Patch(':id/approve')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({ summary: 'Approve a submitted muster (LABOUR_APPROVE)' })
  async approve(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.musters.approve(caller, id, ip);
  }

  @Patch(':id/return')
  @RequirePermissions(Permission.LABOUR_APPROVE)
  @ApiOperation({
    summary: 'Return a muster to draft with a reason (LABOUR_APPROVE)',
  })
  async returnToDraft(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReturnMusterDto,
    @Ip() ip: string,
  ) {
    return this.musters.returnToDraft(caller, id, dto.reason, ip);
  }
}
