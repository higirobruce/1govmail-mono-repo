import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AiModule } from '../ai/ai.module';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [PrismaModule, MailModule, AiModule],
  providers: [RetrievalService],
})
export class ChatModule {}
