import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";

export function projectRoot(metaUrl) {
  return fileURLToPath(new URL("..", metaUrl));
}

export function tarRelativePath(root, target) {
  const value = relative(root, target);
  if (/^[A-Za-z]:/.test(value)) throw new Error("tar 归档路径必须位于插件仓库所在磁盘");
  return value.split(sep).join("/");
}
