'use strict'

/**
 * dsh-crossos — 设置页用的 HTTP API
 *
 * 浏览器半侧（client/bundle.js）只通过这里读写配置，不直接碰文件系统：
 *
 *   GET  /dsh-crossos/api/config   → 当前 crossos.json、生效配置、待迁移会话
 *   PUT  /dsh-crossos/api/config   → 校验后原子写 crossos.json
 *
 * 与 DSH 其它 host 路由一样，先过 connection.requestRejection 的 Host/Origin
 * 信任栅栏，避免本机任意网页跨站改写配置。
 */

const fs = require('node:fs')
const path = require('node:path')

const engine = require('./engine.cjs')
const { copyFromSources } = require('./import.cjs')
const {
  DEFAULTS,
  BOOLEAN_KEYS,
  readFileConfig,
  sanitizeConfig,
  writeFileConfig,
  normalizeMaps,
  normalizeSources,
  loadConfig,
} = require('./config.cjs')

const API_PREFIX = '/dsh-crossos/api'
const MAX_BODY = 1024 * 1024

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** 读最近一次运行报告（不存在/损坏时返回 undefined） */
function readLastRun(home) {
  try {
    const text = fs.readFileSync(path.join(home, 'crossos', 'last-run.json'), 'utf8')
    const data = JSON.parse(text)
    return data && typeof data === 'object' ? data : undefined
  } catch {
    return undefined
  }
}

/** 只读扫描：按生效配置算出"启动时会迁移哪些会话" */
function scanPending(home, config, maps) {
  try {
    const plan = engine.buildPlan({
      home,
      maps,
      adopt: config.adoptWorkspace !== false,
      requireTargetExists: config.requireTargetExists !== false,
      skipCollisions: config.skipCollision !== false,
      skipLive: true,
      onlyExistingWorkspacePaths: true,
    })
    return {
      scanned: plan.sessions.length,
      count: plan.moves.length,
      moves: plan.moves.map((m) => ({ id: m.session.id, from: m.session.cwd, to: m.targetCwd })),
    }
  } catch (error) {
    return { error: String((error && error.message) || error) }
  }
}

/** 只读扫描：按生效配置算出"启动时会从源目录复制哪些会话" */
function scanCopies(home, config, maps) {
  const sources = normalizeSources(config.sources)
  if (!sources.length) return { sources: [], count: 0, items: [], skipped: 0, warnings: [] }
  try {
    const result = copyFromSources({ home, sources, maps, config, dryRun: true })
    return {
      sources,
      count: result.copied.length,
      items: result.copied.slice(0, 20).map((c) => ({ id: c.session.id, from: c.session.cwd, to: c.targetCwd })),
      skipped: result.skipped.length,
      warnings: result.warnings,
    }
  } catch (error) {
    return { sources, error: String((error && error.message) || error), count: 0, items: [], skipped: 0, warnings: [] }
  }
}

/** crossos.json 里存的（规范化后的）配置，用于表单回显 */
function fileView(home) {
  const file = readFileConfig(home)
  let maps = []
  const notes = file.error ? [file.error] : []
  try {
    maps = normalizeMaps(file.data.maps)
  } catch (error) {
    notes.push(error.message)
  }
  const view = { maps, sources: normalizeSources(file.data.sources) }
  for (const key of BOOLEAN_KEYS) {
    if (typeof file.data[key] === 'boolean') view[key] = file.data[key]
  }
  if (typeof file.data.home === 'string') view.home = file.data.home
  return { file, view, notes }
}

/** 设置页打开时读的状态：文件内容 + 生效值 + 待迁移摘要 */
function describe(home, cordisConfig) {
  const { file, view, notes } = fileView(home)
  const loaded = loadConfig(cordisConfig)
  const effective = {
    home: loaded.home,
    maps: loaded.mapsDeclared,
    sources: normalizeSources(loaded.config.sources),
    auto: loaded.config.auto !== false,
    dryRun: loaded.config.dryRun === true,
    adoptWorkspace: loaded.config.adoptWorkspace !== false,
    requireTargetExists: loaded.config.requireTargetExists !== false,
    skipCollision: loaded.config.skipCollision !== false,
    skipLive: loaded.config.skipLive !== false,
    keepOld: loaded.config.keepOld === true,
  }
  const pending = scanPending(loaded.home, loaded.config, loaded.maps)
  const copies = scanCopies(loaded.home, loaded.config, loaded.maps)
  return {
    ok: true,
    home: loaded.home,
    file: file.file,
    exists: file.exists,
    fileConfig: view,
    effective,
    pending,
    copies,
    lastRun: readLastRun(loaded.home),
    notes: [...notes, ...loaded.notes.filter((n) => !notes.includes(n))],
    defaults: { ...DEFAULTS },
  }
}

/**
 * 生成 prefix 路由处理器。
 * @param {{ connection?: { requestRejection?: Function } }} ctx
 * @param {object} cordisConfig 插件在 cordis.patch.yml 里的 config（只读）
 */
function createHandler(ctx, cordisConfig) {
  return async function handler(req, res) {
    let rejection
    try {
      rejection = ctx && ctx.connection && typeof ctx.connection.requestRejection === 'function'
        ? ctx.connection.requestRejection(req)
        : undefined
    } catch {
      rejection = undefined
    }
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end()
      return
    }

    let url
    try {
      url = new URL(req.url || '/', 'http://dsh.local')
    } catch {
      sendJson(res, 400, { ok: false, error: '无法解析请求 URL' })
      return
    }
    const apiPath = url.pathname.replace(/\/+$/, '')
    if (!apiPath.endsWith(`${API_PREFIX}/config`)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }

    const home = loadConfig(cordisConfig).home

    if (req.method === 'GET') {
      sendJson(res, 200, describe(home, cordisConfig))
      return
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error.message || error) })
        return
      }
      const patchInput = body && typeof body === 'object' && body.config && typeof body.config === 'object'
        ? body.config
        : body
      const { value, errors } = sanitizeConfig(patchInput)
      if (errors.length) {
        sendJson(res, 400, { ok: false, errors })
        return
      }
      try {
        writeFileConfig(home, value)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `写入 crossos.json 失败：${error.message}` })
        return
      }
      sendJson(res, 200, describe(home, cordisConfig))
      return
    }

    sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }
}

module.exports = { API_PREFIX, createHandler, describe, scanPending, scanCopies, readLastRun, readBody }
