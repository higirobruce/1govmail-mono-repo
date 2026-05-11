import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';

@Module({
  imports: [PrismaModule, ZimbraModule],
  providers: [DocsService],
  controllers: [DocsController],
})
export class DocsModule {}
