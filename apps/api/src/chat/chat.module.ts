import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AiModule } from '../ai/ai.module';
import { RetrievalService } from './retrieval.service';
import { InboxChatService } from './inbox-chat.service';
import { ChatController } from './chat.controller';
import { SemanticSearchController } from './semantic-search.controller';

@Module({
  imports: [PrismaModule, MailModule, AiModule],
  providers: [RetrievalService, InboxChatService],
  controllers: [ChatController, SemanticSearchController],
})
export class ChatModule {}
