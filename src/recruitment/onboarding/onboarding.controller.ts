import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
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
  IssueKitDto,
  VerifyDocumentDto,
  WaiveItemDto,
} from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment/onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get(':employeeId')
  @ApiOperation({ summary: 'Onboarding checklist for an employee' })
  get(
    @UserEntity() caller: AuthenticatedUser,
    @Param('employeeId') employeeId: string,
  ) {
    return this.onboarding.getByEmployee(caller, employeeId);
  }

  @Patch('items/:id/verify')
  @ApiOperation({ summary: 'Verify a document item via 005 document surface' })
  verify(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerifyDocumentDto,
    @Ip() ip: string,
  ) {
    return this.onboarding.verifyDocument(caller, id, dto, ip);
  }

  @Patch('items/:id/issue')
  @ApiOperation({ summary: 'Issue a kit item' })
  issue(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: IssueKitDto,
    @Ip() ip: string,
  ) {
    return this.onboarding.issueKit(caller, id, dto.quantity, ip);
  }

  @Patch('items/:id/complete-induction')
  @ApiOperation({ summary: 'Mark an induction item complete' })
  induction(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    return this.onboarding.completeInduction(caller, id, ip);
  }

  @Patch('items/:id/waive')
  @RequirePermissions(Permission.RECRUITMENT_APPROVE)
  @ApiOperation({ summary: 'Waive an onboarding item (RECRUITMENT_APPROVE)' })
  waive(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: WaiveItemDto,
    @Ip() ip: string,
  ) {
    return this.onboarding.waive(caller, id, dto.reason, ip);
  }
}
