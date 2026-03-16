#!/usr/bin/env node

/**
 * Backfill embeddings for nodes that were imported without vector indexing.
 * Also adds more edges based on content analysis.
 */

import { getDb, closeDb } from '../lib/db.js';
import { embed } from '../lib/embeddings.js';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  const db = getDb();

  // Phase 1: Backfill missing embeddings
  console.log('=== Phase 1: Backfill embeddings ===');

  const nodesWithoutVec = db.prepare(`
    SELECT n.id, n.name, n.content
    FROM nodes n
    WHERE n.valid_until IS NULL
      AND n.id NOT IN (SELECT node_id FROM vec_nodes)
  `).all();

  console.log(`Found ${nodesWithoutVec.length} nodes without embeddings`);

  let embeddedCount = 0;
  for (const node of nodesWithoutVec) {
    try {
      const text = `${node.name} ${node.content.substring(0, 300)}`;
      const embedding = await embed(text);
      db.prepare('INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)').run(node.id, new Float32Array(embedding));
      embeddedCount++;
      if (embeddedCount % 10 === 0) console.log(`  Embedded ${embeddedCount}/${nodesWithoutVec.length}...`);
    } catch (e) {
      console.error(`  Failed: ${node.name}: ${e.message}`);
    }
  }
  console.log(`Embedded ${embeddedCount} nodes`);

  // Phase 2: Add more edges based on element dependencies
  console.log('\n=== Phase 2: Add missing edges ===');

  const allNodes = db.prepare(`
    SELECT id, name, content, metadata FROM nodes WHERE valid_until IS NULL
  `).all();

  const nodeMap = new Map();
  for (const n of allNodes) {
    nodeMap.set(n.name, n.id);
  }

  const existingEdges = new Set();
  db.prepare('SELECT source_id, target_id, relation_type FROM edges WHERE valid_until IS NULL').all()
    .forEach(e => existingEdges.add(`${e.source_id}|${e.target_id}|${e.relation_type}`));

  const insertEdge = db.prepare(`
    INSERT INTO edges (id, source_id, target_id, relation_type, reasoning, weight, source_session, valid_from, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  let edgeCount = 0;

  function addEdge(sourceName, targetName, relType, reasoning, weight = 0.8) {
    const sourceId = nodeMap.get(sourceName);
    const targetId = nodeMap.get(targetName);
    if (!sourceId || !targetId || sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${relType}`;
    if (existingEdges.has(key)) return;
    existingEdges.add(key);
    insertEdge.run(uuidv4(), sourceId, targetId, relType, reasoning, weight, 'backfill', now, now);
    edgeCount++;
  }

  // Element workflow dependencies (from checklist order)
  addEdge('arrangement > elements > melody > workflow', 'arrangement > elements > kick > workflow',
    'must_precede', 'melody 先選才開始鼓組');
  addEdge('arrangement > elements > kick > workflow', 'arrangement > elements > snare > workflow',
    'must_precede', 'kick 做完再做 snare');
  addEdge('arrangement > elements > snare > workflow', 'arrangement > elements > hihat > workflow',
    'must_precede', 'snare 做完再做 hihat');

  // Snare sub-dependencies
  addEdge('arrangement > elements > snare > rhythm > backbeat', 'arrangement > elements > snare > rhythm > auxiliary',
    'must_precede', '主 snare 先放好再做輔助鼓');
  addEdge('arrangement > elements > snare > workflow', 'arrangement > elements > snare > rhythm > backbeat',
    'requires_reading', 'snare workflow 需要讀 backbeat 節奏');
  addEdge('arrangement > elements > snare > workflow', 'arrangement > elements > snare > rhythm > auxiliary',
    'requires_reading', 'snare workflow 需要讀 auxiliary 節奏');

  // Kick sub-dependencies
  addEdge('arrangement > elements > kick > workflow', 'arrangement > elements > kick > rhythm > basic',
    'requires_reading', 'kick workflow 需要讀基本節奏');

  // 808 dependencies
  addEdge('arrangement > elements > 808 > workflow', 'arrangement > elements > 808 > note-types',
    'requires_reading', '808 workflow 需要讀 note types');
  addEdge('genre > trap > arrangement > 808 > kick-coordination', 'arrangement > elements > 808 > workflow',
    'requires_reading', 'kick-coordination 是 808 workflow 的前提');

  // Transition dependencies
  addEdge('arrangement > elements > transition > workflow', 'arrangement > elements > transition > riser > technique',
    'requires_reading', 'transition 需要讀 riser 技法');
  addEdge('arrangement > elements > transition > workflow', 'arrangement > elements > transition > drum-fill > technique',
    'requires_reading', 'transition 需要讀 drum fill 技法');
  addEdge('arrangement > elements > transition > workflow', 'arrangement > elements > transition > reverse-cymbal > technique',
    'requires_reading', 'transition 需要讀 reverse cymbal 技法');
  addEdge('arrangement > elements > transition > workflow', 'arrangement > elements > transition > progressive-mute',
    'requires_reading', 'transition 需要讀 progressive mute');

  // Trap genre → element workflows
  addEdge('genre > trap > arrangement > kick > pattern', 'arrangement > elements > kick > workflow',
    'refines', 'trap kick pattern 細化 kick workflow');
  addEdge('genre > trap > arrangement > bpm-density', 'arrangement > elements > kick > workflow',
    'aligns_to', 'bpm 影響 kick 密度');
  addEdge('genre > trap > arrangement > bpm-density', 'arrangement > elements > hihat > workflow',
    'aligns_to', 'bpm 影響 hihat 密度');

  // Sample search → element workflows
  addEdge('arrangement > sample-search > splice > workflow', 'arrangement > sample-search > kick > aesthetics',
    'requires_reading', 'splice 搜尋流程適用所有元素');
  addEdge('arrangement > sample-search > splice > workflow', 'arrangement > sample-search > snare > aesthetics',
    'requires_reading', 'splice 搜尋流程適用所有元素');
  addEdge('arrangement > sample-search > splice > workflow', 'arrangement > sample-search > 808 > aesthetics',
    'requires_reading', 'splice 搜尋流程適用所有元素');
  addEdge('arrangement > sample-search > splice > workflow', 'arrangement > sample-search > melody > aesthetics',
    'requires_reading', 'splice 搜尋流程適用所有元素');
  addEdge('arrangement > sample-search > splice > workflow', 'arrangement > sample-search > hihat > aesthetics',
    'requires_reading', 'splice 搜尋流程適用所有元素');

  // Mixing dependencies
  addEdge('mixing > principles', 'mixing > gain-staging > workflow',
    'requires_reading', '混音原則先讀再做 gain staging');
  addEdge('mixing > gain-staging > workflow', 'mixing > gain-staging > element-levels',
    'requires_reading', 'gain staging 需要讀元素音量表');
  addEdge('mixing > principles', 'mixing > sidechain > workflow',
    'requires_reading', '混音原則先讀再做 sidechain');
  addEdge('mixing > principles', 'mixing > send-fx > workflow',
    'requires_reading', '混音原則先讀再做 send FX');

  // Checklist is the master reference
  addEdge('arrangement > elements > checklist', 'arrangement > elements > kick > workflow',
    'requires_reading', 'checklist 引導 kick 操作');
  addEdge('arrangement > elements > checklist', 'arrangement > elements > snare > workflow',
    'requires_reading', 'checklist 引導 snare 操作');
  addEdge('arrangement > elements > checklist', 'arrangement > elements > 808 > workflow',
    'requires_reading', 'checklist 引導 808 操作');
  addEdge('arrangement > elements > checklist', 'arrangement > elements > hihat > workflow',
    'requires_reading', 'checklist 引導 hihat 操作');
  addEdge('arrangement > elements > checklist', 'arrangement > elements > transition > workflow',
    'requires_reading', 'checklist 引導 transition 操作');

  // Preflight → checklist
  addEdge('preflight', 'arrangement > elements > checklist',
    'requires_reading', 'preflight 第一步就是讀 checklist');

  // Tools
  addEdge('tools > gotchas > dangerous-operations', 'arrangement > elements > 808 > workflow',
    'requires_reading', '808 操作需要知道危險操作');
  addEdge('tools > batch > batch-tools', 'arrangement > elements > checklist',
    'requires_reading', 'checklist 提到用 batch 工具');

  // Wet snare → snare workflow
  const wetSnareId = nodeMap.get('wet snare 音量要跟主 snare 差不多');
  const auxSnareNode = nodeMap.get('arrangement > elements > snare > rhythm > auxiliary');
  if (wetSnareId && auxSnareNode) {
    addEdge('wet snare 音量要跟主 snare 差不多', 'arrangement > elements > snare > rhythm > auxiliary',
      'refines', 'wet snare 音量規則細化 auxiliary snare 知識');
  }

  console.log(`Added ${edgeCount} new edges`);

  // Final stats
  const stats = {
    nodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL').get().c,
    edges: db.prepare('SELECT COUNT(*) as c FROM edges WHERE valid_until IS NULL').get().c,
    vectorized: db.prepare('SELECT COUNT(*) as c FROM vec_nodes').get().c,
  };
  console.log(`\nFinal: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.vectorized} vectorized`);

  closeDb();
}

main().catch(console.error);
