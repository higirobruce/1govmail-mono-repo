import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ZimbraModule } from '../zimbra/zimbra.module';

@Module({
  imports: [PrismaModule, ZimbraModule],
  providers: [TasksService],
  controllers: [TasksController],
})
export class TasksModule {}
