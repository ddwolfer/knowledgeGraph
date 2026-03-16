# Knowledge Graph MCP Server

繁體中文 | [English](README.md)

AI agent 的長期記憶系統。透過師徒制教學或專業實踐，讓 agent 累積領域知識、自動回憶、從學徒逐步成長為獨立專家。

適用於任何需要**持續學習 + 知識演化**的場景：軟體開發、音樂製作、設計、醫療診斷、法律分析等。只要有「專家教學 → 學生實踐 → 逐步內化」的知識傳遞模式，這套系統都能用。

## 為什麼需要這個

Claude 每次對話從零開始。在專業知識的學徒制教學中：

- **專家教的會忘** — context compaction 後關鍵教訓消失，同樣的錯重複犯
- **AI 會發明術語** — 沒有 ground truth，從單次示範過度推論成永久規則
- **知識不會演化** — 新教學跟舊知識矛盾時無法取代
- **搜尋靠路徑** — 換個說法就找不到相關知識
- **永遠是學生** — 沒有機制讓 AI 自己的發現成長為持久知識

## 安裝

```bash
cd mcp/knowledge-graph
npm install
```

首次啟動會自動下載 Qwen3-Embedding-0.6B ONNX 模型（~560MB，只下載一次）。

### MCP 設定

在專案 `.mcp.json`：

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/knowledge-graph/main.js"]
    }
  }
}
```

### Hooks 設定

在 `~/.claude/settings.json` 的 `hooks` 中加入（見下方 [Hooks 章節](#hooks自動化) 的完整設定）。

### 匯入既有知識（可選）

```bash
node scripts/import-skills.js <skills-directory>   # 將 markdown 匯入為 KG 節點
node scripts/backfill-embeddings.js                 # 補向量索引
node scripts/backfill-decay.js                      # 補 stability + memory_level
```

---

## 核心設計

### 為什麼自建

研究了 25+ 個 Claude Code 記憶系統（Claude-Recall、A-MEM、Mnemon、Graphiti、memsearch 等），沒有一個同時滿足：

| 需求 | 現有方案的問題 | 本系統的做法 |
|------|-------------|-------------|
| 領域專屬邊類型 | 只有通用邊 | 10 種語義邊（must_precede, aligns_to 等）|
| 信任等級區分 | 不區分知識來源 | principle（專家教的）> pattern（觀察的）> inference（推測的）|
| Anti-fabrication | 無防護 | principle 必須附帶專家原話 quote |
| 基本功 vs 創意空間 | 一視同仁 | fundamental 永不衰退，creative 可挑戰 |
| 記憶衰退 + 成長路徑 | 有衰退但無成長 | FSRS desirable difficulty + Benna-Fusi 4 level |
| 自動化 | 依賴使用者操作 | 6 hooks 覆蓋完整生命週期 |

### 借鑑來源

| 來源 | 借鑑了什麼 |
|------|-----------|
| **Claude-Recall** | Hook 架構（search enforcer, correction detector）|
| **A-MEM** | 邊的資料模型（relation_type + reasoning + weight）|
| **CortexGraph** | 兩階段衰退（快衰退 + 慢長尾）|
| **FSRS (Anki)** | Desirable difficulty（快忘的記憶被想起 → 更大穩定性增強）|
| **Benna-Fusi** | 記憶級聯（4 level 耐久度，獨立於知識來源）|
| **Stanford Generative Agents** | 三信號檢索（recency + importance + relevance）|
| **Graphiti/Zep** | 時間感知（valid_from / valid_until）|

---

## 三層架構

```
┌──────────────────────────────────────────────┐
│ Layer 1: 人格層（CLAUDE.md）                   │
│ Agent 身份 + 行為準則                          │
│ → 每個 turn 都載入，保證行為一致               │
├──────────────────────────────────────────────┤
│ Layer 2: 記憶層（Knowledge Graph MCP）         │
│ SQLite + sqlite-vec + FTS5                    │
│ 12 MCP 工具 + 三合一混合搜尋                    │
│ → 按需調用，不佔 context                       │
├──────────────────────────────────────────────┤
│ Layer 3: 自動化層（Hooks）                     │
│ 6 hooks 覆蓋完整生命週期                       │
│ → 專家不需要提醒，全自動                        │
└──────────────────────────────────────────────┘
```

---

## 記憶衰退與成長系統

### 設計哲學

```
學徒階段：專家說的權重最高 → 學基礎
成長階段：自己的觀察被驗證 → 形成判斷力
專家階段：自己的推論經實踐確認 → 有自己的見解
```

**trust 是來源標記（誰說的），不是永久等級。** AI 自己驗證過的知識也能持久。

### 衰退：CortexGraph 兩階段 × FSRS Stability

```
R = W_fast × e^(-λ_fast × t) + W_slow × e^(-λ_slow × t)
```

- **快衰退**（半衰期 = S 天）：「剛學的容易忘」
- **慢衰退**（半衰期 = S×10 天）：「存活下來的記得很久」
- **S（stability）**：由 trust + category 決定初始值，被存取後透過 FSRS 增長

| 知識類型 | 初始 S | 快半衰期 | 慢半衰期 |
|---------|:------:|:-------:|:-------:|
| 基本功（fundamental） | 365 天 | — | — |
| 專家的創意選擇 | 30 天 | 30天 | 300天 |
| 觀察到的模式 | 7 天 | 7天 | 70天 |
| AI 推測 | 3 天 | 3天 | 30天 |

### 強化：FSRS Desirable Difficulty

```
stabilityGain = e^(1 - R) × gradeMultiplier
```

核心洞察：**快要忘掉的記憶被想起來時，穩定性增強更大。**

- R = 0.9（剛查過）→ 1.11× 增長
- R = 0.3（快忘了）→ 2.01× 增長

### 成長路徑：Benna-Fusi 記憶級聯

trust（來源標記）不變，memory_level（耐久度）獨立成長：

| Level | 條件 | 自動過期? |
|:-----:|------|:--------:|
| 1 新學 | 預設 | ✅ R < 0.02 |
| 2 驗證中 | 跨 3 sessions 存取 | ✅ R < 0.02 |
| 3 鞏固 | 14天 + access ≥ 5 | ❌ 永不 |
| 4 核心 | fundamental 或 access ≥ 50 | ❌ 永不 |

### 基本功 vs 創意空間

| 類型 | metadata.category | 行為 |
|------|:-----------------:|------|
| 基本功 | `"fundamental"` | R = 1.0 永不衰退。有對錯，違反就是錯 |
| 創意空間 | `"creative"` | 可衰退、可被挑戰。沒對錯，只有合適與否 |

---

## 搜尋系統

### 三合一混合搜尋

```
score = 0.4 × vector + 0.2 × keyword + 0.3 × graph + memoryScore
```

| 層 | 機制 | 擅長 |
|---|------|------|
| Vector | sqlite-vec cosine KNN (Qwen3 1024d) | 換了說法但意思一樣 |
| Keyword | FTS5 BM25 (unicode61) | 精確匹配多語言 |
| Graph | Recursive CTE 沿邊展開 1 跳 | 找因果關聯 |
| memoryScore | R × 0.1 + levelBonus | 越常用越重要 |

### Embedding 設計

- **模型**：Qwen3-Embedding-0.6B（ONNX 量化，~560MB）
- **本地運行**：零 API 依賴、離線可用
- **為什麼 Qwen3**：MTEB 多語排行第一、C-MTEB 中文第一

---

## Anti-Fabrication（防虛構）

| 規則 | 機制 |
|------|------|
| principle 必須有 quote | 沒給專家原話 → 拒絕存入 |
| inference 不能建因果邊 | must_precede / reason_for 拒絕 inference 節點 |
| trust 不自動升級 | inference 不會變 principle（需要專家確認 + quote）|
| level 獨立於 trust | inference 可鞏固到 level 4 但仍標記為「AI 的想法」|

---

## 工具一覽（12 個）

### 知識管理
| 工具 | 用途 |
|------|------|
| `store_knowledge` | 存知識節點。自動 embedding/FTS + 建議連邊 + 初始化衰退參數 |
| `connect_knowledge` | 建因果邊。含 anti-fabrication 驗證 |
| `update_knowledge` | 原地更新節點。保留 ID 和所有邊，自動更新索引 |
| `forget_knowledge` | 標記過時。自動 expire 邊 + 清索引 |

### 搜尋
| 工具 | 用途 |
|------|------|
| `search_memory` | 混合搜尋（vector + keyword + graph + memoryScore）|
| `traverse_graph` | 沿因果邊遍歷（支援方向/深度/邊類型過濾）|
| `list_knowledge` | 按條件列出（trust/type/element/source 篩選，時間/存取/strength 排序）|

### 經驗
| 工具 | 用途 |
|------|------|
| `record_experience` | 記錄工作流軌跡（步驟 + 決策 + 結果）|
| `recall_experience` | 依情境找類似經驗 |

### 維護
| 工具 | 用途 |
|------|------|
| `maintain_graph` | Memory Enzyme — prune / merge / validate / orphan |
| `crystallize_skill` | 檢查 KG 與 skill 文件的同步狀態 |
| `memory_stats` | 圖譜統計 |

---

## Hooks（自動化）

### 生命週期覆蓋

```
[新 Session]
  └─ session-start → 自動修復 + 記憶衰退 + consolidation 偵測 + 邊 review

