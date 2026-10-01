# 运行层与协议适配

```text
控制面 → 命令协议 → Durable Agent → Runtime Driver
                         │              ├─ Docker
                         │              └─ Kubernetes
                         └─ NapCat 管理适配 → QQ / OneBot
```

## 中间层异构

RuntimeDriver 负责实例生命周期、存储、管理地址、日志和资源采样。协议适配层负责 NapCat HTTP 认证、二维码、QQ 状态、OneBot 配置与 Debug API。Kubernetes 不复制一份协议适配器，也不通过 pods/exec 实现 HTTP 控制。

接口与实现位于 apps/agent/src/runtime。现有 Docker 路径保留兼容，新驱动由 AGENT_RUNTIME 选择。未知配置直接报错，不能静默回落到 Docker。

## 命令语义

控制面通过 generation、connectionEpoch、attempt 与 session 拒绝过期操作。Agent 保存 receipt/effect/result，命令重放要检查真实执行状态。K8s restart-operation 标记避免重放重复删除已经替换的 Pod。

资源更新使用 resourceVersion，删除使用 UID precondition。namespace 是权限边界；RBAC 本身不能按 label 隔离多个租户。

## 扩展协议

新协议提供管理操作和观测实现，并声明固定制品/资源需求。不要让协议适配器读取宿主 Docker socket 或操作 Kubernetes RBAC。业务 WebSocket 留在协议端与客户端之间，Agent 不成为消息中继。

## 测试

驱动测试覆盖 manifest、资源归属、停启、重放及错误路径；协议测试覆盖凭据刷新、QQ 三态、QR 和配置 token 保留。除单元测试外，发布前必须在实际后端验证持久化、网络隔离和真实消息。
