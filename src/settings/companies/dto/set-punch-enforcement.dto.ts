import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Whether this company refuses a punch that fails validation (020 FR-013). */
export class SetPunchEnforcementDto {
  @ApiProperty({
    description:
      'True refuses a punch that fails location or face validation, instead of recording it as ' +
      'an exception for an admin. False restores the current behaviour.\n\n' +
      'Required rather than optional: turning the block on or off for a company is a decision ' +
      'somebody makes, and an omitted field would make it a decision somebody could make by ' +
      'accident.',
  })
  @IsBoolean()
  punchBlockEnforced!: boolean;
}
