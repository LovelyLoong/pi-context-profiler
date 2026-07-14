import { createHash } from "node:crypto";

export interface ValueMetric {
  serializedBytes: number;
  serializedChars: number;
  roughTokenEstimate: number;
  sha256: string;
}

export interface TextMetric {
  utf8Bytes: number;
  utf16Chars: number;
  codePoints: number;
  roughTokenEstimate: number;
  sha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return "[BigInt]";
      if (typeof item !== "object" || item === null) return item;
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
      return item;
    });
    return serialized ?? "[Undefined]";
  } catch {
    return "[Unserializable]";
  }
}

export function measureValue(value: unknown): ValueMetric {
  const serialized = safeSerialize(value);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  return {
    serializedBytes,
    serializedChars: serialized.length,
    roughTokenEstimate: Math.ceil(serializedBytes / 4),
    sha256: sha256(serialized),
  };
}

export function measureText(value: string): TextMetric {
  const utf8Bytes = Buffer.byteLength(value, "utf8");
  return {
    utf8Bytes,
    utf16Chars: value.length,
    codePoints: Array.from(value).length,
    roughTokenEstimate: Math.ceil(utf8Bytes / 4),
    sha256: sha256(value),
  };
}

export function hashIdentifier(value: string): string {
  return sha256(value);
}
