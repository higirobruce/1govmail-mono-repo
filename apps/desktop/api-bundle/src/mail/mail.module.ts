import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { ZimbraModule } from '../zimbra/zimbra.module';

@Module({
  imports: [ZimbraModule],
  providers: [MailService],
  controllers: [MailController],
})
export class MailModule {}
