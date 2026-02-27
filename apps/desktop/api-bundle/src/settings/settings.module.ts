import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ZimbraModule, PrismaModule],
  providers: [SettingsService],
  controllers: [SettingsController],
})
export class SettingsModule {}
