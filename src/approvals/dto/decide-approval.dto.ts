import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApprovalDecisionAction } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One decision being recorded (016 FR-002 to FR-006, T045).
 *
 * A DTO class for a two-field body, which looks like ceremony and is not: this codebase
 * has already shipped endpoints whose `@Query()`/`@Body()` parameters went unvalidated,
 * and `action` here is the field that decides whether somebody gets paid. Principle II
 * makes the class mandatory; the global pipe's `forbidNonWhitelisted` is what makes it
 * worth having, because a caller who misspells `reason` is told rather than silently
 * recording an unexplained rejection.
 */
export class DecideApprovalDto {
  @ApiProperty({
    enum: ApprovalDecisionAction,
    description:
      '`approve` advances to the next level or completes the chain, `reject` ends it, ' +
      '`return` sends it back to whoever raised it for correction.',
  })
  @IsEnum(ApprovalDecisionAction)
  action: ApprovalDecisionAction;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Required for `reject` and `return` (FR-006). Optional on `approve`. The service, ' +
      'not this DTO, enforces that — the requirement depends on `action`, and a ' +
      'validator that cannot see the whole object would have to guess.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
