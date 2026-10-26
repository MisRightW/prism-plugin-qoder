import { fileURLToPath } from "node:url";

export function projectRoot(metaUrl) {
  return fileURLToPath(new URL("..", metaUrl));
}
