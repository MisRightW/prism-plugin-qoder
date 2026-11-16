# Prism Plugin for Qoder

这个仓库提供 Qoder Desktop 的 Prism Hub 集成，默认通过本机 Chromium DevTools Protocol（CDP）控制已经登录的 Qoder 界面。

插件在 Qoder Desktop 已经以 `--remote-debugging-port` 启动时自动连接；未发现端点时会尝试启动 Qoder Desktop，并探测 `9222`、`9223`、`9224`、`9225` 和 `9333`。插件不会读取 Qoder 的令牌、Cookie 或会话数据库，也不要求用户另外安装或登录 Qoder CLI。

## 前置条件

1. Hub 使用 Node 22 运行插件。
2. Qoder Desktop 已经登录并保持打开。
3. 如果 Qoder 是由其他启动器先打开的，首次使用前请退出 Qoder，再由 Hub 插件自动启动，或用以下方式启动：

```bash
/Applications/Qoder.app/Contents/MacOS/Qoder --remote-debugging-port=9224
```

也可以在 Hub 插件环境中设置 `PRISM_QODER_CDP_URL` 为 CDP 页面 WebSocket 地址，或设置 `PRISM_QODER_CDP_PORT` 指定启动端口。

## 远程能力

- 消息：通过当前 Qoder composer 发送，并通过页面正文轮询确认回复和终态。
- 用户选项：读取页面声明的模型、推理和权限选项，Hub 使用 `model.switch`、`reasoning.switch`、`permission.switch` 控制并重新读取当前值。
- 附件和图片：Hub 先将附件物化为受控本地文件，插件只通过页面的文件输入控件上传；历史和事件只返回文件名、MIME 类型和图片/文件类别，不返回路径或二进制。
- 审批和交互面：读取当前可见的带原生请求标识的对话框，发布 `approval.required` 或 `interactive_surface`，只接受同一请求的 `approval_request_id + action_id` 回写。

Qoder 页面未暴露稳定身份时，插件会安全返回目标失效，不按按钮文案、列表顺序或轮询序号猜测会话、审批或选项。

## 本地验证

```bash
npm install --registry=https://registry.npmjs.org/
npm test
npm run probe
```

`probe` 即使报告 `available=false` 也是协议成功：它表示当前没有可发现的 Qoder CDP 页面。启动带 CDP 参数的 Qoder Desktop 后，Hub 会在下一次探测中自动显示为可用。

## Qoder IDE 桥接

构建并安装 VSIX：

```bash
npm --prefix ide-bridge install --registry=https://registry.npmjs.org/
npm run package:ide
'/Applications/Qoder IDE.app/Contents/Resources/app/bin/code' --install-extension ide-bridge/qoder-prism-bridge.vsix
```

VSIX 启动后在 `~/.qoder/prism/qoder-ide-bridge.json` 生成仅本机可读的描述文件，其中包含回环地址和随机令牌。插件会自动发现该文件；需要隔离或自定义位置时，Hub 也可通过 `PRISM_QODER_IDE_BRIDGE_FILE` 注入绝对路径。插件只将“桥接是否可用”和编辑器上下文返回给 Hub，绝不转发令牌。

当前桥接 API 有意保持最小：读取当前工作区、活动文件、选区位置，以及在 IDE 中打开指定文件。它不提供任意终端执行、任意文件写入，也不调用 Qoder IDE 的私有智能体 API。

## 发布

Release 前执行：

```bash
npm run verify-release
npm test
npm run probe
```

发布正式 GitHub Release 后，仍需由 Prism Registry 的 GitHub App 校验并由维护者审核插件目录和具体 Release，审核状态不由本仓库或本插件自行修改。
