# Linux systemd 安装

要求 Node.js 22、Bun、Docker Engine，以及能够访问 Docker 的可信 botroost 用户。Docker 组权限相当于宿主管理权限。

先在固定版本的源码目录构建：

```sh
bun install --frozen-lockfile
bun run build
sudo bash deploy/install-systemd.sh
```

编辑环境文件，设置 NODE_STATE_DIR=/var/lib/botroost、CONTROL_PLANE_URL、ENROLLMENT_TOKEN、NAPCAT_TOKEN。安装脚本会创建服务用户、复制程序到 /opt/botroost 并设置状态目录权限；不会自动启动，也不会覆盖已有环境文件。

```sh
sudo install -m 644 deploy/botroost-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now botroost-agent
sudo journalctl -u botroost-agent -n 100 --no-pager
```

服务文件默认 User=botroost；管理员需事先创建该用户并授予 Docker 访问权限。升级时先停 Agent，再替换程序，保留 /var/lib/botroost，最后启动。不要同时启动 Compose 和 systemd 管理同一节点。
