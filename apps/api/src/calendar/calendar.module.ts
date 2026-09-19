import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { ProviderModule } from '../provider/provider.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DocsModule } from '../docs/docs.module';

@Module({
  imports: [ProviderModule, PrismaModule, DocsModule],
  providers: [CalendarService],
  controllers: [CalendarController],
  exports: [CalendarService],
})
export class CalendarModule {}
