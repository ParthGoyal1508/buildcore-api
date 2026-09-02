import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReEnrolmentRequestStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

/**
 * Query for the re-enrolment request queue.
 *
 * A DTO for the same reason `ListLeaveApplicationsQueryDto` is one: a bare
 * `@Query('status') status?: SomeEnum` returns a 500 whenever the parameter is
 * absent, because the global `ValidationPipe` (transform: true) hands the
 * undefined value to class-transformer, which dereferences its constructor.
 * The bug is invisible while a status is always supplied.
 */
export class ListReEnrolmentRequestsQueryDto {
  @ApiPropertyOptional({
    enum: ReEnrolmentRequestStatus,
    description: 'Omit to list requests of every status.',
  })
  @IsOptional()
  @IsEnum(ReEnrolmentRequestStatus)
  status?: ReEnrolmentRequestStatus;
}
