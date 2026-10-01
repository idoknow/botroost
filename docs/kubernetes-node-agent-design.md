# Botroost Node Agent / NapCat Kubernetes 部署与改造设计

设计基线：idoknow/botroost main `68f29dde299136c780ed34d039912cf9f6b7cc5c`。状态：设计完成，尚未实现或部署。

## 一、结论

保留现有 Agent 出站命令协议，抽象 RuntimeDriver，增加 Kubernetes 原生驱动；保留 Docker 驱动兼容旧节点。K8s 下一个 Botroost node 表示一个受限 runtime pool，而不是物理服务器。每 pool 一个单活 Agent，每 endpoint 一个 0/1 副本 StatefulSet、独立 PVC、Secret 和内部 Service。

不使用 DinD，不挂 Docker/containerd socket，不通过 SSH 操作宿主机；Agent 不做 OneBot 消息中继。

## 二、现有通信链路（源码核验）

### 控制面与 Agent

`apps/agent/src/index.ts:284-329,923-1098`；`apps/agent/src/cli.ts:9-12`。

- 初次 POST `/api/v1/agent/enroll`，一次性 enrollment token 换 nodeId/nodeSecret/workspaceId，持久化 node-credential.json。
- Agent 主动 HTTP POST heartbeat、commands/claim，再回报 commands/:id/receipt、progress、result。不是控制面主动连接 Agent，也不是 WebSocket 命令通道。
- nodeSecret Bearer 认证；进程 sessionId 放在 x-agent-session-id；命令包含 workspaceId/nodeId/endpointId/generation/connectionEpoch/attempt。
- 无任务等待约 800–1200ms；观测调度间隔 5 秒；执行命令期间 10 秒心跳/进度保活。HTTP 默认 15 秒超时，runtime 操作默认 120 秒。
- FileAgentJournal 持久化 receipt/effect/result；NapCatRuntime 的 runtime-commands.json 恢复观测对象。DB 负责租约、会话和 generation fencing。

API 路由：`apps/api/src/index.ts:157-162`；数据库命令控制：`packages/database/src/index.ts:203-254`。

### Agent 与容器

`apps/agent/src/index.ts:70-205,390-653`。

- execFile 调 Docker CLI：inspect/create/start/stop/restart/kill/rm/logs/stats。
- 容器名 botroost-napcat-<endpointId>；操作前检查 workspace/endpoint/provider labels。
- 固定 NapCat image digest 与 approvedArtifactId 白名单。
- 宿主目录 bind mount 到 `/app/.config/QQ`、`/app/napcat/config`。
- 注入 NAPCAT_WEBUI_SECRET_KEY 和 proxy 环境变量；Docker 内部网络，不发布宿主端口。
- 最低 CPU 1000m、内存 1024Mi；Docker memory-swap 为内存加 512Mi。
- image/resource/proxy 漂移触发容器替换，保留目录；stop 保留数据，delete 删除目录。
- force-restart 使用 immutable container ID kill + start 同一个容器，不依赖 NapCat HTTP。现有文档明确承诺不重建容器，K8s 版本须调整能力说明。

### Agent 与 NapCat 管理面

`apps/agent/src/index.ts:555-577,628-707,747-877`。

目标为 inspect 得到的 `http://<containerIP>:6099`：

- POST `/api/auth/login`，提交 hash = SHA256(token + '.napcat')；读取 data.Credential，后续 Bearer 认证。按 endpoint 缓存，401/unauthorized 时刷新。
- QQ 信息：`/api/QQLogin/GetQQLoginInfo`、`/api/QQLogin/CheckLoginStatus`。
- 二维码：`/api/QQLogin/GetQQLoginQrcode`；仅用户显式刷新调用 `/api/QQLogin/RefreshQRcode`。
- OneBot 配置：`/api/OB11Config/GetConfig`、`/api/OB11Config/SetConfig`；合并 websocketClients/Servers，保留未修改 token。
- 只读 OneBot action：先 `/api/Debug/create`，然后 `/api/Debug/call/<adapterName>` 调 get_status/get_login_info/get_version_info/get_friend_list/get_group_list。
- 一般请求超时 10 秒，目录查询 45 秒；快照缓存 15 秒，目录默认缓存 5 分钟。

