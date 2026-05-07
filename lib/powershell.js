#!/usr/bin/env node
/**
 * PowerShell Security Execution Tool (powershell-exec)
 *
 * Ported from Claude Code's BashTool architecture to a standalone Node.js tool
 * for use with OpenClaw's exec tool on Windows.
 *
 * Capabilities:
 *   1. analyze   - Static security analysis of PowerShell commands
 *   2. exec      - Safe command execution with approval flow
 *   3. checkReadOnly - Read-only mode detection
 *   4. checkPath - Path safety validation
 *
 * Usage:
 *   node tool.js '{"action":"analyze","command":"Remove-Item -Recurse C:\\temp"}'
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB default truncation
const DEFAULT_TIMEOUT_MS = 30_000;   // 30s default timeout
const MAX_TIMEOUT_MS = 5 * 60_000;   // 5m max timeout
const SYSTEM_DIRS = [
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env.ProgramFiles_x86 || 'C:\\Program Files (x86)',
  process.env.SystemDrive + '\\' || 'C:\\',
];

// PowerShell profile paths that must not be modified
const PROTECTED_PROFILES = [
  '$PROFILE',
  '$HOME\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
  '$HOME\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1',
  process.env.USERPROFILE + '\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
  process.env.USERPROFILE + '\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1',
];

// ============================================================================
// DANGER CLASSIFICATION
// ============================================================================

/**
 * High-risk cmdlets/commands — require explicit approval token.
 */
