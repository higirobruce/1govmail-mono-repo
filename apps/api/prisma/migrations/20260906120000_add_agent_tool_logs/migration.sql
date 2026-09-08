-- CreateTable
CREATE TABLE "agent_tool_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tool_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_tool_logs_userId_createdAt_idx" ON "agent_tool_logs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "agent_tool_logs" ADD CONSTRAINT "agent_tool_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
