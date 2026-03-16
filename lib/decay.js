/**
 * Memory Decay & Reinforcement Engine
 *
 * CortexGraph two-component decay × FSRS stability × Benna-Fusi level promotion
 *
 * Design:
 * - trust = source label (who said it), NOT permanent importance
 * - category = fundamental (has right/wrong, never decays) vs creative (challengeable)
 * - memory_level = durability (independent of trust): 1=new → 2=verified → 3=consolidated → 4=core
 * - stability = FSRS S (days) — controls decay speed, grows on access via desirable difficulty
 */

const STABILITY_CAP = 365; // max 1 year

/**
 * Initial stability based on trust + category.
 */
export function initialStability(trust, category) {
  if (category === 'fundamental') return 365;
  return { principle: 30, pattern: 7, inference: 3 }[trust] || 7;
}

/**
 * Calculate current retrievability R ∈ [0, 1].
 * CortexGraph two-component: fast decay (S days) + slow decay (S×10 days).
 * FSRS: stability S controls half-life base.
 *
 * @param {object} node — DB row with stability, memory_level, trust, metadata, access_count, last_accessed, created_at
 * @returns {number} R ∈ [0, 1]
 */
export function retrievability(node) {
  const meta = typeof node.metadata === 'string' ? JSON.parse(node.metadata) : (node.metadata || {});

  // Level 4 + fundamental → never decays
  if ((node.memory_level || 1) >= 4 && meta.category === 'fundamental') return 1.0;

  const S = node.stability || initialStability(node.trust, meta.category);
  const lastAccessed = node.last_accessed || node.created_at;
  const dtDays = (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24);

  if (dtDays <= 0) return 1.0;

  // CortexGraph two-component (adjusted half-lives: S days fast + S×10 days slow)
  const lambdaFast = Math.LN2 / S;          // half-life = S days
  const lambdaSlow = Math.LN2 / (S * 10);   // half-life = S×10 days
  const W_FAST = 0.6;

  const temporal = W_FAST * Math.exp(-lambdaFast * dtDays)
                 + (1 - W_FAST) * Math.exp(-lambdaSlow * dtDays);

  // Sub-linear frequency (CortexGraph n^0.6)
  const frequency = Math.pow((node.access_count || 0) + 1, 0.6);

  // Importance by trust
  const importance = { principle: 1.5, pattern: 1.0, inference: 0.7 }[node.trust] || 1.0;

  return Math.min(temporal * frequency * importance, 1.0);
}

/**
 * Calculate memory score for search ranking.
 * Combines retrievability + level bonus.
 */
export function memoryScore(node) {
  const R = retrievability(node);
  const levelBonus = [0, 0, 0.02, 0.05, 0.1][node.memory_level || 1] || 0;
  return R * 0.1 + levelBonus;
}

/**
 * Reinforce a node on access (FSRS desirable difficulty).
 * R lower → stability grows MORE (the "desirable difficulty" effect).
 *
 * @param {object} db — better-sqlite3 database instance
 * @param {string} nodeId
 * @param {number} grade — 4=success, 3=normal access, 1=corrected by teacher
 * @param {string} [sessionId] — for session tracking (level promotion)
 */
export function reinforceOnAccess(db, nodeId, grade = 3, sessionId = null) {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ? AND valid_until IS NULL').get(nodeId);
  if (!node) return;

  const meta = typeof node.metadata === 'string' ? JSON.parse(node.metadata) : (node.metadata || {});

  // Level 4 + fundamental → no reinforcement needed (already permanent)
  if ((node.memory_level || 1) >= 4 && meta.category === 'fundamental') {
    // Still update access_count and last_accessed for tracking
    const now = new Date().toISOString();
    db.prepare('UPDATE nodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?').run(now, nodeId);
    return;
  }

  const R = retrievability(node);
  const S = node.stability || initialStability(node.trust, meta.category);

  // FSRS desirable difficulty: R lower → bigger stability gain
  const difficultyBonus = Math.exp(1.0 * (1 - R));
  const gradeMultiplier = { 4: 1.5, 3: 1.0, 1: 0.5 }[grade] || 1.0;

  const newStability = Math.min(S * difficultyBonus * gradeMultiplier, STABILITY_CAP);

  // Session tracking for level promotion
  const sessions = new Set(meta.sessions || []);
  if (sessionId) sessions.add(sessionId);

  // Level promotion check
  const newLevel = checkLevelPromotion(node, sessions.size, meta.category);

  // Update metadata
  meta.sessions = [...sessions];
  if (grade !== 3) meta.last_grade = grade;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE nodes SET stability = ?, memory_level = ?,
    access_count = access_count + 1, last_accessed = ?,
    metadata = ?, updated_at = ?
    WHERE id = ?
  `).run(newStability, newLevel, now, JSON.stringify(meta), now, nodeId);
}

/**
 * Check and return new memory level (Benna-Fusi cascade).
 */
function checkLevelPromotion(node, sessionCount, category) {
  let level = node.memory_level || 1;
  const age = (Date.now() - new Date(node.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const access = (node.access_count || 0) + 1; // +1 for current access

  if (level === 1 && sessionCount >= 3) level = 2;
  if (level === 2 && age >= 14 && access >= 5) level = 3;
  if (level === 3 && (
    (node.trust === 'principle' && category === 'fundamental') ||
    access >= 50
  )) level = 4;

  return level;
}
