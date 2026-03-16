/**
 * Search and traversal tools: search_memory, traverse_graph, list_knowledge, update_knowledge
 */

import { z } from 'zod';
import { hybridSearch } from '../lib/search.js';
import { traverseGraph } from '../lib/graph.js';
import { embed, isReady } from '../lib/embeddings.js';
import { getDb } from '../lib/db.js';

export function registerSearchTools(server) {

  // ─── search_memory ───
  server.tool(
    'search_memory',
    'Search the knowledge graph using hybrid search (vector + keyword + graph expansion).',
    {
      query: z.string().describe('Search query — natural language or keywords'),
      mode: z.enum(['hybrid', 'vector', 'keyword']).default('hybrid')
        .describe('Search mode: hybrid (all 3), vector (semantic only), keyword (FTS5 only)'),
      limit: z.number().min(1).max(50).default(10).describe('Max results'),
    },
    async ({ query, mode, limit }) => {
      const results = await hybridSearch(query, { mode, limit });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }

      const formatted = results.map((r, i) => {
        let text = `[${i + 1}] ${r.name} (${r.trust}/${r.type}, score: ${r.score.toFixed(3)})\n`;
        text += `    ${r.content}\n`;
        if (r.quote) text += `    💬 "${r.quote}"\n`;
        if (r.edges.length > 0) {
          text += `    Edges:\n`;
          for (const e of r.edges) {
            const arrow = e.direction === 'outgoing' ? '→' : '←';
            text += `      ${arrow} [${e.relation_type}] ${e.connected_name}`;
            if (e.reasoning) text += ` (${e.reasoning})`;
            text += '\n';
          }
        }
        return text;
      });

      return {
        content: [{
          type: 'text',
          text: `Found ${results.length} results:\n\n${formatted.join('\n')}`
        }]
      };
    }
  );

  // ─── traverse_graph ───
  server.tool(
    'traverse_graph',
    'Traverse the knowledge graph from a starting node, following causal edges.',
    {
      node_id: z.string().describe('Starting node ID'),
      edge_types: z.array(z.enum([
        'must_precede', 'causes', 'implies', 'aligns_to', 'contradicts',
        'refines', 'observed_in', 'reason_for', 'tends_to', 'requires_reading'
      ])).optional().describe('Filter by edge types (default: all)'),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('both')
        .describe('Traversal direction'),
      depth: z.number().min(1).max(5).default(2).describe('Max traversal depth'),
    },
    async ({ node_id, edge_types, direction, depth }) => {
      const result = traverseGraph(node_id, {
        edgeTypes: edge_types || [],
        direction,
        depth
      });

      if (!result.root) {
        return { content: [{ type: 'text', text: `Node ${node_id} not found.` }], isError: true };
      }

      let text = `Root: ${result.root.name} (${result.root.trust}/${result.root.type})\n`;
      text += `  ${result.root.content}\n\n`;

      if (result.nodes.length === 0) {
        text += 'No connected nodes found.\n';
      } else {
        text += `Connected nodes (${result.nodes.length}):\n`;
        for (const n of result.nodes) {
          text += `  [depth ${n._depth}] ${n.name} (${n.trust}/${n.type})\n`;
          text += `    ${n.content}\n`;
        }
      }

      if (result.edges.length > 0) {
        text += `\nEdges (${result.edges.length}):\n`;
        for (const e of result.edges) {
          text += `  ${e.source_name} --[${e.relation_type}]--> ${e.target_name}`;
          if (e.reasoning) text += `  (${e.reasoning})`;
          text += '\n';
        }
      }

      return { content: [{ type: 'text', text }] };
    }
  );

  // ─── list_knowledge ───
  server.tool(
    'list_knowledge',
    'List knowledge nodes by filters. Use for browsing/listing instead of search_memory (which is for relevance-ranked search).',
    {
      trust: z.enum(['principle', 'pattern', 'inference']).optional()
        .describe('Filter by trust level'),
      type: z.enum(['rule', 'procedure', 'observation', 'insight', 'core', 'preference']).optional()
        .describe('Filter by knowledge type'),
      element: z.string().optional()
        .describe('Filter by metadata.element (e.g. "808", "kick", "hihat")'),
      source: z.string().optional()
        .describe('Filter by source (e.g. "auto-capture", "teacher", session ID)'),
      sort: z.enum(['recent', 'accessed', 'name', 'strength']).default('recent')
        .describe('Sort order: recent, accessed, name, strength (by memory decay score)'),
      limit: z.number().min(1).max(50).default(10).describe('Max results'),
    },
    async ({ trust, type, element, source, sort, limit }) => {
      const db = getDb();
      let where = ['n.valid_until IS NULL'];
      const params = [];

      if (trust) { where.push('n.trust = ?'); params.push(trust); }
      if (type) { where.push('n.type = ?'); params.push(type); }
      if (element) { where.push("json_extract(n.metadata, '$.element') = ?"); params.push(element); }
      if (source) { where.push('n.source = ?'); params.push(source); }

      // For sort=strength, we need to fetch all then sort in JS (decay is computed, not a column)
      const useStrengthSort = sort === 'strength';
      const orderBy = sort === 'recent' ? 'n.created_at DESC'
        : sort === 'accessed' ? 'n.access_count DESC'
        : sort === 'name' ? 'n.name ASC'
        : 'n.created_at DESC'; // strength sorts in JS after fetch

      params.push(useStrengthSort ? 200 : limit); // fetch more for strength sort

      const rows = db.prepare(`
        SELECT n.id, n.name, n.content, n.trust, n.type, n.quote, n.access_count, n.created_at,
               n.stability, n.memory_level, n.last_accessed, n.metadata,
               json_extract(n.metadata, '$.element') as element
        FROM nodes n
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ?
      `).all(...params);

      // Sort by strength if requested
      let sortedRows = rows;
      if (useStrengthSort) {
        const { retrievability: calcR } = await import('../lib/decay.js');
        sortedRows = rows.map(r => ({ ...r, _R: calcR(r) }))
          .sort((a, b) => b._R - a._R)
          .slice(0, limit);
      } else {
        sortedRows = rows.slice(0, limit);
      }

      if (sortedRows.length === 0) {
        return { content: [{ type: 'text', text: 'No nodes match the filters.' }] };
      }

      const formatted = sortedRows.map((r, i) => {
        let text = `[${i + 1}] ${r.name} (${r.trust}/${r.type}${r.element ? ', ' + r.element : ''})`;
        text += ` [L${r.memory_level || 1}, ac:${r.access_count}${r._R != null ? ', R:' + r._R.toFixed(2) : ''}, ${r.created_at.substring(0, 10)}]\n`;
        text += `    ${r.content.substring(0, 150)}${r.content.length > 150 ? '...' : ''}\n`;
        if (r.quote) text += `    💬 "${r.quote.substring(0, 80)}${r.quote.length > 80 ? '...' : ''}"\n`;
        return text;
      });

      return {
        content: [{
          type: 'text',
          text: `${rows.length} nodes found:\n\n${formatted.join('\n')}`
        }]
      };
    }
  );

  // ─── update_knowledge ───
  server.tool(
    'update_knowledge',
    'Update an existing knowledge node in-place. Preserves node ID and all edges. Auto-updates FTS and vector index.',
    {
      node_id: z.string().describe('Node ID to update'),
      name: z.string().optional().describe('New name (if changing)'),
      content: z.string().optional().describe('New content (if changing)'),
      trust: z.enum(['principle', 'pattern', 'inference']).optional()
        .describe('New trust level (e.g. pattern → principle upgrade)'),
      type: z.enum(['rule', 'procedure', 'observation', 'insight', 'core', 'preference']).optional()
        .describe('New type (if changing)'),
      quote: z.string().optional().describe('Add or update teacher quote'),
      metadata: z.record(z.any()).optional().describe('Replace metadata (merges with existing)'),
    },
    async ({ node_id, name, content, trust, type, quote, metadata }) => {
      const db = getDb();
      const node = db.prepare('SELECT * FROM nodes WHERE id = ? AND valid_until IS NULL').get(node_id);
      if (!node) {
        return { content: [{ type: 'text', text: `ERROR: node ${node_id} not found or expired` }], isError: true };
      }

      // Anti-fabrication: upgrading to principle requires quote
      const newTrust = trust || node.trust;
      const newQuote = quote || node.quote;
      if (newTrust === 'principle' && !newQuote) {
        return {
          content: [{ type: 'text', text: 'ERROR: trust=principle requires a quote. Provide quote parameter.' }],
          isError: true
        };
      }

      const now = new Date().toISOString();
      const newName = name || node.name;
      const newContent = content || node.content;
      const newType = type || node.type;

      // Merge metadata
      let newMetadata = node.metadata ? JSON.parse(node.metadata) : {};
      if (metadata) {
        newMetadata = { ...newMetadata, ...metadata };
      }

      // Update node
      db.prepare(`
        UPDATE nodes SET name=?, content=?, trust=?, type=?, quote=?, metadata=?, updated_at=?
        WHERE id=?
      `).run(newName, newContent, newTrust, newType, newQuote, JSON.stringify(newMetadata), now, node_id);

      // Update FTS index
      try {
        db.prepare('DELETE FROM fts_nodes WHERE node_id = ?').run(node_id);
        db.prepare('INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)').run(node_id, newName, newContent);
      } catch { /* FTS update failed, non-critical */ }

      // Update vector embedding if content or name changed
      if ((name && name !== node.name) || (content && content !== node.content)) {
        if (isReady()) {
          try {
            const embedding = await embed(`${newName} ${newContent}`);
            try { db.prepare('DELETE FROM vec_nodes WHERE node_id = ?').run(node_id); } catch {}
            db.prepare('INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)').run(node_id, embedding);
          } catch { /* vec update failed, non-critical */ }
        }
      }

      const changes = [];
      if (name && name !== node.name) changes.push(`name: "${node.name}" → "${name}"`);
      if (content && content !== node.content) changes.push('content updated');
      if (trust && trust !== node.trust) changes.push(`trust: ${node.trust} → ${trust}`);
      if (type && type !== node.type) changes.push(`type: ${node.type} → ${type}`);
      if (quote && quote !== node.quote) changes.push('quote added/updated');
      if (metadata) changes.push('metadata merged');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: node_id,
            name: newName,
            changes: changes.length > 0 ? changes : ['no changes'],
            edgesPreserved: true
          }, null, 2)
        }]
      };
    }
  );
}
