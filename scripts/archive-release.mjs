import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { projectRoot, tarRelativePath } from "../src/path-utils.js";

const root = projectRoot(import.meta.url);
const target = process.argv[2];
const artifacts = resolve(root, process.argv[3] || "release-artifacts");
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (!target || !id || !version) throw new Error("需要目标平台、插件 ID 和版本号");
await mkdir(artifacts, { recursive: true });
const directory = `${id}-${version}-${target}`;
const artifact = resolve(artifacts, `${directory}.tar.gz`);
const result = spawnSync("tar", ["-czf", tarRelativePath(root, artifact), "-C", tarRelativePath(root, resolve(root, "release")), directory], { cwd: root, stdio: "inherit" });
if (result.status !== 0) throw new Error(`无法打包 ${target} 发布资产`);
console.log(artifact);
