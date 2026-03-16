#!/usr/bin/env node

/**
 * Import existing skills/ markdown files into the knowledge graph.
 * Creates nodes for each file and edges for dependencies.
 * Preserves skills/ as readable backup — KG is the queryable layer on top.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../lib/db.js';
import { embed, isReady } from '../lib/embeddings.js';

const SKILLS_DIR = '/Users/apple/dev/AutoProducer/skills';
const SOURCE = 'skills-import';

// Element → category mapping
const ELEMENT_MAP = {
  kick: 'kick', '808': '808', snare: 'snare', hihat: 'hihat',
  melody: 'melody', pad: 'pad', perc: 'perc', fx: 'fx',
  transition: 'transition', vocal: 'vocal', bass: 'bass',
};

// Detect element from file path
function detectElement(filePath) {
  const rel = relative(SKILLS_DIR, filePath).toLowerCase();
  for (const [key, value] of Object.entries(ELEMENT_MAP)) {
    if (rel.includes(`/${key}/`) || rel.includes(`/${key}.`)) return value;
  }
  return null;
}

// Detect node type from content/path
function detectType(filePath, content) {
  const name = basename(filePath, '.md');
  if (name === 'workflow') return 'procedure';
  if (name === 'principles' || name === 'checklist') return 'rule';
  if (filePath.includes('aesthetics')) return 'preference';
  if (filePath.includes('technique') || filePath.includes('rhythm')) return 'procedure';
  if (content.includes('必須') || content.includes('禁止') || content.includes('不能') || content.includes('永遠')) return 'rule';
  return 'observation';
}

// Extract teacher quotes from content
function extractQuotes(content) {
  const quotes = [];
  // Match patterns like: 「...」 or 老師說... or quote: "..."
  const patterns = [
    /「([^」]+)」/g,
    /老師[：:]\s*(.+)/g,
    /quote:\s*"([^"]+)"/g,
  ];
  for (const p of patterns) {
    let match;
    while ((match = p.exec(content)) !== null) {
      quotes.push(match[1].trim());
    }
  }
  return quotes;
}

// Parse ## 相關元素 section for dependencies
function extractDependencies(content) {
  const deps = [];
  const section = content.match(/##\s*相關元素[\s\S]*?(?=\n##\s|$)/);
  if (section) {
    const lines = section[0].split('\n');
    for (const line of lines) {
      const match = line.match(/`([^`]+\.md)`/);
      if (match) deps.push(match[1]);
    }
  }
  return deps;
}

// Recursively find all .md files
function findMarkdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        files.push(...findMarkdownFiles(full));
      } else if (entry.endsWith('.md') && stat.isFile()) {
        files.push(full);
      }
    } catch {
      // Skip broken symlinks or inaccessible entries
    }
  }
  return files;
}

async function main() {
  const db = getDb();
  const now = new Date().toISOString();
  const files = findMarkdownFiles(SKILLS_DIR);

  console.log(`Found ${files.length} markdown files in skills/`);

  // Track node IDs by file path for edge creation
  const nodesByPath = new Map();
  let nodeCount = 0;
  let edgeCount = 0;
  let embeddingCount = 0;

  // Phase 1: Create nodes
  const insertNode = db.prepare(`
    INSERT INTO nodes (id, type, trust, name, content, source, quote, metadata, valid_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare('INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)');

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const rel = relative(SKILLS_DIR, filePath);
    const element = detectElement(filePath);
    const type = detectType(filePath, content);
    const quotes = extractQuotes(content);

    // Determine trust level
    const trust = quotes.length > 0 ? 'principle' : 'pattern';

    // Create a concise name from the path
    const parts = rel.replace('.md', '').split('/');
    const name = parts.join(' > ');

    // Truncate content for node (keep first 500 chars for summary, full in FTS)
    const summary = content.substring(0, 500).replace(/^---[\s\S]*?---\n/, '').trim();

    const id = uuidv4();
    const metadata = { element, filePath: rel };

    insertNode.run(
      id, type, trust, name, summary,
      SOURCE, quotes[0] || null,
      JSON.stringify(metadata), now, now, now
    );
    insertFts.run(id, name, content); // Full content in FTS for search
    nodesByPath.set(rel, id);
    nodeCount++;

    // Embedding (if model ready)
    if (isReady()) {
      try {
        const embedding = await embed(`${name} ${summary}`);
        db.prepare('INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)').run(id, new Float32Array(embedding));
        embeddingCount++;
      } catch { /* skip */ }
    }
  }

  console.log(`Created ${nodeCount} nodes (${embeddingCount} with embeddings)`);

  // Phase 2: Create edges from dependencies
  const insertEdge = db.prepare(`
    INSERT INTO edges (id, source_id, target_id, relation_type, reasoning, weight, source_session, valid_from, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const rel = relative(SKILLS_DIR, filePath);
    const sourceId = nodesByPath.get(rel);
    if (!sourceId) continue;

    const deps = extractDependencies(content);
    for (const dep of deps) {
      // Normalize dependency path
      const depRel = dep.startsWith('skills/') ? dep.substring(7) : dep;
      const targetId = nodesByPath.get(depRel);
      if (targetId && targetId !== sourceId) {
        insertEdge.run(
          uuidv4(), sourceId, targetId, 'requires_reading',
          `${basename(rel)} depends on ${basename(depRel)}`,
          0.8, SOURCE, now, now
        );
        edgeCount++;
      }
    }
  }

  // Phase 3: Create structural edges based on element/checklist ordering
  // kick → 808 (must_precede)
  const kickWorkflow = nodesByPath.get('arrangement/elements/kick/workflow.md');
  const eightWorkflow = nodesByPath.get('arrangement/elements/808/workflow.md');
  if (kickWorkflow && eightWorkflow) {
    insertEdge.run(uuidv4(), kickWorkflow, eightWorkflow, 'must_precede', 'checklist 編曲順序', 1.0, SOURCE, now, now);
    edgeCount++;
  }

  // snare → 808 (must_precede, snare backbeat before bass)
  const snareWorkflow = nodesByPath.get('arrangement/elements/snare/workflow.md');
  if (snareWorkflow && eightWorkflow) {
    insertEdge.run(uuidv4(), snareWorkflow, eightWorkflow, 'must_precede', 'checklist 編曲順序', 1.0, SOURCE, now, now);
    edgeCount++;
  }

  // melody → kick (must_precede, melody first in Phase 2)
  const melodyWorkflow = nodesByPath.get('arrangement/elements/melody/workflow.md');
  if (melodyWorkflow && kickWorkflow) {
    insertEdge.run(uuidv4(), melodyWorkflow, kickWorkflow, 'must_precede', 'melody 先選才開始鼓組', 1.0, SOURCE, now, now);
    edgeCount++;
  }

  // 808 → root-note-analysis (requires_reading)
  const rootAnalysis = nodesByPath.get('arrangement/elements/808/root-note-analysis.md');
  if (eightWorkflow && rootAnalysis) {
    insertEdge.run(uuidv4(), eightWorkflow, rootAnalysis, 'requires_reading', '808 需要根音分析', 1.0, SOURCE, now, now);
    edgeCount++;
  }

  // principles → checklist (refines)
  const principles = nodesByPath.get('arrangement/principles.md');
  const checklist = nodesByPath.get('arrangement/elements/checklist.md');
  if (principles && checklist) {
    insertEdge.run(uuidv4(), checklist, principles, 'refines', 'checklist 實現 principles', 0.9, SOURCE, now, now);
    edgeCount++;
  }

  console.log(`Created ${edgeCount} edges`);

  // Stats
  const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL').get().c;
  const totalEdges = db.prepare('SELECT COUNT(*) as c FROM edges WHERE valid_until IS NULL').get().c;
  console.log(`\nFinal: ${totalNodes} nodes, ${totalEdges} edges in knowledge graph`);

  closeDb();
}

main().catch(console.error);
