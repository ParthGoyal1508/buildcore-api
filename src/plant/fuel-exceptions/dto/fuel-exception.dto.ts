import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FuelAttribution, FuelExceptionStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * A reviewer's decision on a fuel variance (020 FR-002, FR-008, FR-009).
 *
 * `attribution` is **optional here and required by the service** when confirming. Making it
 * mandatory on the DTO would also demand it on a dismissal, where it is meaningless; the service
 * refuses a confirmation without one and says so with a code the interface can branch on.
 */
export class ReviewFuelExceptionDto {
  @ApiProperty({
    enum: [FuelExceptionStatus.confirmed, FuelExceptionStatus.dismissed],
    description:
      'The decision. `open` is not accepted — it is the state an exception arrives in, not one ' +
      'anybody can choose, and allowing it would let a reviewer "decide" an item back to undecided.',
  })
  @IsIn([FuelExceptionStatus.confirmed, FuelExceptionStatus.dismissed])
  status: 'confirmed' | 'dismissed';

  @ApiPropertyOptional({
    enum: FuelAttribution,
    description:
      'Who bears it. Required to confirm (FR-002). `neither` is a real answer — the variance ' +
      'was genuine and is being pursued against nobody — and recording it is different from ' +
      'dismissing the exception as unfounded.',
  })
  @IsOptional()
  @IsEnum(FuelAttribution)
  attribution?: FuelAttribution;

  @ApiPropertyOptional({
    description:
      'Which operator bears it. Required when attributing to the operator and more than one ran ' +
      'the machine that day (FR-009) — never inferred, because inferring is how the wrong ' +
      "person's wages get docked.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  operatorEmployeeId?: string;

  @ApiPropertyOptional({
    description:
      'Why. **Required to dismiss** (FR-008): a dismissal nobody has to justify is how an ' +
      'exception register becomes a list everybody clears without reading.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/**
 * Which exceptions to list, or none of them to list every one.
 *
 * A DTO rather than a bare `@Query('status') status?: FuelExceptionStatus`, which is what this
 * used to be and which returned a 500 on **every** unfiltered request — the only request the
 * screen makes on arrival, so the Fuel exceptions panel never loaded at all. The global
 * `ValidationPipe` runs with `transform: true`, and for a parameter whose declared type is not
 * one of the primitives it recognises it calls `plainToClass(metatype, value)`; class-transformer
 * throws `Cannot read properties of undefined (reading 'constructor')` on an undefined value.
 * A supplied `?status=confirmed` survived that path intact, which is why the endpoint looked
 * healthy from a filtered call and from its own unit tests.
 *
 * The same fault, with the same note, was fixed for leave applications, clients and vendors —
 * see `list-leave-applications.dto.ts`. This was the one site left, and `tds.controller.ts`'s
 * `regime` was the other.
 */
export class ListFuelExceptionsQueryDto {
  @ApiPropertyOptional({
    enum: FuelExceptionStatus,
    description: 'Omit to list exceptions in every state.',
  })
  @IsOptional()
  @IsEnum(FuelExceptionStatus)
  status?: FuelExceptionStatus;
}
