import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

import { CLEARANCE_KIND } from '../exit-clearance.service';

const KINDS = Object.values(CLEARANCE_KIND);

/** Waiving one exit obligation (021 FR-016). */
export class WaiveClearanceDto {
  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind: (typeof KINDS)[number];

  @ApiProperty({
    description: "The obligation's id, as the clearance reported it.",
  })
  @IsString()
  @Length(1, 200)
  ref: string;

  @ApiProperty({
    minLength: 10,
    description:
      'Why the company is not pursuing this. Minimum length is deliberate — a mandatory ' +
      'field satisfied by a space is not a reason, and this one writes off company money.',
  })
  @IsString()
  @Length(10, 1000)
  reason: string;
}
