import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SelfService } from '../common/decorators/route-access.decorator';
import { UserEntity } from '../common/decorators/user.decorator';
import { contentDispositionFor } from '../common/storage/file-type';
import { ApprovalFilesService } from './approval-files.service';

/**
 * Files behind an item awaiting approval (2026-10-20). Self-service: authority is the approval
 * itself, checked per item, not a module permission — see `ApprovalFilesService`.
 */
@ApiTags('Approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('approvals')
export class ApprovalFilesController {
  constructor(private readonly files: ApprovalFilesService) {}

  @Get(':entityType/:entityId/files')
  @ApiOperation({
    summary: 'The files an approver can open for one item',
    description:
      'DWR attachments, a bill package’s PDF, the letter under approval, or a flagged ' +
      'punch’s selfie. Empty for item types with no files. 403 to anyone who may neither ' +
      'decide the item nor read its approval history.',
  })
  list(
    @UserEntity() caller: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.files.list(caller, entityType, entityId);
  }

  @Get(':entityType/:entityId/files/:key')
  @ApiOperation({ summary: 'One of those files' })
  async file(
    @UserEntity() caller: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('key') key: string,
    @Res() res: Response,
  ) {
    const { data, filename, contentType } = await this.files.file(
      caller,
      entityType,
      entityId,
      key,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDispositionFor(filename));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(data);
  }
}