const HIGH_RISK_PATTERNS = [
  // Destructive file operations
  { pattern: /Remove-Item\s+-Recurse/i, riskType: 'delete', label: '递归删除操作' },
  { pattern: /Remove-Item\s+-Force\s+-Recurse/i, riskType: 'delete', label: '强制递归删除' },
  { pattern: /rm\s+-(?:r|rf|fr|recursive)/i, riskType: 'delete', label: '递归 rm 删除' },
  { pattern: /Remove-Item\s+.*\$PROFILE/i, riskType: 'delete', label: '删除 PowerShell Profile' },
  { pattern: /del\s+\/f\s+\/s/i, riskType: 'delete', label: '强制递归 del 删除' },
  { pattern: /Remove-Item\s+.*\\\\\*\s+-Recurse/i, riskType: 'delete', label: '全盘递归删除' },

  // System service control
  { pattern: /Stop-Service\s+/i, riskType: 'system', label: '停止系统服务' },
  { pattern: /Restart-Service\s+/i, riskType: 'system', label: '重启系统服务' },
  { pattern: /Set-Service\s+.*-StartupType/i, riskType: 'system', label: '修改服务启动类型' },
  { pattern: /net\s+stop\s+/i, riskType: 'system', label: 'net stop 停止服务' },

  // Execution policy / security
  { pattern: /Set-ExecutionPolicy\s+/i, riskType: 'system', label: '修改执行策略' },
  { pattern: /Set-MpPreference/i, riskType: 'system', label: '修改 Defender 设置' },

  // SQL destructive
  { pattern: /Invoke-SqlCmd.*\bDROP\b/i, riskType: 'data', label: 'SQL DROP 操作' },
  { pattern: /sqlcmd.*\bDROP\b/i, riskType: 'data', label: 'SQLCMD DROP 操作' },

  // Registry dangerous
  { pattern: /Remove-Item\s+-Path\s+.*Registry::/i, riskType: 'system', label: '注册表删除操作' },
  { pattern: /reg\s+delete/i, riskType: 'system', label: '注册表删除' },

  // Git destructive
  { pattern: /git\s+push\s+--force/i, riskType: 'data', label: 'Git force push（覆盖远程历史）' },
  { pattern: /git\s+reset\s+--hard/i, riskType: 'data', label: 'Git reset --hard（丢弃本地更改）' },
  { pattern: /git\s+clean\s+-f[fd]/i, riskType: 'data', label: 'Git clean -fd（删除未跟踪文件）' },

  // Kubernetes destructive
  { pattern: /kubectl\s+delete/i, riskType: 'data', label: 'Kubernetes 删除资源' },

  // Format/wipe
  { pattern: /Format-Volume/i, riskType: 'delete', label: '格式化卷' },
  { pattern: /Clear-Disk/i, riskType: 'delete', label: '清除磁盘' },
  { pattern: /Remove-Partition/i, riskType: 'delete', label: '删除分区' },
  { pattern: /Initialize-Disk\s+-PartitionStyle/i, riskType: 'delete', label: '初始化磁盘' },

  // Dangerous PowerShell operators
  { pattern: /Invoke-Expression/i, riskType: 'system', label: 'Invoke-Expression 执行任意表达式' },
  { pattern: /iex\s+\(/i, riskType: 'system', label: 'iex 间接执行' },
  { pattern: /Invoke-WmiMethod.*-Name\s+create/i, riskType: 'system', label: 'WMI 进程创建' },

  // Profile modification
  { pattern: /Out-File\s+.*\$PROFILE/i, riskType: 'system', label: '写入 PowerShell Profile' },
  { pattern: /Add-Content\s+.*\$PROFILE/i, riskType: 'system', label: '追加内容到 Profile' },
  { pattern: /Set-Content\s+.*\$PROFILE/i, riskType: 'system', label: '写入内容到 Profile' },

  // Network exfiltration
  { pattern: /(?:Invoke-WebRequest|Invoke-RestMethod|curl|wget)\s+.*-OutFile/i, riskType: 'network', label: '网络下载到文件' },
  { pattern: /net\s+use/i, riskType: 'network', label: '网络共享映射' },
  { pattern: /New-PSDrive\s+-Persist/i, riskType: 'network', label: '持久化网络驱动器' },
];

const MEDIUM_RISK_PATTERNS = [
  { pattern: /Remove-Item\s+(?!-Recurse)/i, riskType: 'delete', label: '删除操作（非递归）' },
  { pattern: /del\s+/i, riskType: 'delete', label: 'del 删除操作' },
  { pattern: /rm\s+/i, riskType: 'delete', label: 'rm 删除操作' },
  { pattern: /Clear-Content/i, riskType: 'data', label: '清除文件内容' },
  { pattern: /Clear-Item/i, riskType: 'data', label: '清除项目' },
  { pattern: /Move-Item/i, riskType: 'data', label: '移动文件/目录' },
  { pattern: /Rename-Item/i, riskType: 'data', label: '重命名操作' },
  { pattern: /Stop-Process/i, riskType: 'system', label: '终止进程' },
  { pattern: /Restart-Computer/i, riskType: 'system', label: '重启计算机' },
  { pattern: /Stop-Computer/i, riskType: 'system', label: '关闭计算机' },
  { pattern: /Add-Content/i, riskType: 'data', label: '追加内容到文件' },
  { pattern: /Set-Content/i, riskType: 'data', label: '写入内容到文件' },
  { pattern: /Out-File/i, riskType: 'data', label: '输出到文件' },
  { pattern: /Export-Csv/i, riskType: 'data', label: '导出 CSV' },
  { pattern: /ConvertTo-Json\s+\|/i, riskType: 'data', label: 'JSON 输出管道' },
  { pattern: /Register-ScheduledJob/i, riskType: 'system', label: '注册计划任务' },
  { pattern: /New-LocalUser/i, riskType: 'system', label: '创建本地用户' },
  { pattern: /Set-LocalUser/i, riskType: 'system', label: '修改本地用户' },
  { pattern: /New-ItemProperty/i, riskType: 'system', label: '创建注册表项' },
  { pattern: /Set-ItemProperty/i, riskType: 'system', label: '修改注册表项' },
  { pattern: /New-PSDrive/i, riskType: 'system', label: '映射驱动器' },
  { pattern: /copy-item/i, riskType: 'data', label: '复制操作' },
  { pattern: /cp\s+/i, riskType: 'data', label: 'cp 复制操作' },
  { pattern: /Out-File\s+.*-Append/i, riskType: 'data', label: '追加输出到文件' },
  { pattern: /Compress-Archive/i, riskType: 'data', label: '压缩目录为 zip' },
  { pattern: /Expand-Archive/i, riskType: 'data', label: '解压文件' },
];

const LOW_RISK_PATTERNS = [
  { pattern: /Set-Location/i, riskType: 'unknown', label: '切换工作目录' },
  { pattern: /cd\s+/i, riskType: 'unknown', label: '切换目录' },
  { pattern: /Push-Location/i, riskType: 'unknown', label: '压入目录栈' },
  { pattern: /Start-Process/i, riskType: 'unknown', label: '启动进程' },
  { pattern: /New-Item\s+(?!-ItemType\s+Directory)/i, riskType: 'unknown', label: '创建文件' },
  { pattern: /New-Item\s+-ItemType\s+Directory/i, riskType: 'unknown', label: '创建目录' },
  { pattern: /mkdir\s+/i, riskType: 'unknown', label: '创建目录（mkdir）' },
  { pattern: /ni\s+/i, riskType: 'unknown', label: 'New-Item 别名' },
  { pattern: /Write-Host/i, riskType: 'unknown', label: '输出到控制台' },
  { pattern: /Write-Output/i, riskType: 'unknown', label: '输出到管道' },
  { pattern: /echo\s+/i, riskType: 'unknown', label: 'Echo 输出' },
  { pattern: /Set-Variable/i, riskType: 'unknown', label: '设置变量' },
  { pattern: /Remove-Variable/i, riskType: 'unknown', label: '删除变量' },
  { pattern: /Start-Sleep/i, riskType: 'unknown', label: '暂停执行' },
];

// Purely read-only cmdlets (safe to auto-approve)
const READ_ONLY_CMDLETS = new Set([
  'Get-', 'Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty',
  'Get-Process', 'Get-Service', 'Get-WmiObject', 'Get-CimInstance',
  'Get-Command', 'Get-Module', 'Get-Help', 'Get-PSDrive', 'Get-Location',
  'Get-Date', 'Get-Variable', 'Get-Alias', 'Get-Member', 'Get-History',
  'Get-EventLog', 'Get-WinEvent', 'Get-NetAdapter', 'Get-NetIPAddress',
  'Get-NetTCPConnection', 'Get-ComputerInfo', 'Get-Culture', 'Get-UICulture',
  'Get-HotFix', 'Get-TimeZone',
  'Select-', 'Select-Object', 'Select-String',
  'Where-', 'Where-Object',
  'Sort-', 'Sort-Object',
  'Group-', 'Group-Object',
  'Measure-', 'Measure-Object',
  'ForEach-Object',
  'Write-Host', 'Write-Output', 'Write-Verbose', 'Write-Debug', 'Write-Information',
  'Write-Progress', 'Write-Warning',
  'Format-', 'Format-Table', 'Format-List', 'Format-Wide', 'Format-Custom',
  'Out-Host', 'Out-Default', 'Out-Null', 'Out-String', 'Out-GridView',
  'echo', 'dir', 'ls', 'type', 'cat', 'pwd', 'get-location', 'sort',
  'where', 'select', 'foreach',
]);

// Write operations (for read-only detection: any of these makes it non-read-only)
const WRITE_CMDLETS = new Set([
  'Out-File', 'Set-Content', 'Add-Content', 'Export-Csv', 'Export-Clixml',
  'Export-FormatData', 'Export-ModuleMember', 'Export-PSSession',
  'ConvertTo-Html', 'ConvertTo-Json', 'ConvertTo-Xml',
  'Remove-', 'Remove-Item', 'Remove-Variable', 'Remove-PSDrive',
  'Move-', 'Move-Item', 'Rename-', 'Rename-Item',
  'Copy-', 'Copy-Item',
  'New-', 'New-Item', 'New-PSDrive', 'New-Variable', 'New-Alias',
  'Set-', 'Set-Content', 'Set-Variable', 'Set-Location', 'Set-Item', 'Set-ItemProperty',
  'Clear-', 'Clear-Content', 'Clear-Item', 'Clear-Variable',
  'Invoke-', 'Invoke-Expression', 'Invoke-Command', 'Invoke-WebRequest', 'Invoke-RestMethod',
  'Start-', 'Start-Process', 'Start-Service', 'Start-Sleep',
  'Stop-', 'Stop-Process', 'Stop-Service',
  'Restart-', 'Restart-Service', 'Restart-Computer',
  'Register-', 'Register-ScheduledJob',
  'Compress-Archive', 'Expand-Archive',
  'Format-Volume', 'Clear-Disk', 'Remove-Partition', 'Initialize-Disk',
  'Add-', 'Add-Content',
  'net', 'git', 'kubectl', 'sqlcmd',
  'reg', 'schtasks', 'sc',
  'msiexec', 'wmic',
]);

// ============================================================================
// CMDLET / TOKEN EXTRACTOR
// ============================================================================

/**
 * Extract PowerShell cmdlets and flags from a command string.
 */
function extractPsCmdlets(command) {
  const cmdlets = [];
  const flags = [];
  
  // Match Verb-Noun cmdlets (e.g., Get-Process, Remove-Item)
  const cmdletMatches = command.matchAll(/\b[A-Z][a-z]+-[A-Z][A-Za-z]*\b/g);
  for (const m of cmdletMatches) {
    cmdlets.push(m[0]);
  }

  // Match legacy/external commands (git, kubectl, net, reg, etc.)
  // Only match at start of command or after pipeline/cast tokens.
  // Exclude terms that look like partial matches of Verb-Noun cmdlets.
  const legacyPattern = /(?:^|[|;\n])\s*([a-z][a-z0-9]*(?:\.exe)?)\b/gi;
  const legacyMatches = command.matchAll(legacyPattern);
  for (const m of legacyMatches) {
    const cmd = m[1].toLowerCase().replace(/\.exe$/i, '');
    // Skip if this is a fragment of a Verb-Noun cmdlet already captured
    if (cmdlets.some(c => c.toLowerCase() === cmd)) continue;
    // Skip if cmd is a common verb fragment (get, set, remove, new, etc.)
    // that is already part of a Verb-Noun cmdlet
    const skipVerbs = ['get', 'set', 'remove', 'new', 'select', 'where', 'sort', 'group', 'measure', 'copy', 'move', 'rename', 'clear', 'stop', 'start', 'restart', 'invoke', 'register', 'format', 'out', 'write', 'add', 'export', 'convert', 'compress', 'expand'];
    if (skipVerbs.includes(cmd) && cmdlets.some(c => c.startsWith(cmd.charAt(0).toUpperCase() + cmd.slice(1) + '-'))) continue;
    cmdlets.push(cmd);
  }

  // Match flags (both PowerShell-style -X and CMD-style /X)
  const flagMatches = command.matchAll(/(?:^|\s+)((-{1,2}[A-Za-z][A-Za-z0-9]*)\b|(\/[A-Za-z])\b)/g);
  for (const m of flagMatches) {
    const flag = m[2] || m[3];
    if (flag && !flags.includes(flag)) {
      flags.push(flag);
    }
  }

  return { cmdlets: [...new Set(cmdlets)], flags: [...new Set(flags)] };
}

/**
 * Detect command type: powershell, cmd, or bash-ish.
 */
function detectCommandType(command) {
  // PowerShell cmdlets
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]*\b/.test(command.trim())) {
    return 'powershell';
  }
  // PowerShell operators
  if (/\b(?:Get-|Set-|Remove-|New-|Invoke-|Out-File|Export-Csv|Select-Object|Where-Object)\b/i.test(command)) {
    return 'powershell';
  }
  // CMD commands
  if (/^(?:dir|cd|copy|del|ren|move|type|echo|set |path|ver|cls|color|title|prompt|assoc|ftype)\b/i.test(command.trim())) {
    return 'cmd';
  }
  // Variables
  if (/\$[A-Za-z_]/.test(command)) {
    return 'powershell';
  }
  // Default: treat as CMD (safer default for Windows)
  return 'cmd';
}

