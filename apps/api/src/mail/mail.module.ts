import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { MailScheduler } from './mail.scheduler';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ZimbraModule, PrismaModule],
  providers: [MailService, MailScheduler],
  controllers: [MailController],
})
export class MailModule {}
