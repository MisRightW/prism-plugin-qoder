import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectRoot, tarRelativePath } from "../src/path-utils.js";

test("项目根路径正确解码 file URL", () => {
  const root = projectRoot("file:///tmp/prism%20plugin/scripts/probe.mjs");
  assert.equal(root, fileURLToPath("file:///tmp/prism%20plugin/"));
  assert.ok(!root.includes("%20"));
});

test("tar 参数使用仓库内相对路径", () => {
  assert.equal(tarRelativePath("/tmp/prism-plugin", "/tmp/prism-plugin/release-artifacts/qoder.tar.gz"), "release-artifacts/qoder.tar.gz");
  assert.ok(!tarRelativePath("/tmp/prism-plugin", "/tmp/prism-plugin/release-artifacts/qoder.tar.gz").includes(":"));
});
