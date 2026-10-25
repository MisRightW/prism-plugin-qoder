import { randomUUID } from "node:crypto";
import { IdeBridgeClient } from "./ide-bridge-client.js";
import { QoderClient } from "./qoder-client.js";

const PLUGIN_ID = "qoder";

function now() {
  return new Date().toISOString();
}

function toSession(id, cwd = "") {
  return { PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: "qoder-cli", Endpoint: "", Cwd: cwd, Visible: false };
}

function sessionID(session) {
  return String(session?.NativeSessionID || session?.NativeThreadID || "");
}

function historyItem(item, index) {
  const role = String(item?.role || item?.message?.role || "assistant");
  const blocks = Array.isArray(item?.message?.content) ? item.message.content : [];
  const content = typeof item?.content === "string"
    ? item.content
    : (typeof item?.message?.content === "string"
      ? item.message.content
      : blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join(""));
  return {
    ID: String(item?.uuid || item?.id || `qoder-history-${index}`),
    Role: role,
    Type: role === "user" ? "user" : "assistant",
    Content: content,
    Status: "completed",
    CreatedAt: String(item?.timestamp || item?.created_at || item?.createdAt || now()),
    UpdatedAt: String(item?.timestamp || item?.updated_at || item?.updatedAt || item?.created_at || item?.createdAt || now()),
  };
}

/**
 * Prism 与 Qoder 官方 Agent SDK 的协议适配器。
 */
export class QoderAdapter {
  constructor({ client = new QoderClient(), ideBridge = new IdeBridgeClient() } = {}) {
    this.client = client;
    this.ideBridge = ideBridge;
    this.attachedSessions = new Map();
  }

  id() { return PLUGIN_ID; }

  async probe() {
    const state = await this.client.availability();
    return {
      PluginID: PLUGIN_ID,
      Available: state.available,
      NativeVisibleInput: false,
      NativeVisibleOutput: false,
      CanAttachSession: true,
      CanStartSessionWithMessage: true,
      CanOpenDraft: false,
      CanListSessions: true,
      CanReadHistory: true,
      CanInterrupt: true,
      CanApproval: true,
      CanForwardSync: true,
      CanReverseSync: false,
      CanWaitRun: true,
      CanReadStatus: true,
      CanControlSession: true,
      IntegrationMode: "protocol-native",
      VisibilitySurface: "qoder-cli",
      UnavailableReason: state.reason,
    };
  }

  async discover() {
    const state = await this.client.availability();
    const ideBridge = await this.ideBridge.status();
    return {
      PluginID: PLUGIN_ID,
      Surface: "qoder-cli",
      Endpoint: "",
      ProcessID: 0,
      SessionHints: { qoder_ide_bridge: ideBridge ? "connected" : "disconnected" },
      Verified: state.available,
      Detail: state.reason || "Qoder Agent SDK 已就绪",
    };
  }

  async startSessionWithMessage(req) {
    const text = String(req?.Message?.Text || "").trim();
    if (!text) throw new Error("Qoder 首条消息不能为空");
    const { sessionID: id } = await this.client.start({ prompt: text, cwd: req?.Cwd || process.cwd() });
    const session = toSession(id, req?.Cwd || process.cwd());
    return {
      Session: session,
      Receipt: { NativeMessageID: req.Message.PrismMessageID || randomUUID(), CanonicalNativeSessionID: id, CanonicalNativeThreadID: id, Accepted: true, Visible: false, Detail: "已由 Qoder CLI 接收首条消息" },
      Visibility: { Visible: false, Marker: text, Evidence: "Qoder CLI 为无界面协议集成", CheckedAt: now(), FailureReason: "" },
    };
  }

  async send(session, message) {
    const id = sessionID(session);
    const text = String(message?.Text || "").trim();
    if (!id || !text) throw new Error("Qoder 续聊需要会话 ID 与消息正文");
    let canonicalID = id;
    try {
      await this.client.send(id, text);
    } catch (error) {
      if (!this.attachedSessions.has(id)) throw error;
      const run = await this.client.start({ prompt: text, cwd: this.attachedSessions.get(id) || process.cwd(), resume: id });
      canonicalID = run.sessionID;
      this.attachedSessions.delete(id);
    }
    return { NativeMessageID: message.PrismMessageID || randomUUID(), CanonicalNativeSessionID: canonicalID, CanonicalNativeThreadID: canonicalID, Accepted: true, Visible: false, Detail: "已由 Qoder CLI 接收消息" };
  }

