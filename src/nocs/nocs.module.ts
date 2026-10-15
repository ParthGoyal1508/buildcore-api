import { Module } from '@nestjs/common';

import { NocsController } from './nocs.controller';
import { NocsService } from './nocs.service';

/** Uploaded No Objection Certificates, for every record that can carry one (2026-10-15). */
@Module({
  controllers: [NocsController],
  providers: [NocsService],
})
export class NocsModule {}
