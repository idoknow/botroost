# 故障排查

## 节点离线

检查 Agent 日志、CONTROL_PLANE_URL 的 DNS/TLS、持久凭据和系统时钟。首次注册失败检查 enrollment token 是否已使用。不要把同一凭据复制到第二台机器重试。

## 容器运行但 QQ 离线

区分进程与账号状态。查看 QR/loginError；扫码或处理 QQ 风控。不要把 liveness 配置为“QQ 必须在线”，否则会不断重启。

## 命令失败或卡住

查看操作 progress/结果、Agent 日志及运行对象。K8s 检查 Pending、PVC Bound、镜像拉取、Pod events、资源配额。检查旧实例仍是否运行，不直接删 PVC/finalizer。

## OneBot 未连接

核验反向 WS URL、token、DNS、出口策略及业务平台监听。正向 WS 核验监听地址与 Service targetPort，管理端口 6099 不是 OneBot 业务端口。

## Agent journal 锁

先确认没有存活的 Agent 持有状态目录。异常退出的锁需要运维核验后处理，禁止启动脚本无条件清理锁目录。保留 journal，避免丢失已执行命令记录。

## 日志和指标

日志是有界采样，不代表完整消息账本。metrics unavailable 表示未获取指标，不等于 CPU/内存为零。共享排查记录前脱敏 token、Cookie、二维码登录数据。
