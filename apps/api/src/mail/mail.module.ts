import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { MailScheduler } from './mail.scheduler';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ZimbraModule, PrismaModule, NotificationsModule],
  providers: [MailService, MailScheduler],
  controllers: [MailController],
})
export class MailModule {}
