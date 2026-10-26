import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../src/path-utils.js";

test("项目根路径正确解码 file URL", () => {
  const root = projectRoot("file:///tmp/prism%20plugin/scripts/probe.mjs");
  assert.equal(root, fileURLToPath("file:///tmp/prism%20plugin/"));
  assert.ok(!root.includes("%20"));
});