  async listSessions() {
    const sessions = await this.client.listSessions();
    return (Array.isArray(sessions) ? sessions : []).map((item) => {
      const id = String(item?.sessionId || item?.id || item?.session_id || "");
      const lastModified = Number(item?.lastModified);
      return { PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: "qoder-cli", Endpoint: "", Cwd: String(item?.cwd || item?.dir || ""), Title: String(item?.summary || item?.customTitle || item?.title || id), PrismConversationID: "", Active: false, Visible: false, LastActivityAt: Number.isFinite(lastModified) ? new Date(lastModified).toISOString() : String(item?.updated_at || item?.updatedAt || now()), Metadata: {} };
    }).filter((item) => item.NativeSessionID);
  }

  async attachSession(req) {
    const id = String(req?.NativeSessionID || req?.NativeThreadID || "");
    if (!id) throw new Error("Qoder attachSession 需要原生会话 ID");
    const cwd = req?.Cwd || process.cwd();
    this.attachedSessions.set(id, cwd);
    return toSession(id, cwd);
  }

  async readHistory(session, limit = 50) {
    const items = await this.client.getSessionMessages(sessionID(session), session?.Cwd || process.cwd());
    return (Array.isArray(items) ? items : []).slice(-Math.max(1, limit)).map(historyItem);
  }

  async readDetail(session) {
    let run;
    try { run = this.client.get(sessionID(session)); } catch { run = { status: "idle" }; }
    const detail = {
      native_session_id: sessionID(session),
      status: run.status,
      qoder_ide_bridge: await this.ideBridge.status(),
    };
    if (detail.qoder_ide_bridge) detail.qoder_ide_context = await this.ideBridge.context();
    return detail;
  }

  async *readHistoryStream(session, request = {}) {
    const messages = await this.readHistory(session, request.limit || 50);
    yield { stream_id: request.stream_id, type: "turn", source: "initial", operation: "append", turn: { turn_id: `qoder:${sessionID(session)}`, order_key: "0", revision: 1, messages } };
    yield { stream_id: request.stream_id, type: "end", source: "initial" };
  }

  async *subscribe(session, signal) {
    yield* this.client.get(sessionID(session)).events.iterate(signal);
  }

  async interrupt(session) {
    await this.client.interrupt(sessionID(session));
  }

  async resolveApproval(req) {
    await this.client.resolveApproval(sessionID(req?.Session), String(req?.ApprovalRequestID || ""), String(req?.ActionID || ""));
  }

  async readStatus(session) {
    let run;
    try { run = this.client.get(sessionID(session)); } catch { return { status: "idle", interruptible: false, approval_blocked: false }; }
    return { status: run.status, preview: run.summary, interruptible: run.status === "running", approval_blocked: run.pendingApprovals.size > 0, started_at: run.startedAt };
  }

  async controlSession(req) {
    const action = String(req?.action || "").toLowerCase();
    if (action === "ide.open_file") {
      const target = req?.target && typeof req.target === "object" ? req.target : {};
      const path = typeof target.path === "string" ? target.path : "";
      if (!path) return { ok: false, action, message: "ide.open_file 需要 target.path", details_confirmed: true };
      await this.ideBridge.openFile(path, Number(target.line));
      return { ok: true, action, thread_id: sessionID(req.session), message: "已在 Qoder IDE 打开文件", details_confirmed: true };
    }
    if (action !== "interrupt") return { ok: false, action, message: "Qoder 当前仅支持 interrupt 与 ide.open_file 会话控制", details_confirmed: true };
    await this.interrupt(req.session);
    return { ok: true, action: "interrupt", thread_id: sessionID(req.session), message: "已请求中断 Qoder 会话", details_confirmed: false };
  }

  verifyVisibility(_session, marker) {
    return { Visible: false, Marker: marker, Evidence: "Qoder CLI 为无界面协议集成", CheckedAt: now(), FailureReason: "" };
  }

  async waitForRun(session) {
    const run = this.client.get(sessionID(session));
    for await (const event of run.events.iterate()) {
      if (["completed", "failed", "interrupted"].includes(event.Status)) return event;
    }
    throw new Error("Qoder 会话在完成前关闭");
  }

  async close() { await this.client.close(); }
}
