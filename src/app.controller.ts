import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { AppService } from './app.service';
import { PublicRoute } from './common/decorators/route-access.decorator';

// 019 FR-005: the health check, which load balancers call without a token.
@PublicRoute()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiExcludeEndpoint()
  status() {
    return this.appService.getStatus();
  }
}
