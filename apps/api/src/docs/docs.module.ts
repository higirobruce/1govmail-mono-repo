import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { MailModule } from '../mail/mail.module';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';
import { DocEmbedWorkerService } from './doc-embed-worker.service';

@Module({
  imports: [PrismaModule, ZimbraModule, MailModule],
  providers: [DocsService, DocEmbedWorkerService],
  controllers: [DocsController],
})
export class DocsModule {}
