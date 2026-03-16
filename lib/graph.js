/**
 * Graph traversal via SQLite recursive CTE.
 * Walks edges from a starting node to arbitrary depth.
 */

import { getDb } from './db.js';
import { reinforceOnAccess } from './decay.js';

const VALID_EDGE_TYPES = new Set([
  'must_precede','causes','implies','aligns_to','contradicts',
  'refines','observed_in','reason_for','tends_to','requires_reading'
]);

/**
 * Traverse the knowledge graph from a starting node.
 * @param {string} nodeId - Starting node ID
 * @param {object} options
 * @param {string[]} options.edgeTypes - Filter by edge types (default: all)
 * @param {string} options.direction - "outgoing" | "incoming" | "both" (default: "both")
 * @param {number} options.depth - Max traversal depth (default: 2)
 * @returns {object} { root, nodes, edges } — the subgraph
 */
export function traverseGraph(nodeId, { edgeTypes = [], direction = 'both', depth = 2 } = {}) {
  const db = getDb();

  // Get root node
  const root = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!root) {
    return { root: null, nodes: [], edges: [] };
  }
  root.metadata = root.metadata ? JSON.parse(root.metadata) : null;

  // Validate and build edge type filter
  const safeEdgeTypes = edgeTypes.filter(t => VALID_EDGE_TYPES.has(t));
  const edgeTypeClause = safeEdgeTypes.length > 0
    ? `AND e.relation_type IN (${safeEdgeTypes.map(() => '?').join(',')})`
    : '';

  // Build direction filter
  let directionJoin = '';
  if (direction === 'outgoing') {
    directionJoin = 'e.source_id = t.node_id';
  } else if (direction === 'incoming') {
    directionJoin = 'e.target_id = t.node_id';
  } else {
    directionJoin = '(e.source_id = t.node_id OR e.target_id = t.node_id)';
  }

  // Recursive CTE for traversal
  const query = `
    WITH RECURSIVE traverse(node_id, depth) AS (
      SELECT ?, 0

      UNION ALL

      SELECT
        CASE
          WHEN e.source_id = t.node_id THEN e.target_id
          ELSE e.source_id
        END,
        t.depth + 1
      FROM traverse t
      JOIN edges e ON ${directionJoin}
      WHERE t.depth < ?
        AND e.valid_until IS NULL
        ${edgeTypeClause}
    )
    SELECT DISTINCT node_id, MIN(depth) as min_depth
    FROM traverse
    WHERE node_id != ?
    GROUP BY node_id
  `;

  // Build params: nodeId, depth, [edgeTypes...], nodeId
  const cteParams = [nodeId, depth, ...safeEdgeTypes, nodeId];
  const traversedNodes = db.prepare(query).all(...cteParams);

  // Fetch full node data (filter expired nodes)
  const nodeIds = traversedNodes.map(t => t.node_id);
  const allNodeIds = [nodeId, ...nodeIds];

  const nodes = [];
  for (const nid of nodeIds) {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ? AND valid_until IS NULL').get(nid);
    if (node) {
      node.metadata = node.metadata ? JSON.parse(node.metadata) : null;
      node._depth = traversedNodes.find(t => t.node_id === nid)?.min_depth || 0;
      nodes.push(node);
    }
  }

  if (allNodeIds.length <= 1 && nodes.length === 0) {
    reinforceOnAccess(db, nodeId, 3);
    return { root, nodes: [], edges: [] };
  }

  // Fetch all edges between traversed nodes
  const placeholders = allNodeIds.map(() => '?').join(',');
  const edgesQuery = `
    SELECT e.*,
      n1.name as source_name,
      n2.name as target_name
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE e.source_id IN (${placeholders})
      AND e.target_id IN (${placeholders})
      AND e.valid_until IS NULL
      ${edgeTypeClause}
  `;
  const edgeParams = [...allNodeIds, ...allNodeIds, ...safeEdgeTypes];
  const edges = db.prepare(edgesQuery).all(...edgeParams);

  // Reinforce all traversed nodes (FSRS desirable difficulty)
  for (const nid of allNodeIds) {
    reinforceOnAccess(db, nid, 3);
  }

  return { root, nodes, edges };
}
