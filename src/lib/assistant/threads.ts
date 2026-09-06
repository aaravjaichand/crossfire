/**
 * Threads and messages, read and written here and nowhere else. The one
 * update on a message — draft.filedDecisionId after a human filed it — is
 * made by the filing action, not by any tool.
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Citation, DefenseSource } from "@/lib/accountant/types";
import type {
  AssistantDraft,
  AssistantMessageView,
  AssistantThreadView,
  AssistantToolCall,
  AssistantToolResult,
} from "./types";

export const CONTEXT_MESSAGES = 8;
const TITLE_MAX = 80;

export async function createThread(firstMessage: string, runId?: string): Promise<number> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || "New thread";
  const [row] = await db
    .insert(schema.assistantThreads)
    .values({ title, runId: runId ?? null })
    .returning({ id: schema.assistantThreads.id });
  return row.id;
}

export async function getThread(threadId: number): Promise<AssistantThreadView | null> {
  const [row] = await db.select().from(schema.assistantThreads).where(eq(schema.assistantThreads.id, threadId));
  if (!row) return null;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.assistantMessages)
    .where(eq(schema.assistantMessages.threadId, threadId));
  return threadView(row, count?.n ?? 0);
}

export async function listThreads(limit = 40): Promise<AssistantThreadView[]> {
  const rows = await db
    .select()
    .from(schema.assistantThreads)
    .orderBy(desc(schema.assistantThreads.updatedAt), desc(schema.assistantThreads.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const counts = await db
    .select({ threadId: schema.assistantMessages.threadId, n: sql<number>`count(*)::int` })
    .from(schema.assistantMessages)
    .where(inArray(schema.assistantMessages.threadId, rows.map((r) => r.id)))
    .groupBy(schema.assistantMessages.threadId);
  const byThread = new Map(counts.map((c) => [c.threadId, Number(c.n)]));
  return rows.map((r) => threadView(r, byThread.get(r.id) ?? 0));
}

export async function listMessages(threadId: number): Promise<AssistantMessageView[]> {
  const rows = await db
    .select()
    .from(schema.assistantMessages)
    .where(eq(schema.assistantMessages.threadId, threadId))
    .orderBy(asc(schema.assistantMessages.turn), asc(schema.assistantMessages.id));
  return rows.map(messageView);
}

export async function getMessage(messageId: number): Promise<AssistantMessageView | null> {
  const [row] = await db.select().from(schema.assistantMessages).where(eq(schema.assistantMessages.id, messageId));
  return row ? messageView(row) : null;
}

export type NewMessage = {
  threadId: number;
  role: "user" | "assistant";
  content: string;
  toolCalls?: AssistantToolCall[];
  toolResults?: AssistantToolResult[];
  citations?: Citation[];
  draft?: AssistantDraft;
  runId?: string;
  sampleRef?: string;
  answerSource?: DefenseSource;
};

export async function appendMessage(message: NewMessage): Promise<AssistantMessageView> {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ turn: schema.assistantMessages.turn })
      .from(schema.assistantMessages)
      .where(eq(schema.assistantMessages.threadId, message.threadId))
      .orderBy(desc(schema.assistantMessages.turn))
      .limit(1);
    const turn = (last?.turn ?? 0) + 1;
    const [row] = await tx
      .insert(schema.assistantMessages)
      .values({
        threadId: message.threadId,
        turn,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls ?? null,
        toolResults: message.toolResults ?? null,
        citations: message.citations ?? null,
        draft: message.draft ?? null,
        runId: message.runId ?? null,
        sampleRef: message.sampleRef ?? null,
        answerSource: message.answerSource ?? null,
      })
      .returning();
    await tx
      .update(schema.assistantThreads)
      .set({ updatedAt: new Date() })
      .where(eq(schema.assistantThreads.id, message.threadId));
    return messageView(row);
  });
}

/** Replaces the draft on a message: used to record a filing or a started run. */
export async function updateDraft(messageId: number, draft: AssistantDraft): Promise<void> {
  await db.update(schema.assistantMessages).set({ draft }).where(eq(schema.assistantMessages.id, messageId));
}

// ---------- views ----------

type ThreadRow = typeof schema.assistantThreads.$inferSelect;
type MessageRow = typeof schema.assistantMessages.$inferSelect;

function threadView(row: ThreadRow, messageCount: number): AssistantThreadView {
  return {
    id: row.id,
    title: row.title,
    runId: row.runId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount,
  };
}

function messageView(row: MessageRow): AssistantMessageView {
  return {
    id: row.id,
    threadId: row.threadId,
    turn: row.turn,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
    toolCalls: row.toolCalls ?? [],
    toolResults: row.toolResults ?? [],
    citations: row.citations ?? [],
    draft: row.draft ?? undefined,
    runId: row.runId ?? undefined,
    sampleRef: row.sampleRef ?? undefined,
    answerSource: row.answerSource ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
