import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProviderModule } from '../provider/provider.module';
import { MailModule } from '../mail/mail.module';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';
import { DocEmbedWorkerService } from './doc-embed-worker.service';

@Module({
  imports: [PrismaModule, ProviderModule, MailModule],
  providers: [DocsService, DocEmbedWorkerService],
  controllers: [DocsController],
  exports: [DocsService],
})
export class DocsModule {}
