# Image Summon

常駐 Windows 系統匣的 AI 圖片生成器，以 **MCP（協議版本 2026-07-28，並相容 2025-11-25 及更早的 client）** 提供給 Claude Desktop、Claude Code 及任何 MCP agent 使用，並透過 **MCP Skills 擴充**發佈一個 `image-summon` 技能（使用說明、生成器規格與使用者的知識庫）。所有 agent 都連到同一個常駐實例，直接取得生成好的圖片（檔案路徑 + 預覽圖）。

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

## 設計原則

1. **盡可能好設定**：裝好就能用。agent 一鍵註冊、codex 自動偵測、OpenRouter 用瀏覽器登入、模型能力自動帶給 agent，不必手動改設定檔或設定環境變數。
2. **盡可能不在電腦裡留下 API key**：
   - **Codex 模式**完全不需要金鑰，登入由 Codex 自己管理。
   - **OpenRouter 模式**建議用「使用 OpenRouter 登入」，自動取得一把專屬金鑰，不必複製貼上；不想用 OAuth 也可以手動貼上 API key。
   - **自訂 API** 就填你自己的 API key。
   - 不論哪種方式，金鑰都只以 Windows DPAPI 加密存在本機一處；agent 和 Claude 的設定檔裡只有 MCP 網址，沒有金鑰。解除安裝時會一併清除。

## 功能

| 需求 | 實作 |
|---|---|
| 隨系統啟動、常駐系統匣 | 安裝時寫入 `HKCU\…\Run\ImageSummon --hidden`；單一實例；關閉視窗只會隱藏 |
| agent 連線取得成果 | 本機 MCP 伺服器（Streamable HTTP，綁定 127.0.0.1，檢查 Host/Origin 防 DNS rebinding）；Claude Desktop 經內建 stdio 橋接器連線 |
| a. Codex | 以 stdin 把提示詞送進 `codex exec --json --sandbox read-only --ephemeral`，從 `~/.codex/generated_images/<thread>` 取回圖片 |
| b. OpenRouter | OAuth PKCE 登入（回呼到本機伺服器），金鑰以 Windows DPAPI 加密；模型清單來自 `GET /api/v1/images/models` |
| c. 自訂 | 自訂供應商名稱、API 格式、Base URL、API Key、模型，以及可用的解析度/比例/品質 |
| 三選一 | 設定頁的模式卡或系統匣「生成方式」選單，同一時間只有一種生效 |
| MCP 協議 | 以 MCP TypeScript SDK v2（`@modelcontextprotocol/server` / `node`）實作。2026-07-28 client（每個請求帶 `_meta` envelope、無工作階段）走 `createMcpHandler`；2025-11-25 以前的 client 依 `isLegacyRequest` 分流到原本的有狀態工作階段（`Mcp-Session-Id`），兩種都能收到 `list_changed` |
| Skills via MCP | 實作 MCP Skills 擴充（SEP-2640，`io.modelcontextprotocol/skills`）：只發佈一個 `image-summon` 技能，使用者的知識庫（風格指南、Logo…）是它底下可查閱的細項 |
| 原生去背 | Codex 模式支援 `background: transparent`：要求 Codex 內建的 image_gen 直接輸出帶 alpha 通道的 PNG（不需 API key、不做綠幕去背），並檢查結果是否真的有透明像素，沒有時在結果中附上警告。透明圖的預覽改用 PNG |
| 告知 agent 命令規格 | `generate_image` 的 inputSchema 依目前模型動態產生（`resolution` 1K/2K/4K…、`aspect_ratio`、`quality`、`n`、`input_images` 上限）；切換時送出 `notifications/tools/list_changed` |
| 安裝檔 | electron-builder NSIS：開始功能表、桌面捷徑、解除安裝項目、開機啟動 |

## Agent 看到的工具

- **`generate_image`**：`prompt`（必填）＋目前生成器支援的參數。另有 `output_path`（把副本直接存進專案）、`async`（立即回傳 job_id）。
  回傳：文字（檔案路徑、尺寸、費用）＋ JPEG 預覽圖 ＋ `resource_link`，並附 `structuredContent`（符合 outputSchema）。
  長時間生成會每 5 秒送出 `notifications/progress`，支援 `resetTimeoutOnProgress` 的 client 不會逾時。
- **`get_image_job`**：查詢 / 等待非同步工作。
- **`get_generator_info`**：以文字說明目前模式、模型與可用參數（也提供為 resource `image-summon://generator/spec`）。

