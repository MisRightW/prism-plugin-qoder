import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { CdpPageClient } = createRequire(import.meta.url)("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");

const 默认端口 = [9222, 9223, 9224, 9225, 9333];
const 默认应用路径 = process.platform === "darwin"
  ? "/Applications/Qoder.app/Contents/MacOS/Qoder"
  : process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || "", "Programs", "Qoder", "Qoder.exe")
    : "qoder";

function 文本(value) { return typeof value === "string" ? value.trim() : ""; }
function 等待(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function 错误文本(error) { return error instanceof Error ? error.message : String(error); }
function 端口候选() {
  const configured = Number(process.env.PRISM_QODER_CDP_PORT || 0);
  return configured > 0 ? [configured, ...默认端口.filter((port) => port !== configured)] : 默认端口;
}

class 事件队列 {
  constructor() { this.events = []; this.waiters = []; this.finished = false; }
  push(event) { if (this.finished) return; this.events.push(event); for (const wake of this.waiters.splice(0)) wake(); }
  close() { this.finished = true; for (const wake of this.waiters.splice(0)) wake(); }
  async *iterate(signal, startAt = 0) {
    let cursor = Math.max(0, Number(startAt) || 0);
    while (!signal?.aborted) {
      if (cursor < this.events.length) { yield this.events[cursor++]; continue; }
      if (this.finished) return;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

function 文件名(path) { return String(path || "").split(/[\\/]/).pop() || "附件"; }

function 受控附件(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => {
    const path = 文本(item?.LocalPath || item?.local_path);
    if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error("附件路径无效或不是文件");
    return { path, name: 文本(item?.Name || item?.name) || 文件名(path), mimeType: 文本(item?.MIMEType || item?.mime_type) || "application/octet-stream" };
  });
}

function 页面脚本(包含控件 = false) {
  return `(async () => {
    const collectControls = ${包含控件 ? "true" : "false"};
    const text = (node) => String(node?.innerText || node?.textContent || '').trim();
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const identity = (node, index) => {
      const raw = String(
      node?.getAttribute('data-session-id') || node?.getAttribute('data-sessionid') ||
      node?.getAttribute('data-conversation-id') || node?.getAttribute('data-thread-id') ||
      node?.getAttribute('data-id') || node?.getAttribute('data-row-key') ||
      node?.getAttribute('href') || ''
      ).replace(/^.*(?:session|conversation|thread)[/:=]/i, '').trim();
      const routeID = raw.match(/#\\/chat\\/([^?/#]+)/i)?.[1];
      return routeID || raw || 'ui-' + index;
    };
    const rows = Array.from(document.querySelectorAll(
      '[data-session-id], [data-sessionid], [data-conversation-id], [data-thread-id], [data-row-key^="session:"], a[href*="session"], a[href*="conversation"], [role="treeitem"]'
    )).filter(visible);
    const sessions = [];
    const seen = new Set();
    for (const [index, node] of rows.entries()) {
      const title = text(node).split('\\n').map((item) => item.trim()).filter(Boolean)[0] || '';
      if (!title || /^(new chat|新建会话|历史|history|settings|设置)$/i.test(title)) continue;
      const id = identity(node, index);
      if (seen.has(id)) continue;
      seen.add(id);
      sessions.push({ id, title, selected: node.getAttribute('aria-selected') === 'true' || node.getAttribute('data-selected') === 'true' });
    }
    const visibleNodes = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible);
    const selectedOption = (selector) => {
      const node = visibleNodes(selector)[0];
      if (!node) return null;
      return {
        option_id: String(node.getAttribute('data-option-id') || node.getAttribute('data-value') || node.value || ''),
        label: text(node),
        disabled: Boolean(node.disabled),
      };
    };
    const optionList = (selector) => visibleNodes(selector).map((node, index) => ({
      option_id: String(node.getAttribute('data-option-id') || node.getAttribute('data-value') || node.value || 'option-' + index),
      label: text(node),
      selected: Boolean(node.selected || node.getAttribute('aria-selected') === 'true' || node.getAttribute('data-selected') === 'true'),
      disabled: Boolean(node.disabled),
    })).filter((item) => item.label || item.option_id);
    const dialogs = visibleNodes('[role="dialog"], dialog, [data-interactive-surface]');
    const dialog = dialogs[0];
    const dialogText = text(dialog);
    const dialogRequestID = String(dialog?.getAttribute('data-request-id') || dialog?.getAttribute('data-approval-id') || dialog?.getAttribute('data-interactive-surface-id') || '');
    const dialogActions = dialog ? Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(visible).map((node, index) => ({
      action_id: String(node.getAttribute('data-action-id') || node.getAttribute('data-approval-action') || node.getAttribute('value') || 'action-' + index),
      label: text(node) || String(node.getAttribute('aria-label') || node.getAttribute('title') || ''),
      available: !node.disabled,
      requires_input: false,
      accepts_input: false,
    })).filter((item) => item.label) : [];
    const dialogInputs = dialog ? Array.from(dialog.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]')).filter(visible).map((node, index) => ({
      input_id: String(node.getAttribute('data-input-id') || node.name || 'input-' + index),
      label: String(node.getAttribute('aria-label') || node.getAttribute('placeholder') || ''),
      placeholder: String(node.getAttribute('placeholder') || ''),
      multiline: node.tagName === 'TEXTAREA' || node.getAttribute('contenteditable') === 'true',
      required: Boolean(node.required),
    })) : [];
    const approval = dialogRequestID && dialogActions.length ? {
      approval_request_id: dialogRequestID,
      actions: dialogActions,
      title: String(dialog?.getAttribute('aria-label') || dialog?.getAttribute('aria-labelledby') || ''),
    } : null;
    const interactiveSurface = dialog && (dialogRequestID || dialogInputs.length || dialogActions.length) ? {
      surface_id: dialogRequestID || 'qoder-surface:' + dialogText.slice(0, 160),
      kind: 'dialog',
      title: String(dialog?.getAttribute('aria-label') || ''),
      description: dialogText,
      inputs: dialogInputs,
      actions: dialogActions,
    } : null;
    const model = selectedOption('select[data-model], [data-model-id][aria-selected="true"], [data-control="model"] [aria-selected="true"]');
    const reasoning = selectedOption('select[data-reasoning], [data-reasoning-id][aria-selected="true"], [data-control="reasoning"] [aria-selected="true"]');
    const permission = selectedOption('select[data-permission], [data-permission-id][aria-selected="true"], [data-control="permission"] [aria-selected="true"]');
    const controls = {
      current_model: model,
      model_options: optionList('select[data-model] option, [data-control="model"] [data-option-id], [data-model-id]'),
      current_reasoning: reasoning,
      reasoning_options: optionList('select[data-reasoning] option, [data-control="reasoning"] [data-option-id], [data-reasoning-id]'),
      current_permission: permission,
      permission_options: optionList('select[data-permission] option, [data-control="permission"] [data-option-id], [data-permission-id]'),
    };
    const readMenu = async (button, kind) => {
      if (!(button instanceof HTMLElement)) return { current: null, options: [] };
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const menus = visibleNodes('[role="menu"], [role="listbox"]');
      const menu = menus.at(-1);
      const currentLabel = text(button).split('\\n')[0];
      const options = menu ? Array.from(menu.querySelectorAll('[role="menuitem"], [role="option"]')).filter(visible).map((node, index) => {
        const label = text(node).split('\\n')[0];
        return {
          option_id: String(node.getAttribute('data-option-id') || node.getAttribute('data-value') || node.getAttribute('value') || kind + '-' + index),
          label,
          selected: Boolean(node.getAttribute('data-selected') === 'true' || node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-checked') === 'true' || label === currentLabel),
          disabled: Boolean(node.getAttribute('data-disabled') === 'true' || node.getAttribute('aria-disabled') === 'true'),
        };
      }).filter((item) => item.label && !/模型管理|管理模型/i.test(item.label)) : [];
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const current = options.find((item) => item.selected) || (currentLabel ? { option_id: '', label: currentLabel, disabled: false } : null);
      return { current, options };
    };
    if (collectControls) {
      const modelMenu = await readMenu(visibleNodes('button[aria-label="模型"]')[0], 'model');
      const permissionMenu = await readMenu(visibleNodes('button[aria-label="访问权限"]')[0], 'permission');
      controls.current_model = controls.current_model || modelMenu.current;
      controls.model_options = controls.model_options.length ? controls.model_options : modelMenu.options;
      controls.current_permission = controls.current_permission || permissionMenu.current;
      controls.permission_options = controls.permission_options.length ? controls.permission_options : permissionMenu.options;
    }
    const conversation = document.querySelector('[data-testid="conversation"], [data-testid="content"]');
    const messages = Array.from(conversation?.querySelectorAll('[data-chat-turn]') || []).map((turn, index) => {
      const userNode = turn.querySelector('[data-message-kind="user"] [data-chat-message-text], [data-user-message="true"] [data-chat-message-text]');
      const assistantNode = turn.querySelector('[data-message-kind="assistant"]');
      const assistantParts = Array.from(assistantNode?.querySelectorAll('[data-chat-message-text]') || []).map(text).filter(Boolean);
      const turnID = String(turn.getAttribute('data-message-id') || turn.getAttribute('data-chat-turn') || 'turn-' + index).replace(/^turn:/, '');
      return {
        user: userNode ? { id: String(userNode.closest('[data-message-id]')?.getAttribute('data-message-id') || turnID), content: text(userNode) } : null,
        assistant: assistantParts.length ? { id: 'assistant:' + turnID, content: assistantParts.join('\\n') } : null,
      };
    }).filter((item) => item.user || item.assistant);
    const busy = visibleNodes('button, [role="button"]').some((node) => /stop|停止|cancel|取消/i.test(String(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '')) && !node.disabled);
    return {
      title: text(document.querySelector('h1, [role="heading"]')),
      body: text(document.body),
      messages,
      busy,
      sessions,
      selected: sessions.find((item) => item.selected) || (() => {
        const routeID = location.hash.match(/#\\/chat\\/([^?/#]+)/i)?.[1] || '';
        const route = sessions.find((item) => item.id === routeID);
        return route ? { ...route, selected: true } : null;
      })(),
      controls,
      approval,
      interactive_surface: interactiveSurface,
      composer: visibleNodes('textarea, [contenteditable="true"], input[type="text"]').length > 0,
    };
  })()`;
}

export class QoderCdpClient {
  constructor({ fetcher = globalThis.fetch, endpoint = process.env.PRISM_QODER_CDP_URL || "", launch = process.env.PRISM_QODER_CDP_AUTOSTART !== "false" } = {}) {
    this.fetcher = fetcher;
    this.endpoint = endpoint;
    this.launch = launch;
    this.pageInfo = null;
    this.launchProcess = null;
    this.runs = new Map();
    this.closed = false;
  }

  async resolvePage() {
    const candidates = [];
    if (this.endpoint) candidates.push(this.endpoint);
    for (const port of 端口候选()) candidates.push(`http://127.0.0.1:${port}`);
    for (const candidate of candidates) {
      try {
        if (/^wss?:\/\//i.test(candidate)) return { webSocketDebuggerUrl: candidate, source: "环境变量" };
        const base = candidate.replace(/\/$/, "");
        const response = await this.fetcher(`${base}/json/list`, { signal: AbortSignal.timeout(1200) });
        if (!response.ok) continue;
        const targets = await response.json();
        const page = Array.isArray(targets) && targets.find((item) => item?.type === "page" && item.webSocketDebuggerUrl && /qoder/i.test(`${item.title || ""} ${item.url || ""}`));
        if (page) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, source: base, title: page.title || "" };
      } catch {
        // 端口未开启时继续探测其他候选端点。
      }
    }
    if (this.launch) {
      await this.startApplication();
      for (let i = 0; i < 20; i += 1) {
        await 等待(250);
        try { return await this.resolvePageWithoutLaunch(); } catch { /* 等待 Electron 页面初始化。 */ }
      }
    }
    throw new Error("未发现 Qoder Desktop 的 CDP 端点；请重启 Qoder 并允许插件启动，或设置 PRISM_QODER_CDP_URL。");
  }

  async resolvePageWithoutLaunch() {
    const candidates = [];
    if (this.endpoint) candidates.push(this.endpoint);
    for (const port of 端口候选()) candidates.push(`http://127.0.0.1:${port}`);
    for (const candidate of candidates) {
      if (/^wss?:\/\//i.test(candidate)) return { webSocketDebuggerUrl: candidate, source: "环境变量" };
      const base = candidate.replace(/\/$/, "");
      const response = await this.fetcher(`${base}/json/list`, { signal: AbortSignal.timeout(500) });
      if (!response.ok) continue;
      const targets = await response.json();
      const page = Array.isArray(targets) && targets.find((item) => item?.type === "page" && item.webSocketDebuggerUrl && /qoder/i.test(`${item.title || ""} ${item.url || ""}`));
      if (page) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, source: base, title: page.title || "" };
    }
    throw new Error("CDP 页面尚未就绪");
  }

  async startApplication() {
    if (this.launchProcess && !this.launchProcess.killed && this.launchProcess.exitCode === null) return;
    const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "launch-qoder.mjs");
    const args = [launcher];
    this.launchProcess = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, PRISM_QODER_APP_PATH: process.env.PRISM_QODER_APP_PATH || 默认应用路径 } });
    this.launchProcess.once("exit", () => { this.launchProcess = null; });
    this.launchProcess.unref();
  }

  async withPage(callback) {
    const info = this.pageInfo || await this.resolvePage();
    this.pageInfo = info;
    const page = new CdpPageClient({ commandTimeoutMs: 6000, actionTimeoutMs: 6000 });
    try {
      await page.connectToPage(info.webSocketDebuggerUrl);
      return await callback(page, info);
    } catch (error) {
      this.pageInfo = null;
      throw error;
    } finally {
      await page.close();
    }
  }

  async availability() {
    try {
      const page = await this.resolvePage();
      this.pageInfo = page;
      return { available: true, reason: "", endpoint: page.source };
    } catch (error) {
      return { available: false, reason: 错误文本(error) };
    }
  }

  async inspect() { return this.withPage((page) => page.evaluate(页面脚本())); }

  async listSessions() {
    const state = await this.inspect();
    return (state.sessions || []).map((item) => ({ sessionId: item.id, title: item.title, summary: item.title, cwd: "", selected: Boolean(item.selected || item.id === state.selected?.id) }));
  }

  async selectSession(id, title = "") {
    const expectedID = 文本(id);
    const expectedTitle = 文本(title);
    return this.withPage(async (page) => {
      const result = await page.evaluate(`(async () => {
        const expectedID = ${JSON.stringify(expectedID)};
        const expectedTitle = ${JSON.stringify(expectedTitle)};
        const nodes = Array.from(document.querySelectorAll('[data-session-id], [data-sessionid], [data-conversation-id], [data-thread-id], [data-row-key], [role="treeitem"], a[href]'));
        const match = nodes.find((node) => {
          const values = [node.getAttribute('data-session-id'), node.getAttribute('data-sessionid'), node.getAttribute('data-conversation-id'), node.getAttribute('data-thread-id'), node.getAttribute('data-row-key'), node.getAttribute('href'), node.innerText].filter(Boolean).join(' ');
          return (expectedID && values.includes(expectedID)) || (expectedTitle && String(node.innerText || '').includes(expectedTitle));
        });
        if (!(match instanceof HTMLElement)) return { changed: false };
        match.click();
        await new Promise((resolve) => setTimeout(resolve, 350));
        const routeID = location.hash.match(/#\\/chat\\/([^?/#]+)/i)?.[1] || '';
        return { changed: routeID === expectedID || !routeID, selected: routeID };
      })()`);
      if (!result?.changed) throw new Error("Qoder 页面中找不到目标会话");
      return result;
    });
  }

  async createSession() {
    return this.withPage(async (page) => {
      const clicked = await page.evaluate(`(() => {
      const labels = /new chat|新建会话|new conversation|新对话/i;
      const button = Array.from(document.querySelectorAll('button, a, [role="button"]')).find((node) => labels.test(String(node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || '')));
      if (button instanceof HTMLElement) { button.click(); return true; }
      return false;
    })()`);
      if (!clicked) {
        await page.keyPress("n", ["command"]);
        await 等待(180);
      }
      return true;
    });
  }

  async uploadAttachments(page, attachments) {
    const files = 受控附件(attachments);
    if (!files.length) return [];
    const document = await page.send("DOM.getDocument", { depth: -1, pierce: true });
    const node = await page.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: 'input[type="file"]' });
    if (!node?.nodeId) throw new Error("Qoder 页面未提供附件上传控件");
    await page.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: files.map((item) => item.path) });
    await page.evaluate(`(() => { const node = document.querySelector('input[type="file"]'); if (node) node.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    return files.map((item) => ({ name: item.name, mime_type: item.mimeType, kind: item.mimeType.startsWith("image/") ? "image" : "file" }));
  }

  async sendToPage(text, attachments = []) {
    return this.withPage(async (page) => {
      const input = await page.evaluate(`(() => {
        const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]'));
        return nodes.find((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })?.outerHTML || '';
      })()`);
      if (!input) throw new Error("Qoder 页面中找不到聊天输入框");
      const attachmentMetadata = await this.uploadAttachments(page, attachments);
      await page.evaluate(`(() => {
        const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]'));
        const node = nodes.find((item) => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
        if (node instanceof HTMLElement) { node.focus(); node.click(); }
      })()`);
      await page.insertText(String(text));
      const sent = await page.evaluate(`(() => {
        const labels = /send|发送|submit|提交/i;
        const button = Array.from(document.querySelectorAll('button, [role="button"]')).find((node) => labels.test(String(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '')) && !node.disabled);
        if (button instanceof HTMLElement) { button.click(); return true; }
        return false;
      })()`);
      if (!sent) await page.keyPress("Enter");
      return { accepted: true, attachments: attachmentMetadata };
    });
  }

  async start({ prompt, attachments = [] }) {
    await this.createSession();
    await 等待(250);
    const before = await this.inspect();
    const sendResult = await this.sendToPage(prompt, attachments);
    const after = await this.inspect();
    const selected = after.selected || before.selected;
    const id = 文本(selected?.id);
    if (!id || (before.selected?.id && id === before.selected.id && !(after.sessions || []).some((item) => item.id !== before.selected.id && item.selected))) {
      throw new Error("Qoder 未确认新会话已创建，已拒绝生成临时会话标识");
    }
    const run = this.createRun(id, prompt, sendResult.attachments);
    return { sessionID: id, run };
  }

  createRun(id, prompt, attachments = []) {
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    const eventQueue = new 事件队列();
    const run = { id, status: "running", summary: "", attachments, events: eventQueue, pendingApprovals: new Map(), startedAt: new Date().toISOString(), completion, resolve };
    this.runs.set(id, run);
    this.watchSession(run);
    void this.waitForVisibleReply(run, prompt);
    return run;
  }

  async waitForVisibleReply(run, prompt) {
    let previous = "";
    let stablePolls = 0;
    for (let i = 0; i < 600; i += 1) {
      await 等待(500);
      try {
        const state = await this.inspect();
        if (state.selected?.id && state.selected.id !== run.id) continue;
        const assistant = [...(state.messages || [])].reverse().find((item) => item.assistant)?.assistant;
        const reply = 文本(assistant?.content);
        if (reply && reply !== previous && !reply.includes(prompt)) {
          previous = reply;
          stablePolls = 0;
          run.summary = reply.slice(-2000);
        } else if (reply && reply === previous) {
          stablePolls += 1;
        }
        if (state.approval && !run.pendingApprovals.has(state.approval.approval_request_id)) {
          run.pendingApprovals.set(state.approval.approval_request_id, state.approval);
          run.status = "waiting_approval";
          const approvalEvent = { ID: `qoder:cdp:approval:${state.approval.approval_request_id}`, Type: "approval.required", Status: "waiting_approval", Summary: state.approval.title || "Qoder 需要用户选择", Payload: { approval: state.approval }, CreatedAt: new Date().toISOString() };
          run.events.push(approvalEvent);
        }
        if (i >= 8 && run.summary && stablePolls >= 6 && !state.busy && !state.approval) break;
      } catch { /* 页面刷新期间下一轮继续读取。 */ }
    }
    run.status = "completed";
    const event = { ID: `qoder:cdp:${randomUUID()}`, Type: "run.completed", Status: "completed", Summary: run.summary || "Qoder 已完成处理", Payload: {}, CreatedAt: new Date().toISOString() };
    run.events.push(event);
    run.events.close();
    run.resolve(event);
  }

  get(id) { const run = this.runs.get(id); if (!run) throw new Error(`未找到 Qoder CDP 会话：${id}`); return run; }

  async attach(id) {
    const sessionID = 文本(id);
    if (!sessionID) throw new Error("Qoder CDP 会话需要会话 ID");
    if (!this.runs.has(sessionID)) {
      let resolve;
      const completion = new Promise((done) => { resolve = done; });
      const run = { id: sessionID, status: "idle", summary: "", events: new 事件队列(), pendingApprovals: new Map(), startedAt: new Date().toISOString(), completion, resolve, watching: false };
      this.runs.set(sessionID, run);
      this.watchSession(run);
    }
    return this.runs.get(sessionID);
  }

  async watchSession(run) {
    if (run.watching) return;
    run.watching = true;
    let fingerprint = "";
    while (!this.closed && this.runs.get(run.id) === run) {
      try {
        const state = await this.inspect();
        if (state.selected?.id && state.selected.id !== run.id) {
          await 等待(750);
          continue;
        }
        const assistant = [...(state.messages || [])].reverse().find((item) => item.assistant)?.assistant;
        const body = 文本(assistant?.content || state.body);
        const currentFingerprint = createHash("sha256").update(body).digest("hex");
        if (fingerprint && currentFingerprint !== fingerprint && body) {
          run.summary = body.slice(-2000);
          run.events.push({ ID: `qoder:cdp:body:${currentFingerprint}`, Type: "assistant.message", Status: run.status === "running" ? "running" : "completed", Summary: run.summary, Payload: {}, CreatedAt: new Date().toISOString() });
        }
        fingerprint = currentFingerprint;
        if (state.approval && !run.pendingApprovals.has(state.approval.approval_request_id)) {
          run.pendingApprovals.set(state.approval.approval_request_id, state.approval);
          run.status = "waiting_approval";
          run.events.push({ ID: `qoder:cdp:approval:${state.approval.approval_request_id}`, Type: "approval.required", Status: "waiting_approval", Summary: state.approval.title || "Qoder 需要用户选择", Payload: { approval: state.approval }, CreatedAt: new Date().toISOString() });
        }
      } catch { /* Qoder 页面重载或 CDP 暂时断开时继续重试。 */ }
      await 等待(750);
    }
  }

  async send(id, text, _turnID = "", attachments = []) {
    await this.attach(id);
    await this.selectSession(id);
    const sendResult = await this.sendToPage(text, attachments);
    const run = this.get(id);
    let resolve;
    run.completion = new Promise((done) => { resolve = done; });
    run.resolve = resolve;
    run.events = new 事件队列();
    run.status = "running";
    run.attachments = sendResult.attachments;
    void this.waitForVisibleReply(run, text);
    return randomUUID();
  }

  async getSessionMessages(id) {
    await this.selectSession(id);
    const state = await this.inspect();
    const messages = [];
    for (const item of state.messages || []) {
      if (item.user?.content) messages.push({ id: item.user.id, role: "user", content: item.user.content, created_at: new Date().toISOString() });
      if (item.assistant?.content) messages.push({ id: item.assistant.id, role: "assistant", content: item.assistant.content, created_at: new Date().toISOString() });
    }
    if (messages.length) return messages.slice(-100);
    const blocks = String(state.body || "").split("\\n").map((item) => item.trim()).filter(Boolean);
    return blocks.slice(-100).map((content, index) => ({ id: `cdp-${id}-${index}`, role: index % 2 ? "assistant" : "user", content, created_at: new Date().toISOString() }));
  }

  async inspectDetails(sessionID = "") {
    const state = await this.withPage((page) => page.evaluate(页面脚本(true)));
    const run = sessionID && this.runs.get(sessionID);
    return {
      native_session_id: 文本(sessionID || state.selected?.id),
      current_model: state.controls?.current_model || null,
      model_options: state.controls?.model_options || [],
      current_reasoning: state.controls?.current_reasoning || null,
      reasoning_options: state.controls?.reasoning_options || [],
      current_permission: state.controls?.current_permission || null,
      permission_options: state.controls?.permission_options || [],
      approval: state.approval,
      interactive_surface: state.interactive_surface,
      run: run ? { status: run.status, preview: run.summary || "", started_at: run.startedAt } : { status: "idle" },
    };
  }

  async selectControl(action, target = {}) {
    const optionID = 文本(target?.option_id || target?.optionId || target?.id || target?.value);
    const label = 文本(target?.label || target?.name);
    const kind = action.split(".")[0];
    if (!optionID && !label) throw new Error("Qoder 控件选择缺少 option_id");
    return this.withPage(async (page) => {
      const result = await page.evaluate(`(async () => {
        const kind = ${JSON.stringify(kind)};
        const optionID = ${JSON.stringify(optionID)};
        const label = ${JSON.stringify(label)};
        const button = kind === 'model' ? document.querySelector('button[aria-label="模型"]') : kind === 'permission' ? document.querySelector('button[aria-label="访问权限"]') : null;
        if (button instanceof HTMLElement) {
          button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 100));
          const menu = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).at(-1);
          const menuItems = menu ? Array.from(menu.querySelectorAll('[role="menuitem"], [role="option"]')).filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }) : [];
          const node = menuItems.find((item, index) => {
            const values = [item.getAttribute('data-option-id'), item.getAttribute('data-value'), item.getAttribute('value'), item.innerText, item.getAttribute('aria-label'), kind + '-' + index].filter(Boolean).map(String);
            return (optionID && values.includes(optionID)) || (label && values.some((value) => value.split('\\n')[0].trim() === label));
          });
          if (node instanceof HTMLElement) {
            const rect = node.getBoundingClientRect();
            return { changed: true, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return { changed: false };
        }
        const controls = Array.from(document.querySelectorAll('[data-control="' + kind + '"] [data-option-id], [data-' + kind + '-id], select[data-' + kind + '] option, [role="option"]'));
        const node = controls.find((item) => {
          const values = [item.getAttribute('data-option-id'), item.getAttribute('data-' + kind + '-id'), item.getAttribute('data-value'), item.value, item.innerText, item.getAttribute('aria-label')].filter(Boolean).map(String);
          return (optionID && values.includes(optionID)) || (label && values.includes(label));
        });
        if (!(node instanceof HTMLElement)) return { changed: false };
        node.click();
        if (node.tagName === 'OPTION' && node.parentElement instanceof HTMLSelectElement) node.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { changed: true };
      })()`);
      if (!result?.changed) throw new Error("Qoder 控件选项已失效或当前页面不可见");
      if (result.point) {
        await page.clickPoint(result.point);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return result;
    });
  }

  async applyInteractiveSurface(target = {}) {
    const surfaceID = 文本(target?.surface_id || target?.surfaceId);
    const actionID = 文本(target?.action_id || target?.actionId);
    const input = 文本(target?.input || target?.value);
    if (!surfaceID || !actionID) throw new Error("交互面操作缺少 surface_id 或 action_id");
    return this.withPage(async (page) => {
      const result = await page.evaluate(`(async () => {
        const surfaceID = ${JSON.stringify(surfaceID)};
        const actionID = ${JSON.stringify(actionID)};
        const input = ${JSON.stringify(input)};
        const dialog = Array.from(document.querySelectorAll('[role="dialog"], dialog, [data-interactive-surface]')).find((node) => {
          const id = node.getAttribute('data-request-id') || node.getAttribute('data-approval-id') || node.getAttribute('data-interactive-surface-id');
          return id === surfaceID || (!id && ('qoder-surface:' + String(node.innerText || '').trim().slice(0, 160)) === surfaceID);
        });
        if (!(dialog instanceof HTMLElement)) return { changed: false, reason: 'surface_stale' };
        const field = dialog.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
        if (field && input) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) setter.call(field, input);
          else if (field instanceof HTMLElement) field.textContent = input;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));
        const button = buttons.find((node, index) => (node.getAttribute('data-action-id') || node.getAttribute('data-approval-action') || node.getAttribute('value') || 'action-' + index) === actionID);
        if (!(button instanceof HTMLElement) || button.disabled) return { changed: false, reason: 'action_stale' };
        button.click();
        return { changed: true };
      })()`);
      if (!result?.changed) throw new Error(`Qoder 交互面已失效：${result?.reason || "unknown"}`);
      return result;
    });
  }

  async resolveApproval(id, approvalID, actionID, input = "") {
    const detail = await this.inspectDetails(id);
    if (!detail.approval || detail.approval.approval_request_id !== approvalID) throw new Error("Qoder 审批请求已失效");
    return this.applyInteractiveSurface({ surface_id: approvalID, action_id: actionID, input });
  }

  async controlSession(id, action, target = {}) {
    if (action === "conversation.select") {
      await this.selectSession(id, target?.title || "");
      return { selected: true, thread_id: id };
    }
    if (action === "model.switch" || action === "reasoning.switch" || action === "permission.switch") {
      await this.selectControl(action, target);
    } else if (action === "interactive.surface.apply") {
      await this.applyInteractiveSurface(target);
    } else if (action === "interrupt") {
      await this.interrupt(id);
    } else {
      throw new Error(`Qoder CDP 不支持控制操作：${action}`);
    }
    return this.inspectDetails(id);
  }

  async interrupt(id) {
    const run = this.get(id);
    let clicked = false;
    try {
      await this.selectSession(id);
      const result = await this.withPage((page) => page.evaluate(`(() => {
        const visible = (node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
        const button = Array.from(document.querySelectorAll('button, [role="button"]')).find((node) => visible(node) && !node.disabled && /stop|停止生成|取消生成|中断/i.test(String(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '')));
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`));
      clicked = Boolean(result);
    } catch (error) {
      if (run.status === "running") throw error;
    }
    if (!clicked && run.status === "running") throw new Error("Qoder 页面未提供可用的中断控件");
    run.status = "interrupted";
    run.events.push({ ID: `qoder:cdp:interrupt:${randomUUID()}`, Type: "run.interrupted", Status: "interrupted", Summary: "Qoder 已中断", Payload: {}, CreatedAt: new Date().toISOString() });
    run.events.close();
  }
  async waitForRun(id) { return this.get(id).completion; }
  async close() { this.closed = true; this.pageInfo = null; for (const run of this.runs.values()) run.events.close(); this.runs.clear(); }
}
