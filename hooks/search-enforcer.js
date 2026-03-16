#!/usr/bin/env node

/**
 * Search Enforcer hook (PreToolUse)
 * Blocks write operations until search_memory has been called in the current session.
 * Only active when .song-production-active flag exists.
 *
 * Circuit breaker: after 3 consecutive blocks, auto-allow to prevent deadlock.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const FLAG_FILE = join(process.env.HOME, '.claude/hooks/.song-production-active');
const STATE_FILE = join(process.env.HOME, '.claude/hooks/.search-enforcer-state.json');

// Only active during song production
if (!existsSync(FLAG_FILE)) {
  process.exit(0);
}

// Read stdin
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

let data;
try {
  data = JSON.parse(input);
} catch {
  process.exit(0);
}

const toolName = data.tool_name || '';
const sessionId = data.session_id || '';

// Load state
let state = { sessions: {} };
try {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
} catch { /* first run or corrupt */ }

// Initialize session state
if (!state.sessions[sessionId]) {
  state.sessions[sessionId] = { searched: false, blockCount: 0 };
}
const session = state.sessions[sessionId];

// Read-only tools: always allow
const EXACT_READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Bash', 'Agent',  // built-in
  'search_memory', 'traverse_graph', 'recall_experience', 'memory_stats',  // KG reads
]);
const PREFIX_READ_TOOLS = [
  'mcp__ableton-mcp-pro__get_', 'mcp__ableton-mcp-pro__list_',
  'mcp__ableton-mcp-pro__analyze_', 'mcp__ableton-mcp-pro__measure_',
  'mcp__ableton-mcp-pro__browse_', 'mcp__ableton-mcp-pro__introspect_',
  'mcp__ableton-mcp-pro__compare_', 'mcp__ableton-mcp-pro__evaluate_',
  'mcp__ableton-mcp-pro__classify_', 'mcp__ableton-mcp-pro__score_',
  'mcp__ableton-mcp-pro__splice_search', 'mcp__ableton-mcp-pro__splice_preview',
  'mcp__ableton-mcp-pro__splice_get_token',
  'mcp__knowledge-graph__search', 'mcp__knowledge-graph__traverse',
  'mcp__knowledge-graph__recall', 'mcp__knowledge-graph__memory_stats',
];

const isReadTool = EXACT_READ_TOOLS.has(toolName) ||
  PREFIX_READ_TOOLS.some(prefix => toolName.startsWith(prefix));

if (isReadTool) {
  // Mark as "searched" if it's a KG search tool
  if (['search_memory', 'traverse_graph', 'recall_experience'].includes(toolName) ||
      toolName.startsWith('mcp__knowledge-graph__search') ||
      toolName.startsWith('mcp__knowledge-graph__traverse') ||
      toolName.startsWith('mcp__knowledge-graph__recall')) {
    session.searched = true;
    session.blockCount = 0;
    saveState(state);
  }
  process.exit(0);
}

// KG write tools: always allow (storing knowledge is good)
if (toolName.startsWith('mcp__knowledge-graph__store') ||
    toolName.startsWith('mcp__knowledge-graph__connect') ||
    toolName.startsWith('mcp__knowledge-graph__record') ||
    toolName === 'store_knowledge' || toolName === 'connect_knowledge' ||
    toolName === 'record_experience') {
  process.exit(0);
}

// Write tools: check if memory was searched
if (!session.searched) {
  // Circuit breaker: after 3 blocks, auto-allow
  session.blockCount++;
  saveState(state);

  if (session.blockCount > 3) {
    session.searched = true; // Reset for next round
    session.blockCount = 0;
    saveState(state);
    process.exit(0); // Allow through
  }

  // Block with feedback
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[Search Enforcer] 請先用 search_memory 查詢相關知識再操作。` +
        `（${session.blockCount}/3 次擋住，第 4 次自動放行）`
    }
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Memory was searched, allow
process.exit(0);

function saveState(s) {
  try {
    // Clean old sessions (keep last 10)
    const keys = Object.keys(s.sessions);
    if (keys.length > 10) {
      for (const k of keys.slice(0, keys.length - 10)) {
        delete s.sessions[k];
      }
    }
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch { /* non-critical */ }
}
