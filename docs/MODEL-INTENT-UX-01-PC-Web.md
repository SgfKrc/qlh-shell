# MODEL-INTENT-UX-01 PC Web

实现位于独立仓库的 `frontend_cybergothic/` 应用。未提交 commit，未修改父后端或 Android。

## 产品路径

- `/#/models?fixtures=0` 从同源 `/api/models/intent/catalog` 读取主节点目录。
- 用户明确选择模型、engine、量化后，单次“使用此模型”调用 `POST /api/models/intent`。默认发送 `engine: auto`、`quant_type: ''`、`strategy: auto`、`timeout_seconds: 3600`，格式与档位由后端裁决。
- “发现并连接主节点”调用 `POST /api/models/intent/connect`，body 为 `{}`。不输入 host、不写 inference mode。
- `/current` 恢复操作，`/{operation_id}` 查询进度。后台刷新只更新目录与操作，不改用户模型、engine、量化选择，不自动写入。
- operation、generation、config、阶段、节点传输进度、具名原因在 Models 与 Chat 共用。重试使用原操作意图；取消调用 DELETE；卸载仍调用 `/api/models/unload`。
- `ready && loaded_ready` 且绑定可用后，分布式 Chat 才放行。JSON null current 表示尚无操作；prepared 本机状态单独展示，不代替 ready。
- 切换本地模式显式退出集群，保留原整模加载工作区。模式切换会 abort 在途读写并更新代际，旧响应不得覆盖新模式。
- Unix 秒数与 ISO 字符串 `updated_at` 均可显示；HTTP `{code,message}` 和操作 `{reason_code,reason}` 都显示稳定错误码。

## 真实产品 Playwright 选择器

真实 catalog 的 Qwen3.5-9B ID 为 `qwen3-5-9b`。

```js
await page.goto('/#/models?fixtures=0');
await page.getByTestId('intent-model-qwen3-5-9b').click();
await page.getByTestId('intent-engine').selectOption('pytorch'); // DL；LL 用 llama_cpp
await page.getByTestId('intent-quantization').selectOption('');
await page.getByTestId('intent-use-model').click();
// 主节点自动完成 supply → prepare。
await expect(page.getByTestId('intent-open-chat')).toBeVisible({ timeout: 3_600_000 });
await page.getByTestId('intent-open-chat').click();
await page.getByTestId('chat-input').fill('你的问题');
await expect(page.getByTestId('chat-send')).toBeEnabled();
await page.getByTestId('chat-send').click();
```

| 对象 | testid / label |
| --- | --- |
| 目录模型 | `intent-model-${model_id}` |
| Engine | `intent-engine` / label `Runtime engine` |
| 量化 | `intent-quantization` / label `Quantization` |
| 使用模型 | `intent-use-model` / “使用此模型” |
| 发现连接 | `intent-connect-master` / “发现并连接主节点” |
| 统一进度 | `intent-progress`，整体状态为内部 `.badge` |
| 操作 ID | `intent-operation-id` |
| 代际 | `intent-generation` |
| 节点表 | `intent-node-progress` |
| 单节点传输 | role `progressbar`，名称 `${nodeid} 传输进度` |
| 取消 / 重试 | `intent-cancel` / `intent-retry` |
| 就绪进入聊天 | `intent-open-chat` |
| 聊天输入 / 发送 | `chat-input` / `chat-send` |

## 验证记录（2026-10-13）

- `npm run typecheck`：通过。
- `npm run build`：通过。Vite 提示主 bundle 超过 500 kB（当前约 535 kB）；无构建错误。
- `npm run check:contrast`：27/27 通过。
- `QLH_INTENT_LIVE=1 npm run test:e2e`：全套 79/79 通过，包括真实服务只读用例。
- 后续增加产品 testid 和 Unix 时间兼容后，相关 Models / inference mode / sessions / workbench / intent / live 用例：34/34 通过。
- `git diff --check`：通过。

`tests/model_intent.spec.js` 使用非 fixture 的产品页面与浏览器请求拦截，验证 API 契约、全部阶段、节点进度、刷新恢复、选择保持、重试、取消、连接、错误、两种模式切换的迟到响应、实际卸载与 Chat SSE。它不证明实机三机推理。

`tests/model_intent_live.spec.js` 在 `QLH_INTENT_LIVE=1` 时连接真实后端，不使用 route 或 fixture，仅读取目录/current、选择控件、刷新及检查聊天门控，没有模型写入。默认显式 skip，skip 不算 passed。运行时后端为本机 8000 端口，current 实际为 null，真实目录为 path-free。

无预置工件的三机 DL/LL 供给、prepare 与真实 Chat 推理由父任务继续验收，不以本记录替代。

## 2026-10-14 产品实测补充

父任务已从真实 Surface Web 选模入口完成三机 DL 与 LL。修复后的 LL 操作 `supply_afbcba3e75094963836fbe719f39cc94`，config `60d2659959ab41d591c5a15704264635`、精确代际 `1791919906890923900`：真实问题返回 2／6，两题页面回答与精确代际均显示；两个远端 native handoff、distributed=true、fallback=false 经 master 日志核对。三段 native 仅装载 proper crops，无节点整模。DL 对应成功操作 `supply_90638ba719bd49309de1ee5a96b8073e`，两题 2／6 同样通过。

本轮补上 full SSE 及时发首部、用户取消 reader 收束及 19 位 identity 保真后，又通过 delayed history／超过十秒 SSE 明确复现并修复 ChatPane 历史替换正在生成新轮次的竞态。`loading || refreshing` 统一约束按钮、Enter、表单和历史修改，保留草稿。五项新回归及三个相关文件合计 22 passed，typecheck/build/diff check 通过；mock 前后证据只证明该竞态，不替代上述真实三机验收。

Surface 实际 Web local 退出和 distributed 重入通过，native 子进程真实卸载，cleanup ACK 收齐，旧 ready 没有复活。更完整的 Android／Textual、API 来源门、失败历史和工件证据由核心文档 `docs/model-intent-ux-acceptance-2026-10-13.md` 保存。