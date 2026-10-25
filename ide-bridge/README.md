# Prism Bridge for Qoder IDE

本扩展为 Prism Qoder 插件提供受限的本机 IDE 桥接：读取工作区和当前编辑器元数据，以及在 IDE 中打开文件。

扩展只监听 `127.0.0.1` 的随机端口，启动时生成随机令牌。令牌只写入扩展私有的本机描述文件，供同一用户运行的 Prism Hub 读取，不会通过网络、日志或 Qoder Agent 会话发送。
