# Image Summon

常駐 Windows 系統匣的 AI 圖片生成器，以 **MCP（協議版本 2025-11-25）** 提供給 Claude Desktop、Claude Code 及任何 MCP agent 使用。所有 agent 都連到同一個常駐實例，直接取得生成好的圖片（檔案路徑 + 預覽圖）。

```
Claude Code ──(Streamable HTTP)──────────────┐
                                              ▼
Claude Desktop ──stdio──▶ bridge.js ──HTTP──▶ Image Summon（系統匣，127.0.0.1:47821/mcp）
                                              │  三選一
                       ┌──────────────────────┼──────────────────────┐
                       ▼                      ▼                      ▼
                 a. Codex CLI           b. OpenRouter           c. 自訂 API
              codex exec $imagegen   OAuth PKCE 取得金鑰     OpenAI Images / Gemini /
              （雙向轉發）            /api/v1/images          OpenRouter 相容 / Chat
```

## 功能

| 需求 | 實作 |
|---|---|
| 隨系統啟動、常駐系統匣 | 安裝時寫入 `HKCU\…\Run\ImageSummon --hidden`；單一實例；關閉視窗只會隱藏 |
| agent 連線取得成果 | 本機 MCP 伺服器（Streamable HTTP，綁定 127.0.0.1，檢查 Host/Origin 防 DNS rebinding）；Claude Desktop 經內建 stdio 橋接器連線 |
| a. Codex | 以 stdin 把提示詞送進 `codex exec --json --sandbox read-only --ephemeral`，從 `~/.codex/generated_images/<thread>` 取回圖片 |
| b. OpenRouter | OAuth PKCE 登入（回呼到本機伺服器），金鑰以 Windows DPAPI 加密；模型清單來自 `GET /api/v1/images/models` |
| c. 自訂 | 自訂供應商名稱、API 格式、Base URL、API Key、模型，以及可用的解析度/比例/品質 |
| 三選一 | 設定頁的模式卡或系統匣「生成方式」選單，同一時間只有一種生效 |
| 告知 agent 命令規格 | `generate_image` 的 inputSchema 依目前模型動態產生（`resolution` 1K/2K/4K…、`aspect_ratio`、`quality`、`n`、`input_images` 上限）；切換時送出 `notifications/tools/list_changed` |
| 安裝檔 | electron-builder NSIS：開始功能表、桌面捷徑、解除安裝項目、開機啟動 |

## Agent 看到的工具

- **`generate_image`**：`prompt`（必填）＋目前生成器支援的參數。另有 `output_path`（把副本直接存進專案）、`async`（立即回傳 job_id）。
  回傳：文字（檔案路徑、尺寸、費用）＋ JPEG 預覽圖 ＋ `resource_link`，並附 `structuredContent`（符合 outputSchema）。
  長時間生成會每 5 秒送出 `notifications/progress`，支援 `resetTimeoutOnProgress` 的 client 不會逾時。
- **`get_image_job`**：查詢 / 等待非同步工作。
- **`get_generator_info`**：以文字說明目前模式、模型與可用參數（也提供為 resource `image-summon://generator/spec`）。

範例（OpenRouter，`black-forest-labs/flux-3-image-klein`）時 agent 看到的參數：

```
resolution:   768 | 1K | 1.5K | 2K | 4K      (default 1K)
aspect_ratio: 21:9 | 16:9 | 3:2 | … | auto   (default 16:9)
output_format: jpeg | png
input_images: up to 10
seed: integer
```

## 連接 Agent

開啟設定頁 →「連接 Agent」，一鍵註冊：

- **Claude Code**：執行 `claude mcp add --transport http --scope user image-summon http://127.0.0.1:47821/mcp`
- **Claude Desktop**：寫入 `claude_desktop_config.json`（會先備份成 `.image-summon.bak`），內容為：
  ```json
  { "mcpServers": { "image-summon": {
      "command": "<安裝目錄>\\ImageSummon.exe",
      "args": ["…\\resources\\bridge\\bridge.js", "http://127.0.0.1:47821/mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
  ```
  橋接器直接用 Image Summon 本體的 Electron 以 Node 模式執行，不需另外安裝 Node.js。託盤程式重啟後，橋接器會自動重新建立工作階段。
- 其他 MCP client：直接連 `http://127.0.0.1:47821/mcp`。

## 開發

```powershell
npm install
npm start            # 編譯並以開發模式執行
npm run dist         # 產生 release\Image Summon Setup <版本>.exe
```

- `src/main/`：主程序（`main.ts` 系統匣/視窗/IPC、`server.ts` HTTP + MCP 工作階段、`mcp.ts` 工具、`spec.ts` 動態規格、`jobs.ts` 工作佇列、`providers/` 三種生成方式、`oauth.ts`、`integrations.ts`）
- `renderer/`：設定頁（純 HTML/CSS/JS，contextIsolation + sandbox）
- `bridge/bridge.js`：零相依的 stdio ↔ Streamable HTTP 橋接器
- `scripts/make-icons.mjs`：從 `assets/source/icon-art.png` 產生 `.ico`、各尺寸 PNG 與系統匣圖示（裁切、面積平均縮圖、抗鋸齒圓角遮罩、「生成中」橘點），無外部相依。原圖是用 Image Summon 自己（Codex 模式）生成的；換掉這張圖再執行 `npm run icons` 即可更新全部圖示。
- 開發用：`electron . --capture=<資料夾>` 會把設定頁各分頁截圖到該資料夾。

設定檔位於 `%APPDATA%\image-summon\settings.json`，圖片預設輸出到 `圖片\Image Summon`。

## 已知限制

- 安裝檔未做程式碼簽章，第一次執行會出現 SmartScreen 提示。
- Codex 模式的尺寸/比例由 Codex 決定（agent 可以在提示詞中描述構圖）；一次生成大約 1–3 分鐘。
- 解除安裝不會自動移除 Claude Desktop / Claude Code 的註冊，請先在設定頁按「移除」。

## 授權

[MIT](LICENSE) © 2026 z060142