Agent 借 WebUI Debug HTTP adapter 调 OneBot，不通过业务 WebSocket 进行上述管理。`packages/provider-napcat/src/index.ts` 仍是 unavailable manifest，实际生产实现集中在 apps/agent/src/index.ts，改造必须针对后者。

### 业务与观测

NapCat websocketClients 主动连接 LangBot（反向 WS）；业务客户端连接 websocketServers（正向 WS）。配置成功并不自动发布端口。二维码/状态经 Agent 回写 DB，浏览器从 Botroost API 读取，不直连 6099。

traffic 来自 Docker logs 解析，存在截断与采样窗口；CPU/memory 来自 Docker stats。runtime ready、管理 API 可用、QQ 在线和下游 WS 已连接必须分开；当前 protocol=connected 不证明每条下游 WS 已建立。isLogin=false 且有 QR/loginError 是明确离线，信息不足才是 unknown。

## 三、已有部署与限制

已 fetch server-deploy origin/main `016966b` 并读取 kubernetes/asia/idoknow/botroost：

- resources.json 声明控制面与 PostgreSQL 在 idoknow / cn-gz-tencent-02，存在 botroost-api Service。
- agent.json 已声明 Agent K8s Deployment，但仍固定 JP09、hostNetwork、hostPath、Docker socket，是过渡形态。
- 公共入口保留 JP09 Caddy 与广州 tunnel/relay，不在本次 runtime 改造中顺手迁移。
- agent-admission.json 限制 idoknow 工作负载选择广州/上海，JP09 Agent 是特例；SA 仅允许 default/空，直接部署自定义 SA 的原生 Agent 会被策略拒绝。

上述为 Git 声明而非实时状态。本机无 kubectl context；旧 JP06/JP09 kubeconfig 指向不监听的 localhost:6443，广州 SSH 主机密钥校验失败。没有获得当前集群 capacity、StorageClass 和 NetworkPolicy enforcement；实际放置须实施前核验。没有修改 SSH trust、凭据或集群。

## 四、目标拓扑

```text
Browser → 原有 HTTPS 入口 → Web/API → PostgreSQL
                              ↑
                 HTTP heartbeat/claim/progress/result
                              │
                         Pool Agent
                         /         \
                 K8s API             Service DNS:6099
              生命周期/存储/日志         NapCat 管理 HTTP
                         \         /
                        NapCat endpoint Pod
                              ↕
                        OneBot WS 业务客户端
```

### 部署单元

- 控制面留在 idoknow，不搬 DB/入口。
- 新建 botroost-system 放 Agent；botroost-runtime-<pool> 放 NapCat。管理员/GitOps 预建 namespaces、Rancher project 归属、RBAC/admission/quotas/policies；Agent 无 namespace/RoleBinding 创建权限。
- 一 pool 一 nodeId、一套持久凭据、一 active Agent。共享 node 的 workspace 授权继续由 DB 管理；不能要求 endpoint.workspaceId 等于 enrollment workspaceId。
- 明确批准节点集合；首期优先固定一个有容量的 worker，稳定出口和 local PVC。不给 JP09/us03 默认新增重负载，不使用 Sydney Cloud 专属节点。
- pool namespace 是权限边界，shared pool 不宣称强租户隔离。需要强隔离时独立 workspace pool/namespace/SA，不先引入自动跨 namespace 权限管理。

每 endpoint 创建：

