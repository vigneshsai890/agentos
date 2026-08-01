import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type {
  AuthorizationRequest,
  ContextLookupRequest,
  ContextLookupResult,
  EventSubscription,
  GenerationRequest,
  GenerationResult,
  KernelEventListener,
  KernelEventName,
  KernelEvents,
  KernelGenerationRequest,
  KernelPlugin,
  KernelServices,
  McpClient,
  McpClientFactory,
  McpServerConfig,
  PluginContext,
  RedactedError,
  ScheduleCancelRequest,
  ScheduleCreateRequest,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionRequest,
  ToolResult,
} from "./contracts.js";

export type KernelState = "idle" | "booting" | "ready" | "rolling-back" | "stopping" | "stopped";

export interface CoreKernelOptions {
  readonly services: KernelServices;
  readonly plugins?: readonly KernelPlugin[];
  readonly mcpServers?: readonly McpServerConfig[];
  readonly mcpClientFactory?: McpClientFactory;
}

export class KernelStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelStateError";
  }
}

export class PluginGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginGraphError";
  }
}

export class AuthorizationError extends Error {
  readonly reason: string | undefined;

  constructor(message: string, reason?: string) {
    super(message);
    this.name = "AuthorizationError";
    this.reason = reason;
  }
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Tool not found: ${name}`);
    this.name = "ToolNotFoundError";
  }
}

class TypedEventBus {
  private readonly listeners = new Map<KernelEventName, Set<(payload: unknown) => void>>();

  on<K extends KernelEventName>(event: K, listener: KernelEventListener<K>): EventSubscription {
    const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener as (payload: unknown) => void);
    this.listeners.set(event, listeners);
    return { unsubscribe: () => listeners.delete(listener as (payload: unknown) => void) };
  }

  emit<K extends KernelEventName>(event: K, payload: KernelEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch {
        // Observers cannot compromise lifecycle or authorization state.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

interface ConnectedMcpServer {
  readonly config: McpServerConfig;
  readonly client: McpClient;
  readonly toolNames: readonly string[];
}

interface OperationLease {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  finish(): void;
}

const SAFE_MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_MCP_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.$/;
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "AuthorizationError",
  "KernelStateError",
  "PluginGraphError",
  "ToolNotFoundError",
]);

export function deriveTenantMemoryNamespace(tenantId: string, namespace: string): string {
  if (tenantId.length === 0) throw new TypeError("Principal tenantId must not be empty");
  if (namespace.length === 0) throw new TypeError("Memory namespace must not be empty");
  return `tenant/${encodeURIComponent(tenantId)}/namespace/${encodeURIComponent(namespace)}`;
}

function redactError(error: unknown): RedactedError {
  let candidate = "Error";
  try {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const value = Reflect.get(error, "name");
      if (typeof value === "string" && SAFE_ERROR_NAMES.has(value)) candidate = value;
    }
  } catch {
    candidate = "Error";
  }
  return { name: candidate, message: "[redacted]" };
}

function assertSafeMcpValue(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new KernelStateError(`Invalid MCP ${label}`);
}

export class CoreKernel {
  private readonly services: KernelServices;
  private readonly plugins: readonly KernelPlugin[];
  private readonly mcpServers: readonly McpServerConfig[];
  private readonly mcpClientFactory: McpClientFactory | undefined;
  private readonly events = new TypedEventBus();
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly initializedPlugins: KernelPlugin[] = [];
  private readonly startedPlugins: KernelPlugin[] = [];
  private readonly connectedMcp: ConnectedMcpServer[] = [];
  private readonly inFlight = new Set<OperationLease>();
  private readonly operationContext = new AsyncLocalStorage<OperationLease>();
  private pluginOrder: readonly KernelPlugin[] = [];
  private currentState: KernelState = "idle";
  private shutdownRequested = false;
  private bootPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<readonly unknown[]> | undefined;

  constructor(options: CoreKernelOptions) {
    this.services = options.services;
    this.plugins = options.plugins ?? [];
    this.mcpServers = options.mcpServers ?? [];
    this.mcpClientFactory = options.mcpClientFactory;
  }

  get state(): KernelState {
    return this.currentState;
  }

  on<K extends KernelEventName>(event: K, listener: KernelEventListener<K>): EventSubscription {
    return this.events.on(event, listener);
  }

  listTools(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  getTool(name: string): ToolDescriptor | undefined {
    const tool = this.tools.get(name);
    if (tool === undefined) return undefined;
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }

  registerTool(tool: ToolDefinition): () => void {
    this.assertMutableRegistry();
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return () => {
      this.assertMutableRegistry();
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  boot(): Promise<void> {
    if (this.currentState === "ready" && !this.shutdownRequested) return Promise.resolve();
    if (this.currentState === "booting" && this.bootPromise !== undefined) return this.bootPromise;
    if (this.currentState !== "idle" || this.shutdownRequested) {
      return Promise.reject(new KernelStateError(`Cannot boot kernel from state ${this.currentState}`));
    }
    this.bootPromise = this.performBoot();
    return this.bootPromise;
  }

  lookupContext(request: ContextLookupRequest): Promise<ContextLookupResult> {
    return this.runOperation(request.signal, async (signal) => {
      const namespace = deriveTenantMemoryNamespace(request.principal.tenantId, request.namespace);
      await this.authorize({
        principal: request.principal,
        action: "context.retrieve",
        resource: `context:${namespace}`,
        signal,
      }, "Not authorized to retrieve context");
      signal.throwIfAborted();

      const memoryQuery = this.services.memory === undefined
        ? Promise.resolve([])
        : this.services.memory.search({
            namespace,
            text: request.query,
            ...(request.memoryLimit === undefined ? {} : { limit: request.memoryLimit }),
            ...(request.filter === undefined ? {} : { filter: request.filter }),
            signal,
          });
      const ragQuery = this.services.rag === undefined
        ? Promise.resolve([])
        : this.services.rag.retrieve({
            query: request.query,
            tenantId: request.principal.tenantId,
            principal: request.principal,
            ...(request.ragLimit === undefined ? {} : { limit: request.ragLimit }),
            ...(request.filter === undefined ? {} : { filter: request.filter }),
            signal,
          });

      const [memories, documents] = await Promise.all([memoryQuery, ragQuery]);
      this.events.emit("context:retrieved", {
        namespace,
        memoryCount: memories.length,
        documentCount: documents.length,
      });
      return { memories, documents };
    });
  }

  executeTool(request: ToolExecutionRequest): Promise<ToolResult> {
    return this.runOperation(request.signal, async (signal) => {
      const tool = this.tools.get(request.name);
      if (tool === undefined) throw new ToolNotFoundError(request.name);

      await this.authorize({
        principal: request.principal,
        action: "tool.execute",
        resource: `tool:${request.name}`,
        ...(request.metadata === undefined ? {} : { context: request.metadata }),
        signal,
      }, `Not authorized to execute tool ${request.name}`);
      signal.throwIfAborted();

      const invocationId = request.invocationId ?? randomUUID();
      this.events.emit("tool:started", { name: request.name, invocationId });
      try {
        const result = await tool.execute(request.input, {
          principal: request.principal,
          tenantId: request.principal.tenantId,
          invocationId,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
          signal,
        });
        this.events.emit("tool:completed", {
          name: request.name,
          invocationId,
          isError: result.isError ?? false,
        });
        return result;
      } catch (error) {
        this.events.emit("tool:failed", { name: request.name, invocationId, error: redactError(error) });
        throw error;
      }
    });
  }

  generate(request: KernelGenerationRequest): Promise<GenerationResult> {
    return this.runOperation(request.signal, async (signal) => {
      if (this.services.llm === undefined) throw new KernelStateError("No LLM adapter configured");
      await this.authorize({
        principal: request.principal,
        action: "llm.generate",
        resource: `llm:${this.services.llm.id}`,
        ...(request.metadata === undefined ? {} : { context: request.metadata }),
        signal,
      }, "Not authorized to generate a model response");
      signal.throwIfAborted();
      const { principal: _principal, signal: _requestSignal, ...generationRequest } = request;
      const adapterRequest: GenerationRequest = { ...generationRequest, signal };
      return this.services.llm.generate(adapterRequest);
    });
  }

  schedule(request: ScheduleCreateRequest): Promise<void> {
    return this.runOperation(request.signal, async (signal) => {
      if (this.services.scheduler === undefined) throw new KernelStateError("No scheduler adapter configured");
      await this.authorize({
        principal: request.principal,
        action: "schedule.create",
        resource: `schedule:${request.definition.id}`,
        ...(request.metadata === undefined ? {} : { context: request.metadata }),
        signal,
      }, `Not authorized to create schedule ${request.definition.id}`);
      signal.throwIfAborted();
      await this.services.scheduler.schedule(request.definition, { signal });
    });
  }

  cancelSchedule(request: ScheduleCancelRequest): Promise<boolean> {
    return this.runOperation(request.signal, async (signal) => {
      if (this.services.scheduler === undefined) throw new KernelStateError("No scheduler adapter configured");
      await this.authorize({
        principal: request.principal,
        action: "schedule.cancel",
        resource: `schedule:${request.id}`,
        ...(request.metadata === undefined ? {} : { context: request.metadata }),
        signal,
      }, `Not authorized to cancel schedule ${request.id}`);
      signal.throwIfAborted();
      return this.services.scheduler.cancel(request.id, { signal });
    });
  }

  shutdown(reason?: string): Promise<readonly unknown[]> {
    if (this.operationContext.getStore() !== undefined) {
      throw new KernelStateError("Cannot initiate shutdown from an in-flight kernel operation");
    }
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownRequested = true;
    if (this.currentState === "idle" || this.currentState === "ready") this.currentState = "stopping";
    for (const operation of this.inFlight) operation.controller.abort();
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  private async performBoot(): Promise<void> {
    this.currentState = "booting";
    try {
      this.pluginOrder = topologicalSort(this.plugins);
      this.validateMcpConfiguration();
      const names = this.pluginOrder.map(({ name }) => name);
      this.events.emit("kernel:booting", { pluginOrder: names });
      const context = this.createPluginContext();

      for (const plugin of this.pluginOrder) {
        try {
          await plugin.setup?.(context);
        } catch (error) {
          await this.cleanupPartiallySetupPlugin(plugin, context, error);
          throw error;
        }
        this.initializedPlugins.push(plugin);
        this.assertBootContinues();
        this.events.emit("plugin:setup", { name: plugin.name });
      }

      await this.loadMcpTools();
      this.assertBootContinues();
      await this.services.scheduler?.start();
      this.assertBootContinues();

      for (const plugin of this.pluginOrder) {
        await plugin.start?.(context);
        this.assertBootContinues();
        this.startedPlugins.push(plugin);
        this.events.emit("plugin:started", { name: plugin.name });
      }

      this.currentState = "ready";
      this.events.emit("kernel:ready", { pluginOrder: names, tools: [...this.tools.keys()] });
    } catch (error) {
      await this.rollback(error);
      throw error;
    }
  }

  private async cleanupPartiallySetupPlugin(
    plugin: KernelPlugin,
    context: PluginContext,
    cause: unknown,
  ): Promise<void> {
    try {
      if (plugin.rollback !== undefined) await plugin.rollback(context, cause);
      else await plugin.stop?.(context);
    } catch {
      // Preserve the setup error; the registry and infrastructure are cleared by rollback.
    }
  }

  private assertBootContinues(): void {
    if (this.shutdownRequested) throw new KernelStateError("Kernel boot interrupted by shutdown");
  }

  private validateMcpConfiguration(): void {
    const ids = new Set<string>();
    for (const config of this.mcpServers) {
      assertSafeMcpValue(config.id, SAFE_MCP_SERVER_ID, "server id");
      if (ids.has(config.id)) throw new KernelStateError(`Duplicate MCP server id: ${config.id}`);
      ids.add(config.id);
      if (config.toolPrefix !== undefined) {
        assertSafeMcpValue(config.toolPrefix, SAFE_MCP_PREFIX, "tool prefix");
      }
      if (config.transport === "stdio") {
        if (config.command.trim().length === 0 || /[\u0000-\u001F\u007F]/u.test(config.command)) {
          throw new KernelStateError("Invalid MCP stdio command");
        }
      } else {
        let endpoint: URL;
        try {
          endpoint = new URL(config.url);
        } catch {
          throw new KernelStateError("Invalid MCP HTTP URL");
        }
        if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
          throw new KernelStateError("MCP HTTP URL must use credential-free HTTPS");
        }
      }
    }
  }

  private async loadMcpTools(): Promise<void> {
    if (this.mcpServers.length > 0 && this.mcpClientFactory === undefined) {
      throw new KernelStateError("MCP servers configured without an MCP client factory");
    }
    for (const config of this.mcpServers) {
      const client = this.mcpClientFactory!.create(config);
      const registered: string[] = [];
      try {
        await client.connect();
        const remoteTools = await client.listTools();
        for (const remote of remoteTools) {
          assertSafeMcpValue(remote.name, SAFE_MCP_TOOL_NAME, "remote tool name");
        }
        for (const remote of remoteTools) {
          const name = `${config.toolPrefix ?? `${config.id}.`}${remote.name}`;
          this.registerTool({
            name,
            description: remote.description,
            inputSchema: remote.inputSchema,
            execute: (input, context) => client.callTool(remote.name, input, {
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            }),
          });
          registered.push(name);
        }
      } catch (error) {
        for (const name of registered) this.tools.delete(name);
        await client.close().catch(() => undefined);
        throw error;
      }
      this.connectedMcp.push({ config, client, toolNames: registered });
      this.events.emit("mcp:connected", { serverId: config.id, tools: registered });
    }
  }

  private async rollback(cause: unknown): Promise<void> {
    this.currentState = "rolling-back";
    const context = this.createPluginContext();
    const rolledBack: string[] = [];
    for (const plugin of [...this.initializedPlugins].reverse()) {
      try {
        if (plugin.rollback !== undefined) await plugin.rollback(context, cause);
        else await plugin.stop?.(context);
      } catch {
        // Preserve the original boot error; teardown remains best-effort.
      }
      rolledBack.push(plugin.name);
    }
    await this.closeInfrastructure([]);
    this.tools.clear();
    this.initializedPlugins.length = 0;
    this.startedPlugins.length = 0;
    this.currentState = "stopped";
    this.events.emit("kernel:rollback", { cause: redactError(cause), plugins: rolledBack });
  }

  private async performShutdown(reason?: string): Promise<readonly unknown[]> {
    if (this.currentState === "stopped") return [];
    if (this.currentState === "booting" || this.currentState === "rolling-back") {
      try {
        await this.bootPromise;
      } catch {
        return [];
      }
    }
    this.currentState = "stopping";
    this.events.emit("kernel:shutting-down", reason === undefined ? {} : { reason });
    await this.drainOperations();
    const errors: unknown[] = [];
    const context = this.createPluginContext();

    for (const plugin of [...this.startedPlugins].reverse()) {
      try {
        await plugin.stop?.(context);
        this.events.emit("plugin:stopped", { name: plugin.name });
      } catch (error) {
        errors.push(error);
      }
    }
    await this.closeInfrastructure(errors);
    this.tools.clear();
    this.startedPlugins.length = 0;
    this.initializedPlugins.length = 0;
    this.currentState = "stopped";
    this.events.emit("kernel:stopped", { errors: errors.map(redactError) });
    return errors;
  }

  private async drainOperations(): Promise<void> {
    await Promise.all([...this.inFlight].map(({ done }) => done));
  }

  private async closeInfrastructure(errors: unknown[]): Promise<void> {
    for (const server of [...this.connectedMcp].reverse()) {
      for (const name of server.toolNames) this.tools.delete(name);
      try {
        await server.client.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.connectedMcp.length = 0;
    const closers: Array<(() => Promise<void>) | undefined> = [
      this.services.scheduler === undefined ? undefined : () => this.services.scheduler!.close(),
      this.services.rag?.close === undefined ? undefined : () => this.services.rag!.close!(),
      this.services.memory?.close === undefined ? undefined : () => this.services.memory!.close!(),
    ];
    for (const close of closers) {
      if (close === undefined) continue;
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  private runOperation<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = this.admitOperation(callerSignal);
    let result: Promise<T>;
    try {
      result = this.operationContext.run(lease, () => operation(lease.signal));
    } catch (error) {
      lease.finish();
      return Promise.reject(error);
    }
    return result.finally(() => lease.finish());
  }

  private admitOperation(callerSignal: AbortSignal | undefined): OperationLease {
    this.assertReady();
    const controller = new AbortController();
    const signal = callerSignal === undefined
      ? controller.signal
      : AbortSignal.any([callerSignal, controller.signal]);
    let finished = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const lease: OperationLease = {
      controller,
      signal,
      done,
      finish: () => {
        if (finished) return;
        finished = true;
        this.inFlight.delete(lease);
        resolveDone();
      },
    };
    this.inFlight.add(lease);
    return lease;
  }

  private async authorize(request: AuthorizationRequest, denialMessage: string): Promise<void> {
    const decision = await this.services.auth.authorize(request);
    this.events.emit("auth:decision", {
      action: request.action,
      resource: request.resource,
      principalId: request.principal.id,
      allowed: decision.allowed,
    });
    if (!decision.allowed) throw new AuthorizationError(denialMessage, decision.reason);
  }

  private createPluginContext(): PluginContext {
    return {
      services: this.services,
      registerTool: (tool) => this.registerTool(tool),
      getTool: (name) => this.tools.get(name),
      emit: (event, payload) => this.events.emit(event, payload),
    };
  }

  private assertReady(): void {
    if (this.currentState !== "ready" || this.shutdownRequested) {
      throw new KernelStateError(`Kernel is not accepting work (state: ${this.currentState})`);
    }
  }

  private assertMutableRegistry(): void {
    if (this.currentState !== "idle" && this.currentState !== "booting") {
      throw new KernelStateError(`Tool registry is immutable in state ${this.currentState}`);
    }
  }
}

export function topologicalSort(plugins: readonly KernelPlugin[]): readonly KernelPlugin[] {
  const byName = new Map<string, KernelPlugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) throw new PluginGraphError(`Duplicate plugin: ${plugin.name}`);
    byName.set(plugin.name, plugin);
  }

  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const ordered: KernelPlugin[] = [];
  const visit = (plugin: KernelPlugin, path: readonly string[]): void => {
    if (permanent.has(plugin.name)) return;
    if (temporary.has(plugin.name)) {
      throw new PluginGraphError(`Plugin dependency cycle: ${[...path, plugin.name].join(" -> ")}`);
    }
    temporary.add(plugin.name);
    for (const dependencyName of plugin.dependencies ?? []) {
      const dependency = byName.get(dependencyName);
      if (dependency === undefined) {
        throw new PluginGraphError(`Plugin ${plugin.name} requires missing dependency ${dependencyName}`);
      }
      visit(dependency, [...path, plugin.name]);
    }
    temporary.delete(plugin.name);
    permanent.add(plugin.name);
    ordered.push(plugin);
  };

  for (const plugin of plugins) visit(plugin, []);
  return ordered;
}
