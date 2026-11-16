import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const 默认端口 = Number(process.env.PRISM_QODER_CDP_PORT || 9224);
const 默认路径 = process.platform === "darwin"
  ? "/Applications/Qoder.app/Contents/MacOS/Qoder"
  : process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || "", "Programs", "Qoder", "Qoder.exe")
    : "qoder";

function 文本(value) { return typeof value === "string" ? value.trim() : ""; }
function 等待(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function qoderExecutable(env = process.env, platform = process.platform) {
  if (文本(env.PRISM_QODER_APP_PATH)) return env.PRISM_QODER_APP_PATH;
  if (platform === "darwin") return "/Applications/Qoder.app/Contents/MacOS/Qoder";
  if (platform === "win32") return join(env.LOCALAPPDATA || "", "Programs", "Qoder", "Qoder.exe");
  return "qoder";
}

export function cdpBaseURL(env = process.env) {
  const configured = 文本(env.PRISM_QODER_CDP_URL);
  if (configured && !/^wss?:\/\//i.test(configured)) return configured.replace(/\/$/, "");
  return `http://127.0.0.1:${Number(env.PRISM_QODER_CDP_PORT || 默认端口)}`;
}

async function cdpReady(baseURL, fetcher = globalThis.fetch) {
  for (const path of ["/json/version", "/json/list"]) {
    try {
      const response = await fetcher(`${baseURL}${path}`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return true;
    } catch {
      // 端点尚未就绪，继续等待。
    }
  }
  return false;
}

async function qoderPids(executable) {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
    const needle = executable.includes("/") ? executable : "/" + executable;
    return stdout.split("\n").map((line) => line.trim()).flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match || Number(match[1]) === process.pid) return [];
      const command = match[2];
      if (/--type=|crashpad_handler/i.test(command)) return [];
      return command.includes(needle) || /(?:^|\/)Qoder(?:\.app)?(?:\/|\s|$)/i.test(command) ? [Number(match[1])] : [];
    });
  } catch {
    return [];
  }
}

async function stopExistingQoder(executable) {
  if (process.env.PRISM_QODER_RESTART_EXISTING === "false") return;
  const pids = await qoderPids(executable);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* 进程可能已退出。 */ }
  }
  if (pids.length) await 等待(800);
}

export async function launchQoder({ env = process.env, platform = process.platform, fetcher = globalThis.fetch } = {}) {
  const baseURL = cdpBaseURL(env);
  if (await cdpReady(baseURL, fetcher)) return { started: false, reused: true, baseURL };
  const executable = qoderExecutable(env, platform);
  if (platform !== "linux" && !existsSync(executable)) throw new Error(`找不到 Qoder Desktop：${executable}`);
  await stopExistingQoder(executable);
  const port = Number(env.PRISM_QODER_CDP_PORT || 默认端口);
  const args = [`--remote-debugging-port=${port}`, "--no-first-run"];
  if (文本(env.PRISM_QODER_USER_DATA_DIR)) args.push(`--user-data-dir=${env.PRISM_QODER_USER_DATA_DIR}`);
  const child = spawn(executable, args, { detached: false, stdio: "ignore", env: { ...env } });
  child.unref();
  for (let index = 0; index < 60; index += 1) {
    if (await cdpReady(baseURL, fetcher)) return { started: true, reused: false, baseURL, pid: child.pid };
    await 等待(250);
  }
  throw new Error(`Qoder 已启动但 CDP 端点未就绪：${baseURL}`);
}

async function main() {
  const env = { ...process.env };
  const result = await launchQoder({ env });
  console.error(`Qoder Desktop 已${result.reused ? "复用" : "启动"}，CDP：${result.baseURL}`);
  // launcher 作为 Hub 的前台服务运行；Qoder 退出后由就绪探测自然失败，Hub 会重新托管。
  while (await cdpReady(result.baseURL)) await 等待(1000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
