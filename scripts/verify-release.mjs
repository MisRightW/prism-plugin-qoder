import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const manifest = await readFile(new URL("pluginbridge-plugin.yaml", root), "utf8");
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const field = (name) => manifest.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^(?:"|')|(?:"|')$/g, "");
const required = ["id", "schema_version", "version", "plugin_protocol_version", "min_hub_version", "icon_url", "icon_svg_url"];
for (const name of required) if (!field(name)) throw new Error(`manifest 缺少 ${name}`);
if (field("id") !== "qoder") throw new Error("插件 ID 必须为 qoder");
if (field("version") !== pkg.version) throw new Error("manifest 与 package.json 版本不一致");
if (field("schema_version") !== "1" || field("plugin_protocol_version") !== "4") throw new Error("manifest 协议版本不符合 Prism 要求");
if (!manifest.includes('command: ["${runtime.node}"')) throw new Error("Node 插件必须使用 Hub 托管 Node 运行时");
console.log(JSON.stringify({ id: field("id"), version: field("version"), protocol: field("plugin_protocol_version") }));