## Agent 看到的 Skill（MCP Skills 擴充）

Image Summon 宣告 `io.modelcontextprotocol/skills` 擴充，但**只發佈一個技能 `image-summon`**，不會變成技能管理器。支援的 client 用 `skills/list` 找到它，再以 `resources/read` 讀取 `skill://image-summon/…` 檔案（附 SHA-256 摘要供驗證）：

```
skill://image-summon/
├─ SKILL.md                         使用說明 + 知識庫目錄（自動產生）
├─ references/generator.md          目前生成器規格（切換模式/模型時自動更新）
└─ knowledge/<項目>/README.md        使用者的知識項目
   └─ assets/…                      附件（Logo、參考圖、色票…）
```

- **SKILL.md**：教 agent 何時使用 Image Summon、怎麼寫提示詞、依用途選 `aspect_ratio` / `resolution`、用 `output_path` 把圖放進專案、`async` 長時間生成與錯誤處理；末尾列出知識庫每個項目的名稱、說明、網址與附件本機路徑。技能的 description 也會帶上項目名稱，讓 agent 知道裡面有品牌/風格資料。
- **知識庫**（設定頁「📚 知識庫」）：新增、編輯、改名、刪除知識項目，例如插畫風格指南、品牌色、公司 Logo、吉祥物設定；可從「風格指南」「公司 Logo」「角色設定」範本開始。
  - 每個項目有名稱（小寫英文/數字/連字號）、說明（列在目錄中，agent 依此判斷何時查閱）和 Markdown 內容。
  - 可附加檔案，存在項目的 `assets/`；項目的 README 會列出每個附件的本機絕對路徑，agent 可以直接把 Logo 等圖片放進 `generate_image` 的 `input_images`。
  - 存放在 `%APPDATA%\image-summon\knowledge\<名稱>\`，也可以手動放入資料夾後按「重新載入」。單檔上限 8MB；整個技能依 Skills 規範建議不超過 16MB。
  - 任何變更都會重新產生技能並送出 `notifications/resources/list_changed`。
- 不支援 Skills 擴充的 client 仍可把這些檔案當一般 resource 讀取；`generate_image` 的說明裡也會指向這個技能。

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

- `src/main/`：主程序（`main.ts` 系統匣/視窗/IPC、`server.ts` HTTP + MCP 工作階段、`mcp.ts` 工具/資源、`skills.ts` MCP Skills 擴充、`knowledge.ts` 知識庫、`png.ts` 透明度檢查、`spec.ts` 動態規格、`jobs.ts` 工作佇列、`providers/` 三種生成方式、`oauth.ts`、`integrations.ts`）
- `renderer/`：設定頁（純 HTML/CSS/JS，contextIsolation + sandbox）
- `bridge/bridge.js`：零相依的 stdio ↔ Streamable HTTP 橋接器（2025 工作階段與 2026-07-28 標準標頭 `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 都會轉送）
- `scripts/make-icons.mjs`：從 `assets/source/icon-art.png` 產生 `.ico`、各尺寸 PNG 與系統匣圖示（裁切、面積平均縮圖、抗鋸齒圓角遮罩、「生成中」橘點），無外部相依。原圖是用 Image Summon 自己（Codex 模式）生成的；換掉這張圖再執行 `npm run icons` 即可更新全部圖示。
- 開發用：`electron . --capture=<資料夾>` 會把設定頁各分頁截圖到該資料夾。

設定檔位於 `%APPDATA%\image-summon\settings.json`，知識庫在 `%APPDATA%\image-summon\knowledge\`（解除安裝時會連同 AppData 一起刪除），圖片預設輸出到 `圖片\Image Summon`。

## 已知限制

- 安裝檔未做程式碼簽章，第一次執行會出現 SmartScreen 提示。
- Codex 模式的尺寸/比例由 Codex 決定（agent 可以在提示詞中描述構圖）；一次生成大約 1–3 分鐘。
- Codex 原生去背依賴 Codex CLI 內建 image_gen 的透明輸出（請用新版 Codex CLI）；若提示詞描述了背景/場景，仍可能回傳不透明的圖，此時結果會附上警告。
- 解除安裝不會自動移除 Claude Desktop / Claude Code 的註冊，請先在設定頁按「移除」。

## 授權

[MIT](LICENSE) © 2026 z060142
