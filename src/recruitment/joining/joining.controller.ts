import { Body, Controller, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { JoinDto } from './dto/join.dto';
import { JoiningService } from './joining.service';

@ApiTags('Recruitment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECRUITMENT)
@Controller('recruitment/candidates')
export class JoiningController {
  constructor(private readonly joining: JoiningService) {}

  @Post(':id/join')
  @ApiOperation({
    summary: 'Complete joining — creates the Employee and opens onboarding',
  })
  join(
    @UserEntity() caller: AuthenticatedUser,
    @Param('id') candidateId: string,
    @Body() dto: JoinDto,
    @Ip() ip: string,
  ) {
    return this.joining.join(caller, candidateId, dto, ip);
  }
}