[使用者送訊息]
  └─ auto-recall → 查 KG → 注入相關知識
                 → correction detector → 偵測糾正

[AI 準備操作]
  └─ search-enforcer → 特定模式下擋住沒查記憶的操作

[AI 回覆完]
  └─ auto-capture → 分析學習信號 → 擋住 → 主 Claude 用 MCP 存

[Context 壓縮]
  └─ post-compact → 重注入核心知識
```

### settings.json 設定範例

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{
          "type": "command",
          "command": "node /path/to/hooks/session-start.js",
          "timeout": 10
        }]
      },
      {
        "matcher": "compact",
        "hooks": [{
          "type": "command",
          "command": "node /path/to/hooks/post-compact.js",
          "timeout": 10
        }]
      }
    ],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node /path/to/hooks/auto-recall.js",
        "timeout": 10
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "agent",
        "model": "claude-opus-4-6",
        "prompt": "Auto-Capture prompt（見 settings.json 完整內容）",
        "timeout": 60
      }]
    }],
    "PreToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "node /path/to/hooks/search-enforcer.js",
        "timeout": 5
      }]
    }]
  }
}
```

### Auto-Capture 設計

Agent hook 不能呼叫 MCP 工具。解法：agent 分析對話 → 輸出 `<auto-capture>` 指令 → 擋住主 Claude → 主 Claude 用 MCP 存知識 → 再次觸發 Stop → `stop_hook_active=true` → 放行。

