import { Module } from '@nestjs/common';
import { OrgService } from './org.service';
import { OrgNarrativeService } from './org.narrative';
import { OrgController } from './org.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [PrismaModule, AiModule],
  providers: [OrgService, OrgNarrativeService],
  controllers: [OrgController],
  exports: [OrgService],
})
export class OrgModule {}
