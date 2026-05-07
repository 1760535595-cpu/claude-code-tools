#!/usr/bin/env node

/**
 * ScheduleCron – OpenClaw 定时任务管理工具
 *
 * 基于 OpenClaw 内置 cron CLI 的轻量封装。
 * 支持：创建/列出/查看/删除/启用/禁用/立即执行/历史 等操作。
 * 额外用一个 meta.json 文件存储 description 等扩展信息。
 *
 * 使用方式：
 *   node tool.js <JSON input via stdin>
 *   或
 *   node tool.js --action list
 *   node tool.js --action create --name "xxx" --schedule "0 9 * * *" --message "xxx" [--description "xxx"]
 *   node tool.js --action remove --id <id>
 *   node tool.js --action show --id <id>
 *   node tool.js --action history --id <id>
 *   node tool.js --action run --id <id>
 *   node tool.js --action toggle --id <id>
 *   node tool.js --action status
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\ASUS',
  '.openclaw'
);
const META_FILE = path.join(CONFIG_DIR, 'cron-skills-meta.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function openclaw(args) {
  const bin = 'openclaw';
  const cmd = `${bin} ${args} 2>&1`;
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
      message: err.message,
    };
  }
}

/**
 * 从 stdout 中提取 JSON 对象（用于去除 Config warnings 等前缀）
 * 找到第一个 { 开始解析 JSON，适用于 2>&1 重定向的混合输出
 */
function extractJSON(stdout) {
  // 从第一个 { 开始解析
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) return null;
  // 尝试解析从第一个 { 到末尾
  const candidate = stdout.slice(jsonStart);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    // 如果完整解析失败，尝试逐层缩小范围
    let depth = 0;
    let end = -1;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '{') depth++;
      if (candidate[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > 0) {
      try {
        return JSON.parse(candidate.slice(0, end));
      } catch (_) {}
    }
    return null;
  }
}

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
    }
  } catch (_) {}
  return {};
}

function saveMeta(meta) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

function getMetaKey(id) {
  return `cron-${id}`;
}

/**
 * 简单 cron 表达式转换：自然语言 → 5field
 */
function resolveSchedule(schedule) {
  const known = {
    daily:    '0 9 * * *',
    hourly:   '0 * * * *',
    weekly:   '0 9 * * 1',
    monthly:  '0 9 1 * *',
    minutely: '* * * * *',
    'every-5min': '*/5 * * * *',
    'every-10min': '*/10 * * * *',
    'every-15min': '*/15 * * * *',
    'every-30min': '*/30 * * * *',
    midnight: '0 0 * * *',
    noon:     '0 12 * * *',
    weekday:  '0 9 * * 1-5',
    weekend:  '0 9 * * 6,0',
  };
  const key = schedule.toLowerCase().trim();
  if (known[key]) return known[key];
  return schedule; // 原样返回，已经就是 cron 表达式
}

function parseStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      if (data.trim()) {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function handleCreate(params) {
  const name = params.name;
  let schedule = params.schedule || params.cron;
  const message = params.message;
  const description = params.description || '';
  const every = params.every;

  if (!message) {
    return { error: 'Missing required: message (the prompt to run)' };
  }

  // 定时格式解析
  let cronExpr = '';
  if (schedule) {
    cronExpr = resolveSchedule(schedule);
  } else if (every) {
    cronExpr = every;
  } else {
    return { error: 'Missing required: schedule (cron expression) or every (duration like 10m, 1h)' };
  }

  // 调用 openclaw cron add
  const nameArg = name ? `--name "${name}"` : '';
  const descArg = description ? `--description "${description}"` : '';
  const cmdArgs = `cron add ${nameArg} --cron "${cronExpr}" --message "${message}" ${descArg} --json`;

  const result = openclaw(cmdArgs);
  if (!result.ok) {
    return { error: `Failed to create cron job: ${result.stderr || result.stdout || result.message}` };
  }

  // 解析返回的 JSON
  let id = '';
  const parsed = extractJSON(result.stdout);
  if (parsed && parsed.id) {
    id = parsed.id;
  } else {
    // 尝试从文本输出中提取 id
    const idMatch = result.stdout.match(/id['":]+\s*['"]?([a-zA-Z0-9_-]+)['"]?/i) ||
                    result.stdout.match(/Job\s+([a-zA-Z0-9_-]+)/i);
    if (idMatch) id = idMatch[1];
  }

  if (!id) {
    return { warning: `Cron may have been created but couldn't extract ID`, output: result.stdout };
  }

  // 保存 meta 信息
  const meta = loadMeta();
  const key = getMetaKey(id);
  meta[key] = { id, name, description, schedule: cronExpr, message, created: new Date().toISOString() };
  saveMeta(meta);

  return { success: true, id, name, schedule: cronExpr, description };
}

async function handleList(params) {
  const all = params.all ? '--all' : '';
  const cmdArgs = `cron list ${all} --json`;

  const result = openclaw(cmdArgs);
  if (!result.ok) {
    return { error: `Failed to list cron jobs: ${result.stderr || result.message}` };
  }

  const parsed = extractJSON(result.stdout);
  let jobs = [];
  if (parsed && parsed.jobs) {
    jobs = parsed.jobs;
  } else if (parsed && Array.isArray(parsed)) {
    jobs = parsed;
  }
  if (!Array.isArray(jobs)) {
    return { output: result.stdout };
  }

  // 补上 meta 中的 description
  const meta = loadMeta();
  const enriched = jobs.map(j => {
    const key = getMetaKey(j.id);
    const m = meta[key] || {};
    return {
      ...j,
      description: j.description || m.description || '',
      created: m.created || '',
    };
  });

  return { jobs: enriched };
}

async function handleShow(params) {
  const id = params.id;
  if (!id) return { error: 'Missing required: id' };

  const result = openclaw(`cron show ${id} --json`);
  if (!result.ok) {
    return { error: `Job not found: ${id}`, output: result.stderr || result.message };
  }

  const parsed = extractJSON(result.stdout);
  if (!parsed || !parsed.id) {
    return { output: result.stdout };
  }
  const job = parsed;

  // 补 meta
  const meta = loadMeta();
  const key = getMetaKey(job.id);
  const m = meta[key] || {};
  job.description = job.description || m.description || '';
  job.created = m.created || '';

  return { job };
}

async function handleRemove(params) {
  const id = params.id;
  if (!id) return { error: 'Missing required: id' };

  const result = openclaw(`cron rm ${id}`);
  if (!result.ok) {
    return { error: `Failed to remove job: ${result.stderr || result.message}` };
  }

  // 清理 meta
  const meta = loadMeta();
  const key = getMetaKey(id);
  delete meta[key];
  saveMeta(meta);

  return { success: true, id };
}

async function handleHistory(params) {
  const id = params.id;
  const limit = params.limit || '20';
  const idArg = id ? `--id ${id}` : '';
  const cmdArgs = `cron runs ${idArg} --limit ${limit}`;

  const result = openclaw(cmdArgs);
  if (!result.ok) {
    return { error: `Failed to get run history: ${result.stderr || result.message}` };
  }

  const parsed = extractJSON(result.stdout);
  let runs = [], total = 0;
  if (parsed && Array.isArray(parsed.entries)) {
    runs = parsed.entries;
    total = parsed.total || runs.length;
  } else if (Array.isArray(parsed)) {
    runs = parsed;
    total = runs.length;
  } else {
    return { output: result.stdout };
  }

  return { runs, total };
}

async function handleRun(params) {
  const id = params.id;
  if (!id) return { error: 'Missing required: id' };

  const result = openclaw(`cron run ${id}`);
  if (!result.ok) {
    return { error: `Failed to run job: ${result.stderr || result.message}` };
  }

  return { success: true, id, output: result.stdout };
}

async function handleToggle(params) {
  const id = params.id;
  if (!id) return { error: 'Missing required: id' };

  // 先查当前状态
  const showResult = openclaw(`cron show ${id} --json`);
  if (!showResult.ok) {
    return { error: `Job not found: ${id}` };
  }

  const parsedJob = extractJSON(showResult.stdout);
  if (!parsedJob) {
    return { error: `Could not parse job info for ${id}` };
  }

  const isDisabled = parsedJob.disabled === true || parsedJob.enabled === false;
  const action = isDisabled ? 'enable' : 'disable';
  const result = openclaw(`cron ${action} ${id}`);

  if (!result.ok) {
    return { error: `Failed to ${action} job: ${result.stderr || result.message}` };
  }

  return {
    success: true,
    id,
    previousState: isDisabled ? 'disabled' : 'enabled',
    newState: isDisabled ? 'enabled' : 'disabled',
  };
}

async function handleStatus() {
  const result = openclaw('cron status --json');
  if (!result.ok) {
    return { error: `Failed to get scheduler status: ${result.stderr || result.message}` };
  }

  const parsedStatus = extractJSON(result.stdout);
  if (!parsedStatus) {
    return { output: result.stdout };
  }

  return { status: parsedStatus };
}

async function handleEdit(params) {
  const id = params.id;
  if (!id) return { error: 'Missing required: id' };

  // 构建参数
  const editArgs = [`cron edit ${id}`];
  if (params.name) editArgs.push(`--name "${params.name}"`);
  if (params.message) editArgs.push(`--message "${params.message}"`);
  if (params.schedule || params.cron) {
    const cron = resolveSchedule(params.schedule || params.cron);
    editArgs.push(`--cron "${cron}"`);
  }
  if (params.description !== undefined) {
    editArgs.push(`--description "${params.description}"`);
  }
  if (params.disabled === 'true' || params.disabled === true) editArgs.push('--disabled');
  if (params.disabled === 'false' || params.disabled === false) editArgs.push('--no-disabled');

  if (editArgs.length <= 3) {
    return { error: 'No fields to edit. Provide at least one of: name, message, schedule, description, disabled' };
  }

  const result = openclaw(`${editArgs.join(' ')}`);
  if (!result.ok) {
    return { error: `Failed to edit job: ${result.stderr || result.message}` };
  }

  // 更新 meta
  if (params.description || params.name) {
    const meta = loadMeta();
    const key = getMetaKey(id);
    if (meta[key]) {
      if (params.description) meta[key].description = params.description;
      if (params.name) meta[key].name = params.name;
      if (params.schedule || params.cron) meta[key].schedule = resolveSchedule(params.schedule || params.cron);
      if (params.message) meta[key].message = params.message;
      saveMeta(meta);
    }
  }

  return { success: true, id };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cliArgs = parseArgs(process.argv);
  const stdinInput = await parseStdin();

  // 合并输入：stdin JSON 优先，命令行参数补充
  const params = { ...stdinInput, ...cliArgs };

  let action = params.action || cliArgs.action;
  // 如果没有 action 但有 --action 参数
  if (!action && process.argv.includes('--action')) {
    action = cliArgs.action;
  }
  // 默认 action = list
  if (!action) {
    action = 'list';
  }

  let result;
  switch (action) {
    case 'create':
      result = await handleCreate(params);
      break;
    case 'list':
      result = await handleList(params);
      break;
    case 'show':
      result = await handleShow(params);
      break;
    case 'remove':
    case 'rm':
    case 'delete':
      result = await handleRemove(params);
      break;
    case 'history':
    case 'runs':
      result = await handleHistory(params);
      break;
    case 'run':
      result = await handleRun(params);
      break;
    case 'toggle':
      result = await handleToggle(params);
      break;
    case 'status':
      result = await handleStatus(params);
      break;
    case 'edit':
      result = await handleEdit(params);
      break;
    default:
      result = { error: `Unknown action: ${action}. Supported: create, list, show, remove, history, run, toggle, status, edit` };
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result && result.error ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ error: err.message }, null, 2) + '\n');
  process.exit(1);
});
