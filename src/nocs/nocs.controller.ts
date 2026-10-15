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
import { UserEntity } from '../common/decorators/user.decorator';
import { contentDispositionFor } from '../common/storage/file-type';
import { ListNocsDto, UploadNocDto } from './dto/noc.dto';
import { NocsService } from './nocs.service';

/**
 * Uploaded No Objection Certificates (2026-10-15).
 *
 * **No `@RequirePermissions` here, as on `LettersController`, and for the same reason**: the right
 * a NOC needs is its subject's — a work order's is `PROJECTS`, a labour worker's
 * `DAILY_WORKER_REGISTRY` — knowable only from the request, so `NocsService` refuses per subject.
 */
@ApiTags('NOCs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
