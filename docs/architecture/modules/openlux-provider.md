# OpenLux 接入

在个人设置的 API 配置中添加 **OpenLux**，填写 API Key，默认接口地址为
`https://api.openlux.ai/v1`。同一服务商配置支持 Gemini、GPT Image 和 Seedance 视频；内部自动切换
`/v1beta/models`、`/v1/images` 与 `/api/v3/contents/generations/tasks` 路径。自定义网关的路径前缀会保留。

平台凭据使用 `PLATFORM_OPENLUX_API_KEY`、`PLATFORM_OPENLUX_BASE_URL`，沿用现有平台凭据机制。

## 模型与协议

- Gemini 文本：`gemini-3.8-flash`、`gemini-2.5-pro`、`gemini-2.5-flash`、
  `gemini-3-pro-preview`、`gemini-3-flash-preview`。支持同步、SSE、思考内容和图片输入。
  **不能作为助手模型**：OpenLux 的 Gemini 通道拒绝 `/v1/responses`
  （2026-09-15 实测 503 `channel:protocol_unsupported`），而 Codex 助手只说 Responses 协议。
- GPT 文本（助手模型）：`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-6-astra`，走
  OpenAI 兼容的 `/v1/responses`（Bearer 鉴权），能力声明 `codexRuntimeWireApi: 'responses'`。
  助手准入只由这条 registry 声明裁定，模型网关不再区分供应商。
- GPT Image：`gpt-image-2`、`gpt-image-2-c`、`gpt-image-2.5-flare`、
  `gpt-image-2.5-flare-c`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-sunburst-c`。
  无参考图时发送 JSON generations 请求；有参考图时发送 multipart edits 请求。
  每次生成一张，最多 16 张参考图，提示词最多 1000 个 Unicode 字符。
- 两类接口均使用 Bearer 鉴权。文生图使用 `format` 字段；编辑使用 `output_format`，仅支持 PNG/JPEG。
  暴露 1K/2K/4K 和七种常用宽高比，尺寸遵循共享 GPT Image 尺寸约束。
  2.5 支持 `xhigh`、`max`，旧型号不接受这两个档位。

- Seedance 视频：`doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`，透传火山方舟
  Ark 协议（`POST/GET /api/v3/contents/generations/tasks`），异步 external id 为 `OPENLUX:VIDEO:<id>`。
  模型约束复用 `ark/video-models.ts` 的 2.0 规格（时长 4–15 s、参考 9 图 / 3 音 / 3 视、音频参考需伴随视觉参考）。
  与 Ark 直连的差异：任务 id 是网关自己的数字串而非 `cgt-*`；成品落在网关 TOS；
  **`generate_audio:false` 不透传**（2026-09-16 实测成品仍带音轨），因此能力只登记 `generateAudioOptions: [true]`，
  wire 固定发送 `generate_audio: true`。终态 `failed | expired | cancelled` 保留原生 `error` 进入 FailureRecord。
  参考视频只接受公网 URL，图片与音频可内联。

协议依据为 `test_api/src/openlux-gemini-text.ts`、`openlux-gpt-image-gen.ts`、
`openlux-gpt-image-edit.ts`、`openlux-seedance2.ts`。没有将脚本中的关闭安全设置选项设为默认值。
2026-09-14 实测修正：编辑脚本中的 `format` 被线上接口拒绝，须使用 `output_format`。

## 临时计费

经用户指定，暂参考 OpenRouter 价格，**不代表 OpenLux 实际成本**：

| OpenLux 模型 | 参考价格 |
| --- | --- |
| Gemini 3.8 Flash | 项目内 OpenRouter 同名模型 |
| Gemini 2.5 Pro | OpenRouter 基础输入/输出：1.25 / 10 美元每百万 token |
| Gemini 2.5 Flash | OpenRouter 基础输入/输出：0.3 / 2.5 美元每百万 token |
| Gemini 3 Flash Preview | OpenRouter 基础输入/输出：0.5 / 3 美元每百万 token |
| Gemini 3 Pro Preview | 项目内 OpenRouter Gemini 3.1 Pro |
| GPT-5.6 Luna / Terra / Sol | 项目内 OpenRouter 同名模型 |
| GPT-6 Astra | OpenRouter 基础输入/输出：10 / 50 美元每百万 token（2026-09-15 目录） |
| 所有 GPT Image 型号 | 项目内 OpenRouter GPT Image 2 |
| Seedance 2.0 / 2.0 Fast | 项目内 Ark 同型号成本（480p/720p，CNY/秒）；零售为共享 `SEEDANCE_2_RETAIL_CREDITS_PER_SECOND` |

上述公开 token 单价取自 2026-09-14/15 的 [OpenRouter 模型目录](https://openrouter.ai/api/v1/models)。
助手实时结算：OpenLux 响应没有 `usage.cost`，模型网关按定价目录结算（`catalog_usage`），
usage 幂等 id 带供应商前缀，与 OpenRouter 的按 generation 结算互不影响。
沿用项目币种换算和零售价规则；长上下文、缓存和工具调用附加费用暂未建模。
GPT Image `auto/xhigh/max` 按 `high` 计费；2K/4K 暂按相同比例的 1K 档位计费。
Seedance 借用 Ark 成本是 2026-09-16 产品负责人授权的占位；Ark 没有 1080p 成本档，
因此 OpenLux 上 1080p 被定价可用性投影自动隐藏，补齐真实报价后即可开放。
替换真实报价时统一调整 `src/lib/ai-providers/openlux/pricing.ts`。

## 验证

`tests/integration/provider/openlux.contract.test.ts` 使用本地 HTTP 服务验证 SDK、请求体、
参考图上传、Seedance 任务创建与轮询、响应解析、错误归属和价格覆盖，不消耗真实 API 额度。
真实模型可用性和最终效果仍以 OpenLux 账户授权及线上响应为准。

### 2026-09-14 真实调用验证

使用 `test_api/.env` 的 OpenLux Key，通过应用适配器完成以下验证，密钥未写入报告：

- 五个 Gemini 型号的 SSE 调用成功；3.8 Flash 同步调用成功。
- 六个 GPT Image 型号各生成一张低质量图片，均可解码。
- Flare 使用参考图完成 PNG 编辑；单独协议探测也验证了 JPEG 编辑。
- 编辑接口原先拒绝 `format`；修正为 `output_format` 后已通过复测。
- 2.5 Flare C / Sunburst C 在请求 1088×1088 时返回 1254×1254，其他生成结果为 1088×1088。
  应用保留供应商实际返回的尺寸。

### 2026-09-15 Responses 协议探测

使用同一 Key 直接请求 `https://api.openlux.ai/v1/responses`，密钥未写入报告：

