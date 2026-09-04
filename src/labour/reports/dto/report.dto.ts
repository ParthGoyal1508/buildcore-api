import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsString } from 'class-validator';

export class DeploymentReportDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  periodFrom!: string;

  @ApiProperty({ example: '2026-09-07' })
  @IsDateString()
  periodTo!: string;

  @ApiProperty({ enum: ['skill', 'site', 'contractor'] })
  @IsEnum({ skill: 'skill', site: 'site', contractor: 'contractor' })
  groupBy!: 'skill' | 'site' | 'contractor';
}

export class AttendanceReportDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  periodFrom!: string;

  @ApiProperty({ example: '2026-09-07' })
  @IsDateString()
  periodTo!: string;
}

export class PaymentRegisterReportDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  periodFrom!: string;

  @ApiProperty({ example: '2026-09-07' })
  @IsDateString()
  periodTo!: string;
}
