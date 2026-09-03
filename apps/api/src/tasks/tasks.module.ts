import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksScheduler } from './tasks.scheduler';
import { PrismaModule } from '../prisma/prisma.module';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, ZimbraModule, NotificationsModule],
  providers: [TasksService, TasksScheduler],
  controllers: [TasksController],
  exports: [TasksService],
})
export class TasksModule {}
