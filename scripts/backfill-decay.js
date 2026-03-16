#!/usr/bin/env node

/**
 * Backfill stability and memory_level for existing nodes.
 *
 * Usage: node scripts/backfill-decay.js [--fundamentals "keyword1,keyword2,..."]
 *
 * Options:
 *   --fundamentals  Comma-separated keywords to identify fundamental principles.
 *                   Nodes containing these keywords get category="fundamental" + level 4.
 *                   If omitted, all principles default to category="creative".
 *
 * Example:
 *   node scripts/backfill-decay.js --fundamentals "must always,never change,required"
 */

import { getDb, closeDb } from '../lib/db.js';
import { initialStability } from '../lib/decay.js';

// Parse --fundamentals argument
let fundamentalsKeywords = [];
const flagIndex = process.argv.indexOf('--fundamentals');
if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
  fundamentalsKeywords = process.argv[flagIndex + 1].split(',').map(s => s.trim()).filter(Boolean);
  console.log(`Using ${fundamentalsKeywords.length} fundamental keywords`);
}

function main() {
  const db = getDb();
  const nodes = db.prepare('SELECT id, name, content, trust, metadata, access_count FROM nodes WHERE valid_until IS NULL').all();

  let updated = 0;
  const update = db.prepare('UPDATE nodes SET stability = ?, memory_level = ?, metadata = ? WHERE id = ?');

  for (const node of nodes) {
    const meta = node.metadata ? JSON.parse(node.metadata) : {};

    // Determine category for principles
    if (node.trust === 'principle' && !meta.category) {
      if (fundamentalsKeywords.length > 0) {
        const text = `${node.name} ${node.content}`;
        const isFundamental = fundamentalsKeywords.some(kw => text.includes(kw));
        meta.category = isFundamental ? 'fundamental' : 'creative';
      } else {
        meta.category = 'creative'; // default if no keywords provided
      }
    }

    // Set initial stability
    const S = initialStability(node.trust, meta.category);

    // Set initial memory_level
    let level = 1;
    if (node.trust === 'principle' && meta.category === 'fundamental') {
      level = 4;
    } else if ((node.access_count || 0) >= 5) {
      level = 2;
    }

    update.run(S, level, JSON.stringify(meta), node.id);
    updated++;
  }

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
