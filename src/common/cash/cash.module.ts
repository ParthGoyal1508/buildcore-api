import { Global, Module } from '@nestjs/common';

import { CashPolicyService } from './cash-policy';
import { MyCashPolicyController } from './my-cash-policy.controller';

/** The cash-hiding policy (038), available to every module without importing this one. */
@Global()
@Module({
  controllers: [MyCashPolicyController],
  providers: [CashPolicyService],
  exports: [CashPolicyService],
})
export class CashModule {}
