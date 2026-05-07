#!/usr/bin/env node

/**
 * smart-search tool — Grep + Glob 智能搜索
 *
 * 从 Claude Code 的 GrepTool + GlobTool 架构移植，
 * 提供纯 Node.js 实现，接收 JSON stdin 或命令行参数。
 *
 * 用法:
 *   传入 { action: "grep", pattern, ... } 做文本内容搜索
 *   传入 { action: "glob", pattern, ... } 做文件名匹配
 *
 * 输出: 结构化 JSON，包含 files, matches, durationMs, truncated 等字段
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── 缓存 ─────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000; // 30 秒内同 pattern 复用
const searchCache = new Map();

// ─── 默认排除目录 ──────────────────────────────────────────────────────────
const DEFAULT_EXCLUDE_DIRS = [
  '.git', '.svn', '.hg', '.bzr', '.jj', '.sl',
  'node_modules', '.next', 'dist', 'build', '.cache',
  'target', '__pycache__', '.gradle', 'coverage',
  '.vscode', '.idea', 'out', '.turbo',
];

// ─── 工具检测 ──────────────────────────────────────────────────────────────
function detectRipgrep() {
  try {
    execSync('rg --version', { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function detectFd() {
  try {
    execSync('fd --version', { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function detectGitGrep() {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function detectGnuGrep() {
  try {
    const out = execSync('grep --version', { stdio: 'pipe', encoding: 'utf-8' });
    return /GNU/.test(out) || /ripgrep/.test(out);
  } catch { return false; }
}

// ─── 路径工具 ──────────────────────────────────────────────────────────────
function toRelativePath(absPath, baseDir) {
  const rel = path.relative(baseDir, absPath);
  return rel.startsWith('..') ? absPath : rel;
}

// ─── Grep 实现 ─────────────────────────────────────────────────────────────

/**
 * 使用 ripgrep 搜索（优先）
 */