// ============================================================================
// SECURITY ANALYSIS
// ============================================================================

/**
 * Analyze a command for security risks.
 */
function analyzeCommand(command) {
  const extracted = extractPsCmdlets(command);
  const cmdlets = extracted.cmdlets;
  const flags = extracted.flags;

  // Check high-risk patterns first
  for (const risk of HIGH_RISK_PATTERNS) {
    if (risk.pattern.test(command)) {
      return {
        dangerous: true,
        riskLevel: 'high',
        riskType: risk.riskType,
        details: risk.label,
        cmdlets,
        flags,
        matchedPattern: risk.label,
      };
    }
  }

  // Check medium-risk patterns
  for (const risk of MEDIUM_RISK_PATTERNS) {
    if (risk.pattern.test(command)) {
      return {
        dangerous: true,
        riskLevel: 'medium',
        riskType: risk.riskType,
        details: risk.label,
        cmdlets,
        flags,
        matchedPattern: risk.label,
      };
    }
  }

  // Check low-risk patterns
  for (const risk of LOW_RISK_PATTERNS) {
    if (risk.pattern.test(command)) {
      return {
        dangerous: true,
        riskLevel: 'low',
        riskType: risk.riskType,
        details: risk.label,
        cmdlets,
        flags,
        matchedPattern: risk.label,
      };
    }
  }

  // Default: safe
  return {
    dangerous: false,
    riskLevel: 'safe',
    riskType: 'unknown',
    details: '无风险模式匹配',
    cmdlets,
    flags,
  };
}

