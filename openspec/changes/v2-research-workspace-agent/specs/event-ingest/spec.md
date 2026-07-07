## ADDED Requirements

### Requirement: Event Seq 单调性与幂等
`AgentEvent.seq` MUST 在同一个 run 内严格递增。相同 `(runId, seq)` 且 body 一致的重复 ingest SHALL 幂等成功；body 不一致的重复 ingest MUST 判定为冲突。

#### Scenario: seq 单调递增
- **WHEN** 依次 ingest seq=1、seq=2、seq=3 的事件
- **THEN** 全部成功写入，且按 seq 顺序可查询

#### Scenario: 相同 payload 的重复 ingest 幂等
- **WHEN** 对同一个 `(runId, seq)` 重复 ingest 完全相同的事件 body
- **THEN** 第二次请求返回成功，不产生重复记录

#### Scenario: 不同 payload 的重复 ingest 判定冲突
- **WHEN** 对同一个 `(runId, seq)` ingest 不同的事件 body
- **THEN** 第二次请求返回 INGEST_SEQ_CONFLICT

### Requirement: 终态 Run 拒绝新事件
终态 run（或 `waiting_for_input`）MUST 拒绝普通新事件，除已接受记录的精确重复。

#### Scenario: 终态 run 拒绝新事件
- **WHEN** 向状态为 `completed` 的 run ingest 新事件
- **THEN** 请求返回 RUN_TERMINAL

### Requirement: Payload 判别联合 Schema
`AgentEventDTO.payload` MUST 按 `type` 定义具体形状（判别联合）；thinking/content 类事件（`agent_thinking`/`agent_message`）与 tool_call 类事件 MUST NOT 共用同一套字段。服务端 MUST 按 `type` 校验 `payload` 形状。

#### Scenario: payload 形状与 type 匹配时接受
- **WHEN** ingest `type=tool_call_started` 且 payload 包含 `toolCallId`/`name`/`args`
- **THEN** 请求成功

#### Scenario: payload 形状不匹配时拒绝
- **WHEN** ingest `type=tool_call_started` 但 payload 缺少必需字段或包含 thinking 专属字段
- **THEN** 请求返回 VALIDATION_FAILED

#### Scenario: agent_thinking 与 agent_message 分别对应各自语义边界
- **WHEN** 模型从推理阶段切到输出阶段
- **THEN** ingest 一条 `agent_thinking` 事件，完整推理文本放在 `content` 字段

### Requirement: Artifact 版本事件区分
`artifact_created` 对应首次创建（`artifactId` 留空或不存在），`artifact_updated` 对应已存在 artifact 的新版本。两者 MUST 可区分。

#### Scenario: 首次创建产生 artifact_created
- **WHEN** ingest artifact 请求的 `artifactId` 未提供或指向不存在的 id
- **THEN** 产生 `artifact_created` 事件，version 为 1

#### Scenario: 已存在 artifactId 产生 artifact_updated
- **WHEN** ingest artifact 请求的 `artifactId` 指向已存在的 artifact
- **THEN** 产生 `artifact_updated` 事件，version 递增

### Requirement: SSE Snapshot 与恢复
SSE 端点 SHALL 先发送历史事件 snapshot，再推送新事件；终态或 `waiting_for_input` run 在 snapshot 后 SHALL 发送 `done`。浏览器主路径 SHALL 使用 `POST /api/runs/:runId/events`，`GET` 保留兼容。页面刷新 MUST 能从数据库 snapshot 完整恢复状态。

#### Scenario: Snapshot 包含历史事件
- **WHEN** 建立 SSE 连接查看一个已有若干事件的 run
- **THEN** 首个 snapshot 消息包含全部历史事件

#### Scenario: POST SSE 支持 snapshot 与续读
- **WHEN** 浏览器用 POST 建立 SSE 连接，并在 JSON body 中传入 `lastEventId`
- **THEN** 服务端返回 `text/event-stream`，先发送 snapshot，并从该 cursor 之后续读 Redis stream chunk

#### Scenario: 终态 run 发送 done
- **WHEN** run 已处于终态时建立 SSE 连接
- **THEN** 连接发送 snapshot 后立即发送 done 并可关闭

#### Scenario: waiting_for_input run 发送 snapshot 后 done
- **WHEN** run 处于 `waiting_for_input` 时建立 SSE 连接
- **THEN** snapshot 包含 `waitingForInput` 字段（question/options），随后发送 done
