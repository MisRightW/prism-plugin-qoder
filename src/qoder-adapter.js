import { randomUUID } from "node:crypto";
import { IdeBridgeClient } from "./ide-bridge-client.js";
import { QoderCdpClient } from "./qoder-cdp.js";

const PLUGIN_ID = "qoder";

function now() {
  return new Date().toISOString();
}

function toSession(id, cwd = "") {
  return { PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: "qoder-desktop", Endpoint: "", Cwd: cwd, Visible: true };
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
  constructor({ client = new QoderCdpClient(), ideBridge = new IdeBridgeClient() } = {}) {
    this.client = client;
    this.ideBridge = ideBridge;
    this.attachedSessions = new Map();
    this.drafts = new Map();
  }

  id() { return PLUGIN_ID; }

  async probe() {
    const state = await this.client.availability();
    return {
      PluginID: PLUGIN_ID,
      Available: state.available,
      NativeVisibleInput: true,
      NativeVisibleOutput: true,
      CanAttachSession: true,
      CanStartSessionWithMessage: true,
      CanOpenDraft: true,
      CanListSessions: true,
      CanReadHistory: true,
      CanInterrupt: true,
      CanApproval: true,
      CanForwardSync: true,
      CanReverseSync: true,
      CanWaitRun: true,
      CanReadStatus: true,
      CanControlSession: this.client instanceof QoderCdpClient,
      IntegrationMode: "desktop-automation",
      VisibilitySurface: "qoder-desktop-cdp",
      UnavailableReason: state.reason,
    };
  }

  async discover() {
    const state = await this.client.availability();
    const ideBridge = await this.ideBridge.status();
    return {
      PluginID: PLUGIN_ID,
      Surface: "qoder-desktop",
      Endpoint: "",
      ProcessID: 0,
      SessionHints: { qoder_ide_bridge: ideBridge ? "connected" : "disconnected", transport: state.endpoint || "cdp" },
      Verified: state.available,
      Detail: state.reason || "Qoder Desktop CDP 已就绪",
    };
  }

  async startSessionWithMessage(req) {
    const draft = await this.openDraft({
      DraftID: `implicit:${req?.Message?.PrismMessageID || randomUUID()}`,
      PluginID: PLUGIN_ID,
      Cwd: req?.Cwd,
      SourceDevice: req?.SourceDevice,
      Metadata: req?.Metadata,
    });
    return this.startDraftWithMessage({
      DraftID: draft.DraftID,
      PluginID: PLUGIN_ID,
      Cwd: draft.Cwd,
      Message: req?.Message,
      SourceDevice: req?.SourceDevice,
      Metadata: req?.Metadata,
    });
  }

  async openDraft(req) {
    const draftID = String(req?.DraftID || "").trim();
    if (!draftID) throw new Error("Qoder 草稿需要 DraftID");
    const cwd = String(req?.Cwd || process.cwd()).trim() || process.cwd();
    const draft = {
      DraftID: draftID,
      Cwd: cwd,
      DraftFingerprint: randomUUID(),
    };
    this.drafts.set(draftID, draft);
    return { ...draft, Controls: { actions: [] } };
  }

  async controlDraft(req) {
    const draftID = String(req?.DraftID || "").trim();
    const draft = this.drafts.get(draftID);
    if (!draft) throw new Error("Qoder 草稿已失效");
    throw new Error(`Qoder 草稿不支持控制操作: ${String(req?.Action || "unknown")}`);
  }

  async startDraftWithMessage(req) {
    const draftID = String(req?.DraftID || "").trim();
    const draft = this.drafts.get(draftID);
    if (!draft) throw new Error("Qoder 草稿已失效");
    const text = String(req?.Message?.Text || "").trim();
    if (!text) throw new Error("Qoder 首条消息不能为空");
    const { sessionID: id } = await this.client.start({ prompt: text, cwd: draft.Cwd, attachments: req?.Message?.Attachments || [] });
    if (!id) throw new Error("Qoder CLI 未返回会话 ID");
    this.drafts.delete(draftID);
    const session = toSession(id, draft.Cwd);
    const nativeMessageID = `qoder:${id}:${req?.Message?.PrismMessageID || randomUUID()}`;
    this.attachedSessions.set(id, draft.Cwd);
    this.client.registerTurn?.(id, nativeMessageID, { initial: true });
    return {
      Session: session,
      Receipt: {
        NativeMessageID: nativeMessageID,
        CanonicalNativeSessionID: id,
        CanonicalNativeThreadID: id,
        Accepted: true,
        Visible: true,
        Detail: "Qoder Desktop 已接收首条消息",
      },
      Visibility: {
        Visible: true,
        Marker: text,
        Evidence: `qoder-cdp-session:${id}`,
        CheckedAt: now(),
        FailureReason: "",
      },
    };
  }

  async send(session, message) {
    const id = sessionID(session);
    const text = String(message?.Text || "").trim();
    if (!id || !text) throw new Error("Qoder 续聊需要会话 ID 与消息正文");
    let canonicalID = id;
    const nativeMessageID = `qoder:${id}:${message.PrismMessageID || randomUUID()}`;
    try {
      await this.client.send(id, text, nativeMessageID, message?.Attachments || []);
    } catch (error) {
      if (!this.attachedSessions.has(id)) throw error;
      const cwd = this.attachedSessions.get(id) || process.cwd();
      const run = await this.client.start({ prompt: text, cwd, resume: id, attachments: message?.Attachments || [] });
      canonicalID = run.sessionID;
      this.client.registerTurn?.(canonicalID, nativeMessageID, { initial: true });
      this.attachedSessions.delete(id);
      this.attachedSessions.set(canonicalID, cwd);
    }
    return { NativeMessageID: nativeMessageID, CanonicalNativeSessionID: canonicalID, CanonicalNativeThreadID: canonicalID, Accepted: true, Visible: true, Detail: "Qoder Desktop 已接收消息" };
  }

  async listSessions() {
    const sessions = await this.client.listSessions();
    return (Array.isArray(sessions) ? sessions : []).map((item) => {
      const id = String(item?.sessionId || item?.id || item?.session_id || "");
      const lastModified = Number(item?.lastModified);
      return { PluginID: PLUGIN_ID, NativeSessionID: id, NativeThreadID: id, Surface: "qoder-desktop", Endpoint: "", Cwd: String(item?.cwd || item?.dir || ""), Title: String(item?.summary || item?.customTitle || item?.title || id), PrismConversationID: "", Active: Boolean(item?.selected), Visible: true, LastActivityAt: Number.isFinite(lastModified) ? new Date(lastModified).toISOString() : String(item?.updated_at || item?.updatedAt || now()), Metadata: {} };
    }).filter((item) => item.NativeSessionID);
  }

  async attachSession(req) {
    const id = String(req?.NativeSessionID || req?.NativeThreadID || "");
    if (!id) throw new Error("Qoder attachSession 需要原生会话 ID");
    const cwd = req?.Cwd || process.cwd();
    this.attachedSessions.set(id, cwd);
    await this.client.attach?.(id);
    return toSession(id, cwd);
  }

  async readHistory(session, limit = 50) {
    const items = await this.client.getSessionMessages(sessionID(session), session?.Cwd || process.cwd());
    const result = (Array.isArray(items) ? items : []).slice(-Math.max(1, limit)).map(historyItem);
    const run = this.client.get?.(sessionID(session));
    if (run?.attachments?.length) {
      const lastUser = [...result].reverse().find((item) => item.Role === "user");
      if (lastUser) lastUser.Metadata = { attachments: run.attachments.map((item) => ({ name: item.name, mime_type: item.mime_type || item.mimeType, kind: item.kind || (String(item.mime_type || item.mimeType).startsWith("image/") ? "image" : "file") })) };
    }
    return result;
  }

  async readDetail(session) {
    let run;
    try { run = this.client.get(sessionID(session)); } catch { run = { status: "idle" }; }
    const detail = {
      native_session_id: sessionID(session),
      status: run.status,
      qoder_ide_bridge: await this.ideBridge.status(),
    };
    if (typeof this.client.inspectDetails === "function") Object.assign(detail, await this.client.inspectDetails(sessionID(session)));
    if (detail.qoder_ide_bridge) detail.qoder_ide_context = await this.ideBridge.context();
    return detail;
  }

  async *readHistoryStream(session, request = {}, signal) {
    const streamID = request.stream_id;
    const turnID = `qoder:${sessionID(session)}`;
    let revision = 0;
    let fingerprint = "";
    const read = async () => this.readHistory(session, request.limit || 50);
    const emit = async function* (source, operation) {
      const messages = await read();
      const nextFingerprint = JSON.stringify(messages.map((message) => [message.ID, message.Role, message.Content, message.Status, message.UpdatedAt]));
      if (nextFingerprint === fingerprint) return false;
      fingerprint = nextFingerprint;
      revision += 1;
      yield { stream_id: streamID, type: "turn", source, operation, turn: { turn_id: turnID, order_key: "0", revision, messages } };
      return true;
    };
    for await (const event of emit("initial", "append")) yield event;
    if (!request.live) {
      yield { stream_id: streamID, type: "end", source: "initial" };
      return;
    }
    yield { stream_id: streamID, type: "page_end", source: "initial", operation: "append" };
    while (!signal?.aborted) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal?.aborted) return;
      for await (const event of emit("live", "replace")) yield event;
    }
  }

  async *subscribe(session, signal) {
    const run = this.client.get(sessionID(session));
    if (run?.events?.iterate) {
      yield* run.events.iterate(signal);
      return;
    }
    while (!signal?.aborted) {
      yield { Type: "run.status", Status: run.status, Summary: run.summary || "" };
      if (["completed", "failed", "interrupted"].includes(run.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async interrupt(session) {
    await this.client.interrupt(sessionID(session));
  }

  async resolveApproval(req) {
    await this.client.resolveApproval(sessionID(req?.Session), String(req?.ApprovalRequestID || ""), String(req?.ActionID || ""), String(req?.Input || ""));
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
    if (typeof this.client.controlSession === "function") {
      const details = await this.client.controlSession(sessionID(req.session), action, req?.target || {});
      return { ok: true, action, thread_id: sessionID(req.session), message: "Qoder Desktop 控制已提交", details, details_confirmed: false };
    }
    if (action !== "interrupt") return { ok: false, action, message: "Qoder 当前仅支持 interrupt 与 ide.open_file 会话控制", details_confirmed: true };
    await this.interrupt(req.session);
    return { ok: true, action: "interrupt", thread_id: sessionID(req.session), message: "已请求中断 Qoder 会话", details_confirmed: false };
  }

  verifyVisibility(_session, marker) {
    return { Visible: true, Marker: marker, Evidence: "Qoder Desktop CDP 页面", CheckedAt: now(), FailureReason: "" };
  }

  async waitForRun(session, runID) {
    if (typeof this.client.waitForRun === "function") return this.client.waitForRun(sessionID(session), runID);
    const run = this.client.get(sessionID(session));
    for await (const event of run.events.iterate()) {
      if (["completed", "failed", "interrupted"].includes(event.Status)) return event;
    }
    throw new Error("Qoder 会话在完成前关闭");
  }

  async close() { await this.client.close(); }
}
