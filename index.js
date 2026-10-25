import { serve } from "@rokid-prism/pluginbridge-plugin-sdk";
import { QoderAdapter } from "./src/qoder-adapter.js";

serve(new QoderAdapter()).catch((error) => {
  // 标准输出是 PluginBridge 协议通道，错误只能写入标准错误。
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
