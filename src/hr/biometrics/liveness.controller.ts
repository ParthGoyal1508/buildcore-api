import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SelfService } from '../../common/decorators/route-access.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { IssueLivenessChallengeDto } from './dto/liveness.dto';
import { LivenessService, livenessSubject } from './liveness.service';

/**
 * Issues the head-turn challenge a face capture must follow (057).
 *
 * Open to any signed-in user: a challenge grants nothing by itself. It is bound to the caller (and
 * for a labour punch, the labour), and the endpoint that accepts the capture checks its own
 * permissions as before — so asking for one is harmless, and presenting someone else's is refused.
 */
@ApiTags('Liveness')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@SelfService()
@Controller('liveness/challenges')
export class LivenessController {
  constructor(private readonly liveness: LivenessService) {}

  @Post()
  @ApiOperation({
    summary: 'A one-time head-turn challenge for a face capture',
    description:
      'Returns the frames to capture, in order (`straight`, `left`, `right` — left and right as ' +
      'the person in front of the camera sees them), valid for two minutes and usable once.',
  })
  async issue(
    @UserEntity() user: AuthenticatedUser,
    @Body() dto: IssueLivenessChallengeDto,
  ) {
    if (dto.flow === 'labour-punch' && !dto.workerId) {
      throw new BadRequestException(
        'A labour punch challenge needs the workerId.',
      );
    }
    return this.liveness.issue(
      livenessSubject(
        user.id,
        dto.flow,
        dto.flow === 'labour-punch' ? dto.workerId : undefined,
      ),
      dto.flow.endsWith('enrolment') ? 'enrolment' : 'punch',
    );
  }
}