體感：主 AI 突然「想到」要存知識，自然地用 MCP 工具存入。

---

## Session-Start 自動維護

每個新 session 自動執行：

1. 修復 dangling edges
2. 清理 expired 節點的殘留索引
3. 報告孤兒節點
4. 記憶衰退 — R < 0.02 且 level < 3 → expire
5. 衰退報告 — 顯示 R < 0.3 的節點
6. Consolidation 偵測 — vector similarity < 0.25 的節點對
7. 弱邊清理 — weight < 0.3 → expire
8. 最近邊 review — 24 小時內新增的邊

---

## 資料模型

### 節點

| 欄位 | 說明 |
|------|------|
| type | rule / procedure / observation / insight / core / preference |
| trust | principle（專家教的）/ pattern（觀察的）/ inference（推測的）|
| stability | FSRS S（天數），控制衰退速度 |
| memory_level | Benna-Fusi level 1-4，控制耐久度 |
| metadata.category | fundamental（基本功）/ creative（創意空間）|
| source | session ID / "teacher" / "auto-capture" |
| quote | 專家原話（principle 必填）|

### 邊

| 邊 | 意義 |
|----|------|
| `must_precede` | A 必須在 B 之前 |
| `requires_reading` | 操作 A 前要讀 B |
| `refines` | A 細化 B |
| `contradicts` | A 跟 B 矛盾 |
| `reason_for` | A 是做 B 的原因 |
| `causes` / `implies` / `aligns_to` / `tends_to` / `observed_in` | 其他語義關聯 |

---

## 安全性

| 風險 | 防護 |
|------|------|
| SQL injection | 參數化查詢 + 白名單驗證 |
| FTS5 特殊字元 | sanitize + 雙引號包裝 |
| store 非 atomic | node + FTS 包進 transaction |
| 無效 ID timeout | 移入 try/except 回傳明確錯誤 |
| Stability 溢出 | cap 365 天 |
| Level 單 session 灌水 | metadata.sessions 追蹤跨 session |

---

## 搭配使用

### 推薦的 Skill 結構

Knowledge Graph 儲存「知識」，Skill 文件定義「行為」。兩者互補：

```
skills/
├── <domain>/                    # 領域知識
│   ├── principles.md            # 核心原則
│   ├── elements/                # 各元素的操作流程
│   │   ├── <element>/
│   │   │   └── workflow.md      # 可執行的工具操作步驟
│   │   └── checklist.md         # 元素清單 + 依賴圖
│   └── evaluation/              # 品質評估標準
├── specialty/                   # 專業分支覆寫
├── tools/                       # 工具使用知識
│   ├── gotchas/                 # 危險操作 / 陷阱
│   └── batch/                   # 批量工具對照
└── preflight.md                 # 做事前必讀清單
```

