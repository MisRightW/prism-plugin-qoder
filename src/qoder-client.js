import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function now() {
  return new Date().toISOString();
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function findSessionID(value, depth = 0) {
  if (!value || depth > 5) return "";
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findSessionID(item, depth + 1);
      if (id) return id;
    }
    return "";
  }
  const record = value;
  for (const key of ["session_id", "sessionId"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const item of Object.values(record)) {
    const id = findSessionID(item, depth + 1);
    if (id) return id;
  }
  return "";
}

class AsyncEvents {
  constructor() {
    this.events = [];
    this.waiters = [];
    this.finished = false;
  }

  push(event) {
    if (this.finished) return;
    this.events.push(event);
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  close() {
    this.finished = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async *iterate(signal) {
    let cursor = 0;
    while (!signal?.aborted) {
      if (cursor < this.events.length) {
        yield this.events[cursor++];
        continue;
      }
      if (this.finished) return;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

function inputChannel() {
  const queued = [];
  let wake;
  let ended = false;
  return {
    push(text) {
      const message = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
      };
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve({ value: message, done: false });
      } else {
        queued.push(message);
      }
    },
    end() {
      ended = true;
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { wake = resolve; });
        },
      };
    },
  };
}

/**
 * Qoder SDK 的小型隔离层：插件只依赖公开 SDK，不读取 Desktop 的登录资料。
 */
export class QoderClient {
  constructor({ sdkLoader = () => import("@qoder-ai/qoder-agent-sdk"), executablePath = process.env.PRISM_QODER_CLI_PATH || "" } = {}) {
    this.sdkLoader = sdkLoader;
    this.executablePath = executablePath;
    this.runs = new Map();
  }

  async availability() {
    try {
      const sdk = await this.sdkLoader();
      if (typeof sdk.query !== "function") return { available: false, reason: "Qoder Agent SDK 未提供 query()" };
    } catch (error) {
      return { available: false, reason: `无法加载 Qoder Agent SDK：${error instanceof Error ? error.message : String(error)}` };
    }
    if (this.executablePath) {
      try {
        accessSync(this.executablePath, constants.X_OK);
      } catch {
        return { available: false, reason: `PRISM_QODER_CLI_PATH 不可执行：${this.executablePath}` };
      }
    }
    if (!this.executablePath && !process.env.QODER_PERSONAL_ACCESS_TOKEN && !this.findQoderCLIOnPath()) {
      return { available: false, reason: "未找到已登录的 qodercli；请设置 QODER_PERSONAL_ACCESS_TOKEN，或安装并登录 Qoder CLI" };
    }
    return { available: true, reason: "" };
  }

