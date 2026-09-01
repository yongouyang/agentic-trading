import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // DATABASE_URL overrides the schema datasource — tests/e2e point it at a
    // throwaway SQLite file; unset keeps the schema default (prisma/dev.db).
    // (Env-based, not a constructor param: Nest DI chokes on emitted
    // design:paramtypes metadata for optional scalar params.)
    super(process.env.DATABASE_URL ? { datasources: { db: { url: process.env.DATABASE_URL } } } : undefined);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
