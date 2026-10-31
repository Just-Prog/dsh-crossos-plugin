'use strict'

/**
 * dsh-crossos — 从其它系统复制会话
 *
 * 单机双系统下，两个系统通常各自有自己的 `$DSH_HOME`。与其手工把
 * `sessions/` 拷来拷去，不如让插件在启动时自己读另一侧：
 *
 *   sources: ["/mnt/windows/Users/you/.dsh"]   # 或直接给 sessions 目录
 *
 * 复制规则（只读源，不修改源）：
 *   - 源里本机已有同 id 的会话 → 跳过；
 *   - 源会话的 cwd 必须命中一条映射，且映射结果在本机真实存在
 *     （与迁移共用 requireTargetExists 语义，避免复制成幽灵会话）；
 *   - 复制时保持源 cwd 的 projectKey 与文件名，随后交给 rebase
 *     统一改写 header、挪到本机路径并归组；
 *   - 日志先用临时文件写完再 rename，源里的 *.lock 不复制；
 *   - 复制后立刻回读 header 校验 id，失败则删除该文件。
 *
 * 复制与迁移是两段：本模块只负责"把会话搬进本机 $DSH_HOME"，
 * 路径改写仍由 engine 的 buildPlan/applyPlan 完成。
 */

const fs = require('node:fs')
const path = require('node:path')

const engine = require('./engine.cjs')

/**
 * 把配置里的 source 解析成"本机可访问的 DSH_HOME"。
 * 允许直接写 sessions 目录（例如 /mnt/windows/Users/you/.dsh/sessions）。
 */
function sourceHome(source) {
  const resolved = path.resolve(engine.expand(String(source)))
  if (fs.existsSync(path.join(resolved, 'sessions'))) return resolved
  if (path.basename(resolved) === 'sessions' && fs.existsSync(resolved)) return path.dirname(resolved)
  return resolved
}

/** 复制源目录里本机尚未拥有的会话；返回结构化结果（dryRun 时不落盘） */
function copyFromSources({ home, sources, maps, config = {}, log, dryRun = false }) {
  const emit = log || { info() {}, warn() {} }
  const warnings = []
  const copied = []
  const skipped = []
  const requireTarget = config.requireTargetExists !== false
  const skipLive = config.skipLive !== false
  const local = new Map(engine.scanSessions(home, []).map((s) => [s.id, s]))
  const seen = new Set()

  for (const raw of sources || []) {
    const srcHome = sourceHome(raw)
    if (path.resolve(srcHome) === path.resolve(home)) {
      warnings.push(`源目录就是本机 DSH_HOME，已忽略：${srcHome}`)
      continue
    }
    if (!fs.existsSync(srcHome)) {
      warnings.push(`源目录不存在：${srcHome}`)
      continue
    }
    const list = engine.scanSessions(srcHome, warnings)
    for (const session of list) {
      if (seen.has(session.id) || local.has(session.id)) {
        skipped.push({ id: session.id, source: srcHome, reason: '本机已有同 id 会话' })
        continue
      }
      seen.add(session.id)
      if (!session.cwd) {
        skipped.push({ id: session.id, source: srcHome, reason: '源会话没有 cwd' })
        continue
      }
      if (skipLive && session.livePids.length > 0) {
        skipped.push({ id: session.id, source: srcHome, reason: '源日志正被进程打开' })
        continue
      }
      const targetCwd = engine.mapPath(session.cwd, maps)
      if (!targetCwd) {
        skipped.push({ id: session.id, source: srcHome, reason: '源 cwd 未命中任何映射' })
        continue
      }
      if (requireTarget && !fs.existsSync(targetCwd)) {
        skipped.push({ id: session.id, source: srcHome, reason: `映射目标在本机不存在：${targetCwd}` })
        continue
      }
      const destDir = path.join(engine.sessionsRoot(home), engine.projectKey(session.cwd), engine.encodeSegment(session.id))
      const destFile = path.join(destDir, session.logName)
      if (fs.existsSync(destFile)) {
        skipped.push({ id: session.id, source: srcHome, reason: '目标文件已存在' })
        continue
      }
      copied.push({ source: srcHome, session, destDir, destFile, targetCwd, copied: false, error: undefined })
    }
  }

  const result = { home, sources: [...(sources || [])], copied, skipped, warnings, dryRun: dryRun === true }
  if (dryRun) {
    for (const item of copied) emit.info(`[dry-run] 复制 ${item.session.id}  ${item.session.cwd}  →  ${item.targetCwd}`)
    return result
  }

  for (const item of copied) {
    try {
      fs.mkdirSync(item.destDir, { recursive: true })
      const tmp = `${item.destFile}.tmp-${process.pid}`
      fs.copyFileSync(item.session.file, tmp)
      for (const name of fs.readdirSync(item.session.dir)) {
        if (name === path.basename(item.session.file)) continue
        if (name.endsWith('.lock')) continue
        const from = path.join(item.session.dir, name)
        if (!fs.statSync(from).isFile()) continue
        fs.copyFileSync(from, path.join(item.destDir, name))
      }
      fs.renameSync(tmp, item.destFile)
      const header = engine.readHeader(item.destFile)
      if (!header || header.id !== item.session.id) throw new Error('复制后 header 校验失败')
      item.copied = true
      emit.info(`已复制 ${item.session.id}  ${item.session.cwd}  →  ${item.targetCwd}`)
    } catch (error) {
      item.error = String((error && error.message) || error)
      warnings.push(`复制失败 ${item.session.id}：${item.error}`)
      try {
        fs.rmSync(item.destFile, { force: true })
      } catch {}
    }
  }
  return result
}

module.exports = { copyFromSources, sourceHome }
