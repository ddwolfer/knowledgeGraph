/**
 * Three-in-one hybrid search: vector (sqlite-vec) + keyword (FTS5) + graph expansion (recursive CTE)
 * Scoring: score = 0.4*vector + 0.2*keyword + 0.3*graph - 0.1*age_decay
 */

import { getDb } from './db.js';
import { embed, isReady } from './embeddings.js';
import { memoryScore, reinforceOnAccess } from './decay.js';

/**
 * Hybrid search combining vector, keyword, and graph expansion.
 * @param {string} query - Search query text
 * @param {object} options
 * @param {string} options.mode - "hybrid" | "vector" | "keyword" (default: "hybrid")
 * @param {number} options.limit - Max results (default: 10)
 * @returns {Array} Scored and ranked results with edges
 */
export async function hybridSearch(query, { mode = 'hybrid', limit = 10 } = {}) {
  const db = getDb();
  const now = new Date().toISOString();

  // Collect candidates: { nodeId -> { vectorScore, keywordScore, graphScore } }
  const candidates = new Map();

  const addCandidate = (nodeId, field, score) => {
    if (!candidates.has(nodeId)) {
      candidates.set(nodeId, { vectorScore: 0, keywordScore: 0, graphScore: 0 });
    }
    const c = candidates.get(nodeId);
    c[field] = Math.max(c[field], score);
  };

  // 1. Vector search (if mode allows)
  // mode='vector': always attempt (embed() will load model if needed)
  // mode='hybrid': only if model already ready (optimization — don't block on model load)
  if (mode === 'vector' || (mode === 'hybrid' && isReady())) {
    try {
      const queryEmbedding = await embed(query);
      const vecResults = db.prepare(`
        SELECT node_id, distance
        FROM vec_nodes
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT 20
      `).all(queryEmbedding);

      for (const row of vecResults) {
        // Convert cosine distance to similarity score (0-1)
        const similarity = 1 - row.distance;
        addCandidate(row.node_id, 'vectorScore', Math.max(0, similarity));
      }
    } catch (e) {
      // Vector search failed — fall through to keyword + graph
      console.error('Vector search error:', e.message);
    }
  }

  // 2. Keyword search (FTS5 BM25)
  if (mode !== 'vector') {
    // Sanitize query for FTS5: remove special operators, wrap words in quotes
    const sanitized = query.replace(/["'()*{}[\]^~!@#$%&=+|\\<>?/;:]/g, ' ').trim();
    const words = sanitized.split(/\s+/).filter(w => w.length >= 2).slice(0, 10);

    if (words.length > 0) {
      const ftsQuery = words.map(w => `"${w}"`).join(' OR ');
      try {
        const ftsResults = db.prepare(`
          SELECT node_id, rank
          FROM fts_nodes
          WHERE fts_nodes MATCH ?
          ORDER BY rank
          LIMIT 20
        `).all(ftsQuery);

        // Normalize FTS5 rank (negative, lower = better) to 0-1 score
        if (ftsResults.length > 0) {
          const minRank = ftsResults[ftsResults.length - 1].rank;
          const maxRank = ftsResults[0].rank;
          const range = minRank - maxRank || 1;

          for (const row of ftsResults) {
            const normalized = 1 - (row.rank - maxRank) / range;
            addCandidate(row.node_id, 'keywordScore', normalized);
          }
        }
      } catch (e) {
        console.error('FTS search error:', e.message);
      }
    }
  }

  // 3. Graph expansion — 1-hop from all candidates
  if (mode === 'hybrid' && candidates.size > 0) {
    const candidateIds = [...candidates.keys()];
    const placeholders = candidateIds.map(() => '?').join(',');

    const graphExpanded = db.prepare(`
      SELECT DISTINCT
        CASE WHEN e.source_id IN (${placeholders}) THEN e.target_id ELSE e.source_id END AS expanded_id,
        e.weight
      FROM edges e
      WHERE (e.source_id IN (${placeholders}) OR e.target_id IN (${placeholders}))
        AND e.valid_until IS NULL
    `).all(...candidateIds, ...candidateIds, ...candidateIds);

    for (const row of graphExpanded) {
      addCandidate(row.expanded_id, 'graphScore', row.weight * 0.5);
    }
  }

  // Score and rank
  const results = [];
  for (const [nodeId, scores] of candidates) {
    // Get node data
    const node = db.prepare(`
      SELECT * FROM nodes WHERE id = ? AND valid_until IS NULL
    `).get(nodeId);

    if (!node) continue;

    // Memory score: CortexGraph decay × FSRS stability × Benna-Fusi level
    const mScore = memoryScore(node);

    const finalScore =
      0.4 * scores.vectorScore +
      0.2 * scores.keywordScore +
      0.3 * scores.graphScore +
      mScore;

    // Get connected edges (1-hop)
    const edges = db.prepare(`
      SELECT e.*,
        CASE WHEN e.source_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
        CASE WHEN e.source_id = ? THEN n2.name ELSE n1.name END AS connected_name
      FROM edges e
      LEFT JOIN nodes n1 ON e.source_id = n1.id
      LEFT JOIN nodes n2 ON e.target_id = n2.id
      WHERE (e.source_id = ? OR e.target_id = ?) AND e.valid_until IS NULL
    `).all(nodeId, nodeId, nodeId, nodeId);

    results.push({
      ...node,
      metadata: node.metadata ? JSON.parse(node.metadata) : null,
      score: finalScore,
      scoreBreakdown: scores,
      edges: edges.map(e => ({
        relation_type: e.relation_type,
        direction: e.direction,
        connected_name: e.connected_name,
        reasoning: e.reasoning,
        weight: e.weight
      }))
    });

    // Reinforce on access (FSRS desirable difficulty)
    reinforceOnAccess(db, nodeId, 3);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}
