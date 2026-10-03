import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { HistoryEvictWorker } from './history-evict.worker';

@Module({
  imports: [PrismaModule],
  controllers: [AiController, ConversationsController],
  providers: [AiService, ConversationsService, HistoryEvictWorker],
  exports: [AiService],
})
export class AiModule {}
