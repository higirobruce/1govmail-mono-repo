import { Module } from '@nestjs/common';
import { ZimbraService } from './zimbra.service';

@Module({
  providers: [ZimbraService],
  exports: [ZimbraService],
})
export class ZimbraModule {}
