'use strict'

/**
 * dsh-crossos — 配置解析
 *
 * 配置可以来自两处（后者覆盖前者）：
 *   1. $DSH_HOME/crossos.json      —— 不改插件文件即可调参
 *   2. cordis.patch.yml 的 config  —— 安装插件时写进 profile 组合
 *
 * 路径映射既支持字符串 "FROM=TO"，也支持对象 { from, to } / { windows, linux }。
 * 插件内部会把每条映射展开成双向，因此同一份配置在双系统的任意一侧都可用：
 * 只有"映射后的目标路径在本机真实存在"的会话才会被迁移。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULTS = {
  /** 映射表；空数组表示不启用自动迁移 */
  maps: [],
  /** 启动时自动迁移（false 则只能用 bin 手动跑） */
  auto: true,
  /** true 时只打印计划，不落盘 */
  dryRun: false,
  /** 迁移后把会话 id 写进对应工作区记录（磁盘层面归组） */
  adoptWorkspace: true,
  /** 目标路径不存在就跳过（避免把会话迁到本机不存在的路径） */
  requireTargetExists: true,
  /** 目标目录已被别的会话占用就跳过，而不是报错回滚 */
  skipCollision: true,
  /** 日志正被进程打开的会话跳过 */
  skipLive: true,
  /** 旧目录改名为 <name>.migrated 保留，而不是移入备份目录 */
  keepOld: false,
  /** 覆盖 $DSH_HOME */
  home: '',
}

/** 展开 ~ 与 ${VAR}（仅用于配置里的路径，不做 shell 求值） */
function expand(p) {
  if (typeof p !== 'string') return p
  let s = p.trim()
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2))
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => process.env[name] ?? all)
  return s
}

/** 解析 DSH_HOME：config.home > $DSH_HOME > ~/.dsh */
function resolveHome(config) {
  if (config && typeof config.home === 'string' && config.home.trim()) return path.resolve(expand(config.home))
  const env = process.env.DSH_HOME
  if (env && env.trim()) return path.resolve(expand(env))
  return path.join(os.homedir(), '.dsh')
}

/** 读取 <home>/crossos.json；不存在或损坏时返回空对象 */
function readFileConfig(home) {
  const file = path.join(home, 'crossos.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, exists: false, data: {} }
  }
  try {
    const data = JSON.parse(text)
    return { file, exists: true, data: data && typeof data === 'object' ? data : {} }
  } catch (error) {
    return { file, exists: true, data: {}, error: `crossos.json 解析失败：${error.message}` }
  }
}

/** 把一条映射规范成 { from, to } */
function normalizeOne(item, index) {
  if (typeof item === 'string') {
    const at = item.indexOf('=')
    if (at <= 0) throw new Error(`maps[${index}] 需要 "FROM=TO" 形式：${item}`)
    return { from: item.slice(0, at).trim(), to: item.slice(at + 1).trim() }
  }
  if (item && typeof item === 'object') {
    const from = item.from ?? item.windows ?? item.win ?? item.path
    const to = item.to ?? item.linux ?? item.posix ?? item.local
    if (typeof from === 'string' && typeof to === 'string') return { from: from.trim(), to: to.trim() }
  }
  throw new Error(`maps[${index}] 无法识别，应为 "FROM=TO" 或 { from, to } / { windows, linux }`)
}

/** 规范化映射表，去掉空项与自映射 */
function normalizeMaps(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('maps 必须是数组')
  const out = []
  raw.forEach((item, index) => {
    const m = normalizeOne(item, index)
    if (!m.from || !m.to) throw new Error(`maps[${index}] 的 from/to 不能为空`)
    if (m.from === m.to) return
    out.push(m)
  })
  return out
}

/** 展开成双向映射（A→B 与 B→A），最长前缀匹配保证不会互相干扰 */
function bidirectional(maps) {
  const out = []
  for (const m of maps) {
    out.push({ from: m.from, to: m.to })
    out.push({ from: m.to, to: m.from })
  }
  return out
}

