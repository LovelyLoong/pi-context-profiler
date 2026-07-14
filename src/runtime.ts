import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hashIdentifier, measureText, measureValue } from "./metrics.ts";
import {
  profileAgentStart,
  profileAssistantUsage,
  profileMessages,
  profileProviderPayload,
  profileToolResult,
} from "./profile.ts";

const SCHEMA_VERSION = 1;
const PACKAGE_VERSION = "0.2.0";

type ProfilerRecord = Record<string, unknown>;
type AppendRecord = (filePath: string, record: ProfilerRecord) => void;

export interface ContextProfilerOptions {
  logRoot?: string;
  now?: () => Date;
  appendRecord?: AppendRecord;
  onError?: (error: unknown) => void;
}

interface SessionState {
  requestIndex: number;
  pendingRequestIndex?: number;
  lastRequestIndex?: number;
  agentRunIndex: number;
}

function defaultLogRoot(): string {
  return process.env.PI_CONTEXT_PROFILER_DIR
    ?? join(
      process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      "context-profiler",
    );
}

function appendNdjson(filePath: string, record: ProfilerRecord): void {
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  writeFileSync(
    join(dirname(filePath), "latest.json"),
    `${JSON.stringify({
      schemaVersion: record.schemaVersion,
      timestamp: record.timestamp,
      event: record.event,
      sessionId: record.sessionId,
      fileName: basename(filePath),
    })}\n`,
    "utf8",
  );
}

function safeSessionId(value: string): string {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value)
    ? value
    : hashIdentifier(value);
}

function modelMetadata(ctx: ExtensionContext): unknown {
  const model = ctx.model as unknown as Record<string, unknown> | undefined;
  if (!model) return undefined;
  return {
    provider: typeof model.provider === "string" ? model.provider : undefined,
    id: typeof model.id === "string" ? model.id : undefined,
    contextWindow: typeof model.contextWindow === "number"
      ? model.contextWindow
      : undefined,
    maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
  };
}

function contextUsage(ctx: ExtensionContext): unknown {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  return {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
  };
}

export class ContextProfilerRuntime {
  private readonly logRoot: string;
  private readonly now: () => Date;
  private readonly appendRecord: AppendRecord;
  private readonly onError: (error: unknown) => void;
  private readonly sessions = new Map<string, SessionState>();
  private initialized = false;

  constructor(
    private readonly pi: ExtensionAPI,
    options: ContextProfilerOptions = {},
  ) {
    this.logRoot = options.logRoot ?? defaultLogRoot();
    this.now = options.now ?? (() => new Date());
    this.appendRecord = options.appendRecord ?? appendNdjson;
    this.onError = options.onError ?? (() => undefined);
  }

  register(): void {
    this.pi.on("session_start", (event, ctx) => {
      this.write(ctx, "session_start", { reason: event.reason });
    });
    this.pi.on("before_agent_start", (event, ctx) => {
      const state = this.state(ctx);
      state.agentRunIndex += 1;
      this.write(ctx, "agent_start_profile", {
        agentRunIndex: state.agentRunIndex,
        profile: profileAgentStart(
          event.prompt,
          event.systemPrompt,
          event.systemPromptOptions,
        ),
      });
    });
    this.pi.on("context", (event, ctx) => {
      const state = this.state(ctx);
      const requestIndex = state.requestIndex + 1;
      state.pendingRequestIndex = requestIndex;
      this.write(ctx, "context_snapshot", {
        requestIndex,
        profile: profileMessages(event.messages),
      });
    });
    this.pi.on("before_provider_request", (event, ctx) => {
      const state = this.state(ctx);
      const requestIndex = state.pendingRequestIndex ?? state.requestIndex + 1;
      state.requestIndex = Math.max(state.requestIndex, requestIndex);
      state.lastRequestIndex = requestIndex;
      state.pendingRequestIndex = undefined;
      this.write(ctx, "provider_request", {
        requestIndex,
        profile: profileProviderPayload(event.payload),
      });
    });
    this.pi.on("after_provider_response", (event, ctx) => {
      this.write(ctx, "provider_response", {
        requestIndex: this.state(ctx).lastRequestIndex,
        status: event.status,
        headerCount: Object.keys(event.headers).length,
      });
    });
    this.pi.on("session_before_compact", (event, ctx) => {
      this.write(ctx, "compaction_start", {
        reason: event.reason,
        willRetry: event.willRetry,
        tokensBefore: event.preparation.tokensBefore,
        branchEntryCount: event.branchEntries.length,
        messagesToSummarize: measureValue(event.preparation.messagesToSummarize),
        turnPrefixMessages: measureValue(event.preparation.turnPrefixMessages),
        previousSummary: event.preparation.previousSummary === undefined
          ? undefined
          : measureText(event.preparation.previousSummary),
        customInstructions: event.customInstructions === undefined
          ? undefined
          : measureText(event.customInstructions),
      });
    });
    this.pi.on("session_compact", (event, ctx) => {
      this.write(ctx, "compaction", {
        reason: event.reason,
        willRetry: event.willRetry,
        fromExtension: event.fromExtension,
        tokensBefore: event.compactionEntry.tokensBefore,
        firstKeptEntryIdHash: hashIdentifier(event.compactionEntry.firstKeptEntryId),
        summary: measureText(event.compactionEntry.summary),
        details: measureValue(event.compactionEntry.details),
      });
    });
    this.pi.on("tool_result", (event, ctx) => {
      this.write(ctx, "tool_result", {
        nextRequestIndex: this.state(ctx).requestIndex + 1,
        profile: profileToolResult(event),
      });
    });
    this.pi.on("message_end", (event, ctx) => {
      const usage = profileAssistantUsage(event.message);
      if (!usage) return;
      this.write(ctx, "assistant_usage", {
        requestIndex: this.state(ctx).lastRequestIndex,
        usage,
        contextUsage: contextUsage(ctx),
      });
    });
  }

  private state(ctx: ExtensionContext): SessionState {
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionState = { requestIndex: 0, agentRunIndex: 0 };
    this.sessions.set(sessionId, created);
    return created;
  }

  private initializeLogRoot(): void {
    if (this.initialized) return;
    mkdirSync(this.logRoot, { recursive: true });
    this.initialized = true;
  }

  private write(
    ctx: ExtensionContext,
    event: string,
    details: ProfilerRecord,
  ): void {
    try {
      this.initializeLogRoot();
      const sessionId = ctx.sessionManager.getSessionId();
      const record: ProfilerRecord = {
        schemaVersion: SCHEMA_VERSION,
        packageVersion: PACKAGE_VERSION,
        timestamp: this.now().toISOString(),
        event,
        sessionId: safeSessionId(sessionId),
        cwd: measureText(ctx.cwd),
        model: modelMetadata(ctx),
        ...details,
      };
      this.appendRecord(
        join(this.logRoot, `${safeSessionId(sessionId)}.ndjson`),
        record,
      );
    } catch (error) {
      this.onError(error);
    }
  }
}
