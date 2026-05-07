#!/usr/bin/env node

/**
 * subagent-enhanced — 子代理状态管理器
 *
 * 从 Claude Code AgentTool 架构移植，提供对子代理元数据/状态的集中管理。
 *
 * tool.js 本身不执行子代理（那由 OpenClaw 层面完成），而是作为状态数据库：
 * 1. 记录每个子代理的元数据（id、任务、模式、创建时间、状态）
 * 2. 记录子代理的进度和输出文件路径
 * 3. 支持 spawn/list/status/steer/kill/output 全生命周期操作
 * 4. 持久化到 ~\.openclaw\subagents.json
 *
 * 状态机: pending → running → completed / failed / killed / backgrounded
 *
 * 用法:
 *   node tool.js '{"action":"spawn","task":"...","mode":"fork"}'
 *   node tool.js '{"action":"list"}'
 *   node tool.js '{"action":"status","id":"<agent-id>"}'
 *   node tool.js '{"action":"steer","id":"<agent-id>","message":"..."}'
 *   node tool.js '{"action":"kill","id":"<agent-id>"}'
 *   node tool.js '{"action":"output","id":"<agent-id>"}'
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(require('os').homedir(), '.openclaw');
const DATA_FILE = path.join(DATA_DIR, 'subagents.json');

const VALID_MODES = ['fork', 'isolated'];
const VALID_STATUSES = ['pending', 'running', 'completed', 'failed', 'killed', 'backgrounded'];

// ── Persistence ─────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadAll() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[subagent-enhanced] Warning: failed to read ${DATA_FILE}: ${err.message}`);
  }
  return {};
}

function saveAll(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function generateId() {
  return crypto.randomUUID();
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * actions.spawn — 记录新的子代理条目
 * 
 * 输入:
 *   { action: "spawn", task: string, mode?: "fork"|"isolated", tools?: string[],
 *     background?: boolean, timeout?: number }
 */
function actionSpawn(input) {
  const agents = loadAll();
  const id = generateId();
  const now = new Date().toISOString();

  const mode = input.mode && VALID_MODES.includes(input.mode) ? input.mode : 'fork';

  const record = {
    id,
    task: input.task,
    status: 'pending',
    mode,
    tools: input.tools || [],
    background: !!input.background,
    timeout: input.timeout || 300,
    progress: '',
    createdAt: now,
    updatedAt: now,
    instructionHistory: [],
    outputFile: null,
    agentSessionId: null,     // 由主 Agent 在 spawn 后填写
    completedAt: null,
    error: null,
  };

  agents[id] = record;
  saveAll(agents);

  return {
    success: true,
    action: 'spawn',
    id,
    record,
    detail: {
      nextStep: `Subagent ${id} created as '${mode}' mode. Use sessions_spawn to start it.`,
      spawnHint: mode === 'fork'
        ? 'Fork mode: use sessions_spawn with context="fork" to inherit parent context'
        : 'Isolated mode: use sessions_spawn without context for clean environment',
    },
  };
}

/**
 * actions.list — 列出所有子代理
 */
function actionList() {
  const agents = loadAll();
  const entries = Object.values(agents).map(a => ({
    id: a.id,
    task: a.task.length > 80 ? a.task.slice(0, 80) + '...' : a.task,
    status: a.status,
    mode: a.mode,
    createdAt: a.createdAt,
    progress: a.progress,
    background: a.background,
  }));

  return {
    success: true,
    action: 'list',
    count: entries.length,
    agents: entries,
  };
}

/**
 * actions.status — 查看单个子代理
 */
function actionStatus(input) {
  const agents = loadAll();
  if (!input.id) {
    return { success: false, error: 'Missing required field: id' };
  }

  const record = agents[input.id];
  if (!record) {
    return { success: false, error: `Subagent not found: ${input.id}` };
  }

  const elapsed = record.createdAt
    ? Math.floor((Date.now() - new Date(record.createdAt).getTime()) / 1000)
    : 0;
  const duration = record.completedAt
    ? Math.floor((new Date(record.completedAt).getTime() - new Date(record.createdAt).getTime()) / 1000)
    : elapsed;

  return {
    success: true,
    action: 'status',
    id: record.id,
    task: record.task,
    status: record.status,
    mode: record.mode,
    progress: record.progress,
    tools: record.tools,
    background: record.background,
    timeout: record.timeout,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    durationSec: duration,
    completedAt: record.completedAt,
    error: record.error,
    agentSessionId: record.agentSessionId,
    outputFile: record.outputFile,
    instructionHistory: record.instructionHistory,
  };
}

/**
 * actions.steer — 发送新指令给子代理（更新记录）
 */
function actionSteer(input) {
  const agents = loadAll();
  if (!input.id) {
    return { success: false, error: 'Missing required field: id' };
  }
  if (!input.message) {
    return { success: false, error: 'Missing required field: message' };
  }

  const record = agents[input.id];
  if (!record) {
    return { success: false, error: `Subagent not found: ${input.id}` };
  }

  const steerEntry = {
    timestamp: new Date().toISOString(),
    message: input.message,
  };
  record.instructionHistory = record.instructionHistory || [];
  record.instructionHistory.push(steerEntry);
  record.updatedAt = new Date().toISOString();

  // 如果子代理已完成/失败/已杀掉，重新激活为 running
  if (['completed', 'failed', 'killed'].includes(record.status)) {
    record.status = 'running';
    record.progress = `Re-activated via steer at ${record.updatedAt}`;
  }

  agents[input.id] = record;
  saveAll(agents);

  return {
    success: true,
    action: 'steer',
    id: record.id,
    instructionCount: record.instructionHistory.length,
    entry: steerEntry,
    newStatus: record.status,
  };
}

