import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QoderAdapter } from "../src/qoder-adapter.js";
import { IdeBridgeClient } from "../src/ide-bridge-client.js";
import { QoderClient, __test } from "../src/qoder-client.js";

function fakeSDK() {
  return {
    accessTokenFromEnv: () => ({ type: "token" }),
    query: () => {
      async function* stream() {
        yield { type: "system", session_id: "session-123" };
        yield { type: "assistant", message: { content: [{ type: "text", text: "正在分析项目" }] } };
        yield { type: "result", subtype: "success", result: "完成" };
      }
      const generator = stream();
      generator.interrupt = async () => {};
      generator.close = async () => {};
      return generator;
    },
    listSessions: async () => [{ sessionId: "saved-1", summary: "已有会话", cwd: "/tmp/project", lastModified: 1767225600000 }],
    getSessionMessages: async () => [{ uuid: "message-1", type: "user", message: { content: [{ type: "text", text: "你好" }] }, timestamp: "2026-01-01T00:00:00.000Z" }],
  };
}

test("QoderClient 将 SDK 流转换为 Prism 运行事件", async () => {
  const previous = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-token";
  try {
    const client = new QoderClient({ sdkLoader: async () => fakeSDK() });
    const { sessionID, run } = await client.start({ prompt: "分析项目", cwd: "/tmp/project" });
    assert.equal(sessionID, "session-123");
    await run.completion;
    const events = [];
    for await (const event of run.events.iterate()) events.push(event);
    assert.deepEqual(events.map((event) => event.Status), ["running", "completed"]);
    assert.equal(events.at(-1).Summary, "完成");
  } finally {
    if (previous === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = previous;
  }
});

test("Adapter 将原生会话目录与历史映射为 Prism 数据", async () => {
  const client = {
    availability: async () => ({ available: true, reason: "" }),
    listSessions: async () => [{ id: "saved-1", title: "已有会话", cwd: "/tmp/project" }],
    getSessionMessages: async () => [{ id: "message-1", role: "user", content: "你好", created_at: "2026-01-01T00:00:00.000Z" }],
    get: () => ({ status: "completed", summary: "完成", pendingApprovals: new Map(), startedAt: "2026-01-01T00:00:00.000Z" }),
    close: async () => {},
  };
  const ideBridge = { status: async () => false };
  const adapter = new QoderAdapter({ client, ideBridge });
  const capability = await adapter.probe();
  assert.equal(capability.Available, true);
  const sessions = await adapter.listSessions();
  assert.equal(sessions[0].NativeSessionID, "saved-1");
  const history = await adapter.readHistory({ NativeSessionID: "saved-1", Cwd: "/tmp/project" });
  assert.equal(history[0].Content, "你好");
});

test("IDE bridge 只向回环地址携带描述文件中的令牌", async () => {
  const token = randomUUID();
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url, "/v1/context");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ active_file: "/tmp/example.ts" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const directory = await mkdtemp(join(tmpdir(), "qoder-bridge-"));
    const descriptorPath = join(directory, "bridge.json");
    await writeFile(descriptorPath, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token }));
    const bridge = new IdeBridgeClient({ descriptorPath });
    assert.deepEqual(await bridge.context(), { active_file: "/tmp/example.ts" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("自动发现 Qoder IDE 提供的版本化 CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "qoder-home-"));
  const directory = join(home, ".qoder", "bin", "qodercli");
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "qodercli-1.1.78");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  assert.equal(__test.findQoderCLIPath({ pathValue: "", homeDirectory: home, platform: "darwin" }), executable);
});
