import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import { ReportsModule } from "../reports/reports.module.js";
import { ChatConfig } from "./chat-config.js";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";

/** Phase-3b chat: the API process's single guarded LLM path. Loads even when
 *  chat env is missing — the controller 503s chat routes only. */
@Module({
  imports: [ReportsModule],
  controllers: [ChatController],
  providers: [ChatService, ChatConfig, PrismaService],
})
export class ChatModule {}
