import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** What a NOC can be about (2026-10-15). */
export const NOC_SUBJECTS = [
  'work_order',
  'hire_order',
  'labour_worker',
  'vendor',
  'employee',
  'purchase_order',
] as const;
export type NocSubject = (typeof NOC_SUBJECTS)[number];

/** The step of a work order a NOC follows. */
export const NOC_STAGES = ['loi', 'work_order'] as const;

export class ListNocsDto {
  @ApiProperty({ enum: NOC_SUBJECTS })
  @IsIn(NOC_SUBJECTS)
  subjectType!: NocSubject;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subjectId!: string;
}

/** At most this many records per status request — a page of any list in the app. */
export const MAX_STATUS_SUBJECTS = 500;

export class NocStatusQueryDto {
  @ApiProperty({ enum: NOC_SUBJECTS })
  @IsIn(NOC_SUBJECTS)
  subjectType!: NocSubject;

  @ApiProperty({
    description: 'Comma-separated record ids',
    example: 'id1,id2',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_STATUS_SUBJECTS * 40)
  subjectIds!: string;
}

export class UploadNocDto extends ListNocsDto {
  @ApiPropertyOptional({ enum: NOC_STAGES })
  @IsOptional()
  @IsIn(NOC_STAGES)
  stage?: string;

  @ApiProperty({ description: 'Base64-encoded file' })
  @IsBase64()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentType?: string;

  @ApiPropertyOptional({ description: 'Who issued the certificate' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  issuedBy?: string;

  @ApiPropertyOptional({ description: 'The reference printed on it' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  referenceNo?: string;

  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsISO8601()
  issuedOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
