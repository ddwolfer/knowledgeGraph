/**
 * Core knowledge tools: store_knowledge, connect_knowledge, forget_knowledge, memory_stats
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../lib/db.js';
import { embed, isReady } from '../lib/embeddings.js';
import { initialStability } from '../lib/decay.js';

export function registerKnowledgeTools(server) {

  // ─── store_knowledge ───
  server.tool(
    'store_knowledge',
    'Store a knowledge node in the graph. Auto-generates embedding and FTS index.',
    {
      type: z.enum(['rule', 'procedure', 'observation', 'insight', 'core', 'preference'])
        .describe('Knowledge type'),
      trust: z.enum(['principle', 'pattern', 'inference'])
        .describe('Trust level: principle (teacher said) > pattern (observed) > inference (AI guess)'),
      name: z.string().describe('Short name for this knowledge'),
      content: z.string().describe('Full knowledge content'),
      source: z.string().optional().describe('Session ID or "teacher" / "external"'),
      quote: z.string().optional().describe('Teacher\'s exact words (required for trust=principle)'),
      metadata: z.record(z.any()).optional().describe('JSON metadata: {element, genre, bpm, key, ...}'),
    },
    async ({ type, trust, name, content, source, quote, metadata }) => {
      // Anti-fabrication: principle requires quote
      if (trust === 'principle' && !quote) {
        return {
          content: [{ type: 'text', text: 'ERROR: trust=principle requires a quote (teacher\'s exact words).' }],
          isError: true
        };
      }

      const db = getDb();
      const id = uuidv4();
      const now = new Date().toISOString();

      // Initialize decay fields
      const category = metadata?.category;
      const stability = initialStability(trust, category);
      const memoryLevel = (trust === 'principle' && category === 'fundamental') ? 4 : 1;

      // Transaction: node + FTS must be atomic
      const insertNodeAndFts = db.transaction(() => {
        db.prepare(`
          INSERT INTO nodes (id, type, trust, name, content, source, quote, metadata, stability, memory_level, valid_from, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, type, trust, name, content, source || null, quote || null,
          metadata ? JSON.stringify(metadata) : null, stability, memoryLevel, now, now, now);

        db.prepare(`
          INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)
        `).run(id, name, content);
      });
      insertNodeAndFts();

      // Vector embedding + auto-connect
      let embeddingStatus = 'skipped';
      let autoEdges = [];

      if (isReady()) {
        try {
          const embedding = await embed(`${name} ${content}`);
          db.prepare(`
            INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)
          `).run(id, embedding);
          embeddingStatus = 'indexed';

          // Suggest connections: find most similar existing nodes (don't auto-create edges)
          try {
            const similar = db.prepare(`
              SELECT v.node_id, v.distance, n.name, n.trust
              FROM vec_nodes v
              JOIN nodes n ON v.node_id = n.id
              WHERE v.embedding MATCH ? AND k = 4
                AND n.valid_until IS NULL
                AND v.node_id != ?
            `).all(embedding, id);

            for (const s of similar) {
              if (s.distance < 0.8) {
                autoEdges.push({ target_id: s.node_id, target: s.name, distance: s.distance.toFixed(3) });
              }
            }
          } catch { /* suggestion failed, non-critical */ }
        } catch (e) {
          embeddingStatus = `error: ${e.message}`;
        }
      } else {
        embeddingStatus = 'model_loading';
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ id, name, type, trust, embeddingStatus, suggestedEdges: autoEdges }, null, 2)
        }]
      };
    }
  );

  // ─── connect_knowledge ───
  server.tool(
    'connect_knowledge',
    'Create a causal edge between two knowledge nodes.',
    {
      source_id: z.string().describe('Source node ID'),
      target_id: z.string().describe('Target node ID'),
      relation_type: z.enum([
        'must_precede', 'causes', 'implies', 'aligns_to', 'contradicts',
        'refines', 'observed_in', 'reason_for', 'tends_to', 'requires_reading'
      ]).describe('Edge type'),
      reasoning: z.string().optional().describe('Why this relationship exists'),
      weight: z.number().min(0).max(1).default(1.0).describe('Edge strength 0-1'),
      source_session: z.string().optional().describe('Session where this was learned'),
    },
    async ({ source_id, target_id, relation_type, reasoning, weight: rawWeight, source_session }) => {
      const weight = rawWeight ?? 1.0;
      const db = getDb();

      // Verify both nodes exist
      const sourceNode = db.prepare('SELECT id, trust FROM nodes WHERE id = ?').get(source_id);
      const targetNode = db.prepare('SELECT id, trust FROM nodes WHERE id = ?').get(target_id);

      if (!sourceNode) {
        return { content: [{ type: 'text', text: `ERROR: source node ${source_id} not found` }], isError: true };
      }
      if (!targetNode) {
        return { content: [{ type: 'text', text: `ERROR: target node ${target_id} not found` }], isError: true };
      }

      // Anti-fabrication: inference nodes can't create must_precede or reason_for edges
      if (['must_precede', 'reason_for'].includes(relation_type)) {
        if (sourceNode.trust === 'inference' || targetNode.trust === 'inference') {
          return {
            content: [{
              type: 'text',
              text: `ERROR: ${relation_type} edges cannot involve inference-trust nodes. Only principle/pattern nodes allowed.`
            }],
            isError: true
          };
        }
        if (!source_session) {
          return {
            content: [{
              type: 'text',
              text: `ERROR: ${relation_type} edges require source_session.`
            }],
            isError: true
          };
        }
      }

      // Check for existing edge
      const existing = db.prepare(`
        SELECT id FROM edges
        WHERE source_id = ? AND target_id = ? AND relation_type = ? AND valid_until IS NULL
      `).get(source_id, target_id, relation_type);

      if (existing) {
        // Update weight and reasoning
        db.prepare(`
          UPDATE edges SET weight = ?, reasoning = COALESCE(?, reasoning) WHERE id = ?
        `).run(weight, reasoning, existing.id);

        return {
          content: [{ type: 'text', text: JSON.stringify({ updated: existing.id, weight, relation_type }) }]
        };
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO edges (id, source_id, target_id, relation_type, reasoning, weight, source_session, valid_from, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, source_id, target_id, relation_type, reasoning || null, weight, source_session || null, now, now);

      return {
        content: [{ type: 'text', text: JSON.stringify({ id, relation_type, weight }) }]
      };
    }
  );

  // ─── forget_knowledge ───
  server.tool(
    'forget_knowledge',
    'Mark a knowledge node as expired (soft delete). Does not physically delete.',
    {
      node_id: z.string().describe('Node ID to expire'),
      reason: z.string().describe('Why this knowledge is being expired'),
    },
    async ({ node_id, reason }) => {
      const db = getDb();
      const now = new Date().toISOString();

      const node = db.prepare('SELECT name FROM nodes WHERE id = ?').get(node_id);
      if (!node) {
        return { content: [{ type: 'text', text: `ERROR: node ${node_id} not found` }], isError: true };
      }

      // Expire node
      db.prepare('UPDATE nodes SET valid_until = ?, updated_at = ? WHERE id = ?').run(now, now, node_id);

      // Expire all connected edges
      const expiredEdges = db.prepare(`
        UPDATE edges SET valid_until = ? WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL
      `).run(now, node_id, node_id);

      // Clean FTS5 index
      try { db.prepare('DELETE FROM fts_nodes WHERE node_id = ?').run(node_id); } catch { /* ok */ }

      // Clean vector index
      try { db.prepare('DELETE FROM vec_nodes WHERE node_id = ?').run(node_id); } catch { /* ok */ }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            expired: node.name,
            reason,
            edgesExpired: expiredEdges.changes
          })
        }]
      };
    }
  );

  // ─── memory_stats ───
  server.tool(
    'memory_stats',
    'Get statistics about the knowledge graph.',
    {},
    async () => {
      const db = getDb();

      const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NULL').get().c;
      const edgeCount = db.prepare('SELECT COUNT(*) as c FROM edges WHERE valid_until IS NULL').get().c;
      const episodeCount = db.prepare('SELECT COUNT(*) as c FROM episodes').get().c;

      const byType = db.prepare(`
        SELECT type, COUNT(*) as c FROM nodes WHERE valid_until IS NULL GROUP BY type
      `).all();

      const byTrust = db.prepare(`
        SELECT trust, COUNT(*) as c FROM nodes WHERE valid_until IS NULL GROUP BY trust
      `).all();

      const edgesByType = db.prepare(`
        SELECT relation_type, COUNT(*) as c FROM edges WHERE valid_until IS NULL GROUP BY relation_type
      `).all();

      const expiredNodes = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE valid_until IS NOT NULL').get().c;
      const expiredEdges = db.prepare('SELECT COUNT(*) as c FROM edges WHERE valid_until IS NOT NULL').get().c;

      const vecCount = db.prepare('SELECT COUNT(*) as c FROM vec_nodes').get().c;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            activeNodes: nodeCount,
            activeEdges: edgeCount,
            episodes: episodeCount,
            vectorized: vecCount,
            byType: Object.fromEntries(byType.map(r => [r.type, r.c])),
            byTrust: Object.fromEntries(byTrust.map(r => [r.trust, r.c])),
            edgesByType: Object.fromEntries(edgesByType.map(r => [r.relation_type, r.c])),
            expired: { nodes: expiredNodes, edges: expiredEdges }
          }, null, 2)
        }]
      };
    }
  );
}
