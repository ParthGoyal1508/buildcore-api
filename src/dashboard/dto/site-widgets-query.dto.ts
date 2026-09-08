import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** Query for `GET /site-dashboard/widgets` — which site to scope the widgets to. */
export class SiteWidgetsQueryDto {
  @ApiProperty({ description: 'The site to scope the dashboard to.' })
  @IsString()
  siteId!: string;
}