- Gemini 2.5 Flash / 3 Flash Preview：流式、非流式、带 tool、带 reasoning 一律 503
  `channel:protocol_unsupported`；同一模型走 `/v1/chat/completions` 正常。
- GPT-5.6 Luna：标准 `response.*` SSE 事件序列、`function_call` item、带 `encrypted_content`
  的 reasoning item（medium 档 1292 字节）——Codex 所需能力齐全。
- GPT-6 Astra：流式与 function call 正常；none / medium / high / xhigh / max 各档
  `reasoning_tokens` 均为 0，从不返回 reasoning item。一次非流式 high 档请求被计入 4114 个
  未发送的 `instructions` 输入 token（3840 缓存命中），流式请求未复现；属于中转商计费行为。
- `/v1/responses` 探测结果可复现，脚本不入库；后续供应商通道变化以线上响应为准。

本地原始报告和图片位于 `test_api/output/openlux-app-smoke-2026-09-14T13-11-46-404Z/`；
修正后的适配器编辑复测位于 `test_api/output/openlux-app-smoke-2026-09-14T13-16-48-975Z/`。
初次报告保留编辑失败记录用于追溯，后一次报告记录修正后的成功结果。

### 2026-09-16 Seedance 透传验证

使用 `test_api/src/openlux-seedance2.ts` 对 `https://api.openlux.ai/api/v3` 实测，密钥未写入报告：

- 创建返回 `{ "id": "139513828" }`；状态流转 `pending → running → succeeded`，480p/5s 约 2.5 分钟。
- `video_url` 落在网关自有 TOS，非火山地址。
- 请求 `generate_audio: false` 时查询响应仍为 `generate_audio: true`，成品带音轨，该字段未透传。
- 成品位于 `test_api/output/openlux_seedance2_139513828.mp4`。
- 应用适配器 `openlux/poll.ts` 用同一 Key 查询该已完成任务，解析为 `completed`，`actualVideoTokens` 为 50638；
  未通过应用发起新任务，避免消耗额度。
