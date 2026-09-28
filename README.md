# GroupOps — 多账号群组消息平台

后端（Node.js + TypeScript + PostgreSQL）+ 操作控制台（React 18 + TypeScript + Vite），以及按题目 §2 约定实现的**消息网关 mock** 和 **Agent 服务 mock**。

```
frontend/   React 控制台（登录 / 账号 / 群组 / 群详情 / Agent 运行详情 / 序列）
backend/    API + WebSocket + 网关事件消费 + outbox + Agent 运行器 + 序列调度
mocks/      gateway.ts（§2.1，HTTP + SSE）  agent.ts（§2.2，tool-use 协议）
```

## 跑起来

需要 Node 22+、pnpm 9+、Docker。

```bash
pnpm install
pnpm db:up            # docker compose 起 Postgres（端口 55432）
pnpm migrate          # 可重复执行

# 四个终端（或后台）
pnpm mock:gateway     # :4001
pnpm mock:agent       # :4002
pnpm dev:backend      # :3000
pnpm dev:frontend     # :5173  → 打开 http://localhost:5173
```

登录：`admin/admin`（全部权限）、`viewer/viewer`（只读）。预置账号 `acc_01`…`acc_06`。

环境变量：`PORT` / `DATABASE_URL` / `GATEWAY_URL` / `AGENT_URL`（默认值见 `backend/src/config.ts`），另有 `AGENT_TURN_TIMEOUT_MS`（默认 12000，题目要求 10–15s 可配）。

> mock 网关是内存实现，重启会丢状态、eventId 从 1 重来（真实网关保留全部历史）。重启 mock 后请 `pnpm db:reset` 清掉开发库，否则游标对不上。

### 演示一遍

1. 账号页把 `acc_01`–`acc_03` 点"重连"。
2. 群组页创建群：群主 `acc_01`，成员 `acc_02`、`acc_03` → 等 job 完成，`acc_02` 自动成为 admin。
3. 进群详情，勾上 "Agent 自动回复"。
4. 模拟外部用户发言（网关 mock 的注入接口）：
   ```bash
   curl -XPOST localhost:4001/__inject/message -H 'content-type: application/json' \
        -d '{"groupId":"g_1","text":"有人在吗"}'
   ```
   时间线实时出现消息，随后出现 agent run 和它的回复。消息里带 `[agent:bad]` / `[agent:retry-key]` / `[agent:loop]` / `[agent:kick]` 等标签可以切换 mock agent 的剧本（见 `mocks/src/agent.ts`）；网关故障（429、504、重复推送、群禁言…）用 `POST :4001/__control` 打开（见 `mocks/src/gateway.ts` 顶部 `defaults()`）。

## 测试

```bash
pnpm test             # 后端场景测试：起真实进程 + 独立测试库，19 个用例
```

覆盖 §2.4 的 **S1–S8 全部**，外加：A1 并发 CAS / 转移表 / 终态级联，A2 504 丢失 → 重发一次 → `NETWORK_TIMEOUT`、504 已落地 → 不重发，A5 坏响应连续 3 次、12 步预算、审计 3 次无结论 → `blocked`、run 期间消息合并进下一次 run，**A5.8 在 agent run 执行中 `SIGKILL` 后端再拉起，同一个 runId 续跑并且消息只发了一次**，B2 leave-all 部分失败，B3 refresh 轮换与重放作废整个会话。

```bash
cd frontend && pnpm e2e   # C3：Playwright，登录 → 打开群 → 看到 agent run 步骤；viewer 看不到写按钮
```
（需要上面的开发栈在跑。已装过 Chrome 可用 `CHROME=/path/to/chrome pnpm e2e` 跳过浏览器下载。）

## 关键设计：每条"重启前后都必须成立"是怎么保证的

总原则：**状态、它的后果、以及推给前端的事件，在同一个数据库事务里提交**；不变量尽量交给数据库约束，而不是内存。

