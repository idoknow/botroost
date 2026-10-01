# 部署总览

## 控制面

仓库 deploy/compose.yml 提供已有控制面部署模板。部署前配置数据库、控制面 URL 和认证相关环境变量；先执行数据库迁移，再启动 API、worker 和 Web。不要将开发数据库凭据直接用于公网环境。

## Node Agent

- [Docker Compose](/deploy/docker)：单机安装，Agent 通过宿主 Docker 管理 NapCat。
- [Linux systemd](/deploy/systemd)：源码构建，系统服务守护 Agent。
- [Kubernetes](/deploy/kubernetes)：集群原生运行层，无 Docker socket。

所有模式复用相同 enrollment、心跳和命令协议，均由 Agent 主动访问控制面。NapCat 管理请求留在节点/集群内部。

## 基本配置

| 变量 | 用途 |
| --- | --- |
| CONTROL_PLANE_URL | Agent 可访问的 API 根地址 |
| NODE_STATE_DIR | 持久化凭据、journal 和运行清单 |
| ENROLLMENT_TOKEN | 首次注册的一次性 token |
| AGENT_PROVIDER | napcat 或测试用 fake |
| AGENT_RUNTIME | docker（默认）或 kubernetes |
| NAPCAT_TOKEN | NapCat 管理认证 secret |

所有实例固定镜像 digest；版本升级先测试，再更新批准的制品。请勿同时启动使用同一数据目录的两个 Agent。
