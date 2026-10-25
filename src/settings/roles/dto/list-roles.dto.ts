import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';

export class ListRolesQueryDto {
  @ApiPropertyOptional({
    description:
      'Only roles every grant of which the caller already holds — the set they may actually ' +
      'assign, by the same ceiling the create/invite endpoints enforce on submit (042). ' +
      'Omitted or false, every visible role is returned, as before.',
  })
  @IsOptional()
  @IsBoolean()
  @BooleanQuery()
  grantable?: boolean;
}
