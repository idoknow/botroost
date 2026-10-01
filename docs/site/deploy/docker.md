# Docker Compose 安装

要求 Linux、Docker Engine 和 Compose plugin。Agent 挂载 Docker socket，因此该安装方式适用于可信专用主机。

在仓库根目录：

```sh
cp deploy/agent.env.example deploy/agent.env
# 编辑 deploy/agent.env：控制面地址、注册 token、NapCat secret
chmod 600 deploy/agent.env
docker compose --env-file deploy/agent.env -f deploy/agent.compose.yml up -d --build
docker compose --env-file deploy/agent.env -f deploy/agent.compose.yml logs --tail 100 agent
```

BOTROOST_STATE_DIR 必须是宿主机绝对路径；容器内与宿主路径保持一致，NapCat bind mount 才能读取正确目录。不要删除状态目录来修复登录问题。

停止 Agent 不会自动停止正在运行的 NapCat。卸载前先在控制面处理协议端，再执行 compose down；默认保留宿主数据。