/**
 * actions.kill — 标记子代理为终止
 */
function actionKill(input) {
  const agents = loadAll();
  if (!input.id) {
    return { success: false, error: 'Missing required field: id' };
  }

  const record = agents[input.id];
  if (!record) {
    return { success: false, error: `Subagent not found: ${input.id}` };
  }

  record.status = 'killed';
  record.completedAt = new Date().toISOString();
  record.updatedAt = record.completedAt;
  record.progress = 'Killed by user';

  agents[input.id] = record;
  saveAll(agents);

  return {
    success: true,
    action: 'kill',
    id: record.id,
    status: 'killed',
    completedAt: record.completedAt,
  };
}

/**
 * actions.output — 查看子代理的输出
 */
function actionOutput(input) {
  const agents = loadAll();
  if (!input.id) {
    return { success: false, error: 'Missing required field: id' };
  }

  const record = agents[input.id];
  if (!record) {
    return { success: false, error: `Subagent not found: ${input.id}` };
  }

  // 读 outputFile（如果有）
  let outputContent = null;
  if (record.outputFile && fs.existsSync(record.outputFile)) {
    try {
      outputContent = fs.readFileSync(record.outputFile, 'utf-8');
    } catch (err) {
      outputContent = `[Error reading output file: ${err.message}]`;
    }
  }

  return {
    success: true,
    action: 'output',
    id: record.id,
    status: record.status,
    progress: record.progress,
    outputFile: record.outputFile,
    outputContent,
    instructionHistory: record.instructionHistory || [],
    completedAt: record.completedAt,
    error: record.error,
  };
}

/**
 * 辅助: update — 更新子代理的状态（由主 Agent 在 sessions_spawn 前后调用）
 *
 * 设计说明:
 *   spawn 时 agent 创建记录（status=pending）
 *   主 Agent 在 sessions_spawn 后调用 update 将 status 设为 running 并记录 sessionId
 *   子代理完成/失败后，主 Agent 再调用 update 更新最终状态
 */
function actionUpdate(input) {
  const agents = loadAll();
  if (!input.id) {
    return { success: false, error: 'Missing required field: id' };
  }

  const record = agents[input.id];
  if (!record) {
    return { success: false, error: `Subagent not found: ${input.id}` };
  }

  const now = new Date().toISOString();

  if (input.status) {
    if (!VALID_STATUSES.includes(input.status)) {
      return { success: false, error: `Invalid status: ${input.status}. Valid: ${VALID_STATUSES.join(', ')}` };
    }
    record.status = input.status;
  }

  if (input.progress !== undefined) {
    record.progress = input.progress;
  }

  if (input.agentSessionId) {
    record.agentSessionId = input.agentSessionId;
  }

  if (input.outputFile) {
    record.outputFile = input.outputFile;
  }

  if (input.error) {
    record.error = input.error;
  }

  if (['completed', 'failed', 'killed'].includes(record.status)) {
    record.completedAt = record.completedAt || now;
  }

  record.updatedAt = now;
  agents[input.id] = record;
  saveAll(agents);

  return {
    success: true,
    action: 'update',
    id: record.id,
    status: record.status,
    updatedAt: record.updatedAt,
  };
}

// ── CLI Entry ───────────────────────────────────────────────────────────────

function main() {
  let input;

  // Support both: JSON from stdin and first CLI arg as JSON
  if (process.argv[2]) {
    try {
      input = JSON.parse(process.argv[2]);
    } catch {
      // Treat as raw action name if followed by more args
      if (process.argv[3]) {
        input = { action: process.argv[2], ...(process.argv[3] ? JSON.parse(process.argv[3]) : {}) };
      } else {
        input = { action: process.argv[2] };
      }
    }
  } else {
    // Read from stdin
    const chunks = [];
    const buf = fs.readFileSync(0, 'utf-8');
    input = JSON.parse(buf);
  }

  if (!input || !input.action) {
    console.error('Usage: node tool.js <json-input>  or  node tool.js <action> [json-args]');
    console.error('Actions: spawn, list, status, steer, kill, output, update');
    process.exit(1);
  }

  let result;
  switch (input.action) {
    case 'spawn':
      result = actionSpawn(input);
      break;
    case 'list':
      result = actionList();
      break;
    case 'status':
      result = actionStatus(input);
      break;
    case 'steer':
      result = actionSteer(input);
      break;
    case 'kill':
      result = actionKill(input);
      break;
    case 'output':
      result = actionOutput(input);
      break;
    case 'update':
      result = actionUpdate(input);
      break;
    default:
      result = { success: false, error: `Unknown action: ${input.action}. Valid: spawn, list, status, steer, kill, output, update` };
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.success !== false ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  actionSpawn,
  actionList,
  actionStatus,
  actionSteer,
  actionKill,
  actionOutput,
  actionUpdate,
};
