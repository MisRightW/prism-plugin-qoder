import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 只使用 VSIX 写出的本机受限描述文件；令牌永不进入日志、事件或 Hub 响应。
 */
export class IdeBridgeClient {
  constructor({ descriptorPath = process.env.PRISM_QODER_IDE_BRIDGE_FILE || join(homedir(), ".qoder", "prism", "qoder-ide-bridge.json") } = {}) {
    this.descriptorPath = descriptorPath;
  }

  async descriptor() {
    if (!this.descriptorPath) return null;
    try {
      const data = JSON.parse(await readFile(this.descriptorPath, "utf8"));
      const url = new URL(String(data.url || ""));
      if (url.hostname !== "127.0.0.1" || !data.token) return null;
      return { url: url.toString().replace(/\/$/, ""), token: String(data.token) };
    } catch {
      return null;
    }
  }

  async request(path, init = {}) {
    const descriptor = await this.descriptor();
    if (!descriptor) throw new Error("未发现 Qoder IDE 本地桥接；请安装并启动 Prism Bridge for Qoder IDE");
    const response = await fetch(`${descriptor.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Qoder IDE 本地桥接请求失败");
    return body;
  }

  async status() {
    try {
      await this.request("/v1/context");
      return true;
    } catch {
      return false;
    }
  }

  async context() {
    return this.request("/v1/context");
  }

  async openFile(path, line) {
    await this.request("/v1/open-file", { method: "POST", body: JSON.stringify({ path, line }) });
  }
}