| 需求 | 做法 | 代码 |
|---|---|---|
| A0 schema 落后拒绝启动 | 启动时比较 `schema_migrations` 与代码里的最大版本，落后直接退出；迁移带 advisory lock、逐个事务、可重复执行 | `migrate.ts` `main.ts` |
| A1 并发变更至多一个成功 | `UPDATE … WHERE status = expectedFrom` 本身就是 CAS，0 行即 `CAS_CONFLICT` | `domain.ts` |
| A1 终态"要么都生效要么都不生效" | 状态 + 退出所有群 + 取消排队消息 + 序列步骤 skipped + WS 事件在一个事务里；三种来源（发送错误 / 网关事件 / 操作员）走同一个函数 | `domain.ts` |
| A1 推给前端的状态必须已保存 | WS 事件写入 `ws_events` 表，和状态同事务；提交前最后拿一把 advisory lock，使 `seq` 顺序 = 提交顺序，读取方按 seq 追就不会漏掉晚提交的事务 | `db.ts` `ws.ts` |
| A2 不会"网关发了库里没有" | outbox：先 INSERT `queued`，再调网关 | `outbox.ts` |
| A2 不会"一条记录对应网关多条消息" | 调网关前原子地打 `attempt_started_at`（抢占）。崩溃后"已抢占但无结果"的行按 504 处理：先 by-client-id 查证，确认没发出才重发，且总共只重发一次 | `outbox.ts` |
| A2 504 → 5 秒内定论 | `unknown` 每 200ms 查 by-client-id；200 → sent；404 且距 504 ≥ 2s → 重发一次 / 已重发过则 `failed NETWORK_TIMEOUT`；503 保持 unknown，恢复后 200ms 内再判 | `outbox.ts` |
| A2 限流期间网关收不到 send、到期按原序发出 | 每个账号同一时刻只有一条在途，队头按 id 取；限流期间账号不是 online 就不派发 | `outbox.ts` |
| A2 事件去重 | 每个事件和一条 `processed_events` 主键插入同事务；消息另有 `(group_id, msg_id)` 唯一索引，覆盖"换了新 eventId 的补投" | `stream.ts` |
| A2 停机/断流期间的事件 | 相邻事件可乱序 ≤1s，所以不能从"见过的最大 eventId"续传；持久化的是"至少 1.5s 前见过的最大 eventId"，重连从它续拉，重叠部分靠去重吸收 | `stream.ts` |
| A2 处理事件时写库失败 | 事件追加到本地 journal 文件（不丢），推 `inconsistency`，事件流继续；journal 每 2s 重放直到清空 | `stream.ts` |
| A2 自己的消息一行 | 回流的 `message` 可能早于 `message_sent`：因为每账号只有一条在途，可以立刻把 msgId 挂到那条 outbox 行上 | `stream.ts` `outbox.ts` |
| A4 翻页不重不漏 | `(sent_at, id)` keyset 游标 | `app.ts` |
| A5 同群至多一个 running（多实例也成立） | 部分唯一索引 `agent_runs(group_id) WHERE status='running'`；触发与 run 结束都在同一把按群的 advisory lock 下，结束时把待处理消息一次性放进下一个 run | `agent/trigger.ts` |
| A5.8 重启续跑、副作用不重复也不误记失败 | 有副作用的工具（send / kick）分三段落库：步骤 `executing` → 副作用意图（outbox 行 / `effect.phase=calling`）→ 结果。恢复时**观察**已记录的副作用（消息状态、网关成员列表），而不是再做一次 | `agent/runner.ts` |
| A5 60 秒墙钟、停机不计 | `elapsed_ms` + `active_since`，每步落库；被重新认领时 `active_since` 重置为当前 | `agent/runner.ts` |
| A5 只有一个实例驱动一个 run | run / job 都有租约（owner + until），实例 ID 稳定，重启后立即收回自己的租约 | `agent/runner.ts` `jobs.ts` |
| B1 并发启动恰好一个 201 | 部分唯一索引 `sequence_runs(group_id) WHERE status='running'`，冲突即 409 | `sequences.ts` |
| B1 预检 = 实际发送 | 占位符解析是纯函数，预检接口与启动共用 | `sequences.ts` |
| B1 重启不会一次性全发 | 只有当前步骤有 `scheduled_at`；下一步在"发出"（`message_sent` / skipped）时才排期；启动时只重排最早一个已过期的步骤 | `sequences.ts` `domain.ts` |
| B3 refresh 重放作废整个会话 | refresh 只放 HttpOnly cookie，每次使用即轮换；旧 token 再用 → 会话吊销，access token 带 `sid`，校验时查会话 | `auth.ts` |

### 测试里抓到的一个真问题：时钟

场景测试 S4 一开始不稳定：限流期间网关仍然收到了 send。原因是**数据库时钟（colima 虚拟机）比宿主机快 5 秒**，而限流截止时间用 JS 时间写、却拿数据库 `now()` 判断到期，于是提前 5 秒"到期"，再发一次又把网关的计时重置了。生产上多实例之间同样会有时钟偏差，所以改成：**所有持久化的截止时间只用数据库时钟**（限流到期、unknown 的 2 秒判定窗口、agent 的 60 秒墙钟），并给限流等待加 0.5s 余量，防止和网关之间的时钟差让我们早发。

## 取舍与已知限制

题目说明"做到哪算哪、以已完成部分评估"，所以优先把 A 组做深、做可验证，而不是铺满所有条目。

- **做了**：A0–A6 全部；B1、B2、B3、B4（WS `sinceSeq` 补发 + 前端重连后重拉当前页）；C3。
- **没做**：C1 媒体文件下载与清理（`mediaUrl` 已入库，未下载）；C2 接真实 LLM。
- **多实例**：设计上考虑了（租约、advisory lock、部分唯一索引、LISTEN/NOTIFY 广播 WS），但测试只跑了单实例。
- **建群崩溃窗口**：网关 `createGroup` 成功后、写库前崩溃，恢复时会再建一个群，网关里留下一个孤儿群。要彻底消除需要网关支持幂等键，§2.1 没有提供。
- **消息落地顺序**：我们保证同账号**提交**顺序；落地顺序由网关每条消息的延迟决定，测试断言的是提交顺序。
- **kick 504 后仍在群里**：成员列表确认没踢掉则再试一次；两次都确认不了时返回 `SEND_TIMEOUT`（错误码表里没有更贴切的）。
- **UNKNOWN_TOOL / INVALID_INPUT** 计入"连续协议错误"计数（它们在 A5.3 里被归为协议错误），但步骤 `kind` 记为 `tool_use`，因为 assistant 的 tool_use 块照常追加了。
- 重复调用 `get_recent_messages`（A5.11）：照常返回数据并附一句 `note` 提示收尾，靠 12 步上限兜底。

## 目录速览

```
backend/src/
  domain.ts         账号状态机、终态级联、限流、群不可达级联、序列推进
  outbox.ts         出站派发、504/unknown 判定、message_sent 合并
  stream.ts         网关 SSE 消费、去重、安全游标、journal
  agent/runner.ts   agent 循环、预算、协议错误、审计、幂等、崩溃续跑
  agent/trigger.ts  触发与待处理合并
  jobs.ts           建群 / 全部退群（可续跑）
  sequences.ts      占位符解析、序列调度
  auth.ts ws.ts app.ts db.ts migrate.ts
backend/test/       场景测试（harness 起真实进程，可 SIGKILL 后端）
```
