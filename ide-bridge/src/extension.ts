import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";

interface BridgeDescriptor {
  version: 1;
  url: string;
  token: string;
  created_at: string;
}

let server: Server | undefined;
let descriptorPath = "";
let bridgeToken = "";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${bridgeToken}`;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const part of request) {
    body += String(part);
    if (body.length > 32 * 1024) throw new Error("请求正文过大");
  }
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function contextSnapshot(): Record<string, unknown> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.selection;
  return {
    workspace_folders: (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
    active_file: editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : "",
    language_id: editor?.document.languageId || "",
    selection: selection ? {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
      is_empty: selection.isEmpty,
    } : null,
  };
}

async function openFile(body: Record<string, unknown>): Promise<void> {
  const path = typeof body.path === "string" ? body.path : "";
  if (!path) throw new Error("path 不能为空");
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const line = Number(body.line);
  if (Number.isInteger(line) && line >= 1 && line <= document.lineCount) {
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

function requestHandler(request: IncomingMessage, response: ServerResponse): void {
  void (async () => {
    if (!authorized(request)) return send(response, 401, { error: "未授权" });
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/context") return send(response, 200, contextSnapshot());
    if (request.method === "POST" && url.pathname === "/v1/open-file") {
      await openFile(await readBody(request));
      return send(response, 200, { ok: true });
    }
    return send(response, 404, { error: "未找到接口" });
  })().catch((error) => send(response, 400, { error: error instanceof Error ? error.message : String(error) }));
}

async function persistDescriptor(url: string): Promise<void> {
  const descriptor: BridgeDescriptor = { version: 1, url, token: bridgeToken, created_at: new Date().toISOString() };
  await writeFile(descriptorPath, JSON.stringify(descriptor), { encoding: "utf8", mode: 0o600 });
  await chmod(descriptorPath, 0o600);
}

async function startBridge(context: vscode.ExtensionContext): Promise<void> {
  if (server) return;
  bridgeToken = randomBytes(32).toString("base64url");
  // 使用稳定且私有的用户目录，Hub 无需获知 VS Code 的内部 globalStorage 路径。
  const home = process.env.USERPROFILE || process.env.HOME || context.globalStorageUri.fsPath;
  const descriptorDirectory = join(home, ".qoder", "prism");
  await mkdir(descriptorDirectory, { recursive: true, mode: 0o700 });
  descriptorPath = join(descriptorDirectory, "qoder-ide-bridge.json");
  server = createServer(requestHandler);
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得本地桥接端口");
  await persistDescriptor(`http://127.0.0.1:${address.port}`);
}

async function stopBridge(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  bridgeToken = "";
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand("qoderPrism.startBridge", async () => {
      await startBridge(context);
      void vscode.window.showInformationMessage("Prism 的 Qoder IDE 本地桥接已启动");
    }),
    vscode.commands.registerCommand("qoderPrism.stopBridge", async () => {
      await stopBridge();
      void vscode.window.showInformationMessage("Prism 的 Qoder IDE 本地桥接已停止");
    }),
    { dispose: () => { void stopBridge(); } },
  );
  await startBridge(context);
}

export function deactivate(): Thenable<void> | undefined {
  return stopBridge();
}
