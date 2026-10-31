/* dsh-crossos — 浏览器半侧（手写，无构建步骤）。
 * 注册到 DSH 设置页：设置 → dsh-crossos，用于编辑 $DSH_HOME/crossos.json：
 *   - 路径映射表（双系统下同一项目两侧的绝对路径）
 *   - 「启动时自动导入」开关（对应 crossos.json 的 auto）
 * 配置通过 host 的 /dsh-crossos/api/config 读写，client 不直接碰文件系统。
 */
window.__ModuleLoader__.load({
  id: 'dsh-crossos',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var React
    try { React = require('react') } catch { React = null }
    if (!React || typeof React.createElement !== 'function') {
      React = {
        createElement(type, props) {
          return { type: type, props: props || {} }
        },
        useState(init) { var v = typeof init === 'function' ? init() : init; return [v, function () {}] },
        useEffect() {},
        useMemo(fn) { return fn() },
        useCallback(fn) { return fn },
      }
    }
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const NS = 'dshCrossos'

    const ZH = {
      title: 'dsh-crossos',
      subtitle: '单机双系统会话同步：把另一套系统里创建的会话，按路径映射改成当前系统的项目路径。',
      mapsTitle: '路径映射',
      mapsHint: '同一项目在两个系统里的绝对路径。例如 Windows 侧 {win}，Linux 侧 {linux}。只需要填一条，插件会自动按双向匹配。',
      addMap: '添加映射',
      remove: '删除',
      fromLabel: '系统 A 的路径',
      toLabel: '系统 B 的路径',
      autoTitle: '启动时自动导入',
      autoHint: '打开后，每次启动 DSH 都会自动把可映射的会话迁移到当前系统（有备份，失败整体回滚）。关闭则只保留手动执行。',
      dryRunTitle: '试运行',
      dryRunHint: '只打印计划，不真正改动文件。首次配置时可先打开确认。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，重启 DSH 后生效',
      reload: '刷新',
      configFile: '配置文件',
      pending: '待迁移会话',
      pendingNone: '没有需要迁移的会话',
      pendingSome: '当前映射下可迁移 {n} 个会话',
      lastRun: '上次运行',
      lastRunNever: '还没有运行记录',
      lastRunOk: '迁移 {n} 个',
      error: '操作失败',
      loadError: '读取配置失败',
      emptyMaps: '还没有映射。填一条「系统 A 的路径」与「系统 B 的路径」即可。',
      pathPlaceholder: '如 D:\\Projects\\demo 或 /home/me/demo',
      homeLabel: 'DSH_HOME',
      sourcesTitle: '源目录（可选）',
      sourcesHint: '其它系统写下的 DSH_HOME 或 sessions 目录，一行一个。启动时先把本机还没有的会话复制过来，再按上面的映射迁移。写本机可访问的挂载路径即可，源目录只读。',
      sourcesPlaceholder: '如 /mnt/windows/Users/you/.dsh',
      copiesTitle: '待复制会话',
      copiesNone: '没有需要复制的会话',
      copiesSome: '将从源目录复制 {n} 个会话',
    }

    const EN = {
      title: 'dsh-crossos',
      subtitle: 'Sync sessions across two OSes on one machine by rewriting project paths.',
      mapsTitle: 'Path mappings',
      mapsHint: 'Absolute paths of the same project on both systems. One entry is enough; matching is bidirectional.',
      addMap: 'Add mapping',
      remove: 'Remove',
      fromLabel: 'Path on system A',
      toLabel: 'Path on system B',
      autoTitle: 'Import on startup',
      autoHint: 'When enabled, DSH migrates mappable sessions at every startup (backed up, rolled back on failure).',
      dryRunTitle: 'Dry run',
      dryRunHint: 'Only print the plan without touching any file.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. Restart DSH to apply.',
      reload: 'Refresh',
      configFile: 'Config file',
      pending: 'Sessions to migrate',
      pendingNone: 'Nothing to migrate',
      pendingSome: '{n} session(s) can be migrated with the current mappings',
      lastRun: 'Last run',
      lastRunNever: 'No run recorded yet',
      lastRunOk: 'Migrated {n}',
      error: 'Request failed',
      loadError: 'Failed to load config',
      emptyMaps: 'No mapping yet. Fill in one path per system.',
      pathPlaceholder: 'e.g. D:\\Projects\\demo or /home/me/demo',
      homeLabel: 'DSH_HOME',
      sourcesTitle: 'Source directories (optional)',
      sourcesHint: 'DSH_HOME or sessions directories written by the other system, one per line. Missing sessions are copied here first, then rebased with the mappings above. Point at a mount path this system can read; sources are never modified.',
      sourcesPlaceholder: 'e.g. /mnt/windows/Users/you/.dsh',
      copiesTitle: 'Sessions to copy',
      copiesNone: 'Nothing to copy',
      copiesSome: '{n} session(s) will be copied from the sources',
    }

    var API = '/dsh-crossos/api'
    try {
      var base = (typeof document !== 'undefined' && document.baseURI) || (typeof location !== 'undefined' ? location.href : '/')
      API = new URL('dsh-crossos/api', new URL('.', base)).pathname.replace(/\/+$/, '')
    } catch {}

    var STYLE = [
      '.dshcx { display: flex; flex-direction: column; gap: 16px; font-family: var(--dsw-font-family); }',
      '.dshcx-sub { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-sm-14); margin: 0; }',
      '.dshcx-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; background: var(--dsw-alias-bg-layer-1); }',
      '.dshcx-card-title { font-size: var(--dsw-font-sm-14); font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dshcx-hint { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xs-13); margin: 0; line-height: 1.6; }',
      '.dshcx-map { display: flex; gap: 8px; align-items: center; }',
      '.dshcx-map input { flex: 1 1 0; min-width: 0; }',
      '.dshcx input[type="text"] { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; color: var(--dsw-alias-label-primary); font-size: var(--dsw-font-sm-14); outline: none; }',
      '.dshcx input[type="text"]:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.dshcx textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 66px; font-family: var(--dsw-font-family); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; color: var(--dsw-alias-label-primary); font-size: var(--dsw-font-sm-14); outline: none; }',
      '.dshcx textarea:focus { border-color: var(--dsw-alias-brand-primary); }',
      '.dshcx button { cursor: pointer; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); padding: 6px 12px; font-size: var(--dsw-font-xs-13); }',
      '.dshcx button:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dshcx button.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); }',
      '.dshcx button:disabled { opacity: .55; cursor: default; }',
      '.dshcx button.ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-tertiary); }',
      '.dshcx-switch { display: flex; gap: 10px; align-items: flex-start; }',
      '.dshcx-switch input { margin-top: 3px; }',
      '.dshcx-switch-text { display: flex; flex-direction: column; gap: 4px; }',
      '.dshcx-actions { display: flex; gap: 8px; align-items: center; }',
      '.dshcx-note { font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-state-success-primary); }',
      '.dshcx-error { font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-state-error-primary); }',
      '.dshcx-meta { display: flex; flex-direction: column; gap: 6px; font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); }',
      '.dshcx-meta code { color: var(--dsw-alias-label-primary); word-break: break-all; }',
    ].join('\n')

    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || document.getElementById('dshcx-styles')) return
        var el = document.createElement('style')
        el.id = 'dshcx-styles'
        el.textContent = STYLE
        document.head.appendChild(el)
      } catch {}
    }

    function request(path, options) {
      return fetch(API + path, Object.assign({ headers: { accept: 'application/json' } }, options || {}))
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok || !body || body.ok === false) {
              var detail = body && (body.error || (body.errors && body.errors.join('；')))
              throw new Error(detail || ('HTTP ' + res.status))
            }
            return body
          })
        })
    }

    function loadState() {
      return request('/config')
    }

    function saveState(patch) {
      return request('/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ config: patch }),
      })
    }

    function ConfigSection(props) {
      var t = props.t || function (k) { return k }
      useEffect(function () { ensureStyles() }, [])

      var _s = useState({ loading: true, error: '', data: null })
      var state = _s[0]
      var setState = _s[1]

      var _d = useState({ maps: [], sources: [], auto: true, dryRun: false })
      var draft = _d[0]
      var setDraft = _d[1]

      var _m = useState('')
      var message = _m[0]
      var setMessage = _m[1]

      var _e = useState('')
      var error = _e[0]
      var setError = _e[1]

      var _p = useState(false)
      var saving = _p[0]
      var setSaving = _p[1]

      var applyState = useCallback(function (data) {
        setState({ loading: false, error: '', data: data })
        var fileCfg = data.fileConfig || {}
        setDraft({
          maps: Array.isArray(fileCfg.maps) ? fileCfg.maps.map(function (m) { return { from: m.from || '', to: m.to || '' } }) : [],
          sources: Array.isArray(fileCfg.sources) ? fileCfg.sources.slice() : [],
          auto: fileCfg.auto !== false,
          dryRun: fileCfg.dryRun === true,
        })
      }, [])

      var refresh = useCallback(function () {
        setMessage('')
        setError('')
        return loadState().then(applyState).catch(function (e) {
          setState({ loading: false, error: String(e.message || e), data: null })
        })
      }, [applyState])

      useEffect(function () { refresh() }, [refresh])

      function updateMap(index, key, value) {
        setDraft(function (prev) {
          var maps = prev.maps.slice()
          maps[index] = Object.assign({}, maps[index], { [key]: value })
          return Object.assign({}, prev, { maps: maps })
        })
      }
      function addMap() {
        setDraft(function (prev) { return Object.assign({}, prev, { maps: prev.maps.concat([{ from: '', to: '' }]) }) })
      }
      function removeMap(index) {
        setDraft(function (prev) {
          var maps = prev.maps.slice()
          maps.splice(index, 1)
          return Object.assign({}, prev, { maps: maps })
        })
      }
      function save() {
        setSaving(true)
        setMessage('')
        setError('')
        var clean = draft.maps
          .map(function (m) { return { from: String(m.from || '').trim(), to: String(m.to || '').trim() } })
          .filter(function (m) { return m.from && m.to })
        var sources = (draft.sources || [])
          .map(function (s) { return String(s || '').trim() })
          .filter(function (s) { return s.length > 0 })
        saveState({ maps: clean, sources: sources, auto: draft.auto, dryRun: draft.dryRun })
          .then(function (data) {
            applyState(data)
            setMessage(t('saved'))
          })
          .catch(function (e) { setError(String(e.message || e)) })
          .then(function () { setSaving(false) })
      }

      if (state.loading) return h('div', { className: 'dshcx' }, h('p', { className: 'dshcx-hint' }, '…'))
      if (state.error) {
        return h('div', { className: 'dshcx' },
          h('p', { className: 'dshcx-error' }, t('loadError') + '：' + state.error),
          h('div', { className: 'dshcx-actions' }, h('button', { onClick: refresh }, t('reload'))))
      }

      var data = state.data
      var pending = (data && data.pending) || {}
      var lastRun = data && data.lastRun

      return h('div', { className: 'dshcx' },
        h('h2', { style: { margin: 0, fontSize: '18px', color: 'var(--dsw-alias-label-primary)' } }, t('title')),
        h('p', { className: 'dshcx-sub' }, t('subtitle')),

        h('div', { className: 'dshcx-card' },
          h('div', { className: 'dshcx-card-title' }, t('mapsTitle')),
          h('p', { className: 'dshcx-hint' }, t('mapsHint')),
          draft.maps.length === 0
            ? h('p', { className: 'dshcx-hint' }, t('emptyMaps'))
            : draft.maps.map(function (m, i) {
              return h('div', { className: 'dshcx-map', key: i },
                h('input', {
                  type: 'text',
                  value: m.from,
                  placeholder: t('pathPlaceholder'),
                  'aria-label': t('fromLabel'),
                  onChange: function (e) { updateMap(i, 'from', e.target.value) },
                }),
                h('input', {
                  type: 'text',
                  value: m.to,
                  placeholder: t('pathPlaceholder'),
                  'aria-label': t('toLabel'),
                  onChange: function (e) { updateMap(i, 'to', e.target.value) },
                }),
                h('button', { className: 'ghost', onClick: function () { removeMap(i) } }, t('remove')))
            }),
          h('div', { className: 'dshcx-actions' },
            h('button', { onClick: addMap }, t('addMap')),
            h('button', { className: 'primary', onClick: save, disabled: saving }, saving ? t('saving') : t('save')),
            h('button', { className: 'ghost', onClick: refresh }, t('reload'))),
          message ? h('div', { className: 'dshcx-note' }, message) : null,
          error ? h('div', { className: 'dshcx-error' }, t('error') + '：' + error) : null),

        h('div', { className: 'dshcx-card' },
          h('div', { className: 'dshcx-card-title' }, t('sourcesTitle')),
          h('p', { className: 'dshcx-hint' }, t('sourcesHint')),
          h('textarea', {
            rows: 3,
            value: (draft.sources || []).join('\n'),
            placeholder: t('sourcesPlaceholder'),
            'aria-label': t('sourcesTitle'),
            onChange: function (e) { setDraft(Object.assign({}, draft, { sources: e.target.value.split('\n') })) },
          })),

        h('div', { className: 'dshcx-card' },
          h('label', { className: 'dshcx-switch' },
            h('input', { type: 'checkbox', checked: draft.auto, onChange: function (e) { setDraft(Object.assign({}, draft, { auto: e.target.checked })) } }),
            h('span', { className: 'dshcx-switch-text' },
              h('span', { className: 'dshcx-card-title' }, t('autoTitle')),
              h('span', { className: 'dshcx-hint' }, t('autoHint')))),
          h('label', { className: 'dshcx-switch' },
            h('input', { type: 'checkbox', checked: draft.dryRun, onChange: function (e) { setDraft(Object.assign({}, draft, { dryRun: e.target.checked })) } }),
            h('span', { className: 'dshcx-switch-text' },
              h('span', { className: 'dshcx-card-title' }, t('dryRunTitle')),
              h('span', { className: 'dshcx-hint' }, t('dryRunHint'))))),

        pending && pending.error
          ? h('div', { className: 'dshcx-error' }, pending.error)
          : h('div', { className: 'dshcx-card' },
            h('div', { className: 'dshcx-card-title' }, t('pending')),
            h('p', { className: 'dshcx-hint' },
              pending.count ? t('pendingSome').replace('{n}', String(pending.count)) : t('pendingNone')),
            (pending.moves || []).slice(0, 8).map(function (m, i) {
              return h('div', { className: 'dshcx-meta', key: i },
                h('span', {}, m.id),
                h('code', {}, m.from + '  →  ' + m.to))
            })),

        (function () {
          var copies = data && data.copies
          if (!copies || !copies.sources || !copies.sources.length) return null
          return h('div', { className: 'dshcx-card' },
            h('div', { className: 'dshcx-card-title' }, t('copiesTitle')),
            h('p', { className: 'dshcx-hint' },
              copies.count ? t('copiesSome').replace('{n}', String(copies.count)) : t('copiesNone')),
            (copies.items || []).slice(0, 8).map(function (m, i) {
              return h('div', { className: 'dshcx-meta', key: i },
                h('span', {}, m.id),
                h('code', {}, m.from + '  →  ' + m.to))
            }))
        })(),

        h('div', { className: 'dshcx-card' },
          h('div', { className: 'dshcx-card-title' }, t('lastRun')),
          h('p', { className: 'dshcx-hint' },
            lastRun
              ? (lastRun.at || '') + ' · ' + t('lastRunOk').replace('{n}', String((lastRun.done && lastRun.done.length) || 0))
              : t('lastRunNever')),
          h('div', { className: 'dshcx-meta' },
            h('span', {}, t('configFile') + '：', h('code', {}, (data && data.file) || '')),
            h('span', {}, t('homeLabel') + '：', h('code', {}, (data && data.home) || '')),
            h('span', {}, t('autoTitle') + '：', h('code', {}, (data && data.effective && data.effective.auto ? 'on' : 'off'))))),
      )
    }

    function makeTranslator(locale) {
      var zh = true
      return function t(key) {
        var dict = zh ? ZH : EN
        if (typeof locale === 'function') {
          try {
            var live = locale(key)
            if (live) return live
          } catch {}
        }
        return dict[key] || key
      }
    }

    function apply(ctx) {
      ensureStyles()
      var t = makeTranslator(null)
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register(NS, 'zh', ZH)
          ctx.locale.register(NS, 'en', EN)
          try { t = makeTranslator(ctx.locale.bind(NS)) } catch {}
        }
      } catch {}

      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-crossos',
            order: 94,
            locale: NS,
            label: function () { return t('title') },
            inject: function () { return {} },
          }, function DshCrossosSection() {
            return h(ConfigSection, { t: t })
          })
        })
      }, 'dsh-crossos: settings section')
    }

    module.exports = {
      name: 'dsh-crossos',
      inject: ['slots', 'locale'],
      apply: apply,
      __internals: { ZH: ZH, EN: EN, API: API, ConfigSection: ConfigSection },
    }
    return module.exports
  },
})
