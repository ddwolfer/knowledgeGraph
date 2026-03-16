#!/usr/bin/env node

/**
 * Backfill stability, memory_level, and metadata.category for existing nodes.
 */

import { getDb, closeDb } from '../lib/db.js';
import { initialStability } from '../lib/decay.js';

const FUNDAMENTALS_KEYWORDS = [
  'MIDI 僅限 808', 'Utility -18dB', 'Transpose 校正', '808 stab 對齊正常 kick',
  'clip 長度對齊', 'Device chain', 'end_marker', 'loop_end', 'MCP 重啟後 ID',
  'exec_python', 'Melody = 主體', '編曲順序', '因果邏輯', '小 bar', '擴展', '減法',
  'Consolidate', 'Snare backbeat', '輔助鼓 duration', 'offbeat', 'Hi-hat 用一個 loop',
  'Hi-hat 留白', 'Wet snare 音量', 'Melody/Pad 不能鋪滿', '銜接音', 'Transition',
  '長音 bass 用 Synth Bass', '808 和 Synth Bass 不能同段', 'Env Sustain',
  'Drum fill 獨立軌道', 'EQ Eight HP 3000Hz', 'Utility -12dB', 'EQ Eight HP 200Hz',
  'Utility -8dB', 'FX 軌道', '-30dB', 'Device Chain 固定數值',
  'store_chosen_bank', 'clip gain', 'clip.end_time', 'Group Track',
  '808 選音要先 preview', 'looping=false', 'load_sample_to_track 只載入',
];

function main() {
  const db = getDb();
  const nodes = db.prepare('SELECT id, name, content, trust, metadata FROM nodes WHERE valid_until IS NULL').all();

  let updated = 0;
  const update = db.prepare('UPDATE nodes SET stability = ?, memory_level = ?, metadata = ? WHERE id = ?');

  for (const node of nodes) {
    const meta = node.metadata ? JSON.parse(node.metadata) : {};

    // Determine category
    if (node.trust === 'principle' && !meta.category) {
      const text = `${node.name} ${node.content}`;
      const isFundamental = FUNDAMENTALS_KEYWORDS.some(kw => text.includes(kw));
      meta.category = isFundamental ? 'fundamental' : 'creative';
    }

    // Set initial stability
    const S = initialStability(node.trust, meta.category);

    // Set initial memory_level based on existing access patterns
    let level = 1;
    if (node.trust === 'principle' && meta.category === 'fundamental') {
      level = 4; // fundamentals start at core
    } else if ((node.access_count || 0) >= 5) {
      level = 2; // frequently accessed = at least verified
    }

    update.run(S, level, JSON.stringify(meta), node.id);
    updated++;
  }

  // Stats
  const stats = {
    total: updated,
    fundamental: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL AND json_extract(metadata, '$.category') = 'fundamental'").get().c,
    creative: db.prepare("SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL AND json_extract(metadata, '$.category') = 'creative'").get().c,
    level4: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL AND memory_level = 4').get().c,
    level2: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL AND memory_level = 2').get().c,
    level1: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL AND memory_level = 1').get().c,
  };

  console.log('Backfill complete:', JSON.stringify(stats, null, 2));
  closeDb();
}

main();
