import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { ZimbraModule } from '../zimbra/zimbra.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ZimbraModule, PrismaModule],
  providers: [ContactsService],
  controllers: [ContactsController],
})
export class ContactsModule {}
