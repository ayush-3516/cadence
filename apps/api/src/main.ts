import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import fastifyCookie from "@fastify/cookie";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.register(fastifyCookie, { secret: process.env.JWT_SECRET ?? "dev-only-secret" });

  const corsOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:3001").split(",");
  app.enableCors({ origin: corsOrigins, credentials: true });

  const config = new DocumentBuilder().setTitle("Cadence API").setVersion("1.0").build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}
bootstrap();
