# @xiaopin44/claude-code-tools
<img width="1910" height="915" alt="a2a3dd616b5980100cf549a822b6434b" src="https://github.com/user-attachments/assets/49f091de-11da-4899-8241-b7a0cc0bb179" />

> **Claude Code 级 AI Agent 工具套件 — 让 AI Agent 在 Windows 上也能像 Claude Code 一样干活。**
> 纯 Node.js · 零外部依赖 · Windows 原生适配

```
npx @xiaopin44/claude-code-tools --help
```

---

## 📌 它们解决什么问题

### 1. 🔧 智能文件编辑 → "AI 改代码总是改错位置"

**痛点：** 同一个函数名出现好几次，AI 改错地方，文件就废了。AI 不知道改的是不是对的。

**解决方案：** 精准替换 + 唯一性验证。匹配到多个或零个直接报错，不改。自动备份，改错了一键恢复。

```bash
cct file-edit '{"oldStr":"var x = 1","newStr":"let x = 1"}'
```

---

### 2. 🔍 智能搜索 → "Windows 上 rg 装不上 / 搜不了"

**痛点：** ripgrep（rg）在 Windows 上经常装不上，没有它 AI 就搜不了代码。OpenClaw 自带的 grep 走 PowerShell 很慢。

**解决方案：** rg 优先 → git grep → findstr 自动降级。啥都不用装，搜就行。

```bash
cct search '{"action":"grep","pattern":"TODO","path":"src"}'
```

---

### 3. 🛡️ PowerShell 安全执行 → "AI 乱删系统文件" ⭐ Windows 独有

**痛点：** AI Agent 在 Windows 上执行 PowerShell 时，`Remove-Item C:\Windows` 你敢让它跑吗？  
OpenClaw 没有 cmdlet 分类能力，不知道哪个命令会删东西。  
**Claude Code 和 Cursor 在 Windows 上都做不到这个。**

**解决方案：** 500+ cmdlet 分类，哪些只读哪些写入自动识别。系统目录写入自动拦截，$PROFILE 不可篡改。危险命令必须传 approvalToken 才能执行。

```bash
cct powershell '{"action":"analyze","command":"Remove-Item -Recurse -Force C:\\temp"}'
cct powershell '{"action":"exec","command":"Get-Process | Where-Object CPU -gt 10"}'
```

---

### 4. ⏰ 定时任务管理 → "AI 不会定时干活的"

**痛点：** OpenClaw 有 cron 能力但没管理界面。想建个"每天早上查库存"的任务——没地方搞。

**解决方案：** 用 `daily` / `weekly` 自然语言就能创建 cron 任务，list / run / toggle / remove 全管理。

```bash
cct cron '{"action":"create","name":"每日报告","schedule":"daily","message":"生成今天的销售报表"}'
cct cron '{"action":"list"}'
cct cron '{"action":"run","id":"<task-id>"}'
```

---

### 5. 📋 任务清单 + 后台进程 → "AI 跑长任务只能干等"

**痛点：** AI 运行 `npm build` 要等好几分钟，期间啥也干不了。任务做了一半想保存进度——没地方记。

**解决方案：** 后台起进程不阻塞主流程，随时看状态看输出。待办清单结构化保存，还能触发"验证提醒"——所有待办完成后提醒要验证结果（Claude Code 特色机制）。

```bash
cct task '{"action":"todo:add","content":"完成文档","priority":"high"}'
cct task '{"action":"task:start","name":"编译","command":"npm run build","cwd":"./project"}'
cct task '{"action":"task:list"}'
```

---

### 6. 🤖 子代理增强 → "多个子代理跑起来就乱了"

**痛点：** OpenClaw 的 sessions_spawn 能创建子代理但没法集中管理。跑的多了，谁在跑什么、跑多久了、进度怎么样——一头雾水。

**解决方案：** 状态机跟踪每个子代理，steer 可以中途改方向，list 一目了然。

```bash
cct subagent '{"action":"spawn","task":"分析API响应时间","mode":"fork"}'
cct subagent '{"action":"list"}'
cct subagent '{"action":"steer","id":"<agent-id>","message":"换个方向做XX"}'
```

---

## ✨ 一句话

> **AI Agent 在 Windows 上干活需要的工具，Claude Code 有的这里都有，Claude Code 没有的（PowerShell 安全保护）这里也有。而价格只要一折的零头。**

---

## 🆚 对比参考

| | Claude Code | Cursor | **claude-code-tools** |
|---|---|---|---|
| 💰 定价 | **$200/月** | **$20/月** | **¥99 永久买断** |
| 🔒 平台锁定 | 锁定 Anthropic + IDE | 锁定 VSCode | **任何 Node 环境** |
| 🪟 PowerShell 安全 | ❌ 无 | ❌ 无 | **✅ 500+ cmdlet 分类** |
| 🪟 搜索引擎 | ❌ 依赖 rg | ❌ 依赖 rg | **✅ rg→git grep→findstr 自动降级** |
| 🔧 开源可改 | ❌ 闭源 | ❌ 闭源 | **✅ MIT 开源** |
| 🏃 无需 GUI | ❌ 需 IDE | ❌ 需 IDE | **✅ 纯 CLI** |

---

## 🚀 安装

```bash
# 全局安装（推荐）
npm install -g @xiaopin44/claude-code-tools

# 使用
cct search '{"action":"grep","pattern":"TODO"}'

# 或免安装直接使用
npx @xiaopin44/claude-code-tools search '{"action":"grep","pattern":"TODO"}'

# 查看完整帮助
cct --help
```

---

## 📦 定价

```
Claude Code Max       $200/月    =  ¥1,460/月
Cursor Pro             $20/月    =   ¥146/月
GitHub Copilot         $10/月    =    ¥73/月

✦ claude-code-tools     ¥99 永久  =    ¥99 一次性
```

---

## 🔧 开发

```bash
git clone https://github.com/1760535595-cpu/claude-code-tools.git
cd claude-code-tools
node bin/cli.cjs --help
```

## 📄 License

MIT © xiaopin44
