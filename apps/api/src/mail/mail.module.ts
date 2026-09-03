import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { MailScheduler } from './mail.scheduler';
import { CardExtractorService } from './card-extractor.service';
import { CardWorkerService } from './card-worker.service';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [ZimbraModule, PrismaModule, NotificationsModule, TasksModule],
  providers: [MailService, MailScheduler, CardExtractorService, CardWorkerService],
  controllers: [MailController],
})
export class MailModule {}
