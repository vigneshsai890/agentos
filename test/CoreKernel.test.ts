import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizationError,
  CoreKernel,
  KernelStateError,
  PluginGraphError,
  deriveTenantMemoryNamespace,
  topologicalSort,
} from "../src/CoreKernel.js";
import type {
  AuthAdapter,
  AuthorizationDecision,
  AuthorizationRequest,
  KernelPlugin,
  McpClient,
  McpServerConfig,
  MemoryRecord,
  Principal,
  RedactedError,
  ToolResult,
} from "../src/contracts.js";

const principal: Principal = {
  id: "user-1",
  tenantId: "tenant-1",
  roles: ["operator"],
};

const allow: AuthAdapter = {
  authorize: async () => ({ allowed: true }),
};

const success: ToolResult = {
  content: [{ type: "text", value: "ok" }],
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("topologicalSort orders dependencies and rejects cycles", () => {
  const plugins: KernelPlugin[] = [
    { name: "api", dependencies: ["tools"] },
    { name: "tools", dependencies: ["storage"] },
    { name: "storage" },
  ];
  assert.deepEqual(topologicalSort(plugins).map(({ name }) => name), ["storage", "tools", "api"]);
  assert.throws(
    () => topologicalSort([{ name: "a", dependencies: ["b"] }, { name: "b", dependencies: ["a"] }]),
    PluginGraphError,
  );
});

test("boot follows DAG order and shutdown reverses it", async () => {
  const calls: string[] = [];
  const plugin = (name: string, dependencies: readonly string[] = []): KernelPlugin => ({
    name,
    dependencies,
    setup: () => { calls.push(`setup:${name}`); },
    start: () => { calls.push(`start:${name}`); },
    stop: () => { calls.push(`stop:${name}`); },
  });
  const kernel = new CoreKernel({
    services: { auth: allow },
    plugins: [plugin("child", ["base"]), plugin("base")],
  });

  await kernel.boot();
  await kernel.shutdown("test");

  assert.deepEqual(calls, [
    "setup:base", "setup:child", "start:base", "start:child", "stop:child", "stop:base",
  ]);
  assert.equal(kernel.state, "stopped");
});

test("failed boot rolls initialized plugins back in reverse order", async () => {
  const calls: string[] = [];
  const kernel = new CoreKernel({
    services: { auth: allow },
    plugins: [
      { name: "one", setup: () => { calls.push("setup:one"); }, rollback: () => { calls.push("rollback:one"); } },
      { name: "two", setup: () => { throw new Error("boom"); } },
    ],
  });

  await assert.rejects(kernel.boot(), /boom/);
  assert.deepEqual(calls, ["setup:one", "rollback:one"]);
  assert.equal(kernel.state, "stopped");
});

test("native MCP tools are namespaced, authorized, and closed", async () => {
  const calls: string[] = [];
  const client: McpClient = {
    connect: async () => { calls.push("connect"); },
    listTools: async () => [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    callTool: async (name) => { calls.push(`call:${name}`); return success; },
    close: async () => { calls.push("close"); },
  };
  const kernel = new CoreKernel({
    services: { auth: allow },
    mcpServers: [{ id: "local", transport: "stdio", command: "server" }],
    mcpClientFactory: { create: () => client },
  });

  await kernel.boot();
  assert.deepEqual(kernel.listTools().map(({ name }) => name), ["local.echo"]);
  assert.deepEqual(await kernel.executeTool({ name: "local.echo", input: {}, principal }), success);
  await kernel.shutdown();
  assert.deepEqual(calls, ["connect", "call:echo", "close"]);
});

test("authorization is fail-closed before tool execution", async () => {
  let executed = false;
  const kernel = new CoreKernel({
    services: { auth: { authorize: async () => ({ allowed: false, reason: "policy" }) } },
    plugins: [{
      name: "tools",
      setup: (context) => {
        context.registerTool({
          name: "dangerous",
          description: "test",
          inputSchema: { type: "object" },
          execute: async () => { executed = true; return success; },
        });
      },
    }],
  });

  await kernel.boot();
  await assert.rejects(
    kernel.executeTool({ name: "dangerous", input: {}, principal }),
    AuthorizationError,
  );
  assert.equal(executed, false);
  await kernel.shutdown();
});

test("memory and RAG lookups execute concurrently in a tenant-bound namespace", async () => {
  const record: MemoryRecord = {
    id: "m1",
    namespace: "conversation",
    text: "remembered",
    createdAt: new Date(0),
  };
  let searchedNamespace: string | undefined;
  const kernel = new CoreKernel({
    services: {
      auth: allow,
      memory: {
        upsert: async () => undefined,
        delete: async () => undefined,
        search: async (query) => {
          searchedNamespace = query.namespace;
          return [{ record, score: 0.9 }];
        },
      },
      rag: {
        retrieve: async () => [{ id: "d1", text: "document", source: "kb", score: 0.8 }],
      },
    },
  });
  await kernel.boot();

  const context = await kernel.lookupContext({
    query: "question",
    namespace: "conversation/shared",
    principal,
  });
  assert.equal(
    searchedNamespace,
    deriveTenantMemoryNamespace(principal.tenantId, "conversation/shared"),
  );
  assert.equal(context.memories[0]?.record.id, "m1");
  assert.equal(context.documents[0]?.id, "d1");
  await kernel.shutdown();
});


test("boot after shutdown rejects instead of returning the stale successful boot", async () => {
  const kernel = new CoreKernel({ services: { auth: allow } });
  await kernel.boot();
  await kernel.shutdown();

  await assert.rejects(kernel.boot(), KernelStateError);
  assert.equal(kernel.state, "stopped");
});

test("a plugin whose setup partially fails is cleaned up", async () => {
  const calls: string[] = [];
  const setupFailure = new Error("setup failed");
  const kernel = new CoreKernel({
    services: { auth: allow },
    plugins: [{
      name: "partial",
      setup: (context) => {
        calls.push("setup");
        context.registerTool({
          name: "partial.tool",
          description: "partially registered",
          inputSchema: { type: "object" },
          execute: async () => success,
        });
        throw setupFailure;
      },
      rollback: (context, cause) => {
        calls.push("rollback");
        assert.equal(cause, setupFailure);
        assert.notEqual(context.getTool("partial.tool"), undefined);
      },
    }],
  });

  await assert.rejects(kernel.boot(), /setup failed/);
  assert.deepEqual(calls, ["setup", "rollback"]);
  assert.deepEqual(kernel.listTools(), []);
  assert.equal(kernel.state, "stopped");
});

test("an unregister handle cannot mutate the ready registry", async () => {
  let unregister: (() => void) | undefined;
  const kernel = new CoreKernel({
    services: { auth: allow },
    plugins: [{
      name: "tool",
      setup: (context) => {
        unregister = context.registerTool({
          name: "stable",
          description: "stable",
          inputSchema: { type: "object" },
          execute: async () => success,
        });
      },
    }],
  });
  await kernel.boot();

  assert.throws(() => unregister?.(), KernelStateError);
  assert.notEqual(kernel.getTool("stable"), undefined);
  await kernel.shutdown();
});

test("context, generation, and schedule changes are fail-closed by authorization", async () => {
  const requests: AuthorizationRequest[] = [];
  let memorySearches = 0;
  let generations = 0;
  let schedules = 0;
  let cancellations = 0;
  const kernel = new CoreKernel({
    services: {
      auth: {
        authorize: async (request) => {
          requests.push(request);
          return { allowed: false, reason: "denied" };
        },
      },
      memory: {
        upsert: async () => undefined,
        delete: async () => undefined,
        search: async () => { memorySearches += 1; return []; },
      },
      llm: {
        id: "test-model",
        generate: async () => {
          generations += 1;
          return { message: { role: "assistant", content: "generated" } };
        },
      },
      scheduler: {
        start: async () => undefined,
        schedule: async () => { schedules += 1; },
        cancel: async () => { cancellations += 1; return true; },
        close: async () => undefined,
      },
    },
  });
  await kernel.boot();

  await assert.rejects(
    kernel.lookupContext({ query: "q", namespace: "n", principal }),
    AuthorizationError,
  );
  await assert.rejects(
    kernel.generate({ messages: [{ role: "user", content: "hello" }], principal }),
    AuthorizationError,
  );
  await assert.rejects(
    kernel.schedule({
      definition: { id: "nightly", runAt: new Date(0), handler: async () => undefined },
      principal,
    }),
    AuthorizationError,
  );
  await assert.rejects(
    kernel.cancelSchedule({ id: "nightly", principal }),
    AuthorizationError,
  );

  assert.deepEqual(requests.map(({ action }) => action), [
    "context.retrieve",
    "llm.generate",
    "schedule.create",
    "schedule.cancel",
  ]);
  assert.deepEqual(requests.map(({ resource }) => resource), [
    `context:${deriveTenantMemoryNamespace(principal.tenantId, "n")}`,
    "llm:test-model",
    "schedule:nightly",
    "schedule:nightly",
  ]);
  assert.equal(requests.every(({ signal }) => signal instanceof AbortSignal), true);
  assert.deepEqual([memorySearches, generations, schedules, cancellations], [0, 0, 0, 0]);
  await kernel.shutdown();
});

test("shutdown synchronously closes admission, aborts delayed auth, and drains before teardown", async () => {
  const authDecision = deferred<AuthorizationDecision>();
  let authorizationRequest: AuthorizationRequest | undefined;
  let executed = false;
  let pluginStopped = false;
  let memoryClosed = false;
  const kernel = new CoreKernel({
    services: {
      auth: {
        authorize: (request) => {
          authorizationRequest = request;
          return authDecision.promise;
        },
      },
      memory: {
        upsert: async () => undefined,
        delete: async () => undefined,
        search: async () => [],
        close: async () => { memoryClosed = true; },
      },
    },
    plugins: [{
      name: "delayed",
      setup: (context) => {
        context.registerTool({
          name: "delayed",
          description: "delayed auth",
          inputSchema: { type: "object" },
          execute: async () => { executed = true; return success; },
        });
      },
      stop: () => { pluginStopped = true; },
    }],
  });
  await kernel.boot();

  const operation = kernel.executeTool({ name: "delayed", input: {}, principal });
  const operationRejected = assert.rejects(
    operation,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.notEqual(authorizationRequest, undefined);

  const shutdown = kernel.shutdown("race");
  assert.equal(kernel.state, "stopping");
  assert.equal(shutdown, kernel.shutdown("duplicate"));
  assert.equal(authorizationRequest?.signal?.aborted, true);
  assert.throws(
    () => kernel.executeTool({ name: "delayed", input: {}, principal }),
    KernelStateError,
  );
  await Promise.resolve();
  assert.equal(pluginStopped, false);
  assert.equal(memoryClosed, false);

  authDecision.resolve({ allowed: true });
  await operationRejected;
  await shutdown;
  assert.equal(executed, false);
  assert.equal(pluginStopped, true);
  assert.equal(memoryClosed, true);
  assert.equal(kernel.state, "stopped");
});

test("unsafe MCP server ids and prefixes and duplicate server ids fail before side effects", async () => {
  const configurations: readonly (readonly McpServerConfig[])[] = [
    [{ id: "", transport: "stdio" as const, command: "server" }],
    [{ id: "bad\nid", transport: "stdio" as const, command: "server" }],
    [{ id: "../server", transport: "stdio" as const, command: "server" }],
    [{ id: "safe", transport: "stdio" as const, command: "server", toolPrefix: "" }],
    [{ id: "safe", transport: "stdio" as const, command: "server", toolPrefix: "bad\nprefix." }],
    [{ id: "safe", transport: "stdio" as const, command: "server", toolPrefix: "unsafe/" }],
    [
      { id: "duplicate", transport: "stdio" as const, command: "server" },
      { id: "duplicate", transport: "http" as const, url: "https://example.test/mcp" },
    ],
  ];

  for (const mcpServers of configurations) {
    let factoryCalls = 0;
    const kernel = new CoreKernel({
      services: { auth: allow },
      mcpServers,
      mcpClientFactory: {
        create: () => {
          factoryCalls += 1;
          throw new Error("factory must not run");
        },
      },
    });
    await assert.rejects(kernel.boot(), KernelStateError);
    assert.equal(factoryCalls, 0);
    assert.equal(kernel.state, "stopped");
  }
});

test("empty, control, and unsafe MCP remote tool names are rejected and closed", async () => {
  for (const remoteName of ["", "bad\nname", "../escape", "tool/name"]) {
    let closes = 0;
    const client: McpClient = {
      connect: async () => undefined,
      listTools: async () => [{
        name: remoteName,
        description: "invalid",
        inputSchema: { type: "object" },
      }],
      callTool: async () => success,
      close: async () => { closes += 1; },
    };
    const kernel = new CoreKernel({
      services: { auth: allow },
      mcpServers: [{ id: "safe", transport: "stdio", command: "server" }],
      mcpClientFactory: { create: () => client },
    });

    await assert.rejects(kernel.boot(), KernelStateError);
    assert.equal(closes, 1);
    assert.deepEqual(kernel.listTools(), []);
  }
});

test("errors emitted by tool, rollback, and stopped events are redacted", async () => {
  let toolError: RedactedError | undefined;
  let stoppedErrors: readonly RedactedError[] = [];
  const kernel = new CoreKernel({
    services: { auth: allow },
    plugins: [{
      name: "errors",
      setup: (context) => {
        context.registerTool({
          name: "fails",
          description: "fails",
          inputSchema: { type: "object" },
          execute: async () => { throw new Error("tool-secret-token"); },
        });
      },
      stop: () => { throw new Error("stop-secret-token"); },
    }],
  });
  kernel.on("tool:failed", ({ error }) => { toolError = error; });
  kernel.on("kernel:stopped", ({ errors }) => { stoppedErrors = errors; });
  await kernel.boot();
  await assert.rejects(
    kernel.executeTool({ name: "fails", input: {}, principal, invocationId: "fixed" }),
    /tool-secret-token/,
  );
  const shutdownErrors = await kernel.shutdown();

  assert.deepEqual(toolError, { name: "Error", message: "[redacted]" });
  assert.deepEqual(stoppedErrors, [{ name: "Error", message: "[redacted]" }]);
  assert.equal(JSON.stringify({ toolError, stoppedErrors }).includes("secret-token"), false);
  assert.match(String(shutdownErrors[0]), /stop-secret-token/);

  let rollbackCause: RedactedError | undefined;
  const failedKernel = new CoreKernel({
    services: { auth: allow },
    plugins: [{ name: "boot-error", setup: () => { throw new Error("boot-secret-token"); } }],
  });
  failedKernel.on("kernel:rollback", ({ cause }) => { rollbackCause = cause; });
  await assert.rejects(failedKernel.boot(), /boot-secret-token/);
  assert.deepEqual(rollbackCause, { name: "Error", message: "[redacted]" });
  assert.equal(JSON.stringify(rollbackCause).includes("secret-token"), false);
});


test("public tool discovery exposes descriptors without executable capabilities", async () => {
  const kernel = new CoreKernel({ services: { auth: allow } });
  kernel.registerTool({
    name: "safe",
    description: "safe descriptor",
    inputSchema: { type: "object" },
    execute: async () => success,
  });
  await kernel.boot();

  const listed = kernel.listTools()[0] as unknown as Record<string, unknown>;
  const fetched = kernel.getTool("safe") as unknown as Record<string, unknown>;
  assert.equal("execute" in listed, false);
  assert.equal("execute" in fetched, false);
  await kernel.shutdown();
});

test("error redaction is total for hostile thrown values", async () => {
  const hostile = Object.create(null, {
    name: { get: () => { throw new Error("name-secret"); } },
  });
  let emitted: RedactedError | undefined;
  const kernel = new CoreKernel({ services: { auth: allow } });
  kernel.registerTool({
    name: "hostile",
    description: "throws a hostile object",
    inputSchema: { type: "object" },
    execute: async () => { throw hostile; },
  });
  kernel.on("tool:failed", ({ error }) => { emitted = error; });
  await kernel.boot();
  try {
    await kernel.executeTool({ name: "hostile", input: {}, principal });
    assert.fail("tool should reject");
  } catch (error) {
    assert.equal(error, hostile);
  }
  assert.deepEqual(emitted, { name: "Error", message: "[redacted]" });
  await kernel.shutdown();
});

test("invalid MCP transport details fail before factory creation", async () => {
  const invalid = [
    { id: "stdio", transport: "stdio", command: "" },
    { id: "http", transport: "http", url: "http://example.test/mcp" },
    { id: "credentials", transport: "sse", url: "https://user@example.test/mcp" },
  ] as unknown as readonly McpServerConfig[];
  for (const config of invalid) {
    let factoryCalls = 0;
    const kernel = new CoreKernel({
      services: { auth: allow },
      mcpServers: [config],
      mcpClientFactory: { create: () => { factoryCalls += 1; throw new Error("unexpected"); } },
    });
    await assert.rejects(kernel.boot(), KernelStateError);
    assert.equal(factoryCalls, 0);
  }
});
