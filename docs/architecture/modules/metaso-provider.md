# Metaso（秘塔）接入

在个人设置的 API 配置中添加 **Metaso**，填写 API Key，默认接口地址为
`https://metaso.cn/api/minimax`。Metaso 只是把 MiniMax v2 视频协议原样转发到该前缀下，
本项目不做任何字段翻译；自定义网关的路径前缀会保留。

平台凭据使用 `PLATFORM_METASO_API_KEY`、`PLATFORM_METASO_BASE_URL`，沿用现有平台凭据机制。

## 模型与协议

- 视频：`MiniMax-H3`（768P | 2K，4–15 s）、`MiniMax-H3-Max`（480P | 768P，5–15 s）。
  创建 `POST /v2/video_generation` → `{ task_id }`；查询 `GET /v2/query/video_generation/{task_id}`
  → `{ task: { status, content: { url }, error, usage } }`。异步 external id 为 `METASO:VIDEO:<task_id>`。
- 分辨率沿用供应商原生拼写（`480P` / `768P` / `2K`），不映射成小写档位。
- `content` 必须且只能包含一个非空 `text`（≤ 7000 字符）；首/尾帧模式与多模态参考模式互斥。
  参考上限：图 ≤ 9、视频 ≤ 3、音频 ≤ 3，音/视频单段 2–15 s 且各通道总时长 ≤ 15 s，视频 MP4/MOV ≤ 50 MB。
  三类媒体均接受 data URI，因此 transport 全部登记为公网 URL + 内联。
- 宽高比：纯文生视频必须给出明确比例（不能 `adaptive`）；有首帧时 adapter 固定发送 `adaptive`，由图片决定比例
  （能力 `firstFrameAspectRatio: 'adaptive'`）。参考模式沿用用户选定比例。
- H3 始终生成音轨，没有关闭开关，能力只登记 `generateAudioOptions: [true]`。
- `aigc_watermark` 固定 `false`。`extra.prompt_expansion_mode` 与 `h3_context_ir`（只产出增强提示词）
  **未接入**：前者需要新增跨 registry/UI 的能力字段，后者不是产品内任何模态；MiniMax 缺省即 `balanced`。
- 失败归属：HTTP 4xx 的 `{ type: 'error', error: { type, message } }` 视为明确拒绝，`authorized_error` / 401 / 403
  映射 `PROVIDER_AUTH_INVALID`，402 映射 `PROVIDER_BILLING_REQUIRED`，其余 `PROVIDER_SUBMISSION_REJECTED`；
  429/5xx/超时不证明未受理，按 `outcome_unknown` 处理。任务终态 `failed | cancelled` 携带原生 `task.error`
  进入 FailureRecord（`GENERATION_FAILED`）；未知状态原地抛错，不猜测。

协议依据为 `test_api/src/metaso-minimax-h3.ts` 与 MiniMax 官方 v2 文档（2026-09-16 抓取）。

## 临时计费

经产品负责人指定（2026-09-16），**没有任何 Metaso / MiniMax 真实报价**，两张面均为占位：

| 分辨率 | 零售（积分/秒） | 成本（CNY/秒，按标准 1.8 倍 markup 反推） |
| --- | --- | --- |
| 480P | 14（= Seedance 2.5 480p） | 0.7778 |
| 768P | 31（= Seedance 2.5 720p） | 1.7222 |
| 2K | 68（= Seedance 2.5 1080p） | 3.7778 |

成本是从零售反推的，margin 保险丝因此只反映"我们按什么价收"，不反映真实利润。
拿到真实报价后在 `src/lib/ai-providers/metaso/pricing.ts` 同时替换两张面。

## 验证

`tests/integration/provider/metaso.contract.test.ts` 使用本地 HTTP 服务验证请求体、鉴权、文本/首帧/参考三种
content 组装、比例规则、pre-accept 拒绝、4xx/5xx 归属、终态 FailureRecord 与占位价格，不消耗真实额度。

### 2026-09-16 真实调用验证（test_api 脚本）

使用 `test_api/.env` 的 Metaso Key，密钥未写入报告：

- `video_generation` / `h3_context_ir` / `query` 三个接口在 `/api/minimax` 前缀下透传正常；
  Metaso 文档中 `h3_context_ir` 示例缺 `/api` 是笔误。
- `task_id` 为 19 位数字串；查询错误格式与官方一致（`invalid task_id (2013)`）。
- 状态流转 `queued → running → succeeded`，768P/5s 文生视频约 40 s；查询响应额外带 `estimated_remaining_seconds`。
- 成品 url 落在 `files.metaso.cn`（带 `expires/signature`，有时效）；768P 16:9 实际为 1344×768，含音轨。
- 成品位于 `test_api/output/metaso_h3_*.mp4`。
- 应用适配器 `metaso/poll.ts` 用同一 Key 查询已完成任务 `2100168406192103424`，解析为 `completed` 并取到成品 url；
  未通过应用发起新任务，避免消耗额度。