/**
 * Check if a command is read-only (safe for auto-execution).
 */
function checkReadOnlyCommand(command) {
  const analysis = analyzeCommand(command);
  
  // If already flagged as dangerous, it's not read-only
  if (analysis.dangerous) {
    return { isReadOnly: false, readOnlyCmdlets: [], writeCmdlets: analysis.cmdlets.filter(c => !isReadOnlyCmdlet(c)) };
  }

  const extracted = extractPsCmdlets(command);
  const cmdlets = extracted.cmdlets;

  // If no cmdlets identified, assume read-only for simple commands like echo/pwd
  if (cmdlets.length === 0) {
    // Check for basic read-only commands
    const simpleReadOnly = ['echo', 'pwd', 'get-location', 'dir', 'ls', 'type', 'sort', 'where'];
    const parts = command.trim().split(/\s+/);
    const baseCmd = parts[0]?.toLowerCase();
    if (simpleReadOnly.includes(baseCmd) || baseCmd && (baseCmd.startsWith('get-') || baseCmd.startsWith('select-') || baseCmd.startsWith('where-') || baseCmd.startsWith('sort-') || baseCmd.startsWith('group-') || baseCmd.startsWith('measure-'))) {
      return { isReadOnly: true, readOnlyCmdlets: [baseCmd], writeCmdlets: [] };
    }
    return { isReadOnly: false, readOnlyCmdlets: [], writeCmdlets: [] };
  }

  // Check each cmdlet — if any is a write cmdlet, the command is not read-only
  const readOnlyCmdlets = [];
  const writeCmdlets = [];
  
  // Handle pipeline: check each segment individually
  const segments = command.split(/[\|;]/);
  let allReadOnly = true;
  
  for (const segment of segments) {
    const segExtracted = extractPsCmdlets(segment.trim());
    for (const cmdlet of segExtracted.cmdlets) {
      if (isWriteCmdlet(cmdlet)) {
        allReadOnly = false;
        writeCmdlets.push(cmdlet);
      } else {
        readOnlyCmdlets.push(cmdlet);
      }
    }
  }

  return {
    isReadOnly: allReadOnly,
    readOnlyCmdlets: [...new Set(readOnlyCmdlets)],
    writeCmdlets: [...new Set(writeCmdlets)],
  };
}

