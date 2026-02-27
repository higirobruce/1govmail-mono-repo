import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ZimbraModule, PrismaModule],
  providers: [CalendarService],
  controllers: [CalendarController],
})
export class CalendarModule {}
