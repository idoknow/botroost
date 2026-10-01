# 升级与备份

## 升级

固定源码 SHA 与镜像 digest。先测试构建与迁移；控制面部署顺序为数据库迁移、API/worker、Web；Agent 单独滚动升级，并观察心跳、命令收据和运行状态。

Agent 与协议端生命周期独立。更换 Agent 程序不需要清空登录数据或重建 NapCat。重启问题先定位，避免用反复重建掩盖故障。

## 备份

- PostgreSQL：定期备份并演练恢复。
- Agent：node-credential.json、agent-journal.jsonl、runtime-commands.json。
- NapCat：QQ/config 两个目录或对应 PVC。
- 部署配置：保留镜像 digest、Git SHA、存储类与出口配置。

QQ 数据冷备：先停止协议端，确认进程退出再拷贝。不要同时恢复成两份在线实例。备份含登录凭据，存放在受控位置。

## 验证

每次更新检查公网 UI、API、节点心跳、扫码状态、真实业务消息及日志。HTTP 200 不等于完整链路可用。
