import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveApplicationStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

/**
 * Query for the HR admin leave list.
 *
 * A DTO rather than a bare `@Query('status') status?: LeaveApplicationStatus`,
 * which is what this used to be and which returned a 500 whenever the parameter
 * was absent. The global `ValidationPipe` runs with `transform: true`; for a
 * parameter whose declared type is not one of the primitives it recognises, it
 * calls `plainToClass(metatype, value)`, and class-transformer throws
 * `Cannot read properties of undefined (reading 'constructor')` on an undefined
 * value. Passing `?status=pending` masked the bug entirely, because a defined
 * value survives that path — so the failure only ever appeared on the unfiltered
 * "All statuses" request.
 *
 * A DTO class is a metatype the pipe validates properly, and `@IsOptional` makes
 * an absent value legal instead of fatal.
 */
export class ListLeaveApplicationsQueryDto {
  @ApiPropertyOptional({
    enum: LeaveApplicationStatus,
    description: 'Omit to list applications of every status.',
  })
  @IsOptional()
  @IsEnum(LeaveApplicationStatus)
  status?: LeaveApplicationStatus;
}
