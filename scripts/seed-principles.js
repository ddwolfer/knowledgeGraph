#!/usr/bin/env node

/**
 * Seed principles into Knowledge Graph from a JSON file.
 *
 * Usage:
 *   node scripts/seed-principles.js [path-to-seeds.json]
 *
 * If no path given, looks for ./seeds.json in the knowledgeGraph directory.
 * If seeds file doesn't exist, exits silently (no seeds to import).
 *
 * Idempotent: skips if nodes with the same source tag already exist.
 *
 * seeds.json format:
 * [
 *   {
 *     "name": "Rule name",
 *     "content": "Rule description",
 *     "type": "rule",           // rule | observation | procedure | insight
 *     "category": "fundamental", // fundamental (never decay) | general
 *     "quote": "original quote or null"
 *   }
 * ]
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../lib/db.js';
import { embed, isReady } from '../lib/embeddings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const seedsPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(__dirname, '..', 'seeds.json');

if (!existsSync(seedsPath)) {
  console.log(`No seeds file found at ${seedsPath}, skipping.`);
  process.exit(0);
}

let PRINCIPLES;
try {
  PRINCIPLES = JSON.parse(readFileSync(seedsPath, 'utf-8'));
} catch (e) {
  console.error(`Failed to parse ${seedsPath}: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(PRINCIPLES) || PRINCIPLES.length === 0) {
  console.log('Seeds file is empty, skipping.');
  process.exit(0);
}

const now = new Date().toISOString();
const SOURCE = 'seed-principles';

async function main() {
  const db = getDb();

  // Idempotency guard
  const existing = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE source = ?").get(SOURCE).c;
  if (existing > 0) {
    console.log(`Already have ${existing} ${SOURCE} nodes, skipping (delete them to re-seed).`);
    closeDb();
    return;
  }

  // Wait for embedding model
  console.log('Waiting for embedding model...');
  try { await embed('test'); console.log('ready'); } catch { console.log('FTS5 only'); }

  const insertNode = db.prepare(`
    INSERT INTO nodes (id, type, trust, name, content, source, quote, metadata, stability, memory_level, valid_from, access_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare('INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)');

  let count = 0;
  for (const p of PRINCIPLES) {
    const id = uuidv4();
    const trust = p.quote ? 'principle' : 'pattern';
    const stability = p.category === 'fundamental' ? 365 : 30;
    const level = p.category === 'fundamental' ? 4 : 3;
    const metadata = JSON.stringify({ category: p.category || 'general' });

    insertNode.run(id, p.type || 'rule', trust, p.name, p.content, SOURCE, p.quote || null, metadata, stability, level, now, 10, now, now);
    insertFts.run(id, p.name, p.content);
    count++;

    if (isReady()) {
      try {
        const emb = await embed(`${p.name} ${p.content}`);
        db.prepare('INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)').run(id, emb);
      } catch {}
    }
  }

  console.log(`Seeded ${count} principles`);
  closeDb();
}

main().catch(console.error);
