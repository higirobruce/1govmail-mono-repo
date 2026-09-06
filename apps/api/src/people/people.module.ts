import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PeopleService } from './people.service';
import { PeopleController } from './people.controller';

@Module({
  imports: [PrismaModule],
  providers: [PeopleService],
  controllers: [PeopleController],
  exports: [PeopleService],
})
export class PeopleModule {}
