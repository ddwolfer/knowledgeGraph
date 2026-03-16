/**
 * Maintenance tools: maintain_graph (Memory Enzyme) + crystallize_skill (Knowledge-Skill Sync)
 */

import { z } from 'zod';
import { readFileSync } from 'fs';
import { maintainGraph } from '../lib/enzyme.js';
import { getDb } from '../lib/db.js';

export function registerMaintenanceTools(server) {

  // ─── maintain_graph ───
  server.tool(
    'maintain_graph',
    'Run maintenance operations on the knowledge graph: prune weak edges, find duplicates, validate edges, find orphan nodes.',
    {
      operations: z.enum(['prune', 'merge', 'validate', 'orphan', 'all']).default('all')
        .describe('Which maintenance operation to run'),
    },
    async ({ operations }) => {
      const report = maintainGraph(operations);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(report, null, 2)
        }]
      };
    }
  );

  // ─── crystallize_skill ───
  server.tool(
    'crystallize_skill',
    'Check if KG has knowledge not yet reflected in skill md files. Reports unsynced knowledge that needs to be added to existing skills, or suggests creating new md files if content doesn\'t fit anywhere.',
    {
      topic: z.string().describe('Topic to check (e.g. "kick", "808", "hihat", "transition")'),
      skill_paths: z.array(z.string()).optional()
        .describe('Absolute paths to existing skill md files to check against. If omitted, only lists KG knowledge for the topic.'),
    },
    async ({ topic, skill_paths }) => {
      const db = getDb();

      // Find all knowledge nodes related to this topic
      const topicPattern = `%${topic}%`;
      const nodes = db.prepare(`
        SELECT n.id, n.name, n.content, n.trust, n.type, n.quote, n.created_at,
               json_extract(n.metadata, '$.element') as element
        FROM nodes n
        WHERE n.valid_until IS NULL
          AND (n.name LIKE ? OR n.content LIKE ? OR json_extract(n.metadata, '$.element') = ?)
        ORDER BY n.trust DESC, n.created_at DESC
      `).all(topicPattern, topicPattern, topic);

      if (nodes.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ topic, status: 'no_knowledge', message: `No knowledge found for topic "${topic}".` }, null, 2)
          }]
        };
      }

      // Read existing skill files and check which KG knowledge is NOT mentioned
      const unsynced = [];
      const synced = [];
      let skillContents = '';

      if (skill_paths && skill_paths.length > 0) {
        for (const sp of skill_paths) {
          try {
            skillContents += readFileSync(sp, 'utf-8') + '\n';
          } catch (e) {
            // file doesn't exist — all knowledge for this path is unsynced
          }
        }
      }

      for (const node of nodes) {
        // Heuristic: check if the node's key phrases appear in skill files
        const keyPhrases = extractKeyPhrases(node.name, node.content);
        const found = skillContents && keyPhrases.some(phrase => skillContents.includes(phrase));

        if (found) {
          synced.push({ name: node.name, trust: node.trust });
        } else {
          unsynced.push({
            name: node.name,
            trust: node.trust,
            type: node.type,
            content_preview: node.content.substring(0, 150),
            quote: node.quote || null,
            created_at: node.created_at,
          });
        }
      }

      // Find edges between topic nodes for context
      const nodeIds = nodes.map(n => n.id);
      const placeholders = nodeIds.map(() => '?').join(',');
      const edges = nodeIds.length > 0 ? db.prepare(`
        SELECT e.relation_type, n1.name as source_name, n2.name as target_name, e.reasoning
        FROM edges e
        JOIN nodes n1 ON e.source_id = n1.id
        JOIN nodes n2 ON e.target_id = n2.id
        WHERE (e.source_id IN (${placeholders}) OR e.target_id IN (${placeholders}))
          AND e.valid_until IS NULL
      `).all(...nodeIds, ...nodeIds) : [];

      // Determine if new file is needed
      const needsNewFile = !skill_paths || skill_paths.length === 0 ||
        (unsynced.length > 3 && unsynced.filter(n => n.trust === 'principle').length >= 2);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            topic,
            total_nodes: nodes.length,
            by_trust: {
              principle: nodes.filter(n => n.trust === 'principle').length,
              pattern: nodes.filter(n => n.trust === 'pattern').length,
              inference: nodes.filter(n => n.trust === 'inference').length,
            },
            synced: synced.length,
            unsynced_count: unsynced.length,
            unsynced,
            related_edges: edges.length,
            suggestion: needsNewFile
              ? 'Consider creating a new md file — multiple unsynced principles found with no existing skill file.'
              : unsynced.length > 0
                ? `Update existing skill files — ${unsynced.length} knowledge items not yet reflected.`
                : 'All knowledge is synced with skill files.',
          }, null, 2)
        }]
      };
    }
  );
}

/**
 * Extract key phrases from node name and content for matching against skill files.
 */
function extractKeyPhrases(name, content) {
  const phrases = [];

  // Use node name parts (split by > for hierarchical names)
  const nameParts = name.split('>').map(s => s.trim()).filter(s => s.length > 2);
  phrases.push(...nameParts);

  // Extract quoted text from content (teacher quotes)
  const quoteMatches = content.match(/「([^」]+)」/g);
  if (quoteMatches) {
    phrases.push(...quoteMatches.map(q => q.replace(/[「」]/g, '')));
  }

  // Use first meaningful sentence
  const firstLine = content.split('\n')[0];
  if (firstLine && firstLine.length > 5 && firstLine.length < 80) {
    phrases.push(firstLine);
  }

  return phrases;
}