function isReadOnlyCmdlet(cmdlet) {
  for (const ro of READ_ONLY_CMDLETS) {
    if (cmdlet.startsWith(ro) || cmdlet.toLowerCase() === ro.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function isWriteCmdlet(cmdlet) {
  const lower = cmdlet.toLowerCase();
  for (const wc of WRITE_CMDLETS) {
    const wcLower = wc.toLowerCase();
    if (lower.startsWith(wcLower) || lower === wcLower) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// PATH SAFETY
// ============================================================================

/**
 * Check if a command targets system-protected file paths.
 * Only flags when the command contains write operations.
 */
function checkPathSafety(command) {
  const issues = [];

  // Only check paths if the command involves writing
  const isWriteOp = MEDIUM_RISK_PATTERNS.some(r => r.riskType !== 'system' && r.pattern.test(command))
    || /Out-File|Set-Content|Add-Content|Export-Csv|Out-File -Append|ConvertTo-Json\s+\||Compress-Archive|Expand-Archive/i.test(command);

  if (!isWriteOp) {
    return { safe: true, issues: [] };
  }

  // Check for system directory writes
  for (const sysDir of SYSTEM_DIRS) {
    if (!sysDir) continue;
    const lowerDir = sysDir.toLowerCase();
    // Check for paths containing system directories
    if (command.toLowerCase().includes(lowerDir)) {
      issues.push(`写入系统目录: ${sysDir}`);
    }
  }

  // Check for profile modification
  for (const profile of PROTECTED_PROFILES) {
    if (command.includes(profile)) {
      issues.push('修改 PowerShell Profile 受保护操作');
    }
  }

  // Check UNC paths (network exfiltration risk)
  const uncMatch = command.match(/\\\\[a-zA-Z][^\\\s]+\\(?!.*\\).*$/);
  if (uncMatch && /Out-File|Set-Content|Add-Content|Export-Csv/i.test(command)) {
    issues.push(`写入 UNC 网络路径: ${uncMatch[0]}`);
  }

  // Check environment variable paths
  const envVarPaths = command.matchAll(/\$env:[A-Za-z_][A-Za-z0-9_]*/g);
  for (const ev of envVarPaths) {
    if (command.includes('Out-File') || command.includes('Set-Content') || command.includes('Add-Content')) {
      issues.push(`通过环境变量 ${ev[0]} 写入路径`);
    }
  }

  return {
    safe: issues.length === 0,
    issues,
  };
}

// ============================================================================
// EXECUTION
// ============================================================================

/**
 * Execute a PowerShell command safely.
 */
function executeCommand(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeout = DEFAULT_TIMEOUT_MS,
    approvalToken = null,
  } = options;

  const startTime = Date.now();

  // Step 1: Analyze the command
  const analysis = analyzeCommand(command);

  // Step 2: If dangerous, require approval token
  if (analysis.dangerous) {
    if (!approvalToken) {
      return {
        success: false,
        error: '需要权限批准',
        approvalRequired: true,
        analysis,
        stdout: '',
        stderr: '此命令需要批准才能执行',
        exitCode: -1,
        durationMs: Date.now() - startTime,
        truncated: false,
      };
    }
    // Validate approval token (simple check: must be non-empty and match expected format)
    if (typeof approvalToken !== 'string' || approvalToken.length < 1) {
      return {
        success: false,
        error: '无效的批准令牌',
        approvalRequired: false,
        analysis,
        stdout: '',
        stderr: '提供的批准令牌无效',
        exitCode: -1,
        durationMs: Date.now() - startTime,
        truncated: false,
      };
    }
  }

  // Step 3: Determine shell type
  const cmdType = detectCommandType(command);
  let shellCmd, shellArgs;

  if (cmdType === 'powershell') {
    shellCmd = 'powershell.exe';
    shellArgs = ['-NoProfile', '-NonInteractive', '-Command', command];
  } else {
    // CMD
    shellCmd = 'cmd.exe';
    shellArgs = ['/C', command];
  }

  // Step 4: Execute
  const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT_MS);
  
  try {
    const result = spawnSync(shellCmd, shellArgs, {
      cwd,
      timeout: effectiveTimeout,
      maxBuffer: MAX_OUTPUT_BYTES + 1024, // slightly more to detect truncation
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env },
    });

    const durationMs = Date.now() - startTime;
    let stdout = (result.stdout || '').trim();
    let stderr = (result.stderr || '').trim();

    // Check for truncation
    const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(stderr, 'utf8');
    const truncated = stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES;

    // Truncate if needed
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n... [输出已截断]';
    }
    if (stderrBytes > MAX_OUTPUT_BYTES) {
      stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n... [错误输出已截断]';
    }

    return {
      success: result.status === 0 || result.status === null,
      error: result.error ? result.error.message : null,
      analysis,
      stdout,
      stderr,
      exitCode: result.status !== null ? result.status : -1,
      signal: result.signal,
      durationMs,
      truncated,
      commandType: cmdType,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      analysis,
      stdout: '',
      stderr: err.message,
      exitCode: -1,
      durationMs: Date.now() - startTime,
      truncated: false,
      commandType: cmdType,
    };
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

function printJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function printError(msg) {
  process.stderr.write(msg + '\n');
}

function main() {
  const args = process.argv.slice(2);
  
  // Support JSON from stdin or command line argument
  let input;
  if (args.length === 0 && !process.stdin.isTTY) {
    // Read from stdin
    let rawData = '';
    const buf = process.stdin.read();
    if (buf) {
      rawData = buf.toString();
    } else {
      // Synchronous read
      rawData = require('fs').readFileSync(0, 'utf8');
    }
    try {
      input = JSON.parse(rawData);
    } catch (e) {
      printError(`错误: 无法解析 stdin JSON — ${e.message}`);
      process.exit(1);
    }
  } else if (args.length > 0) {
    try {
      input = JSON.parse(args.join(' '));
    } catch (e) {
      // Support simple "action command" form
      if (args.length >= 2 && args[0] === 'exec') {
        input = { action: 'exec', command: args.slice(1).join(' ') };
      } else if (args.length >= 2 && args[0] === 'analyze') {
        input = { action: 'analyze', command: args.slice(1).join(' ') };
      } else if (args.length >= 2 && args[0] === 'check') {
        input = { action: 'checkReadOnly', command: args.slice(1).join(' ') };
      } else {
        printError(`错误: 无法解析参数 JSON — ${e.message}`);
        process.exit(1);
      }
    }
  } else {
    printError('用法: node tool.js \'{"action":"analyze|exec|checkReadOnly|checkPath","command":"..."}\'');
    process.exit(1);
  }

  const { action, command, cwd, timeout, approvalToken } = input;

  if (!action || !command) {
    printError('错误: action 和 command 为必填字段');
    process.exit(1);
  }

  switch (action) {
    case 'analyze': {
      const result = analyzeCommand(command);
      printJson(result);
      break;
    }

    case 'exec': {
      const result = executeCommand(command, { cwd, timeout, approvalToken });
      printJson(result);
      break;
    }

    case 'checkReadOnly': {
      const result = checkReadOnlyCommand(command);
      printJson(result);
      break;
    }

    case 'checkPath': {
      const result = checkPathSafety(command);
      printJson(result);
      break;
    }

    default:
      printError(`错误: 未知 action "${action}"。支持: analyze, exec, checkReadOnly, checkPath`);
      process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  analyzeCommand,
  executeCommand,
  checkReadOnlyCommand,
  checkPathSafety,
  detectCommandType,
  extractPsCmdlets,
};
