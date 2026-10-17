import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { contentDispositionFor } from '../common/storage/file-type';
import { ListNocsDto, NocStatusQueryDto, UploadNocDto } from './dto/noc.dto';
import { NOC_PERMISSIONS, NocsService } from './nocs.service';

/**
 * Uploaded No Objection Certificates (2026-10-15).
 *
 * The right a NOC needs is its subject's — a work order's is `PROJECTS`, a labour worker's
 * `DAILY_WORKER_REGISTRY` — knowable only from the request, so `NocsService` refuses per subject
 * and at the level the action needs.
 *
 * The guard is the outer gate (036 B16): a caller must hold **at least one** subject area, at the
 * level the verb implies (read for GET, write for POST/DELETE), before the service is asked at
 * all. It cannot be the only gate — holding `PROJECTS` must not open employee NOCs — which is why
 * the service still checks the specific one.
 */
@ApiTags('NOCs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(...NOC_PERMISSIONS)
@Controller('nocs')
export class NocsController {
  constructor(private readonly nocs: NocsService) {}

  @Get()
  @ApiOperation({ summary: 'The NOCs uploaded for one record' })
  async list(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: ListNocsDto,
  ) {
    return this.nocs.list(caller, query);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Open or closed for a page of records',
    description:
      'Open until a NOC is uploaded, closed from then on. A work order closes on its ' +
      'NOC after the work order, not the one after the LOI.',
  })
  async status(
    @UserEntity() caller: AuthenticatedUser,
    @Query() query: NocStatusQueryDto,
  ) {
    return this.nocs.statuses(
      caller,
      query.subjectType,
      query.subjectIds.split(','),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Upload a NOC for a record' })
  async upload(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: UploadNocDto,
  ) {
    return this.nocs.upload(caller, dto);
  }

  @Get(':id/file')
  @ApiOperation({ summary: 'The uploaded certificate' })
  async file(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const file = await this.nocs.file(caller, id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', contentDispositionFor(file.fileName));
    res.send(file.buffer);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an uploaded NOC' })
  async remove(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.nocs.remove(caller, id);
  }
}