  findQoderCLIOnPath() {
    const names = process.platform === "win32" ? ["qodercli.exe", "qodercli.cmd", "qodercli"] : ["qodercli"];
    return String(process.env.PATH || "").split(delimiter).some((directory) => names.some((name) => {
      try {
        accessSync(join(directory, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }));
  }

  async sdk() {
    const sdk = await this.sdkLoader();
    if (typeof sdk.query !== "function") throw new Error("Qoder Agent SDK 未提供 query()");
    return sdk;
  }

  async auth(sdk) {
    if (process.env.QODER_PERSONAL_ACCESS_TOKEN) {
      if (typeof sdk.accessTokenFromEnv !== "function") throw new Error("Qoder Agent SDK 不支持环境变量认证");
      return sdk.accessTokenFromEnv();
    }
    if (typeof sdk.qodercliAuth !== "function") throw new Error("Qoder Agent SDK 不支持 Qoder CLI 登录态认证");
    return sdk.qodercliAuth();
  }

  async start({ prompt, cwd, resume = "" }) {
    const state = await this.availability();
    if (!state.available) throw new Error(state.reason);
    const sdk = await this.sdk();
    const channel = inputChannel();
    const events = new AsyncEvents();
    const pendingApprovals = new Map();
    let resolveSession;
    let rejectSession;
    const sessionReady = new Promise((resolve, reject) => {
      resolveSession = resolve;
      rejectSession = reject;
    });
    const options = {
      auth: await this.auth(sdk),
      includePartialMessages: true,
      cwd,
      ...(resume ? { resume } : {}),
      ...(this.executablePath ? { pathToQoderCLIExecutable: this.executablePath } : {}),
      canUseTool: async (toolName, input, toolOptions) => new Promise((resolve) => {
        const approvalID = String(toolOptions?.toolUseID || randomUUID());
        pendingApprovals.set(approvalID, { resolve, toolUseID: toolOptions?.toolUseID || approvalID });
        events.push({
          ID: `qoder:${approvalID}:approval`,
          Type: "approval.required",
          Status: "waiting_approval",
          Summary: `Qoder 请求使用工具 ${toolName}`,
          Payload: { approval_id: approvalID, tool_name: toolName, input },
          CreatedAt: now(),
        });
      }),
    };
    channel.push(prompt);
    const generator = sdk.query({ prompt: channel, options });
    const run = {
      id: "",
      cwd,
      channel,
      generator,
      events,
      pendingApprovals,
      status: "running",
      summary: "",
      startedAt: now(),
      completion: null,
    };
    run.completion = (async () => {
      try {
        for await (const message of generator) {
          const sessionID = findSessionID(message);
          if (sessionID && !run.id) {
            run.id = sessionID;
            this.runs.set(sessionID, run);
            resolveSession(sessionID);
          }
          const assistantText = message?.type === "assistant" ? textFromContent(message?.message?.content) : "";
          if (assistantText) {
            run.summary = assistantText;
            events.push({ ID: `qoder:${run.id || "pending"}:${randomUUID()}`, Type: "assistant.message", Status: "running", Summary: assistantText, Payload: {}, CreatedAt: now() });
          }
          if (message?.type === "result") {
            const successful = message.subtype === "success";
            run.status = successful ? "completed" : "failed";
            run.summary = typeof message.result === "string" ? message.result : (message.errors?.join("；") || run.summary || "Qoder 执行结束");
            events.push({
              ID: `qoder:${run.id || "pending"}:result:${randomUUID()}`,
              Type: successful ? "run.completed" : "run.failed",
              Status: run.status,
              Summary: run.summary,
              Payload: { subtype: message.subtype || "" },
              CreatedAt: now(),
            });
          }
        }
        if (!run.id) rejectSession(new Error("Qoder CLI 未返回会话 ID"));
      } catch (error) {
        if (!run.id) rejectSession(error);
        run.status = "failed";
        run.summary = error instanceof Error ? error.message : String(error);
        events.push({ ID: `qoder:pending:error:${randomUUID()}`, Type: "run.failed", Status: "failed", Summary: run.summary, Payload: {}, CreatedAt: now() });
      } finally {
        events.close();
        for (const approval of pendingApprovals.values()) approval.resolve({ behavior: "deny", message: "会话已结束", toolUseID: approval.toolUseID });
      }
    })();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("等待 Qoder 会话初始化超时")), 15000);
    });
    let sessionID;
    try {
      sessionID = await Promise.race([sessionReady, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { sessionID, run };
  }

  get(sessionID) {
    const run = this.runs.get(sessionID);
    if (!run) throw new Error(`未找到受当前 Prism 进程管理的 Qoder 会话：${sessionID}`);
    return run;
  }

  async send(sessionID, text) {
    this.get(sessionID).channel.push(text);
  }

  async interrupt(sessionID) {
    const run = this.get(sessionID);
    if (typeof run.generator?.interrupt !== "function") throw new Error("当前 Qoder SDK 会话不支持中断");
    await run.generator.interrupt();
  }

  async resolveApproval(sessionID, approvalID, actionID) {
    const approval = this.get(sessionID).pendingApprovals.get(approvalID);
    if (!approval) throw new Error(`未找到 Qoder 审批：${approvalID}`);
    this.get(sessionID).pendingApprovals.delete(approvalID);
    const allow = /^(allow|approve|yes)$/i.test(actionID);
    approval.resolve(allow
      ? { behavior: "allow", toolUseID: approval.toolUseID }
      : { behavior: "deny", message: "已由 Prism 用户拒绝", toolUseID: approval.toolUseID });
  }

  async listSessions(cwd = process.cwd()) {
    const sdk = await this.sdk();
    if (typeof sdk.listSessions !== "function") throw new Error("Qoder Agent SDK 不支持列出会话");
    return sdk.listSessions({ dir: cwd });
  }

  async getSessionMessages(sessionID, cwd = process.cwd()) {
    const sdk = await this.sdk();
    if (typeof sdk.getSessionMessages !== "function") throw new Error("Qoder Agent SDK 不支持读取会话历史");
    return sdk.getSessionMessages(sessionID, { dir: cwd, view: "historical" });
  }

  async close() {
    for (const run of this.runs.values()) {
      run.channel.end();
      await run.generator?.close?.();
    }
    this.runs.clear();
  }
}

export const __test = { findSessionID, textFromContent };
