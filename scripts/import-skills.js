#!/usr/bin/env node

/**
 * Import markdown skill files into the Knowledge Graph.
 *
 * Usage: node scripts/import-skills.js <skills-directory>
 *
 * Walks the directory tree, reads .md files, creates KG nodes + edges
 * based on content analysis (quotes, dependencies, structure).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb } from '../lib/db.js';
import { embed, isReady } from '../lib/embeddings.js';

const SKILLS_DIR = process.argv[2];
if (!SKILLS_DIR) {
  console.error('Usage: node scripts/import-skills.js <skills-directory>');
  console.error('Example: node scripts/import-skills.js ./skills');
  process.exit(1);
}

const SOURCE = 'skills-import';

function detectType(filePath, content) {
  const name = basename(filePath, '.md');
  if (name === 'workflow') return 'procedure';
  if (name === 'principles' || name === 'checklist') return 'rule';
  if (filePath.includes('aesthetics') || filePath.includes('preference')) return 'preference';
  if (filePath.includes('technique') || filePath.includes('pattern')) return 'procedure';
  if (/必須|禁止|不能|永遠|must|never|always/i.test(content)) return 'rule';
  return 'observation';
}

function extractQuotes(content) {
  const quotes = [];
  const patterns = [/「([^」]+)」/g, /quote:\s*"([^"]+)"/g];
  for (const p of patterns) {
    let match;
    while ((match = p.exec(content)) !== null) quotes.push(match[1].trim());
  }
  return quotes;
}

function extractDependencies(content) {
  const deps = [];
  const section = content.match(/##\s*(Related|Dependencies|相關)[\s\S]*?(?=\n##\s|$)/i);
  if (section) {
    const matches = section[0].matchAll(/`([^`]+\.md)`/g);
    for (const m of matches) deps.push(m[1]);
  }
  return deps;
}

function findMarkdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) files.push(...findMarkdownFiles(full));
      else if (extname(entry) === '.md' && stat.isFile()) files.push(full);
    } catch { /* skip broken symlinks */ }
  }
  return files;
}

async function main() {
  const db = getDb();
  const now = new Date().toISOString();
  const files = findMarkdownFiles(SKILLS_DIR);

  console.log(`Found ${files.length} markdown files in ${SKILLS_DIR}`);

  const nodesByPath = new Map();
  let nodeCount = 0, edgeCount = 0, embeddingCount = 0;

  const insertNode = db.prepare(`
    INSERT INTO nodes (id, type, trust, name, content, source, quote, metadata, valid_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare('INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)');

  // Phase 1: Create nodes
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const rel = relative(SKILLS_DIR, filePath);
    const type = detectType(filePath, content);
    const quotes = extractQuotes(content);
    const trust = quotes.length > 0 ? 'principle' : 'pattern';
    const name = rel.replace('.md', '').split('/').join(' > ');
    const summary = content.substring(0, 500).replace(/^---[\s\S]*?---\n/, '').trim();

    const id = uuidv4();
    insertNode.run(id, type, trust, name, summary, SOURCE, quotes[0] || null,
      JSON.stringify({ filePath: rel }), now, now, now);
    insertFts.run(id, name, content);
    nodesByPath.set(rel, id);
    nodeCount++;

    if (isReady()) {
      try {
        const embedding = await embed(`${name} ${summary}`);
        db.prepare('INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)').run(id, embedding);
        embeddingCount++;
      } catch { /* skip */ }
    }
  }

  console.log(`Created ${nodeCount} nodes (${embeddingCount} with embeddings)`);

  // Phase 2: Create edges from ## Dependencies / ## 相關元素 sections
  const insertEdge = db.prepare(`
    INSERT INTO edges (id, source_id, target_id, relation_type, reasoning, weight, source_session, valid_from, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const rel = relative(SKILLS_DIR, filePath);
    const sourceId = nodesByPath.get(rel);
    if (!sourceId) continue;

    for (const dep of extractDependencies(content)) {
      const depRel = dep.startsWith('skills/') ? dep.substring(7) : dep;
      const targetId = nodesByPath.get(depRel);
      if (targetId && targetId !== sourceId) {
        insertEdge.run(uuidv4(), sourceId, targetId, 'requires_reading',
          `${basename(rel)} depends on ${basename(depRel)}`, 0.8, SOURCE, now, now);
        edgeCount++;
      }
    }
  }

  console.log(`Created ${edgeCount} edges`);

  const stats = {
    nodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL').get().c,
    edges: db.prepare('SELECT COUNT(*) as c FROM edges WHERE valid_until IS NULL').get().c,
  };
  console.log(`Final: ${stats.nodes} nodes, ${stats.edges} edges`);
  closeDb();
}

main().catch(console.error);
