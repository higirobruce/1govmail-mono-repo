import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ZimbraModule } from './zimbra/zimbra.module';
import { AuthModule } from './auth/auth.module';
import { MailModule } from './mail/mail.module';
import { ContactsModule } from './contacts/contacts.module';
import { CalendarModule } from './calendar/calendar.module';
import { SettingsModule } from './settings/settings.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ZimbraModule,
    AuthModule,
    MailModule,
    ContactsModule,
    CalendarModule,
    SettingsModule,
    TasksModule,
  ],
})
export class AppModule {}