**關鍵**：skill 文件必須「可執行」— agent 讀完後能直接操作，不需要猜。

### 搭配其他 MCP Server

Knowledge Graph 是記憶層，搭配**領域操作 MCP** 來執行工作：

| 組合 | Knowledge Graph 負責 | 領域 MCP 負責 |
|------|---------------------|--------------|
| 程式開發 | 架構決策、code review 經驗、bug 模式 | IDE / Git / CI 操作 |
| 設計 | 設計原則、品牌規範、使用者回饋 | Figma / 設計工具操作 |
| 資料分析 | 分析方法論、領域知識、過去經驗 | DB / BI 工具操作 |
| 任何專業領域 | 領域知識、工作流經驗、專家教學 | 對應的操作工具 |

---

## 參考資料

### 學術論文
| 論文 | 貢獻 |
|------|------|
| [FSRS Algorithm](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm) | Power-law forgetting curve + desirable difficulty |
| [MemoryBank (AAAI 2024)](https://arxiv.org/abs/2305.10250) | LLM 長期記憶 + Ebbinghaus forgetting curve |
| [Benna & Fusi (Nature Neuroscience 2016)](https://www.nature.com/articles/nn.4401) | 突觸級聯模型 |
| [Generative Agents (Stanford, UIST 2023)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) | 三信號檢索 + Reflection 機制 |
| [Zep: Temporal KG Architecture](https://arxiv.org/abs/2501.13956) | 雙時間模型 |
| [Synaptic Memory Consolidation](https://arxiv.org/html/2405.16922v1) | EWC + Synaptic Intelligence |
| [Mem0: AI Agent Memory](https://arxiv.org/html/2504.19413v1) | Production-ready agent memory |

### 開源實作
| 專案 | 借鑑 |
|------|------|
| [CortexGraph](https://github.com/prefrontal-systems/cortexgraph) | 兩階段衰退、consolidation、sub-linear frequency |
| [Claude-Recall](https://github.com/anthropics/claude-recall) | search enforcer、correction detector |
| [A-MEM](https://github.com/a-mem/a-mem) | typed edges、memory enzyme |
| [Mnemon](https://github.com/mnemon-dev/mnemon) | 4 圖架構、importance decay |
| [memsearch (Zilliz)](https://github.com/zilliztech/memsearch) | Hybrid dense+BM25+RRF |
| [second-brain (jugaad-lab)](https://github.com/jugaad-lab/second-brain) | Category-weighted decay |
| [Graphiti (Zep)](https://github.com/getzep/graphiti) | Temporal knowledge graph |

### 認知科學
| 概念 | 應用 |
|------|------|
| [Ebbinghaus Forgetting Curve](https://en.wikipedia.org/wiki/Forgetting_curve) | 記憶衰退基礎模型 |
| [SM-2 Algorithm](https://super-memory.com/english/ol/sm2.htm) | 間隔重複經典算法 |
| [Desirable Difficulty](https://en.wikipedia.org/wiki/Desirable_difficulty) | FSRS 的核心理論基礎 |

---

## 致謝

本系統融合了多個開源社群和學術研究的智慧。特別感謝：

- **[open-spaced-repetition](https://github.com/open-spaced-repetition)** 的 FSRS 算法
- **[prefrontal-systems](https://github.com/prefrontal-systems)** 的 CortexGraph
- **[Anthropic](https://github.com/anthropics)** 的 Claude-Recall
- **Stanford HCI Group** 的 Generative Agents 論文
- **Benna & Fusi** 的突觸級聯模型
- **[Zilliz](https://github.com/zilliztech)**、**[jugaad-lab](https://github.com/jugaad-lab)**、**[Zep](https://github.com/getzep)** 等開源專案

---

## 部署

### 包含在 repo 中
- 所有 `lib/`、`tools/`、`hooks/`、`scripts/` 程式碼
- Hooks 設定範例

### 使用者自己產生
- `knowledge.db` — 首次啟動自動建立
- Qwen3 ONNX 模型 — 首次 embed 時自動下載
- `node_modules/` — `npm install`

### 首次使用
1. `npm install`
2. 設定 `.mcp.json` + `~/.claude/settings.json` hooks
3. 啟動 Claude Code → MCP 自動啟動 → 模型自動下載
4. 開始對話 → hooks 自動運作 → 知識自動累積

## License

MIT