1. StatefulSet napcat-<uuid>，replicas 0/1，updateStrategy OnDelete，固定 digest，禁止多副本。
2. 显式 PVC napcat-data-<uuid>，QQ/config 两个子目录；受控 initContainer 初始化权限。PVC 不挂自动级联删除的 workload ownerReference。
3. ClusterIP 管理 Service（6099）和批准的 forward WS 端口；另建 governing headless Service。
4. 独立 Secret 保存 NapCat secret/必要代理凭据。新实例每 endpoint 独立 secret，旧实例迁移保持旧 secret 至验证完成；不写 annotation/日志/状态。
5. 无权限 runtime SA，automountServiceAccountToken=false；无 hostNetwork/hostPath/socket/privileged。

准入限制固定镜像、entrypoint、SA、卷形态、节点集合和资源上限；不允许用户透传 PodSpec。RuntimeDefault、no-new-privileges、最小 capabilities；固定 NapCat 镜像能否 non-root/readOnlyRootFilesystem 必须实测。

### 数据、资源和出口

- stop/restart/更新不删 PVC；delete 显式逐项删除数据并回读，不依赖 GC 默默删卷。
- 优先经验证支持 ReadWriteOncePod 的 CSI；否则 RWO + 单副本 + 明确 fencing。RWO 不是进程互斥锁。
- local-path 可作首期，但节点绑定，不承诺自动跨节点恢复。节点失联必须隔离旧进程后迁移，防双登录。
- endpoint 初始建议 requests/limits=1000m CPU、1024Mi memory；PVC 建议 2Gi，属起始容量建议。K8s 不照搬 Docker memory-swap。
- Agent 初始建议 requests=100m/256Mi，memory limit=512Mi，后续以实测并发/内存调优。
- pool 容量取批准节点余量、namespace quota、DB 业务 quota、观测延迟约束；实施前采集 allocatable 与已分配 requests，不能用空闲内存截图替代容量核算。
- QQ 出口变更可能重登/风控；固定节点或经验证出口网关。现有 HTTP_PROXY/ALL_PROXY 不证明 QQ 原生连接全部代理，需抓取真实连接验证。

## 五、Node Agent 代码改造

### 模块边界

新增/拆出：

- agent.ts：DurableAgent，移除 DurableFakeAgent 命名及 instanceof NapCatRuntime 耦合。
- runtime/types.ts：RuntimeDriver、EndpointRef、OperationContext、RuntimeInstance。
- runtime/docker.ts：现有 Docker CLI/host storage 实现。
- runtime/kubernetes.ts：官方 client、in-cluster SA、超时取消、list/watch/relist。
- runtime/kubernetes-resources.ts：纯函数生成受控 manifests。
- napcat/client.ts：认证、QQ/QR/Debug/OB11Config HTTP，无 Docker/K8s 依赖。
- napcat/runtime.ts：provider 编排与缓存，依赖 RuntimeDriver。

RuntimeDriver 提供 inspect、ensure、setRunning、restart、delete、managementTarget、logs、usage；不要让 K8s 实现伪装成 DockerClient。EndpointRef 带 workspace/node/endpoint；OperationContext 带 command/generation/epoch/attempt/signal；RuntimeInstance 带 workload UID/Pod UID/containerID/observedGeneration。

新增 AGENT_RUNTIME=docker|kubernetes，AGENT_PROVIDER=napcat 保留。K8s namespace/节点/storage profile 为平台配置，command.metadata 不能任意覆盖。

### 操作与成功判据

- start：幂等确保 Secret/PVC/Services/StatefulSet，replicas=1，等待目标 revision 容器 Running，再分别探测 API/QQ。已有 stopped 实例也必须恢复运行。
- stop：replicas=0，确认旧 Pod 终止；超时仍 reconciling，保留数据。
- restart：patch 目标 spec，再按 UID 删除旧 Pod，等新 UID/revision；OnDelete 防自动 rollout 和手动删除造成双重重启。
- force-restart：K8s 语义为受控替换 Pod、保留 PVC，不保留 container ID。API/UI capability 与 docs/force-restart.md 同步说明；不授 pods/exec 来模拟 Docker。
- 不将强制 API 删除记录当成旧进程已死。节点正常时缩短 grace 并确认旧执行点终止；节点失联返回 blocked，需节点/存储 fencing 后恢复，禁止生成第二份 QQ 实例。
- QR/WS 配置保留现有 HTTP API，仅由 managementTarget 提供内部 Service 地址。
- proxy 更新 Secret 与配置摘要并受控替换；desiredState=stopped 时维持 0 副本。
- logs 用 pods/log，限定 container/UID/tail/since/bytes/timestamps，保持脱敏。
- delete：确认停机→删 workload/services/secret→按策略删 PVC，各步回读；Terminating/detach 未完成不能报删除成功。

