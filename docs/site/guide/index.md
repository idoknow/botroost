# Botroost

Botroost 是机器人协议端的控制平台。控制面负责身份、工作区、操作队列和状态；Node Agent 管理运行实例；NapCat 提供 QQ 登录及 OneBot 连接。

## 开始

1. 部署控制面或登录已有平台。
2. 在目标工作区创建节点接入凭据。
3. 选择一种 [Agent 安装方式](/deploy/)，使用一次性 enrollment token 启动。
4. 确认节点在线，再创建 NapCat 协议端。
5. 启动、扫码，并配置业务端 OneBot WebSocket。

控制面的状态不是业务连通性的替代：节点在线、进程运行、QQ 在线、业务 WS 连接需要分别确认。
