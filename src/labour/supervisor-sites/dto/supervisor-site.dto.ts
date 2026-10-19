import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class SetSupervisorSitesDto {
  @ApiProperty({
    type: [String],
    description: 'Replaces the supervisor’s assigned sites',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  siteIds!: string[];
}
