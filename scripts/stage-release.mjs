import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRoot } from "../src/path-utils.js";

const root = projectRoot(import.meta.url);
const platform = process.env.PRISM_PLATFORM;
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (!platform || !id || !version) throw new Error("需要 PRISM_PLATFORM、插件 ID 和版本号");

const destination = resolve(root, "release", `${id}-${version}-${platform}`);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of ["index.js", "src", "node_modules", "package.json", "package-lock.json", "pluginbridge-plugin.yaml", "README.md", "LICENSE"]) {
  await cp(resolve(root, entry), resolve(destination, entry), { recursive: true });
}
const vsix = resolve(root, "ide-bridge", "qoder-prism-bridge.vsix");
try {
  await cp(vsix, resolve(destination, "qoder-prism-bridge.vsix"));
} catch {
  // CI 在没有 IDE 构建依赖时会明确失败，避免发布不完整的桥接安装包。
  throw new Error("缺少 Qoder IDE bridge VSIX，请先运行 npm run package:ide");
}
console.log(destination);
