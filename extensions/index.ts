import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ContextProfilerRuntime } from "../src/runtime.ts";

export default function contextProfilerExtension(pi: ExtensionAPI): void {
  new ContextProfilerRuntime(pi).register();
}
