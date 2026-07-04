import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDbClient, type DbClient } from "@cadence/db";

export const DB_CLIENT = Symbol("DB_CLIENT");

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DbClient => {
        const url = config.getOrThrow<string>("DATABASE_URL");
        return createDbClient(url);
      },
    },
  ],
  exports: [DB_CLIENT],
})
export class DbModule {}
