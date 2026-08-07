// Real pi-backed session backend (spec ADR-6): wraps createAgentSession with
// per-conversation cwd and model binding. Lazy-imports the pi SDK so this
// module can be loaded without it (tests use the fake backend instead).

import { join } from "node:path";
import type { PiSessionHandle, SessionBackend, SessionListItem } from "./conversation-manager.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

export class PiSessionBackend implements SessionBackend {
  private sdk: PiSdk | undefined;
  private modelRuntime: unknown;

  private async ensureSdk(): Promise<PiSdk> {
    if (this.sdk) return this.sdk;
    const sdk = await import("@earendil-works/pi-coding-agent");
    this.sdk = sdk;
    const agentDir = sdk.getAgentDir();
    this.modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    return sdk;
  }

  async createSession(opts: { cwd: string; modelId?: string; sessionFile?: string }): Promise<PiSessionHandle> {
    const sdk = await this.ensureSdk();
    const agentDir = sdk.getAgentDir();
    const sessionManager = opts.sessionFile
      ? sdk.SessionManager.open(opts.sessionFile, undefined, opts.cwd)
      : sdk.SessionManager.create(opts.cwd);
    const loader = new sdk.DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir,
      systemPromptOverride: (base: string | undefined) => {
        const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
        return base?.trim() ? `${base}\n\n${extra}` : extra;
      },
    });
    await loader.reload();
    const { session } = await sdk.createAgentSession({
      cwd: opts.cwd,
      agentDir,
      modelRuntime: this.modelRuntime as never,
      model: await this.resolveModel(sdk, opts.modelId),
      resourceLoader: loader,
      sessionManager,
    });
    const handle: PiSessionHandle = {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
      async prompt(text, images) {
        await session.prompt(text, images?.length ? { images } : undefined);
      },
      subscribe(fn) {
        return session.subscribe(fn);
      },
      getLastAssistantText() {
        const messages = [...session.messages].reverse() as unknown as Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
        for (const msg of messages) {
          if (msg.role !== "assistant") continue;
          const content = msg.content;
          if (typeof content === "string") return content.trim();
          if (Array.isArray(content)) {
            return content
              .map((p) => (p && p.type === "text" ? p.text ?? "" : ""))
              .join("")
              .trim();
          }
        }
        return "";
      },
      getModelLabel() {
        return session.model?.id ?? "default";
      },
      async dispose() {
        try { session.dispose(); } catch { /* ignore */ }
      },
    };
    return handle;
  }

  async listSessions(cwd?: string): Promise<SessionListItem[]> {
    const sdk = await this.ensureSdk();
    const list = cwd ? await sdk.SessionManager.list(cwd) : await sdk.SessionManager.listAll();
    return list.map((s: { path: string; name?: string; firstMessage?: string; messageCount?: number; modified?: unknown; cwd?: string }) => ({
      path: s.path,
      name: s.name,
      firstMessage: s.firstMessage,
      messageCount: s.messageCount ?? 0,
      modified: (s.modified as Date | string) ?? new Date(0),
      cwd: s.cwd,
    }));
  }

  private async resolveModel(sdk: PiSdk, modelId: string | undefined) {
    const registry = new sdk.ModelRegistry(this.modelRuntime as never);
    await registry.refresh().catch(() => undefined);
    if (modelId) {
      const found = registry.find("configured", modelId) ?? registry.find("*", modelId) ?? registry.getAll().find((m) => m.id === modelId);
      if (found && registry.hasConfiguredAuth(found)) return found;
    }
    return undefined; // default: settings.json model
  }
}
