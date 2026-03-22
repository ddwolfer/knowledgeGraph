#!/usr/bin/env node

/**
 * Auto-Recall + Correction Detector hook (UserPromptSubmit)
 *
 * 1. Auto-Recall: queries SQLite FTS5 → outputs <memory-context> to stdout
 * 2. Correction Detector: keyword heuristics detect corrections/preferences
 *    → outputs additionalContext instructing Claude (main model) to save via store_knowledge
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'knowledge.db');

// Correction / preference detection patterns
const CORRECTION_PATTERNS = [
  /不是.{0,10}是/,      // 不是X是Y
  /不要.{2,}/,           // 不要做X
  /不對/,                // 不對
  /錯了/,                // 錯了
  /應該是/,              // 應該是X
  /應該要/,              // 應該要X
  /別再/,                // 別再X
  /以後要/,              // 以後要X
  /以後不/,              // 以後不要X
  /記住/,                // 記住X
  /不能這樣/,            // 不能這樣
  /搞錯/,                // 搞錯了
  /弄錯/,                // 弄錯了
  /改成/,                // 改成X
  /換成/,                // 換成X
  /not\s+that/i,         // not that, instead...
  /don'?t\s+/i,          // don't do X
  /wrong/i,              // wrong
  /should\s+be/i,        // should be X
  /instead\s+(of|use)/i, // instead of X, use Y
  /never\s+/i,           // never do X
  /always\s+/i,          // always do X
  /stop\s+/i,            // stop doing X
  /remember\s+/i,        // remember to X
];

// Read stdin with timeout guard
let input = '';
try {
  const timeout = setTimeout(() => process.exit(0), 8000);
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  clearTimeout(timeout);
} catch {
  process.exit(0);
}

let prompt;
try {
  if (!input.trim()) process.exit(0);
  const data = JSON.parse(input);
  prompt = data.prompt || '';
} catch {
  process.exit(0);
}

if (!prompt || prompt.trim().length < 2) {
  process.exit(0);
}

// Open DB (read-only for search)
let db;
try {
  db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);
} catch {
  process.exit(0);
}

try {
  // === Part 1: Auto-Recall ===
  const sanitized = prompt.replace(/["'()*{}[\]^~!@#$%&=+|\\<>?/;:]/g, ' ').trim();
  let memoryContext = '';

  if (sanitized) {
    const words = sanitized.split(/\s+/).filter(w => w.length >= 2).slice(0, 8);

    if (words.length > 0) {
      const ftsQuery = words.map(w => `"${w}"`).join(' OR ');
      let results = [];

      try {
        results = db.prepare(`
          SELECT f.node_id, f.name, f.content, n.trust, n.type, n.quote,
                 rank as score
          FROM fts_nodes f
          JOIN nodes n ON f.node_id = n.id
          WHERE fts_nodes MATCH ? AND n.valid_until IS NULL
          ORDER BY rank
          LIMIT 5
        `).all(ftsQuery);
      } catch {
        try {
          const likeQuery = `%${words[0]}%`;
          results = db.prepare(`
            SELECT n.id as node_id, n.name, n.content, n.trust, n.type, n.quote
            FROM nodes n
            WHERE n.content LIKE ? AND n.valid_until IS NULL
            LIMIT 5
          `).all(likeQuery);
        } catch { /* skip */ }
      }

      if (results.length > 0) {
        // Compact format: name + trust/type only, no full content or edges
        // Agent can use search_memory or get_knowledge for full details
        memoryContext = '<memory-context>\n';
        memoryContext += 'Related knowledge (use get_knowledge(ids) for details):\n';
        for (const r of results) {
          memoryContext += `  - [${r.trust}/${r.type}] ${r.name} (id: ${r.node_id})\n`;
        }
        memoryContext += '</memory-context>';

        // NOTE: Do NOT update access_count here.
        // Auto-recall runs on every user message — updating counts would inflate them
        // and make post-compact's ORDER BY access_count meaningless.
        // Only explicit search_memory (via hybridSearch) updates counts.
      }
    }
  }

  // === Part 2: Correction Detector ===
  let correctionDetected = false;
  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(prompt)) {
      correctionDetected = true;
      break;
    }
  }

  // === Output ===
  if (correctionDetected) {
    // Output JSON with additionalContext: memory-context + correction instruction
    const output = {
      hookSpecificOutput: {
        additionalContext: (memoryContext ? memoryContext + '\n\n' : '') +
          '<correction-detected>\n' +
          '使用者的訊息包含糾正或偏好。在回覆完使用者後，用 store_knowledge MCP 工具把這個糾正/偏好存入知識圖譜：\n' +
          '- trust: "principle"（如果是老師教的）或 "pattern"（如果是使用者偏好）\n' +
          '- type: "rule" 或 "preference"\n' +
          '- quote: 引用使用者原話\n' +
          '- source: "teacher" 或 "user"\n' +
          '如果已經有相同的知識存在（用 search_memory 確認），就不要重複存。\n' +
          '</correction-detected>'
      }
    };
    process.stdout.write(JSON.stringify(output));
  } else if (memoryContext) {
    // Output plain text memory-context
    process.stdout.write(memoryContext);
  }
  // If neither, output nothing (exit 0 silently)

} catch {
  // Any error: exit silently, don't block user
} finally {
  db.close();
}
