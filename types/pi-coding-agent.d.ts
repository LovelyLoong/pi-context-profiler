declare module "@earendil-works/pi-coding-agent" {
  interface ContextUsage {
    tokens: number;
    contextWindow: number;
    percent: number;
  }

  interface ProfilerEventMap {
    session_start: {
      reason: unknown;
    };
    before_agent_start: {
      prompt: string;
      systemPrompt: string;
      systemPromptOptions: unknown;
    };
    context: {
      messages: unknown;
    };
    before_provider_request: {
      payload: unknown;
    };
    after_provider_response: {
      status: unknown;
      headers: Record<string, unknown>;
    };
    session_before_compact: {
      reason: unknown;
      willRetry: boolean;
      branchEntries: unknown[];
      customInstructions?: string;
      preparation: {
        tokensBefore: number;
        messagesToSummarize: unknown;
        turnPrefixMessages: unknown;
        previousSummary?: string;
      };
    };
    session_compact: {
      reason: unknown;
      willRetry: boolean;
      fromExtension: boolean;
      compactionEntry: {
        tokensBefore: number;
        firstKeptEntryId: string;
        summary: string;
        details: unknown;
      };
    };
    tool_result: unknown;
    message_end: {
      message: unknown;
    };
  }

  export interface ExtensionContext {
    cwd: string;
    model?: unknown;
    sessionManager: {
      getSessionId(): string;
    };
    getContextUsage(): ContextUsage | undefined;
  }

  export interface ExtensionAPI {
    on<EventName extends keyof ProfilerEventMap>(
      event: EventName,
      handler: (event: ProfilerEventMap[EventName], context: ExtensionContext) => void,
    ): void;
  }
}
