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
import { cdpBaseURL, qoderExecutable } from "../scripts/launch-qoder.mjs";

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

test("Qoder 连续发送时 waitForRun 不会复用上一轮终态", async () => {
  const previous = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-token";
  try {
    const client = new QoderClient({
      sdkLoader: async () => ({
        accessTokenFromEnv: () => ({ type: "token" }),
        query: ({ prompt }) => {
          async function* stream() {
            let first = true;
            for await (const input of prompt) {
              const text = input.message.content[0].text;
              if (first) {
                first = false;
                yield { type: "system", session_id: "multi-turn-session" };
              }
              yield { type: "assistant", message: { content: [{ type: "text", text: `处理：${text}` }] } };
              yield { type: "result", subtype: "success", result: `完成：${text}` };
            }
          }
          const generator = stream();
          generator.interrupt = async () => {};
          generator.close = async () => {};
          return generator;
        },
      }),
    });
    const adapter = new QoderAdapter({ client, ideBridge: { status: async () => false } });
    const started = await adapter.startSessionWithMessage({
      Cwd: "/tmp/project",
      Message: { PrismMessageID: "m1", Text: "第一轮" },
    });
    const first = await adapter.waitForRun(started.Session, started.Receipt.NativeMessageID);
    assert.equal(first.Summary, "完成：第一轮");
    const secondReceipt = await adapter.send(started.Session, { PrismMessageID: "m2", Text: "第二轮" });
    const second = await adapter.waitForRun(started.Session, secondReceipt.NativeMessageID);
    assert.equal(second.Summary, "完成：第二轮");
  } finally {
    if (previous === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = previous;
  }
});

test("Qoder live 历史流会推送新用户消息", async () => {
  let history = [{ id: "m1", role: "user", content: "第一轮", created_at: "2026-01-01T00:00:00.000Z" }];
  const adapter = new QoderAdapter({
    client: {
      getSessionMessages: async () => history,
      availability: async () => ({ available: true, reason: "" }),
    },
    ideBridge: { status: async () => false },
  });
  const controller = new AbortController();
  const iterator = adapter.readHistoryStream({ NativeSessionID: "session-1" }, { stream_id: "history-1", limit: 20, live: true }, controller.signal)[Symbol.asyncIterator]();
  const initial = await iterator.next();
  assert.equal(initial.value.type, "turn");
  const pageEnd = await iterator.next();
  assert.equal(pageEnd.value.type, "page_end");
  history = [...history, { id: "m2", role: "user", content: "第二轮", created_at: "2026-01-01T00:01:00.000Z" }];
  const update = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("live history 未推送新消息")), 1500)),
  ]);
  assert.equal(update.value.type, "turn");
  assert.equal(update.value.source, "live");
  assert.equal(update.value.turn.messages.at(-1).Content, "第二轮");
  controller.abort();
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
  assert.equal(capability.CanControlSession, false);
  const sessions = await adapter.listSessions();
  assert.equal(sessions[0].NativeSessionID, "saved-1");
  const history = await adapter.readHistory({ NativeSessionID: "saved-1", Cwd: "/tmp/project" });
  assert.equal(history[0].Content, "你好");
});

test("Adapter 支持草稿打开并提交首条消息", async () => {
  const client = {
    availability: async () => ({ available: true, reason: "" }),
    start: async ({ prompt, cwd }) => {
      assert.equal(prompt, "通过草稿发送");
      assert.equal(cwd, "/tmp/project");
      return { sessionID: "draft-session-1" };
    },
  };
  const adapter = new QoderAdapter({ client, ideBridge: { status: async () => false } });
  const draft = await adapter.openDraft({ DraftID: "draft-1", Cwd: "/tmp/project" });
  assert.equal(draft.DraftID, "draft-1");
  assert.ok(draft.DraftFingerprint);
  const started = await adapter.startDraftWithMessage({
    DraftID: "draft-1",
    Cwd: "/tmp/project",
    Message: { PrismMessageID: "message-1", Text: "通过草稿发送" },
  });
  assert.equal(started.Session.NativeSessionID, "draft-session-1");
  assert.equal(started.Receipt.Accepted, true);
  assert.equal(started.Receipt.Visible, true);
  assert.equal(started.Visibility.Visible, true);
});

test("QoderClient 列出跨工作区的完整会话目录", async () => {
  let received;
  const client = new QoderClient({
    sdkLoader: async () => ({
      query: () => {},
      listSessions: async (options) => { received = options; return [{ sessionId: "all-workspaces", cwd: "/tmp/other-project" }]; },
    }),
  });
  assert.deepEqual(await client.listSessions(), [{ sessionId: "all-workspaces", cwd: "/tmp/other-project" }]);
  assert.equal(received, undefined);
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

test("Qoder launcher 使用可覆盖的应用路径和 CDP 端口", () => {
  assert.equal(qoderExecutable({ PRISM_QODER_APP_PATH: "/tmp/Qoder" }, "darwin"), "/tmp/Qoder");
  assert.equal(qoderExecutable({}, "darwin"), "/Applications/Qoder.app/Contents/MacOS/Qoder");
  assert.equal(cdpBaseURL({ PRISM_QODER_CDP_PORT: "9555" }), "http://127.0.0.1:9555");
  assert.equal(cdpBaseURL({ PRISM_QODER_CDP_URL: "http://127.0.0.1:9666/" }), "http://127.0.0.1:9666");
});
