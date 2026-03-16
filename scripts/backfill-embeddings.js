#!/usr/bin/env node

/**
 * Backfill embeddings for nodes that were imported without vector indexing.
 *
 * Usage: node scripts/backfill-embeddings.js
 *
 * Finds all active nodes without a vec_nodes entry and generates embeddings.
 */

import { getDb, closeDb } from '../lib/db.js';
import { embed } from '../lib/embeddings.js';

async function main() {
  const db = getDb();

  const nodesWithoutVec = db.prepare(`
    SELECT n.id, n.name, n.content
    FROM nodes n
    WHERE n.valid_until IS NULL
      AND n.id NOT IN (SELECT node_id FROM vec_nodes)
  `).all();

  console.log(`Found ${nodesWithoutVec.length} nodes without embeddings`);

  let count = 0;
  for (const node of nodesWithoutVec) {
    try {
      const text = `${node.name} ${(node.content || '').substring(0, 300)}`;
      const embedding = await embed(text);
      db.prepare('INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)').run(node.id, embedding);
      count++;
      if (count % 10 === 0) console.log(`  Embedded ${count}/${nodesWithoutVec.length}...`);
    } catch (e) {
      console.error(`  Failed: ${node.name}: ${e.message}`);
    }
  }

  console.log(`Embedded ${count} nodes`);

  const stats = {
    nodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL').get().c,
    edges: db.prepare('SELECT COUNT(*) as c FROM edges WHERE valid_until IS NULL').get().c,
    vectorized: db.prepare('SELECT COUNT(*) as c FROM vec_nodes').get().c,
  };
  console.log(`Final: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.vectorized} vectorized`);

  closeDb();
}

main().catch(console.error);
