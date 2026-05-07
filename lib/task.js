#!/usr/bin/env node

/**
 * task-manager tool.js
 * ====================
 * Enhanced task management with two subsystems:
 * 1. Todo - structured checklist (from Claude Code TodoWriteTool)
 * 2. Task - background process lifecycle management (from Claude Code Task series)
 *
 * Persistent storage: ~/.openclaw/task-manager.json
 *
 * Usage:
 *   node tool.js < <json-input>
 *   or pipe via: echo '{"action":"..."}' | node tool.js
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const crypto = require('crypto')

// ── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(require('os').homedir(), '.openclaw')
const DATA_FILE = path.join(DATA_DIR, 'task-manager.json')
const MAX_CONCURRENT_TASKS = 5
const MAX_OUTPUT_SIZE = 50 * 1024 // 50KB

// ── Database ─────────────────────────────────────────────────────────────────

function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { todos: [], tasks: [], runningPids: {} }
  }
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

// ── Todo Subsystem ────────────────────────────────────────────────────────────

function todoAdd({ content, priority, tags }) {
  if (!content || typeof content !== 'string') {
    return { error: 'Missing or invalid "content"' }
  }
  const data = loadData()
  const item = {
    id: crypto.randomUUID(),
    content,
    status: 'pending',
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    createdAt: new Date().toISOString(),
    tags: Array.isArray(tags) ? tags : [],
  }
  data.todos.push(item)
  saveData(data)
  return { ok: true, todo: item }
}

function todoList() {
  const data = loadData()
  return { ok: true, todos: data.todos }
}

function todoUpdate({ id, status, content, priority, tags }) {
  if (!id) return { error: 'Missing "id"' }
  const data = loadData()
  const idx = data.todos.findIndex(t => t.id === id)
  if (idx === -1) return { error: `Todo not found: ${id}` }

  const validStatuses = ['pending', 'in_progress', 'completed', 'skipped']
  if (status && !validStatuses.includes(status)) {
    return { error: `Invalid status: ${status}` }
  }

  if (content !== undefined) data.todos[idx].content = content
  if (status) data.todos[idx].status = status
  if (priority && ['high', 'medium', 'low'].includes(priority)) data.todos[idx].priority = priority
  if (tags !== undefined) data.todos[idx].tags = tags
  if (status === 'completed') data.todos[idx].completedAt = new Date().toISOString()

  saveData(data)
  return { ok: true, todo: data.todos[idx] }
}

function todoRemove({ id }) {
  if (!id) return { error: 'Missing "id"' }
  const data = loadData()
  const idx = data.todos.findIndex(t => t.id === id)
  if (idx === -1) return { error: `Todo not found: ${id}` }
  const removed = data.todos.splice(idx, 1)[0]
  saveData(data)
  return { ok: true, removed }
}

function todoClear({ status }) {
  const data = loadData()
  const filterStatus = status || 'completed'
  const before = data.todos.length
  data.todos = data.todos.filter(t => t.status !== filterStatus)
  const removed = before - data.todos.length
  saveData(data)
  return { ok: true, removed }
}

function todoSummary() {
  const data = loadData()
  const todos = data.todos
  const counts = { pending: 0, in_progress: 0, completed: 0, skipped: 0 }
  for (const t of todos) counts[t.status] = (counts[t.status] || 0) + 1

  // Verification nudge: when all done, >=3 items, none has "verif"
  const allDone = todos.every(t => t.status === 'completed')
  let verificationNudgeNeeded = false
  if (allDone && todos.length >= 3 && !todos.some(t => /verif/i.test(t.content))) {
    verificationNudgeNeeded = true
  }

  return {
    ok: true,
    summary: {
      total: todos.length,
      pending: counts.pending,
      in_progress: counts.in_progress,
      completed: counts.completed,
      skipped: counts.skipped,
      verificationNudgeNeeded,
    },
  }
}

// ── Task Subsystem (background process) ──────────────────────────────────────

const runningProcesses = {} // taskId -> ChildProcess

function taskStart({ name, command, cwd }) {
  if (!name) return { error: 'Missing "name"' }
  if (!command || typeof command !== 'string') return { error: 'Missing "command"' }

  const data = loadData()
  const runningCount = Object.keys(data.runningPids).length

  if (runningCount >= MAX_CONCURRENT_TASKS) {
    return { error: `Max concurrent tasks (${MAX_CONCURRENT_TASKS}) reached` }
  }

  const taskId = crypto.randomUUID()

  // Parse command into cmd + args
  const parts = parseCommand(command)
  const cmd = parts[0]
  const args = parts.slice(1)

  const proc = spawn(cmd, args, {
    cwd: cwd || process.cwd(),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let outputBuffer = ''
  proc.stdout.on('data', chunk => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    outputBuffer += text
    if (outputBuffer.length > MAX_OUTPUT_SIZE) {
      outputBuffer = outputBuffer.slice(-MAX_OUTPUT_SIZE)
    }
  })
  proc.stderr.on('data', chunk => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    outputBuffer += text
    if (outputBuffer.length > MAX_OUTPUT_SIZE) {
      outputBuffer = outputBuffer.slice(-MAX_OUTPUT_SIZE)
    }
  })

  let exitCode = null
  let exitSignal = null
  proc.on('exit', (code, signal) => {
    exitCode = code
    exitSignal = signal
    const data2 = loadData()
    const taskData = data2.tasks.find(t => t.id === taskId)
    if (taskData) {
      taskData.status = code === 0 ? 'completed' : 'failed'
      taskData.exitCode = code
      taskData.exitSignal = signal ? signal.toString() : null
      taskData.completedAt = new Date().toISOString()
      taskData.output = outputBuffer
      delete data2.runningPids[taskId]
      saveData(data2)
    }
    delete runningProcesses[taskId]
  })

  proc.on('error', err => {
    const data2 = loadData()
    const taskData = data2.tasks.find(t => t.id === taskId)
    if (taskData) {
      taskData.status = 'failed'
      taskData.error = err.message
      taskData.completedAt = new Date().toISOString()
      taskData.output = outputBuffer
      delete data2.runningPids[taskId]
      saveData(data2)
    }
    delete runningProcesses[taskId]
  })

  runningProcesses[taskId] = proc

  const taskEntry = {
    id: taskId,
    name,
    command,
    cwd: cwd || process.cwd(),
    status: 'running',
    pid: proc.pid,
    createdAt: new Date().toISOString(),
    output: '',
  }

  data.tasks.push(taskEntry)
  data.runningPids[taskId] = proc.pid
  saveData(data)

  return { ok: true, taskId, name, pid: proc.pid, status: 'running' }
}

function taskList() {
  const data = loadData()
  const tasks = data.tasks.map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    command: t.command,
    pid: t.pid,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    exitCode: t.exitCode,
  }))
  return { ok: true, tasks }
}

function taskStatus({ id }) {
  if (!id) return { error: 'Missing "id"' }
  const data = loadData()
  const task = data.tasks.find(t => t.id === id)
  if (!task) return { error: `Task not found: ${id}` }
  return {
    ok: true,
    task: {
      id: task.id,
      name: task.name,
      status: task.status,
      command: task.command,
      pid: task.pid,
      exitCode: task.exitCode,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    },
  }
}

function taskStop({ id }) {
  if (!id) return { error: 'Missing "id"' }

  const data = loadData()
  const task = data.tasks.find(t => t.id === id)
  if (!task) return { error: `Task not found: ${id}` }
  if (task.status !== 'running') return { error: `Task ${id} is not running (status: ${task.status})` }

  // Try in-memory process first
  const proc = runningProcesses[id]
  if (proc) {
    proc.kill('SIGTERM')
    setTimeout(() => {
      try { if (runningProcesses[id]) proc.kill('SIGKILL') } catch {}
    }, 3000)
  } else {
    // Try killing by PID (works cross-process on same machine)
    try {
      process.kill(task.pid, 'SIGTERM')
    } catch (e) {
      // Process may have already exited
    }
  }

  task.status = 'stopped'
  task.completedAt = new Date().toISOString()
  saveData(data)

  return { ok: true, taskId: id, message: `Stopped task ${id}` }
}

function taskOutput({ id }) {
  if (!id) return { error: 'Missing "id"' }
  const data = loadData()
  const task = data.tasks.find(t => t.id === id)
  if (!task) return { error: `Task not found: ${id}` }

  // For running tasks, try to get live output from buffer
  let output = task.output || ''
  const proc = runningProcesses[id]
  if (proc && proc.status === 'running') {
    // Live output is being captured; return what we have so far
  }

  return {
    ok: true,
    taskId: id,
    status: task.status,
    output: output.slice(0, MAX_OUTPUT_SIZE),
    truncated: output.length > MAX_OUTPUT_SIZE,
  }
}

function taskCleanup() {
  const data = loadData()
  const before = data.tasks.length
  const terminalStatuses = ['completed', 'failed', 'stopped']
  data.tasks = data.tasks.filter(t => !terminalStatuses.includes(t.status))
  const removed = before - data.tasks.length

  // Also clean up stale pids
  for (const [tid, pid] of Object.entries(data.runningPids)) {
    if (!runningProcesses[tid]) {
      delete data.runningPids[tid]
    }
  }

  saveData(data)
  return { ok: true, removed }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCommand(cmd) {
  // Simple shell-like split that handles quoted strings
  const parts = []
  let current = ''
  let inQuote = null
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ' ') {
      if (current) { parts.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}

// ── Main Dispatcher ──────────────────────────────────────────────────────────

function dispatch(input) {
  const { action } = input

  if (!action || typeof action !== 'string') {
    return { error: 'Missing "action" field' }
  }

  switch (action) {
    // Todo operations
    case 'todo:add':     return todoAdd(input)
    case 'todo:list':    return todoList()
    case 'todo:update':  return todoUpdate(input)
    case 'todo:remove':  return todoRemove(input)
    case 'todo:clear':   return todoClear(input)
    case 'todo:summary': return todoSummary()

    // Task operations
    case 'task:start':   return taskStart(input)
    case 'task:list':    return taskList()
    case 'task:status':  return taskStatus(input)
    case 'task:stop':    return taskStop(input)
    case 'task:output':  return taskOutput(input)
    case 'task:cleanup': return taskCleanup()

    default:
      return { error: `Unknown action: "${action}". Valid: todo:add, todo:list, todo:update, todo:remove, todo:clear, todo:summary, task:start, task:list, task:status, task:stop, task:output, task:cleanup` }
  }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

function main() {
  let input

  // Read from stdin (pipe mode)
  const stdin = fs.readFileSync(0, 'utf-8').trim()
  if (stdin) {
    try {
      input = JSON.parse(stdin)
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: `Invalid JSON: ${e.message}` }) + '\n')
      process.exit(1)
    }
  } else {
    // Try argv
    const argv = process.argv.slice(2)
    if (argv.length > 0) {
      try {
        input = JSON.parse(argv.join(' '))
      } catch (e) {
        process.stdout.write(JSON.stringify({ error: `Invalid JSON from argv: ${e.message}` }) + '\n')
        process.exit(1)
      }
    } else {
      process.stdout.write(JSON.stringify({
        error: 'Usage: pipe JSON to stdin or pass as argv',
        usage: {
          todo: 'echo \'{"action":"todo:add","content":"..."}\' | node tool.js',
          task: 'echo \'{"action":"task:start","name":"...","command":"..."}\' | node tool.js',
        },
      }) + '\n')
      process.exit(0)
    }
  }

  const result = dispatch(input)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  // If there are running processes, keep the process alive briefly
  // but we don't hang — the spawned children send output to their own buffers
  // and the main process can exit. Completed callbacks will update the JSON.
  if (Object.keys(runningProcesses).length > 0) {
    // Don't exit immediately — let child process callbacks run
    setTimeout(() => {
      // Process cleanup already handles the save
    }, 100)
  }
}

main()
