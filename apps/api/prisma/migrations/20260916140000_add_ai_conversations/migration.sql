-- AiConversation
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT,
    "scopeLabel" TEXT,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTurnAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_conversations_userId_lastTurnAt_idx" ON "ai_conversations"("userId", "lastTurnAt");

-- AiConversationTurn
CREATE TABLE "ai_conversation_turns" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "steps" JSONB,
    "proposals" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversation_turns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_conversation_turns_conversationId_seq_key" ON "ai_conversation_turns"("conversationId", "seq");
CREATE INDEX "ai_conversation_turns_userId_idx" ON "ai_conversation_turns"("userId");

-- AgentToolLog gains the conversation link
ALTER TABLE "agent_tool_logs" ADD COLUMN "conversationId" TEXT;
CREATE INDEX "agent_tool_logs_conversationId_idx" ON "agent_tool_logs"("conversationId");

-- Foreign keys
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_conversation_turns" ADD CONSTRAINT "ai_conversation_turns_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_tool_logs" ADD CONSTRAINT "agent_tool_logs_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
