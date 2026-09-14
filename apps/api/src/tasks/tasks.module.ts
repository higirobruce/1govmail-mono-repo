import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksScheduler } from './tasks.scheduler';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderModule } from '../provider/provider.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, ProviderModule, NotificationsModule],
  providers: [TasksService, TasksScheduler],
  controllers: [TasksController],
  exports: [TasksService],
})
export class TasksModule {}