function grepWithRipgrep({ pattern, searchPath, glob, excludeDirs, type,
                           caseInsensitive, context, headLimit, offset,
                           outputMode, multiline }) {
  const args = ['--hidden', '--no-heading'];

  // 排除 VCS 和构建目录
  for (const dir of excludeDirs) {
    args.push('--glob', `!${dir}`);
  }

  // 列宽限制
  args.push('--max-columns', '500');

  if (multiline) {
    args.push('-U', '--multiline-dotall');
  }

  if (caseInsensitive) args.push('-i');

  // 输出模式
  if (outputMode === 'files_with_matches') {
    args.push('-l');
  } else if (outputMode === 'count') {
    args.push('-c');
  }

  // 行号（content 模式默认开启）
  if (outputMode === 'content') {
    args.push('-n');
  }

  // 上下文
  if (outputMode === 'content' && context) {
    args.push('-C', String(context));
  }

  // 模式参数
  if (pattern.startsWith('-')) {
    args.push('-e', pattern);
  } else {
    args.push(`"${pattern.replace(/"/g, '\\"')}"`);
  }

  // 文件类型过滤
  if (type) args.push('--type', type);

  // Glob 过滤
  if (glob) {
    const globPatterns = [];
    const rawPatterns = glob.split(/\s+/);
    for (const rp of rawPatterns) {
      if (rp.includes('{') && rp.includes('}')) {
        globPatterns.push(rp);
      } else {
        globPatterns.push(...rp.split(',').filter(Boolean));
      }
    }
    for (const gp of globPatterns) {
      if (gp) args.push('--glob', gp);
    }
  }

  const cmd = `rg ${args.join(' ')} ${searchPath || '.'}`;

  try {
    const stdout = execSync(cmd, {
      cwd: searchPath || process.cwd(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return parseRgOutput(stdout.trim(), {
      outputMode,
      searchPath: searchPath || process.cwd(),
      headLimit,
      offset,
    });
  } catch (err) {
    // rg 返回 1 = 无匹配, 其他错误
    if (err.status === 1) {
      return emptyResult({ outputMode });
    }
    throw err;
  }
}

/**
 * 解析 rg 输出为结构化结果
 */
function parseRgOutput(output, { outputMode, searchPath, headLimit, offset }) {
  if (!output) return emptyResult({ outputMode });

  const lines = output.split('\n').filter(Boolean);

  if (outputMode === 'content') {
    // 每行: relative/path:line_num:content
    // 或相对路径的情况
    const effectiveLimit = headLimit == null ? 250 : headLimit;
    const effectiveOffset = offset || 0;
    const sliced = applyHeadLimit(lines, effectiveLimit, effectiveOffset);

    // 提取唯一文件名
    const fileSet = new Set();
    for (const line of sliced.items) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) fileSet.add(line.substring(0, colonIdx));
    }

    return {
      mode: 'content',
      files: [...fileSet],
      content: sliced.items.join('\n'),
      matches: { totalLines: sliced.items.length, files: fileSet.size },
      durationMs: 0,
      truncated: sliced.truncated,
    };
  }

  if (outputMode === 'count') {
    const effectiveLimit = headLimit == null ? 250 : headLimit;
    const effectiveOffset = offset || 0;
    const sliced = applyHeadLimit(lines, effectiveLimit, effectiveOffset);

    let totalMatches = 0;
    let fileCount = 0;
    for (const line of sliced.items) {
      const colonIdx = line.lastIndexOf(':');
      if (colonIdx > 0) {
        const count = parseInt(line.substring(colonIdx + 1), 10);
        if (!isNaN(count)) {
          totalMatches += count;
          fileCount++;
        }
      }
    }

    return {
      mode: 'count',
      files: sliced.items,
      matches: { totalMatches, fileCount },
      content: sliced.items.join('\n'),
      durationMs: 0,
      truncated: sliced.truncated,
    };
  }

  // files_with_matches
  const effectiveLimit = headLimit == null ? 250 : headLimit;
  const effectiveOffset = offset || 0;
  const sliced = applyHeadLimit(lines, effectiveLimit, effectiveOffset);

  return {
    mode: 'files_with_matches',
    files: sliced.items,
    matches: { files: sliced.items.length },
    content: sliced.items.join('\n'),
    durationMs: 0,
    truncated: sliced.truncated,
  };
}

/**
 * 使用系统 grep 搜索（fallback）
 */
function grepWithSystemGrep({ pattern, searchPath, glob, excludeDirs, type,
                              caseInsensitive, context, headLimit, offset,
                              outputMode, multiline }) {
  const args = ['-r'];

  if (caseInsensitive) args.push('-i');
  if (outputMode === 'files_with_matches') args.push('-l');
  if (outputMode === 'count') args.push('-c');
  if (outputMode === 'content') args.push('-n');
  if (context && outputMode === 'content') args.push('-C', String(context));

  args.push('--include', pattern);

  // 排除目录用 --exclude-dir
  for (const dir of excludeDirs) {
    args.push('--exclude-dir', dir);
  }

  // Glob — grep 支持有限，用 --include/--exclude 模拟
  if (glob) {
    for (const gp of glob.split(/[\s,]+/).filter(Boolean)) {
      args.push('--include', gp.replace(/\\/g, '/'));
    }
  }

  const cmd = `grep ${args.join(' ')} .`;

  try {
    const stdout = execSync(cmd, {
      cwd: searchPath || process.cwd(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return parseGrepOutput(stdout.trim(), {
      outputMode,
      searchPath: searchPath || process.cwd(),
      headLimit,
      offset,
    });
  } catch (err) {
    if (err.status === 1) return emptyResult({ outputMode });
    throw err;
  }
}

function parseGrepOutput(output, { outputMode, searchPath, headLimit, offset }) {
  if (!output) return emptyResult({ outputMode });
  const lines = output.split('\n').filter(Boolean);

  const effectiveLimit = headLimit == null ? 250 : headLimit;
  const effectiveOffset = offset || 0;
  const sliced = applyHeadLimit(lines, effectiveLimit, effectiveOffset);

  const fileSet = new Set();
  for (const line of sliced.items) {
    // grep output: ./path:line_content 或 ./path:num:content
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) fileSet.add(line.substring(0, colonIdx).replace(/^\.\//, ''));
  }

  return {
    mode: outputMode,
    files: [...fileSet],
    content: sliced.items.join('\n'),
    matches: { totalLines: sliced.items.length, files: fileSet.size },
    durationMs: 0,
    truncated: sliced.truncated,
  };
}

/**
 * 使用 git grep 搜索（只在 git tracked 文件中）
 */
function grepWithGitGrep({ pattern, searchPath, glob, excludeDirs, type,
                           caseInsensitive, context, headLimit, offset,
                           outputMode, multiline }) {
  const args = ['--no-pager', 'grep', '--no-color', '--column'];

  if (caseInsensitive) args.push('-i');
  if (outputMode === 'files_with_matches') args.push('-l');
  if (outputMode === 'count') args.push('-c');
  if (outputMode === 'content') args.push('-n');
  if (context && outputMode === 'content') args.push('-C', String(context));

  // 排除
  for (const dir of excludeDirs) {
    args.push(`:(exclude)${dir}`);
  }

  // Glob 过滤 — git grep 不支持直接 glob，用 pathspec 部分模拟
  if (glob) {
    for (const gp of glob.split(/[\s,]+/).filter(Boolean)) {
      args.push(`:${gp}`);
    }
  }

  args.push('--', pattern);

  const cmd = `git ${args.join(' ')}`;

  try {
    const stdout = execSync(cmd, {
      cwd: searchPath || process.cwd(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return parseRgOutput(stdout.trim(), {
      outputMode,
      searchPath: searchPath || process.cwd(),
      headLimit,
      offset,
    });
  } catch (err) {
    if (err.status === 1) return emptyResult({ outputMode });
    throw err;
  }
}

// ─── Glob 实现 ─────────────────────────────────────────────────────────────

/**
 * 使用 fd 搜索文件名（优先）
 */
function globWithFd({ pattern, searchPath, excludeDirs }) {
  const args = ['--type', 'f', '--color', 'never'];

  for (const dir of excludeDirs) {
    args.push('--exclude', dir);
  }

  args.push(pattern);

  const cmd = `fd ${args.join(' ')} ${searchPath || '.'}`;

  try {
    const stdout = execSync(cmd, {
      cwd: searchPath || process.cwd(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    return stdout.trim().split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

/**
 * 使用 find 搜索文件名（fallback）
 */
function globWithFind({ pattern, searchPath, excludeDirs }) {
  const excludeFlags = excludeDirs.map(d => `-name "${d}" -prune -o`).join(' ');
  const cmd = `find ${searchPath || '.'} ${excludeFlags} -type f -name "${pattern}" -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`;

  try {
    const stdout = execSync(cmd, {
      cwd: searchPath || process.cwd(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Node.js 内置 fallback ───────────────────────────────────────────────

/**
 * 纯 Node.js 递归文件搜索（当 rg/fd/find 都不可用时）
 */
function nodeGlobWalk({ pattern, searchPath, excludeDirs, baseDir }) {
  const results = [];
  const absolutePath = searchPath ? path.resolve(searchPath) : (baseDir || process.cwd());

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(absolutePath, fullPath);

      // 跳过排除目录
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        // glob 匹配
        if (isGlobMatch(entry.name, pattern) || isGlobMatch(fullPath, pattern)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(absolutePath);
  return results;
}

function isGlobMatch(name, pattern) {
  // 简单 glob 匹配（支持 * 和 ?）
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${regexStr}$`).test(name);
  } catch {
    return name.includes(pattern);
  }
}

/**
 * Pure Node.js grep fallback — 逐文件读取内容匹配
 */
function nodeGrepWalk({ pattern, searchPath, excludeDirs, caseInsensitive,
                        outputMode, headLimit, context, offset, baseDir }) {
  const absolutePath = searchPath ? path.resolve(searchPath) : (baseDir || process.cwd());
  const results = [];
  const fileResults = [];
  const flags = caseInsensitive ? 'gi' : 'g';
  const effectiveLimit = headLimit == null ? 250 : headLimit;
  let lineCount = 0;

  function walk(dir) {
    if (results.length >= effectiveLimit * 2) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= effectiveLimit * 2) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const relPath = path.relative(absolutePath, fullPath);
          const contentLines = content.split('\n');
          let fileMatched = false;

          for (let i = 0; i < contentLines.length; i++) {
            const match = contentLines[i].match(new RegExp(pattern, flags));
            if (match) {
              fileMatched = true;

              if (outputMode === 'content') {
                // 上下文行
                const ctx = context || 0;
                const start = Math.max(0, i - ctx);
                const end = Math.min(contentLines.length, i + ctx + 1);
                for (let j = start; j < end; j++) {
                  let prefix = '';
                  if (j < i) prefix = '-';
                  else if (j === i) prefix = ':';
                  else prefix = '+';
                  results.push(`${relPath}:${j + 1}${prefix}${contentLines[j]}`);
                  lineCount++;
                }
                results.push('--');
              } else if (outputMode === 'count') {
                const cnt = (contentLines[i].match(new RegExp(pattern, flags)) || []).length;
                results.push(`${relPath}:${cnt}`);
                lineCount++;
              }
            }
          }

          if (fileMatched && (outputMode === 'files_with_matches' || !outputMode)) {
            fileResults.push(relPath);
            results.push(relPath);
            lineCount++;
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(absolutePath);

  const sliced = applyHeadLimit(results, effectiveLimit, (offset || 0));

  return {
    mode: outputMode || 'files_with_matches',
    files: outputMode === 'content' ? [] : sliced.items,
    content: sliced.items.join('\n'),
    matches: {
      totalLines: sliced.items.length,
      files: fileResults.length,
    },
    durationMs: 0,
    truncated: sliced.truncated,
  };
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function applyHeadLimit(items, limit, offset) {
  const effOffset = offset || 0;
  if (limit === 0) {
    return { items: items.slice(effOffset), truncated: false };
  }
  const effectiveLimit = limit ?? 250;
  const sliced = items.slice(effOffset, effOffset + effectiveLimit);
  return {
    items: sliced,
    truncated: items.length - effOffset > effectiveLimit,
    appliedLimit: items.length - effOffset > effectiveLimit ? effectiveLimit : undefined,
  };
}

function emptyResult({ outputMode }) {
  return {
    mode: outputMode || 'files_with_matches',
    files: [],
    matches: { files: 0 },
    content: '',
    durationMs: 0,
    truncated: false,
  };
}

function getCacheKey({ action, pattern, path, glob, outputMode, caseInsensitive, type, context, multiline }) {
  // 只 cache 相同 action+pattern+path+glob 的组合
  return JSON.stringify({ action, pattern, path, glob, outputMode, caseInsensitive, type, context, multiline });
}

// ─── 多模式组合搜索 ────────────────────────────────────────────────────────

function combineResults(results, operator = 'AND') {
  if (results.length === 0) return emptyResult({ outputMode: 'files_with_matches' });

  if (operator === 'OR') {
    // 合并所有文件的并集
    const allFiles = new Set();
    for (const r of results) {
      for (const f of r.files) allFiles.add(f);
    }
    return {
      mode: 'files_with_matches',
      files: [...allFiles],
      matches: { files: allFiles.size },
      content: [...allFiles].join('\n'),
      durationMs: results.reduce((s, r) => s + r.durationMs, 0),
      truncated: results.some(r => r.truncated),
    };
  }

  // AND — 取交集
  if (results.length === 1) return results[0];

  const fileSets = results.map(r => new Set(r.files));
  const intersection = [...fileSets[0]].filter(f => fileSets.every(s => s.has(f)));

  return {
    mode: 'files_with_matches',
    files: intersection,
    matches: { files: intersection.length },
    content: intersection.join('\n'),
    durationMs: results.reduce((s, r) => s + r.durationMs, 0),
    truncated: results.some(r => r.truncated),
  };
}

// ─── 主入口 ────────────────────────────────────────────────────────────────

function search(input) {
  const {
    action,
    pattern,
    path: searchPath,
    glob,
    output_mode = 'files_with_matches',
    context,
    case_insensitive = false,
    file_type: type,
    head_limit,
    offset = 0,
    // 增强参数
    multiline = false,
    git_grep = false,
    patterns,       // 多 pattern 搜索: [{ pattern, glob?, type? }, ...]
    operator = 'AND', // AND 或 OR
  } = input;

  const userCwd = process.cwd();
  const baseDir = searchPath ? path.resolve(searchPath) : userCwd;

  // 如果有多 pattern 模式
  if (patterns && Array.isArray(patterns) && patterns.length > 0) {
    const results = patterns.map(p => search({
      action: 'grep',
      pattern: p.pattern,
      path: p.path || searchPath,
      glob: p.glob,
      output_mode: 'files_with_matches',
      head_limit: p.head_limit || head_limit,
      offset: 0,
      // 其他参数给 false
      git_grep,
    }));
    return combineResults(results, operator);
  }

  // 缓存检查
  const cacheKey = getCacheKey(input);
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return { ...cached.result, cached: true };
  }

  const startTime = Date.now();
  let result;

  if (action === 'grep') {
    if (!pattern) throw new Error('pattern is required for grep action');

    // 优先 git grep（如果指定且 git 仓库）
    if (git_grep && detectGitGrep()) {
      try {
        result = grepWithGitGrep({
          pattern, searchPath: baseDir, glob, excludeDirs: DEFAULT_EXCLUDE_DIRS,
          type, caseInsensitive: case_insensitive, context,
          headLimit: head_limit, offset, outputMode: output_mode, multiline,
        });
      } catch {
        // fallthrough to below
      }
    }

    if (!result) {
      // 检测可用工具
      const hasRg = detectRipgrep();
      const hasGnu = detectGnuGrep();

      if (hasRg) {
        result = grepWithRipgrep({
          pattern, searchPath: baseDir, glob, excludeDirs: DEFAULT_EXCLUDE_DIRS,
          type, caseInsensitive: case_insensitive, context,
          headLimit: head_limit, offset, outputMode: output_mode, multiline,
        });
      } else if (hasGnu) {
        result = grepWithSystemGrep({
          pattern, searchPath: baseDir, glob, excludeDirs: DEFAULT_EXCLUDE_DIRS,
          type, caseInsensitive: case_insensitive, context,
          headLimit: head_limit, offset, outputMode: output_mode, multiline,
        });
      } else {
        // Node.js 内置 fallback
        result = nodeGrepWalk({
          pattern, searchPath: baseDir, excludeDirs: DEFAULT_EXCLUDE_DIRS,
          caseInsensitive: case_insensitive,
          outputMode: output_mode, headLimit: head_limit, context, offset,
        });
      }
    }
  } else if (action === 'glob') {
    if (!pattern) throw new Error('pattern is required for glob action');

    const hasFd = detectFd();
    let files;

    if (hasFd) {
      files = globWithFd({ pattern, searchPath: baseDir, excludeDirs: DEFAULT_EXCLUDE_DIRS });
    } else {
      if (process.platform === 'win32' || !detectGnuGrep()) {
        files = nodeGlobWalk({ pattern, searchPath: baseDir, excludeDirs: DEFAULT_EXCLUDE_DIRS });
      } else {
        files = globWithFind({ pattern, searchPath: baseDir, excludeDirs: DEFAULT_EXCLUDE_DIRS });
      }
    }

    // 相对化路径
    files = files.map(f => toRelativePath(f, baseDir));
    // 排序
    files.sort();

    const totalCount = files.length;
    // 默认最多返回 100 个
    const LIMIT = 100;
    const truncated = totalCount > LIMIT;

    result = {
      files: files.slice(0, LIMIT),
      totalCount,
      durationMs: Date.now() - startTime,
      truncated,
      mode: 'glob',
    };
  } else {
    throw new Error(`Unknown action: ${action}. Expected "grep" or "glob".`);
  }

  result.durationMs = Date.now() - startTime;

  // 写入缓存
  if (action === 'grep') {
    searchCache.set(cacheKey, { timestamp: Date.now(), result: { ...result } });
  }

  return result;
}

// ─── CLI 入口 ──────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);

  // JSON stdin 模式
  if (argv.length === 0 && !process.stdin.isTTY) {
    let inputData = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { inputData += chunk; });
    process.stdin.on('end', () => {
      try {
        const input = JSON.parse(inputData);
        const result = search(input);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
        process.exit(1);
      }
    });
    return;
  }

  // 命令行参数模式
  if (argv.length === 0) {
    process.stderr.write(`
Smart Search Tool — Grep + Glob for OpenClaw

Usage:
  # JSON stdin
  echo '{"action":"grep","pattern":"TODO"}' | node tool.js

  # CLI args
  node tool.js --action grep --pattern "TODO" --head_limit 10

Args:
  --action        "grep" | "glob"
  --pattern       Search pattern / glob
  --path          Directory to search (default: cwd)
  --glob          Glob filter for grep
  --output_mode   "content" | "files_with_matches" | "count"
  --context       Lines of context (content mode only)
  --case_insensitive  true | false (default: false)
  --file_type     ripgrep file type (e.g., "js", "py", "rust")
  --head_limit    Max results (default: 250 grep, 100 glob)
  --offset        Skip N results before taking (default: 0)
  --multiline     Multiline grep (default: false)
  --git_grep      Only search git tracked files (default: false)
  --help          This message
`);
    process.exit(0);
  }

  // 解析 CLI args
  const input = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--action': input.action = argv[++i]; break;
      case '--pattern': input.pattern = argv[++i]; break;
      case '--path': input.path = argv[++i]; break;
      case '--glob': input.glob = argv[++i]; break;
      case '--output_mode': input.output_mode = argv[++i]; break;
      case '--context': input.context = parseInt(argv[++i], 10); break;
      case '--case_insensitive': input.case_insensitive = argv[++i] === 'true'; break;
      case '--file_type': input.file_type = argv[++i]; break;
      case '--head_limit': input.head_limit = parseInt(argv[++i], 10); break;
      case '--offset': input.offset = parseInt(argv[++i], 10); break;
      case '--multiline': input.multiline = argv[++i] === 'true'; break;
      case '--git_grep': input.git_grep = argv[++i] === 'true'; break;
      case '--help':
        process.stdout.write('See --action for usage\n');
        process.exit(0);
    }
  }

  try {
    const result = search(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { search };
