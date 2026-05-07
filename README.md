# @xiaopin44/claude-code-tools

> **Claude Code 级工具套件 — 为 OpenClaw 及其他 Node.js Agent 框架打造。**
> Windows 原生适配，零外部依赖，开箱即用。

```
npx @xiaopin44/claude-code-tools --help
```

---

## ✨ 核心卖点

| vs | Claude Code | Cursor | **claude-code-tools** |
|---|---|---|---|
| 💰 定价 | **$200/月** | **$20/月** | **¥99 永久买断** |
| 🔒 平台锁定 | 锁定 Anthropic | 锁定 VSCode | **任何 Node 环境** |
| 🪟 Windows 深度 | ❌ 无 cmdlet 安全 | ❌ 无 | **✅ PowerShell 全分类** |
| 🔧 可定制 | ❌ 闭源 | ❌ 闭源 | **✅ 开源可改** |
| 🏃 无需 GUI | ❌ 需 IDE | ❌ 需 IDE | **✅ 纯 CLI** |

## 🚀 安装

```bash
npm install -g @xiaopin44/claude-code-tools
```

或直接使用（无需安装）：

```bash
npx @xiaopin44/claude-code-tools search '{"action":"grep","pattern":"TODO"}'
```

## 🛠️ 工具清单

### 1. 🔧 智能文件编辑 `cct file-edit`

Claude Code FileEditTool 移植。精准替换，自动备份，唯一性验证。

```bash
# 精准替换
cct file-edit '{"oldStr":"var x = 1","newStr":"let x = 1"}'

# 多文件批量替换（dry-run 预览）
cct file-edit '{"files":[{"path":"src/a.js","ops":[{"oldStr":"foo","newStr":"bar"}]}],"dryRun":true}'

# 回滚
cct file-edit '{"action":"restore","backupId":"1730000000000-foo.js"}'
```

### 2. 🔍 智能搜索 `cct search`

Claude Code GrepTool + GlobTool 合并。自动选择最优搜索引擎（rg → git grep → findstr）。

```bash
# 文本搜索
cct search '{"action":"grep","pattern":"TODO","path":"src","contextLines":2}'

# 文件匹配
cct search '{"action":"glob","pattern":"**/*.ts","base":"src"}'

# 不区分大小写 + 正则
cct search '{"action":"grep","pattern":"import.*from","caseSensitive":false,"regex":true}'
```

### 3. 🛡️ PowerShell 安全执行 `cct powershell`

**Windows 独有**。Claude Code PowerShellTool 移植。cmdlet 分类、危险检测、拦截。

```bash
# 分析命令安全性
cct powershell '{"action":"analyze","command":"Remove-Item -Recurse -Force C:\\temp"}'

# 安全执行（只读命令自动放行，危险命令需批准）
cct powershell '{"action":"exec","command":"Get-Process | Where-Object CPU -gt 10"}'

# 只读检测
cct powershell '{"action":"checkReadOnly","command":"Set-Content C:\\test.txt"}'
```

### 4. ⏰ 定时任务管理 `cct cron`

Claude Code ScheduleCronTool 移植。调用 OpenClaw cron 系统。

```bash
# 创建每天 9 点的任务
cct cron '{"action":"create","name":"每日报告","schedule":"0 9 * * *","message":"生成今天的销售报表"}'

# 自然语言（daily → 0 9 * * *）
cct cron '{"action":"create","name":"周报","schedule":"weekly","message":"每周总结"}'

# 列表 + 立即执行 + 删除
cct cron '{"action":"list"}'
cct cron '{"action":"run","id":"<task-id>"}'
cct cron '{"action":"remove","id":"<task-id>"}'
```

### 5. 📋 任务清单 + 后台进程 `cct task`

Claude Code TodoWriteTool + Task 系列移植。待办管理 + 后台子进程运行。

```bash
# 待办清单
cct task '{"action":"todo:add","content":"完成文档","priority":"high","tags":["docs"]}'
cct task '{"action":"todo:list"}'
cct task '{"action":"todo:summary"}'

# 后台进程
cct task '{"action":"task:start","name":"编译","command":"npm run build","cwd":"./project"}'
cct task '{"action":"task:list"}'
cct task '{"action":"task:status","id":"<task-id>"}'
```

### 6. 🤖 子代理增强 `cct subagent`

Claude Code AgentTool + forkSubagent 移植。子代理状态管理。

```bash
# 登记子代理
cct subagent '{"action":"spawn","task":"分析API响应时间","mode":"fork"}'

# 管理
cct subagent '{"action":"list"}'
cct subagent '{"action":"status","id":"<agent-id>"}'
cct subagent '{"action":"steer","id":"<agent-id>","message":"换个方向做XX"}'
cct subagent '{"action":"kill","id":"<agent-id>"}'
```

---

## 🪟 Windows 独有优势

与其他 Agent 框架相比，claude-code-tools 在 Windows 上有不可替代的能力：

| 能力 | 竞品 | 本工具 |
|---|---|---|
| PowerShell cmdlet 分类 | ❌ 都不支持 | ✅ 500+ cmdlet 映射 |
| 只读/写入命令检测 | ❌ | ✅ Get/Set/Remove 分类 |
| 系统目录保护 | ❌ | ✅ C:\Windows\ 写入自动拦截 |
| PowerShell Profile 保护 | ❌ | ✅ $PROFILE 不可篡改 |
| 搜索引擎自动降级 | ❌ 依赖 rg | ✅ rg → git grep → findstr |

---

## 📦 对比定价

```
Claude Code Max       $200/月    =  ¥1,460/月
Cursor Pro            $20/月     =   ¥146/月
GitHub Copilot        $10/月     =    ¥73/月

✦ claude-code-tools    ¥99 永久  =    ¥99 一次性
```

## 🔧 开发

```bash
# Clone
git clone https://github.com/1760535595-cpu/claude-code-tools.git
cd claude-code-tools

# 本地测试
node bin/cli.js --help
node bin/cli.js cron '{"action":"list"}'

# 发布
npm publish
```

## 📄 License

MIT © xiaopin44
