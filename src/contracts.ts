export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface Abortable {
  readonly signal?: AbortSignal;
}

export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface GenerationRequest extends Abortable {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDescriptor[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: JsonObject;
}

export interface GenerationResult {
  readonly message: Message;
  readonly toolCalls?: readonly ToolCall[];
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly model?: string;
  readonly raw?: unknown;
}

/** A generation request admitted by the kernel and authorized for its principal. */
export interface KernelGenerationRequest extends GenerationRequest {
  readonly principal: Principal;
}

export interface LlmAdapter {
  readonly id: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export interface EmbeddingAdapter {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[], options?: Abortable): Promise<readonly (readonly number[])[]>;
}

export interface MemoryRecord {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
  readonly embedding?: readonly number[];
  readonly metadata?: JsonObject;
  readonly createdAt: Date;
}

export interface MemoryQuery extends Abortable {
  readonly namespace: string;
  readonly text: string;
  readonly embedding?: readonly number[];
  readonly limit?: number;
  readonly filter?: JsonObject;
}

export interface MemoryMatch {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface MemoryAdapter {
  upsert(records: readonly MemoryRecord[]): Promise<void>;
  search(query: MemoryQuery): Promise<readonly MemoryMatch[]>;
  delete(ids: readonly string[], namespace: string): Promise<void>;
  close?(): Promise<void>;
}

export interface RagDocument {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly score: number;
  readonly metadata?: JsonObject;
}

export interface RagQuery extends Abortable {
  readonly query: string;
  readonly tenantId: string;
  readonly principal: Principal;
  readonly limit?: number;
  readonly filter?: JsonObject;
}

export interface RagAdapter {
  retrieve(query: RagQuery): Promise<readonly RagDocument[]>;
  close?(): Promise<void>;
}

export interface Principal {
  readonly id: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly claims?: JsonObject;
}

export interface AuthorizationRequest extends Abortable {
  readonly principal: Principal;
  readonly action: string;
  readonly resource: string;
  readonly context?: JsonObject;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly obligations?: JsonObject;
}

export interface AuthAdapter {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
  readonly additionalProperties?: boolean | JsonSchema;
  /** Vendor and draft-specific JSON Schema keywords. */
  readonly [keyword: string]: unknown;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolExecutionContext extends Abortable {
  readonly principal: Principal;
  readonly tenantId: string;
  readonly invocationId: string;
  readonly metadata?: JsonObject;
}

export interface ToolResult {
  readonly content: readonly {
    readonly type: "text" | "json";
    readonly value: string | JsonValue;
  }[];
  readonly isError?: boolean;
  readonly metadata?: JsonObject;
}

export interface ToolDefinition extends ToolDescriptor {
  execute(input: JsonObject, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface McpRemoteTool extends ToolDescriptor {}

export interface McpClient {
  connect(): Promise<void>;
  listTools(options?: Abortable): Promise<readonly McpRemoteTool[]>;
  callTool(name: string, input: JsonObject, options?: Abortable): Promise<ToolResult>;
  close(): Promise<void>;
}

interface McpServerConfigBase {
  readonly id: string;
  readonly toolPrefix?: string;
}

export type McpServerConfig =
  | (McpServerConfigBase & {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly url?: never;
      readonly headers?: never;
    })
  | (McpServerConfigBase & {
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly command?: never;
      readonly args?: never;
    });

export interface McpClientFactory {
  create(config: McpServerConfig): McpClient;
}

export interface ScheduledTaskContext extends Abortable {
  readonly scheduledAt: Date;
  readonly attempt: number;
}

export interface ScheduleDefinition {
  readonly id: string;
  readonly cron?: string;
  readonly runAt?: Date;
  readonly timezone?: string;
  readonly handler: (context: ScheduledTaskContext) => Promise<void>;
}

export interface ScheduleCreateRequest extends Abortable {
  readonly definition: ScheduleDefinition;
  readonly principal: Principal;
  readonly metadata?: JsonObject;
}

export interface ScheduleCancelRequest extends Abortable {
  readonly id: string;
  readonly principal: Principal;
  readonly metadata?: JsonObject;
}

export interface SchedulerAdapter {
  start(): Promise<void>;
  schedule(definition: ScheduleDefinition, options?: Abortable): Promise<void>;
  cancel(id: string, options?: Abortable): Promise<boolean>;
  close(): Promise<void>;
}

export interface ContextLookupRequest extends Abortable {
  readonly query: string;
  readonly namespace: string;
  readonly principal: Principal;
  readonly memoryLimit?: number;
  readonly ragLimit?: number;
  readonly filter?: JsonObject;
}

export interface ContextLookupResult {
  readonly memories: readonly MemoryMatch[];
  readonly documents: readonly RagDocument[];
}

export interface KernelServices {
  readonly llm?: LlmAdapter;
  readonly embeddings?: EmbeddingAdapter;
  readonly memory?: MemoryAdapter;
  readonly rag?: RagAdapter;
  readonly auth: AuthAdapter;
  readonly scheduler?: SchedulerAdapter;
}

export interface PluginContext {
  readonly services: KernelServices;
  registerTool(tool: ToolDefinition): () => void;
  getTool(name: string): ToolDefinition | undefined;
  emit<K extends keyof KernelEvents>(event: K, payload: KernelEvents[K]): void;
}

export interface KernelPlugin {
  readonly name: string;
  readonly dependencies?: readonly string[];
  setup?(context: PluginContext): Promise<void> | void;
  start?(context: PluginContext): Promise<void> | void;
  stop?(context: PluginContext): Promise<void> | void;
  rollback?(context: PluginContext, cause: unknown): Promise<void> | void;
}

export interface ToolExecutionRequest extends Abortable {
  readonly name: string;
  readonly input: JsonObject;
  readonly principal: Principal;
  readonly invocationId?: string;
  readonly metadata?: JsonObject;
}

export interface RedactedError {
  readonly name: string;
  readonly message: "[redacted]";
}

export interface KernelEvents {
  "kernel:booting": { readonly pluginOrder: readonly string[] };
  "kernel:ready": { readonly pluginOrder: readonly string[]; readonly tools: readonly string[] };
  "kernel:rollback": { readonly cause: RedactedError; readonly plugins: readonly string[] };
  "kernel:shutting-down": { readonly reason?: string };
  "kernel:stopped": { readonly errors: readonly RedactedError[] };
  "plugin:setup": { readonly name: string };
  "plugin:started": { readonly name: string };
  "plugin:stopped": { readonly name: string };
  "mcp:connected": { readonly serverId: string; readonly tools: readonly string[] };
  "context:retrieved": { readonly namespace: string; readonly memoryCount: number; readonly documentCount: number };
  "auth:decision": { readonly action: string; readonly resource: string; readonly principalId: string; readonly allowed: boolean };
  "tool:started": { readonly name: string; readonly invocationId: string };
  "tool:completed": { readonly name: string; readonly invocationId: string; readonly isError: boolean };
  "tool:failed": { readonly name: string; readonly invocationId: string; readonly error: RedactedError };
}

export type KernelEventName = keyof KernelEvents;
export type KernelEventListener<K extends KernelEventName> = (payload: KernelEvents[K]) => void;

export interface EventSubscription {
  unsubscribe(): void;
}
