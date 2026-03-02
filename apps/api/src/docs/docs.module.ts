import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DocsController } from './docs.controller';
import { DocsService } from './docs.service';

@Module({
  imports: [PrismaModule],
  providers: [DocsService],
  controllers: [DocsController],
})
export class DocsModule {}
