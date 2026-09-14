import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { ProviderModule } from '../provider/provider.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ProviderModule, PrismaModule],
  providers: [SettingsService],
  controllers: [SettingsController],
})
export class SettingsModule {}
