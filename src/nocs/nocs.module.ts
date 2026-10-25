import { Module } from '@nestjs/common';

import { LettersModule } from '../letters/letters.module';
import { NocsController } from './nocs.controller';
import { NocsService } from './nocs.service';

/** Uploaded No Objection Certificates, for every record that can carry one (2026-10-15). */
@Module({
  imports: [LettersModule],
  controllers: [NocsController],
  providers: [NocsService],
  // 042: `labour` filters its worker list by NOC status through the exported service —
  // the only route Principle I allows into another module's rows.
  exports: [NocsService],
})
export class NocsModule {}
