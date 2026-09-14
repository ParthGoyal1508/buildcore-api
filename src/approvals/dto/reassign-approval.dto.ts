import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * One pending item being handed to a named person at its current level (016 FR-019,
 * T062).
 *
 * Reassignment exists so an item does not die when the person who must approve it cannot.
 * The grant is deliberately not restricted to existing holders of the level's role: the
 * stall it clears is a level whose only holder has already decided earlier in the chain,
 * and a holder check would leave exactly that case unclearable. What constrains it
 * instead is `SETTINGS` on the endpoint, a mandatory reason, an audit entry naming actor
 * and level, and the grant being cleared as soon as the chain advances.
 */
export class ReassignApprovalDto {
  @ApiProperty({
    description:
      'The user to hand the current level to. They need not already hold the level’s ' +
      'role — granting it to somebody who does not is the whole point when the sole ' +
      'holder has already decided (FR-019). They still cannot decide twice (FR-021a).',
  })
  @IsString()
  @MinLength(1)
  toUserId: string;

  @ApiProperty({
    maxLength: 500,
    description:
      'Why the reassignment was made. Mandatory, unlike the reason on `approve` — an ' +
      'unexplained reassignment of an approval is exactly what an audit trail exists ' +
      'to explain, and it is written to the log with the actor and the level.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
