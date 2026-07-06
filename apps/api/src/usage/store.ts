import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@cap/db";

export type LLMUsageRecordInput = {
  runId: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  ttfbMs?: number;
  durationMs?: number;
  cost?: number;
};

export async function recordLLMUsage(
  input: LLMUsageRecordInput,
): Promise<string> {
  const record = await prisma.lLMUsageRecord.create({
    data: {
      id: randomUUID(),
      runId: input.runId,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      ttfbMs: input.ttfbMs,
      durationMs: input.durationMs,
      cost: input.cost,
    },
  });
  return record.id;
}

export type LLMUsageRecordDTO = {
  id: string;
  runId: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  ttfbMs?: number;
  durationMs?: number;
  cost?: number;
  createdAt: string;
};

export type ListUsageRecordsOptions = {
  userId: string;
  runId?: string;
  provider?: string;
  model?: string;
  limit: number;
  offset: number;
};

type UsageRecordRow = {
  id: string;
  runId: string;
  provider: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  ttfbMs: number | null;
  durationMs: number | null;
  cost: number | null;
  createdAt: Date;
};

export async function listUsageRecords(
  options: ListUsageRecordsOptions,
): Promise<LLMUsageRecordDTO[]> {
  const conditions = [Prisma.sql`r."userId" = ${options.userId}`];
  if (options.runId) {
    conditions.push(Prisma.sql`u."runId" = ${options.runId}`);
  }
  if (options.provider) {
    conditions.push(Prisma.sql`u.provider = ${options.provider}`);
  }
  if (options.model) {
    conditions.push(Prisma.sql`u.model = ${options.model}`);
  }

  const rows = await prisma.$queryRaw<UsageRecordRow[]>`
    SELECT
      u.id,
      u."runId",
      u.provider,
      u.model,
      u."promptTokens",
      u."completionTokens",
      u."totalTokens",
      u."ttfbMs",
      u."durationMs",
      u.cost,
      u."createdAt"
    FROM "LLMUsageRecord" u
    JOIN "AgentRun" r ON r.id = u."runId"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY u."createdAt" DESC, u.id DESC
    LIMIT ${options.limit}
    OFFSET ${options.offset}
  `;

  return rows.map(toLLMUsageRecordDTO);
}

export function toLLMUsageRecordDTO(row: UsageRecordRow): LLMUsageRecordDTO {
  return {
    id: row.id,
    runId: row.runId,
    provider: row.provider,
    model: row.model,
    ...(row.promptTokens !== null ? { promptTokens: row.promptTokens } : {}),
    ...(row.completionTokens !== null
      ? { completionTokens: row.completionTokens }
      : {}),
    ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
    ...(row.ttfbMs !== null ? { ttfbMs: row.ttfbMs } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    ...(row.cost !== null ? { cost: row.cost } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
