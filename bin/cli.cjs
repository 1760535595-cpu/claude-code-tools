#!/usr/bin/env node

/**
 * claude-code-tools CLI
 * =====================
 * Unified entry point for all Claude Code-grade tools.
 * All tool.js files are CommonJS (#!/usr/bin/env node + require).
 * 
 * This CLI wraps them via child_process.execSync for compatibility.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOOLS = {
  'file-edit':   { file: 'file-edit.js',   desc: '智能文件编辑 — 精准替换+唯一性验证+自动备份' },
  'search':      { file: 'search.js',      desc: '智能搜索 — Grep+Glob 多引擎' },
  'powershell':  { file: 'powershell.js',  desc: 'PowerShell 安全执行 — cmdlet 分类+风险分析' },
  'cron':        { file: 'cron.js',        desc: '定时任务管理 — cron+自然语言调度' },
  'task':        { file: 'task.js',        desc: '任务清单+后台进程管理' },
  'subagent':    { file: 'subagent.js',    desc: '子代理增强 — 状态机+指令历史' },
};

const LIB_DIR = path.join(__dirname, '..', 'lib');

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch { return '1.0.0'; }
}

function showHelp() {
  const ver = getVersion();
  console.log(`
╔══════════════════════════════════════════╗
║   @xiaopin44/claude-code-tools v${ver.padEnd(13)}║
╚══════════════════════════════════════════╝

Windows 原生适配的 AI Agent 工具套件。
从 Claude Code 架构移植，纯 Node.js，零外部依赖。

━━━━━ 对比参考 ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Claude Code Max  →  $200/月  (锁定 Anthropic + IDE)
  Cursor Pro       →  $20/月   (锁定 VSCode)
  ✦ claude-code-tools → ¥99 永久买断 (任何 Node 环境)

━━━━━ 可用工具 ━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  for (const [name, info] of Object.entries(TOOLS)) {
    console.log(`  cct ${name.padEnd(14)} ${info.desc}`);
  }
  console.log(`
━━━━━ 用法示例 ━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # 安全分析 PowerShell 命令
  cct powershell '{"action":"analyze","command":"Remove-Item -Recurse -Force C:\\\\temp"}'

  # 搜索代码中的 TODO
  cct search '{"action":"grep","pattern":"TODO","path":"src"}'

  # 精准文件编辑（自动备份 · 唯一性验证）
  cct file-edit '{"oldStr":"var x","newStr":"let x"}'

  # 创建定时任务
  cct cron '{"action":"create","name":"通知","schedule":"daily","message":"早上好"}'

  # 待办清单管理
  cct task '{"action":"todo:list"}'

  # 子代理追踪
  cct subagent '{"action":"list"}'

  # 通过 stdin 传参
  echo '{"action":"list"}' | cct search

━━━━━ Windows 独有优势 ━━━━━━━━━━━━━━━━━━
  ✅ PowerShell cmdlet 安全执行 — 唯一实现（Claude Code 没有）
  ✅ 无需 ripgrep — findstr 自动降级（Windows 原生）
  ✅ 系统目录保护 — C:\\Windows 写入自动拦截
  ✅ Profile 保护 — $PROFILE 不可篡改
  ✅ 一次性买断 vs $200/月订阅

━━━━━ 输出格式 ━━━━━━━━━━━━━━━━━━━━━━━━━━
  所有工具返回 JSON，机器可读。
`);
}

function run() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(getVersion());
    process.exit(0);
  }

  const toolName = args[0];
  const tool = TOOLS[toolName];

  if (!tool) {
    console.error('错误: 未知工具 "' + toolName + '"');
    console.error('可用工具: ' + Object.keys(TOOLS).join(', '));
    process.exit(1);
  }

  const toolPath = path.join(LIB_DIR, tool.file);
  if (!fs.existsSync(toolPath)) {
    console.error('错误: 工具文件不存在: ' + toolPath);
    process.exit(1);
  }

  // Determine input JSON
  let jsonInput;

  if (args.length >= 2) {
    // From command line arguments
    jsonInput = args.slice(1).join(' ');
  } else if (!process.stdin.isTTY) {
    // From stdin pipe
    try {
      jsonInput = fs.readFileSync('/dev/stdin', 'utf-8').trim();
    } catch {
      // Windows fallback
      jsonInput = fs.readFileSync(0, 'utf-8').trim();
    }
  } else {
    console.error('用法: cct ' + toolName + ' \'{"action":"..."}\'');
    console.error(' 或:  echo \'{"action":"..."}\' | cct ' + toolName);
    process.exit(1);
  }

  try {
    JSON.parse(jsonInput); // Validate JSON
  } catch (e) {
    console.error('错误: 无效的 JSON 输入: ' + e.message);
    process.exit(1);
  }

  try {
    const result = execSync('node "' + toolPath + '"', {
      input: jsonInput,
      encoding: 'utf-8',
      timeout: 300000, // 5 min
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      windowsHide: true,
    });
    process.stdout.write(result);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    process.exit(e.status || 1);
  }
}

run();
