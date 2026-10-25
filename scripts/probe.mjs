import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const child = spawn(process.execPath, ["index.js"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const response = await new Promise((resolveResponse, reject) => {
  const timer = setTimeout(() => reject(new Error(`probe 超时：${stderr}`)), 15000);
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const line = buffer.split("\n").find((value) => value.trim());
    if (!line) return;
    clearTimeout(timer);
    try { resolveResponse(JSON.parse(line)); } catch (error) { reject(error); }
  });
  child.once("error", reject);
  child.stdin.end('{"id":"local-probe","method":"adapter.probe","params":{}}\n');
});
if (response.id !== "local-probe" || response.ok !== true || response.payload?.plugin_id !== "qoder") throw new Error(`probe 响应无效：${JSON.stringify(response)}`);
console.log(`Qoder PluginBridge 探测通过；available=${Boolean(response.payload.available)}`);
