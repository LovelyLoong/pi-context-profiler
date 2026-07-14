import { basename } from "node:path";
import { hashIdentifier, measureText, measureValue, type ValueMetric } from "./metrics.ts";

type UnknownRecord = Record<string, unknown>;

export interface ContentPartProfile {
  index: number;
  kind?: string;
  metric: ValueMetric;
}

export interface MessageProfile {
  index: number;
  role: string;
  kind?: string;
  toolName?: string;
  isError?: boolean;
  metric: ValueMetric;
  contentMetric?: ValueMetric;
  contentParts?: ContentPartProfile[];
}

export interface MessageCollectionProfile {
  itemCount: number;
  metric: ValueMetric;
  items: MessageProfile[];
  byRole: Record<string, { count: number; serializedBytes: number }>;
}

function record(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as UnknownRecord;
}

function safeLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(value)) return fallback;
  return value;
}

function optionalLabel(value: unknown): string | undefined {
  const label = safeLabel(value, "");
  return label || undefined;
}

function contentParts(content: unknown): ContentPartProfile[] | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.map((part, index) => {
    const partRecord = record(part);
    return {
      index,
      kind: optionalLabel(partRecord?.type),
      metric: measureValue(part),
    };
  });
}

function messageToolName(message: UnknownRecord): string | undefined {
  const direct = optionalLabel(message.toolName ?? message.name ?? message.tool_name);
  if (direct) return direct;
  const fn = record(message.function);
  return optionalLabel(fn?.name);
}

function profileMessage(message: unknown, index: number): MessageProfile {
  const value = record(message) ?? {};
  const content = value.content;
  return {
    index,
    role: safeLabel(value.role, "unknown"),
    kind: optionalLabel(value.type),
    toolName: messageToolName(value),
    isError: typeof value.isError === "boolean" ? value.isError : undefined,
    metric: measureValue(message),
    contentMetric: content === undefined ? undefined : measureValue(content),
    contentParts: contentParts(content),
  };
}

export function profileMessages(messages: unknown): MessageCollectionProfile {
  const values = Array.isArray(messages) ? messages : [];
  const items = values.map(profileMessage);
  const byRole: MessageCollectionProfile["byRole"] = {};

  for (const item of items) {
    const current = byRole[item.role] ?? { count: 0, serializedBytes: 0 };
    current.count += 1;
    current.serializedBytes += item.metric.serializedBytes;
    byRole[item.role] = current;
  }

  return {
    itemCount: items.length,
    metric: measureValue(messages),
    items,
    byRole,
  };
}

function profileTools(tools: unknown): unknown {
  const values = Array.isArray(tools) ? tools : [];
  return {
    itemCount: values.length,
    metric: measureValue(tools),
    items: values.map((tool, index) => {
      const value = record(tool) ?? {};
      const fn = record(value.function);
      return {
        index,
        kind: optionalLabel(value.type),
        name: optionalLabel(value.name ?? fn?.name),
        metric: measureValue(tool),
      };
    }),
  };
}

export function profileProviderPayload(payload: unknown): unknown {
  const value = record(payload);
  if (!value) return { metric: measureValue(payload), payloadKind: "non-object" };

  const knownKeys = new Set(["instructions", "system", "input", "messages", "tools"]);
  const other = Object.fromEntries(
    Object.entries(value).filter(([key]) => !knownKeys.has(key)),
  );

  return {
    metric: measureValue(payload),
    instructions: value.instructions === undefined ? undefined : measureValue(value.instructions),
    system: value.system === undefined ? undefined : measureValue(value.system),
    input: profileMessages(value.input),
    messages: profileMessages(value.messages),
    tools: profileTools(value.tools),
    otherKeyCount: Object.keys(other).length,
    other: measureValue(other),
  };
}

function pathIdentity(path: unknown): unknown {
  if (typeof path !== "string") return undefined;
  return {
    basename: basename(path),
    pathHash: hashIdentifier(path),
    pathUtf8Bytes: Buffer.byteLength(path, "utf8"),
  };
}

function namedTextMetrics(value: unknown): unknown[] {
  const entries = record(value);
  if (!entries) return [];
  return Object.entries(entries).map(([name, text]) => ({
    name: safeLabel(name),
    metric: typeof text === "string" ? measureText(text) : measureValue(text),
  }));
}

export function profileAgentStart(
  prompt: string,
  systemPrompt: string,
  systemPromptOptions: unknown,
): unknown {
  const options = record(systemPromptOptions) ?? {};
  const contextFiles = Array.isArray(options.contextFiles) ? options.contextFiles : [];
  const skills = Array.isArray(options.skills) ? options.skills : [];
  const guidelines = Array.isArray(options.promptGuidelines)
    ? options.promptGuidelines
    : [];

  return {
    prompt: measureText(prompt),
    systemPrompt: measureText(systemPrompt),
    options: {
      metric: measureValue(systemPromptOptions),
      customPrompt: typeof options.customPrompt === "string"
        ? measureText(options.customPrompt)
        : undefined,
      appendSystemPrompt: typeof options.appendSystemPrompt === "string"
        ? measureText(options.appendSystemPrompt)
        : undefined,
      selectedTools: Array.isArray(options.selectedTools)
        ? options.selectedTools.map((name) => safeLabel(name))
        : [],
      toolSnippets: namedTextMetrics(options.toolSnippets),
      promptGuidelines: guidelines.map((item, index) => ({
        index,
        metric: typeof item === "string" ? measureText(item) : measureValue(item),
      })),
      cwd: pathIdentity(options.cwd),
      contextFiles: contextFiles.map((item, index) => {
        const file = record(item) ?? {};
        return {
          index,
          path: pathIdentity(file.path),
          content: typeof file.content === "string"
            ? measureText(file.content)
            : measureValue(file.content),
        };
      }),
      skills: skills.map((item, index) => {
        const skill = record(item) ?? {};
        return {
          index,
          name: optionalLabel(skill.name),
          metric: measureValue(item),
        };
      }),
    },
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function profileAssistantUsage(message: unknown): unknown | undefined {
  const value = record(message);
  if (value?.role !== "assistant") return undefined;
  const usage = record(value.usage);
  if (!usage) return undefined;

  const input = finiteNumber(usage.input);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  return {
    input,
    output: finiteNumber(usage.output),
    cacheRead,
    cacheWrite,
    reasoning: finiteNumber(usage.reasoning),
    totalTokens: finiteNumber(usage.totalTokens),
    activeInputTokens: input + cacheRead + cacheWrite,
    stopReason: optionalLabel(value.stopReason),
    provider: optionalLabel(value.provider),
    model: optionalLabel(value.model),
  };
}

export function profileToolResult(event: unknown): unknown {
  const value = record(event) ?? {};
  return {
    toolCallIdHash: typeof value.toolCallId === "string"
      ? hashIdentifier(value.toolCallId)
      : undefined,
    toolName: safeLabel(value.toolName),
    isError: value.isError === true,
    input: measureValue(value.input),
    content: measureValue(value.content),
    contentParts: contentParts(value.content),
    details: measureValue(value.details),
  };
}
