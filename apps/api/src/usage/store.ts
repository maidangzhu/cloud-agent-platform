import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";

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
