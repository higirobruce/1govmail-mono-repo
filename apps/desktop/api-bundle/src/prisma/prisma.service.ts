import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // PrismaBetterSqlite3 accepts { url } where url is the SQLite file path.
    // Strip the "file:" scheme prefix that Prisma / Electron pass in DATABASE_URL.
    const dbUrl = process.env.DATABASE_URL ?? 'file:./dev.db';
    const dbPath = dbUrl.replace(/^file:/, '');

    const adapter = new PrismaBetterSqlite3({ url: dbPath });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
