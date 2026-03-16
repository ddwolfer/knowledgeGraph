/**
 * Memory Enzyme — periodic maintenance for graph quality (from A-MEM pattern).
 * Operations: prune, merge, validate, orphan
 */

import { getDb } from './db.js';

/**
 * Run maintenance operations on the knowledge graph.
 * @param {string} operations - "prune" | "merge" | "validate" | "orphan" | "all"
 * @returns {object} Report of actions taken
 */
export function maintainGraph(operations = 'all') {
  const db = getDb();
  const now = new Date().toISOString();
  const report = {};

  const VALID_OPS = new Set(['prune', 'merge', 'validate', 'orphan']);
  const ops = operations === 'all'
    ? ['prune', 'merge', 'validate', 'orphan']
    : VALID_OPS.has(operations) ? [operations] : [];

  if (ops.length === 0) {
    return { error: `Unknown operation: ${operations}. Valid: prune, merge, validate, orphan, all` };
  }

  for (const op of ops) {
    switch (op) {
      case 'prune':
        report.prune = pruneEdges(db, now);
        break;
      case 'merge':
        report.merge = findDuplicates(db);
        break;
      case 'validate':
        report.validate = validateEdges(db);
        break;
      case 'orphan':
        report.orphan = findOrphans(db);
        break;
    }
  }

  return report;
}

/**
 * Prune weak or stale edges.
 * - weight < 0.3
 * - nodes not accessed in > 90 days
 */
function pruneEdges(db, now) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Mark low-weight edges as expired
  const weakEdges = db.prepare(`
    UPDATE edges
    SET valid_until = ?
    WHERE weight < 0.3 AND valid_until IS NULL
  `).run(now);

  // Report nodes with low retrievability (using inline decay calc)
  const allNodes = db.prepare(`
    SELECT id, name, trust, stability, memory_level, access_count, last_accessed, created_at, metadata
    FROM nodes WHERE valid_until IS NULL
  `).all();

  const decaying = [];
  for (const node of allNodes) {
    const meta = node.metadata ? JSON.parse(node.metadata) : {};
    const level = node.memory_level || 1;
    if (level >= 3) continue; // consolidated nodes don't need reporting

    const S = node.stability || ({ principle: 30, pattern: 7, inference: 3 }[node.trust] || 7);
    const lastAccessed = node.last_accessed || node.created_at;
    const dtDays = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
    if (dtDays <= 0) continue;

    const lambdaFast = Math.LN2 / S;
    const lambdaSlow = Math.LN2 / (S * 10);
    const temporal = 0.6 * Math.exp(-lambdaFast * dtDays) + 0.4 * Math.exp(-lambdaSlow * dtDays);
    const frequency = Math.pow((node.access_count || 0) + 1, 0.6);
    const importance = { principle: 1.5, pattern: 1.0, inference: 0.7 }[node.trust] || 1.0;
    const R = Math.min(temporal * frequency * importance, 1.0);

    if (R < 0.5) {
      decaying.push({ id: node.id, name: node.name, trust: node.trust, level, R: parseFloat(R.toFixed(3)) });
    }
  }

  return {
    weakEdgesExpired: weakEdges.changes,
    decayingNodes: decaying.sort((a, b) => a.R - b.R),
  };
}

/**
 * Find potential duplicate nodes (same name or very similar content).
 * Returns suggestions — does NOT auto-merge (needs human review).
 */
function findDuplicates(db) {
  // 1. Exact name duplicates
  const nameDupes = db.prepare(`
    SELECT name, GROUP_CONCAT(id) as ids, COUNT(*) as count
    FROM nodes
    WHERE valid_until IS NULL
    GROUP BY name
    HAVING count > 1
  `).all();

  // 2. Vector similarity consolidation candidates (cosine distance < 0.3)
  const similarPairs = [];
  try {
    const activeNodes = db.prepare(`
      SELECT n.id, n.name, n.trust, n.type
      FROM nodes n
      JOIN vec_nodes v ON n.id = v.node_id
      WHERE n.valid_until IS NULL
    `).all();

    // For each node, find nearest neighbors
    const seen = new Set();
    for (const node of activeNodes) {
      const neighbors = db.prepare(`
        SELECT v2.node_id, v2.distance, n2.name, n2.trust, n2.type
        FROM vec_nodes v1
        JOIN vec_nodes v2 ON v2.node_id != v1.node_id
        JOIN nodes n2 ON v2.node_id = n2.id
        WHERE v1.node_id = ?
          AND v2.embedding MATCH (SELECT embedding FROM vec_nodes WHERE node_id = ?)
          AND k = 3
          AND n2.valid_until IS NULL
          AND v2.distance < 0.3
      `).all(node.id, node.id);

      for (const n of neighbors) {
        const pairKey = [node.id, n.node_id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        similarPairs.push({
          nodeA: { id: node.id, name: node.name, trust: node.trust },
          nodeB: { id: n.node_id, name: n.name, trust: n.trust },
          distance: parseFloat(n.distance.toFixed(3)),
        });
      }
    }
  } catch { /* vec search failed, skip consolidation */ }

  return {
    nameDuplicates: nameDupes.map(d => ({
      name: d.name,
      ids: d.ids.split(','),
      count: d.count
    })),
    similarPairs: similarPairs.sort((a, b) => a.distance - b.distance),
    note: 'Review and manually merge if appropriate. Use forget_knowledge + store_knowledge to consolidate similar nodes.'
  };
}

/**
 * Validate edge integrity.
 * - Both source and target nodes exist and are valid
 * - High-trust edges (must_precede, reason_for) have source_session
 */
function validateEdges(db) {
  // Edges pointing to expired/deleted nodes
  const danglingEdges = db.prepare(`
    SELECT e.id, e.relation_type, e.source_id, e.target_id
    FROM edges e
    LEFT JOIN nodes n1 ON e.source_id = n1.id AND n1.valid_until IS NULL
    LEFT JOIN nodes n2 ON e.target_id = n2.id AND n2.valid_until IS NULL
    WHERE e.valid_until IS NULL
      AND (n1.id IS NULL OR n2.id IS NULL)
  `).all();

  // High-trust edges without source_session
  const unsourcedEdges = db.prepare(`
    SELECT e.id, e.relation_type, e.source_id, e.target_id
    FROM edges e
    WHERE e.valid_until IS NULL
      AND e.relation_type IN ('must_precede', 'reason_for')
      AND e.source_session IS NULL
  `).all();

  return {
    danglingEdges: danglingEdges.length,
    unsourcedHighTrustEdges: unsourcedEdges.length,
    details: {
      dangling: danglingEdges,
      unsourced: unsourcedEdges
    }
  };
}

/**
 * Find orphan nodes (no edges at all).
 */
function findOrphans(db) {
  const orphans = db.prepare(`
    SELECT n.id, n.name, n.type, n.trust
    FROM nodes n
    WHERE n.valid_until IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE (e.source_id = n.id OR e.target_id = n.id) AND e.valid_until IS NULL
      )
  `).all();

  return {
    count: orphans.length,
    orphans: orphans.map(n => ({ id: n.id, name: n.name, type: n.type, trust: n.trust }))
  };
}