### 幂等、崩溃与 fencing

- 保留 session/epoch/generation fence，副作用前校验取消信号；丢租约后不再发后续写入。
- 稳定对象名与 workspace/node/endpoint labels；操作前校验 UID/归属；PATCH resourceVersion CAS，DELETE UID/resourceVersion preconditions。
- journal 需写 intent：commandId、旧 Pod UID、目标 config hash/revision；副作用完成而 recordEffect 尚未写入时崩溃，重放通过实际状态收敛，不能再重启一轮。
- 独立 desired-runtime inventory，不用最近的 read-logs/refresh-qr 命令覆盖期望配置；分别记录 appliedGeneration/pendingGeneration。
- Agent 单副本 StatefulSet + PVC + namespaced Lease + API session fence。Lease 只是协调，不是物理进程死亡证明；丢租约 fail-closed，旧节点不明时不自动双活。
- 当前 FileAgentJournal 的 mkdir lock 在 SIGKILL 后可残留，owner 只有 PID/时间/nonce。跨 Pod 不能用 PID 判活；增加 Pod UID/boot identity 与受控 stale lock recovery，或经过验证的 SQLite/WAL。禁止 initContainer 无条件删锁。
- 首版每次仍 claim 一条，心跳/轻量观测从慢操作解耦，probe 有界并发。现有 heartbeat 最多 200 runtimes，首版 pool 不超此上限；未来扩容需分页/快照完整性协议。

### 观测和探针

runtime 从 Pod/container/revision 推导；provider 看管理 API；protocol 看 QQ/OneBot；convergence 比对实际与期望。NapCat startup/readiness 检查进程/6099，不以 QQ 是否扫码作为健康门槛；liveness 不依赖 QQ/下游网络。控制面故障不反复重启健康 Agent/NapCat。

CPU/memory 改读 namespace 范围 metrics.k8s.io，缺失上报 unavailable/observedAt，不能填 0。traffic cursor 按 Pod UID/container restart 分开，重启标 reset/partial，必要时有界读取 previous logs。watch 处理 410 relist/429/backoff，写之前仍回读对象。

### 跨模块兼容

- agent-protocol：版本化 runtime/capabilities/restart semantic。现有 strict Zod schema 要先服务端兼容后新 Agent 上报。
- runtime-sdk：新增平台批准 persistent storage profile，保留旧 ephemeral 兼容；现有 schema 只有 none/ephemeral。
- database/API：node driver/pool/capabilities；runtimeRequestForProvider 改为同时考虑 node backend，shared-node 授权保留。
- worker：按节点能力生成命令，分类 deadline（拉镜像/调度可能超 120 秒），继续总 deadline 和进度续租。
- Web/API：明确 Pod 替换、存储/调度失败、WS 暴露范围；不开放任意 K8s spec。
- Dockerfile：新增无 Docker CLI 的 K8s Agent target，直接 non-root entrypoint；现有 node-entrypoint 用 setpriv，不能直接 runAsNonRoot 就假设可运行。

## 六、网络和权限