/**
 * 合并默认值、crossos.json、cordis 配置。
 * @returns {{ config: object, home: string, maps: Array<{from:string,to:string}>, notes: string[] }}
 */
function loadConfig(configFromCordis) {
  const cordis = configFromCordis && typeof configFromCordis === 'object' ? { ...configFromCordis } : {}
  // 插件 bundle patch 里的默认 config 会带 "maps: []"；空数组表示"未配置"，
  // 不能让它盖掉 crossos.json 里的映射表。
  if (Array.isArray(cordis.maps) && cordis.maps.length === 0) delete cordis.maps
  for (const key of Object.keys(cordis)) if (cordis[key] === undefined) delete cordis[key]
  const home = resolveHome({ ...DEFAULTS, ...cordis })
  const file = readFileConfig(home)
  const notes = []
  if (file.error) notes.push(file.error)
  if (!file.exists) notes.push(`未找到 ${file.file}（可选；也可以直接在 cordis.patch.yml 里配 config.maps）`)

  const config = { ...DEFAULTS, ...file.data, ...cordis }
  let maps
  try {
    maps = normalizeMaps(config.maps)
  } catch (error) {
    notes.push(error.message)
    maps = []
  }
  if (!maps.length) notes.push('maps 为空：不会迁移任何会话。配置示例见 README.md')
  return { config, home, maps: bidirectional(maps), mapsDeclared: maps, notes, homeConfigFile: file.file }
}

/** 可写字段（crossos.json 里由设置页维护的键） */
const WRITABLE = ['maps', 'auto', 'dryRun', 'adoptWorkspace', 'requireTargetExists', 'skipCollision', 'skipLive', 'keepOld', 'home']

const BOOLEAN_KEYS = ['auto', 'dryRun', 'adoptWorkspace', 'requireTargetExists', 'skipCollision', 'skipLive', 'keepOld']

/**
 * 校验并规范设置页提交的配置片段：只接受已知键，布尔字段必须是布尔，
 * maps 必须是能被 normalizeMaps 接受的数组。未知键原样忽略。
 * @returns {{ value: object, errors: string[] }}
 */
function sanitizeConfig(input) {
  const errors = []
  const value = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value, errors: ['配置必须是对象'] }
  }
  for (const key of WRITABLE) {
    if (!(key in input)) continue
    const raw = input[key]
    if (key === 'maps') {
      try {
        value.maps = normalizeMaps(raw)
      } catch (error) {
        errors.push(error.message)
      }
      continue
    }
    if (key === 'home') {
      if (typeof raw === 'string') value.home = raw.trim()
      else errors.push('home 必须是字符串')
      continue
    }
    if (BOOLEAN_KEYS.includes(key)) {
      if (typeof raw !== 'boolean') {
        errors.push(`${key} 必须是布尔值`)
        continue
      }
      value[key] = raw
    }
  }
  return { value, errors }
}

/**
 * 原子写 crossos.json：保留文件里已有的未知键，只覆盖本次提交的已知键。
 * 同目录写临时文件再 rename，权限 0600。
 */
function writeFileConfig(home, patch) {
  const dir = home
  const file = path.join(dir, 'crossos.json')
  fs.mkdirSync(dir, { recursive: true })
  const current = readFileConfig(home)
  const next = { ...(current.data && typeof current.data === 'object' ? current.data : {}), ...patch }
  const text = JSON.stringify(next, null, 2) + '\n'
  const tmp = path.join(dir, `.crossos.json.tmp-${process.pid}`)
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  return file
}

module.exports = {
  DEFAULTS,
  WRITABLE,
  BOOLEAN_KEYS,
  expand,
  resolveHome,
  readFileConfig,
  normalizeMaps,
  sanitizeConfig,
  writeFileConfig,
  bidirectional,
  loadConfig,
}
