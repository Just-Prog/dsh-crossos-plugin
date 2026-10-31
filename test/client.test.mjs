import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const code = fs.readFileSync(new URL('../client/bundle.js', import.meta.url), 'utf8')

let loaded
const sandbox = {
  window: { __ModuleLoader__: { load: (config) => { loaded = config } } },
  console,
  URL,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
}
vm.runInNewContext(code, sandbox)

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`✗ ${name}\n  ${error && error.message}`)
  }
}

const fakeReact = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props || {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(init) {
    return [typeof init === 'function' ? init() : init, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

function factory() {
  return loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
}

test('bundle 通过 __ModuleLoader__ 注册，id 为包名', () => {
  assert.ok(loaded, '未调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-crossos')
  assert.equal(typeof loaded.factory, 'function')
})

test('factory 返回 host 插件契约 { name, inject, apply }', () => {
  const mod = factory()
  assert.equal(mod.name, 'dsh-crossos')
  assert.deepEqual([...mod.inject], ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply 在 settings.section 上注册分区，标签可本地化', () => {
  const mod = factory()
  const registered = []
  const ctx = {
    locale: {
      register(namespace, lang, dict) {
        assert.equal(namespace, 'dshCrossos')
        assert.ok(['zh', 'en'].includes(lang))
        assert.ok(dict && typeof dict === 'object')
      },
      bind() {
        return () => undefined
      },
    },
    slots: {
      inject(slot, fn) {
        assert.equal(slot, 'settings.section')
        fn()
      },
      register(definition, component) {
        registered.push({ definition, component })
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  mod.apply(ctx)
  assert.equal(registered.length, 1)
  const { definition, component } = registered[0]
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'dsh-crossos')
  assert.equal(typeof definition.order, 'number')
  assert.equal(typeof definition.label(), 'string')
  assert.equal(typeof component, 'function')
})

test('ConfigSection 首次渲染返回容器节点', () => {
  const mod = factory()
  const node = mod.__internals.ConfigSection({ t: (key) => key })
  assert.equal(node.type, 'div')
  assert.equal(node.props.className, 'dshcx')
})

test('语言字典包含设置页必需文案', () => {
  const mod = factory()
  for (const dict of [mod.__internals.ZH, mod.__internals.EN]) {
    for (const key of ['title', 'mapsTitle', 'addMap', 'autoTitle', 'save', 'saved']) {
      assert.equal(typeof dict[key], 'string')
    }
  }
})

test('API 基址默认指向 /dsh-crossos/api', () => {
  const mod = factory()
  assert.equal(mod.__internals.API, '/dsh-crossos/api')
})

function collectButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) for (const item of children) collectButtons(item, out)
  else if (children) collectButtons(children, out)
  return out
}

test('每个可编辑区块都带保存键', () => {
  const original = fakeReact.useState
  fakeReact.useState = (init) => {
    if (init && init.loading === true) {
      return [{
        loading: false,
        error: '',
        data: { fileConfig: { maps: [], sources: [] }, pending: {}, copies: null, lastRun: null, file: '', home: '' },
      }, () => {}]
    }
    return [typeof init === 'function' ? init() : init, () => {}]
  }
  try {
    const mod = factory()
    const node = mod.__internals.ConfigSection({ t: (key) => key })
    const saves = collectButtons(node).filter((b) => b.props.children === 'save')
    assert.equal(saves.length, 3, '期望映射卡、源目录卡与页面底部各有一个保存键')
  } finally {
    fakeReact.useState = original
  }
})

console.log(`client.test: ${passed} 通过，${failures.length} 失败`)
for (const f of failures) console.error(f)
process.exit(failures.length ? 1 : 0)