- Agent→API 走现有内部 Service，不绕 JP09 relay；优先内部 TLS，明文仅限批准隔离网络。
- Agent→K8s API 使用 CA 校验与短期 projected token。
- Agent→NapCat 6099 仅精确 namespace+podSelector 放行；不接受任意管理 URL。
- NapCat 禁访问管理 API、cloud metadata、其他 endpoint 6099；允许 DNS、QQ 与批准业务目标。QQ 动态域名不能用普通 NetworkPolicy 静态 IP 列表假装解决，需核验 CNI FQDN/公网 egress 方案。
- reverse WS 优先；URL/代理校验要覆盖私网允许清单、metadata、DNS rebinding，网络策略兜底。
- forward WS 首版内部 ClusterIP，端口白名单且不能占 6099；验证监听地址及 Service targetPort。
- 外部 forward WS 为显式 opt-in，独立 WSS 域名复用既有 Ingress，token/连接配额/超时；不自动 NodePort、不开放 6099。

Agent Role 仅 runtime namespace 的 StatefulSets、Pods、Services、PVC、Secrets 必需读写；pods/log get，Pods delete；无 pods/exec/attach/portforward。Secret 尽量不 list/watch。system namespace 只固定 Lease 操作；metrics 仅 runtime namespace；无 cluster-admin、namespace/Role/RoleBinding/SA 创建权限。

RBAC 不支持按 label 隔离动态对象，namespace 才是权限边界；准入约束可引用 Secret/PVC/SA。Agent 身份在 system namespace，NapCat 无法通过自己 namespace 卷挂载取得。新增 namespaces 独立 policy，不放宽 idoknow 现有共享规则。

## 七、交付与迁移

1. 先拆驱动与 HTTP client，Docker 行为保持，现有回归全部通过。
2. 新增 K8s driver、契约测试、isolated namespace 真 API 测试。
3. 实施前完成实时集群权限/容量/SC/备份/CNI/架构检查；批准实际 pool worker。
4. Botroost main 合入，构建 SHA/digest 镜像；部署清单走 server-deploy/kubernetes/asia/idoknow/botroost。schema migration Job 先于新服务；不手改 live image。
5. 新注册 K8s pool，旧 Docker node 保留，仅新建测试 endpoint。完整扫码、真实消息、状态、WS、日志、proxy、restart、崩溃恢复验证。
6. 逐 endpoint 专用迁移流程：冻结操作→停旧进程→冷拷贝 QQ/config 与权限/清单校验→事务切换 node/backend、提升 generation、作废旧命令→旧 Agent retire inventory/tombstone→新 pool 启动验证。
7. 现有系统没有已确认的 backend 迁移 API，必须明确开发；不能直接 SQL 改 nodeId 就视为完成。
8. 回滚先停止新执行点再恢复旧绑定；禁止双登录/双向在线同步。新状态回拷策略明确，QQ 可能需重新扫码。
9. 稳定后另行批准清理旧目录、JP09 socket/hostPath 特例；入口 relay 迁移保持独立任务。

## 八、验收

自动测试覆盖两驱动契约、NapCat auth/QQ 三态/QR/secret 保留、manifest 安全、UID/workspace fence、CAS 冲突、执行后 journal 前崩溃重放、旧 session 拒绝、metrics unavailable、Pending/PVC 错误、节点分区不双开。

真实集群验证：完整扫码与双向 OneBot 消息；stop/start/restart/proxy 更新数据保留；Agent SIGKILL 后 journal 安全恢复；控制面失联不影响业务；Pod/Agent 升级不产生重复实例；NetworkPolicy 越权实际拒绝；外网不能访问 6099；无 runtime SA token；至少一个 endpoint 备份恢复演练。Git main SHA、镜像 digest、GitOps 和实际 Pod imageID 对齐，公网 UI 操作有真实集群副作用闭环。

## 九、本次验证记录

- Linux chan / GitHub dadachann 拉取 idoknow/botroost，干净 main fast-forward 至上述基线。
- 独立 worktree `/home/chan/code/projects/botroost-k8s-design`，分支 docs/kubernetes-node-agent。
- bun install --frozen-lockfile 成功。
- bun x vitest run apps/agent/test packages/agent-protocol/test：8 个测试文件、92 tests passed。
- 仅新增设计文档，未实现 K8s driver、未推送、未部署、未迁移任何实例。
