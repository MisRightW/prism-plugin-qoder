# Prism Plugin for Qoder

这个仓库提供 Qoder 的 Prism Hub 集成，采用两个互补的公开接口：

- `native`：通过官方 `@qoder-ai/qoder-agent-sdk` 和 `qodercli` 托管 Qoder Agent 会话。
- `ide-bridge`：一个 Qoder IDE VSIX，只在本机回环地址暴露工作区上下文和“打开文件”能力。

插件不会读取 Qoder Desktop、Qoder IDE 或浏览器的登录令牌、Cookie 和会话数据库。Qoder CLI 登录是独立前置条件。

## 前置条件

1. Hub 使用 Node 22 运行插件。
2. 安装 Qoder CLI，并完成 `qodercli login`；或在 Hub 启动插件的环境中设置 `QODER_PERSONAL_ACCESS_TOKEN`。
3. 当 CLI 不在 `PATH` 时，设置 `PRISM_QODER_CLI_PATH` 为可执行文件的绝对路径。

仅安装或登录 Qoder Desktop 不满足以上认证条件。

## 本地验证

```bash
npm install --registry=https://registry.npmjs.org/
npm test
npm run probe
```

`probe` 即使报告 `available=false` 也是协议成功：它表示本机尚未安装或登录 Qoder CLI。完成 CLI 登录后，Hub 会在下一次探测中自动显示为可用。

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
