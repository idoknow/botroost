# Kubernetes 安装

Kubernetes 驱动以 namespace 为运行池，使用 ServiceAccount 调用 API。每个协议端使用 StatefulSet、PVC、Secret 和 ClusterIP Service。NapCat 管理适配层与 Docker 相同。

::: warning 验证范围
该驱动需要在目标集群完成存储、网络策略、固定镜像和 QQ/OneBot 实测后再承载生产实例。不要自动迁移已有 Docker 实例。
:::

## 前置条件

- 批准的 worker 容量、可用 StorageClass 和可靠备份。
- 固定出口；跨节点可能改变 QQ 登录环境。
- 集群管理员预建 namespace、RBAC、配额和 NetworkPolicy。
- 每 pool 只运行一个 Agent；不配置 HPA。

使用 deploy/kubernetes/agent.yaml 作为安装基线。替换镜像为本次构建 agent-kubernetes target 的 digest，填写 Secret，配置 StorageClass 后部署：

```sh
docker build --target agent-kubernetes -t REGISTRY/botroost-agent:VERSION .
docker push REGISTRY/botroost-agent:VERSION
kubectl apply -f deploy/kubernetes/agent.yaml
kubectl -n botroost-system rollout status statefulset/botroost-agent
kubectl -n botroost-system logs botroost-agent-0 --tail=100
```

RUNTIME_NAMESPACE 指向运行池；RUNTIME_STORAGE_CLASS 可选，默认集群默认类；RUNTIME_VOLUME_SIZE 默认 2Gi。管理 6099 仅允许 Agent 访问。默认支持反向 WS，正向 WS 端口需管理员单独批准并配置 Service。

## 故障与数据

stop 缩容为 0，保留 PVC。restart 替换 Pod；节点失联不强制删除旧 Pod。RWO 不等于进程互斥，旧节点未隔离时禁止强行启动第二份登录实例。

local-path PVC 不支持透明跨节点迁移。删除是破坏性操作；PVC 长时间 Terminating 应检查 attachment/旧 Pod，而非直接删 finalizer。

当前资源统计在未提供 metrics 驱动时显示 unavailable，不使用假零值。高可用 Lease、自动迁移和大规模池调度不在首版安装基线内。
