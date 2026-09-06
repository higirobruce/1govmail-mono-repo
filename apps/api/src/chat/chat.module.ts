import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AiModule } from '../ai/ai.module';
import { DocsModule } from '../docs/docs.module';
import { RetrievalService } from './retrieval.service';
import { AskService } from './ask.service';
import { GenerationCacheService } from './generation-cache.service';
import { DossierService } from './dossier.service';
import { ChatController } from './chat.controller';
import { SemanticSearchController } from './semantic-search.controller';

@Module({
  imports: [PrismaModule, MailModule, AiModule, DocsModule],
  providers: [RetrievalService, AskService, GenerationCacheService, DossierService],
  controllers: [ChatController, SemanticSearchController],
})
export class ChatModule {}
