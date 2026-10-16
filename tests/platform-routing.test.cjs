// Synthetic contract tests for the extension's real worker and page bridge.
// They use only Node built-ins and never contact an OJ or submit a real record.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const EXTENSION_DIR = path.resolve(__dirname, '..')
const APP_URL = 'https://sdustjudge.cn/problem/P1001'
const APP_TAB_ID = 41
const EXTENSION_ID = 'oj-lite-test-extension'
const SOURCE_CODE = 'int main() { return 0; }'
const SOURCE_SHA256 = crypto.createHash('sha256').update(SOURCE_CODE).digest('hex')
const PAGE_BRIDGE_SOURCE = fs.readFileSync(path.join(EXTENSION_DIR, 'page-bridge.js'), 'utf8')
const BACKGROUND_SOURCE = fs.readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8')
const CODEFORCES_PLATFORM_SOURCE = fs.readFileSync(path.join(EXTENSION_DIR, 'platforms/codeforces.js'), 'utf8')

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const quickTimeout = (callback, _delay, ...args) => setTimeout(callback, 1, ...args)

function makeManualClock(startAt = 100000) {
  let now = startAt
  const timers = []
  return {
    now: () => now,
    setTimeout(callback, delay = 0, ...args) {
      const timer = { at: now + Math.max(0, Number(delay) || 0), callback: () => callback(...args), cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true },
    pendingCount: () => timers.filter((timer) => !timer.cancelled).length,
    async advanceTo(target) {
      while (true) {
        timers.sort((left, right) => left.at - right.at)
        const timerIndex = timers.findIndex((timer) => !timer.cancelled && timer.at <= target)
        if (timerIndex < 0) break
        const [timer] = timers.splice(timerIndex, 1)
        now = timer.at
        timer.callback()
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
      }
      now = target
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
    },
  }
}

function makeClockedCodeforcesPlatform({ clock, task, initiallyLoading = false, prepareAfterMs = 0, compileMode = 'pending-until-65s' }) {
  const submitUrl = `https://codeforces.com/contest/${task.contestId}/submit`
  const tab = {
    id: 701,
    url: initiallyLoading ? 'about:blank' : submitUrl,
    pendingUrl: initiallyLoading ? submitUrl : undefined,
    status: initiallyLoading ? 'loading' : 'complete',
  }
  const state = { createCount: 0, fillTimes: [], detectedAt: null, compileReadCount: 0, compileMode }
  class ClockDate extends Date {
    static now() { return clock.now() }
  }
  const chrome = {
    tabs: {
      async create() { state.createCount += 1; return { ...tab } },
      async get() { return { ...tab } },
      async query() { return [{ ...tab }] },
    },
    scripting: {
      async executeScript({ func }) {
        if (func.name === 'fillCodeforcesSubmitForm') {
          state.fillTimes.push(clock.now())
          if (clock.now() < task.startedAt + prepareAfterMs) {
            return [{ result: { ok: false, retryable: true, error: 'editor is still initializing' } }]
          }
          return [{ result: { ok: true, loggedInHandle: 'fixture-user' } }]
        }
        if (func.name === 'detectCodeforcesSubmissionInDom') return [{ result: {} }]
        if (func.name === 'readCodeforcesCompileError') {
          state.compileReadCount += 1
          state.detectedAt ??= clock.now()
          if (state.compileMode === 'terminal') return [{ result: { phase: 'not_compile_error' } }]
          if (state.compileMode === 'unavailable-at-deadline' && clock.now() >= task.startedAt + task.timeoutMs + 20000) {
            return [{ result: { pending: true } }]
          }
          if (state.compileMode === 'pending-until-65s' && clock.now() >= task.startedAt + 64000) {
            return [{ result: { compileError: 'fixture CE' } }]
          }
          return [{ result: { pending: true } }]
        }
        return [{ result: {} }]
      },
    },
  }
  const context = vm.createContext({
    chrome,
    Date: ClockDate,
    URL,
    URLSearchParams,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    console: { log() {}, warn() {}, error() {} },
  })
  vm.runInContext(CODEFORCES_PLATFORM_SOURCE, context, { filename: path.join(EXTENSION_DIR, 'platforms/codeforces.js') })
  return { state, tab, submit: context.OJCodeforcesPlatform.submit }
}

async function settleMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(message)
}

function makeNode(overrides = {}) {
  const node = {
    value: '',
    name: '',
    id: '',
    className: '',
    textContent: '',
    options: [],
    style: {},
    isConnected: true,
    classList: { contains: () => false, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute: () => {},
    appendChild: () => {},
    insertBefore: () => {},
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({ width: 100, height: 24 }),
    click: () => {},
    submit: () => {},
    requestSubmit: () => {},
  }
  return Object.assign(node, overrides)
}

function makeOjDocument(url, effects) {
  const parsed = new URL(url)
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => makeNode(),
    addEventListener: () => {},
  }
  if (parsed.origin === 'https://atcoder.jp') {
    const taskSelect = makeNode()
    const languageSelect = makeNode({ options: [{ value: '5001', textContent: 'C++ 23' }] })
    const textarea = makeNode({ name: 'sourceCode' })
    const csrf = makeNode({ value: 'synthetic-csrf-token' })
    const form = makeNode({
      querySelector(selector) {
        if (selector.includes('data.TaskScreenName')) return taskSelect
        if (selector.includes('data.LanguageId')) return null
        if (selector.includes('sourceCode')) return textarea
        if (selector.includes('csrf_token')) return csrf
        return null
      },
      appendChild() {},
      click() { effects.submitClicks += 1 },
      submit() { effects.autoSubmits += 1 },
      requestSubmit() { effects.autoSubmits += 1 },
    })
    doc.querySelector = (selector) => {
      if (selector === 'form.form-code-submit' || selector === 'form[action*="/submit"]') return form
      if (selector.startsWith('#select-lang-')) return languageSelect
      if (selector.includes('textarea[name="sourceCode"]')) return textarea
      return null
    }
    doc.querySelectorAll = (selector) => selector === 'select' ? [languageSelect] : []
    return doc
  }

  if (parsed.origin === 'https://codeforces.com') {
    const languageSelect = makeNode({ options: [{ value: '42', textContent: 'GNU C++17' }] })
    const problemSelect = makeNode({ options: [{ value: 'A', textContent: 'A. Synthetic Problem' }] })
    const textarea = makeNode({ name: 'source' })
    const inputs = new Map()
    let notice = null
    const form = makeNode({
      getAttribute(name) { return name === 'action' ? `${parsed.pathname}` : null },
      querySelector(selector) {
        if (selector.includes('programTypeId') || selector.includes('programType') || selector.includes('language')) return languageSelect
        if (selector.includes('submittedProblemCode') || selector.includes('submittedProblemIndex')
          || selector.includes('problemIndex') || selector.includes('name="index"')) return problemSelect
        if (selector.includes('textarea')) return textarea
        const name = selector.match(/^\[name="([^"]+)"\]$/)?.[1]
        if (name) {
          if (!inputs.has(name)) inputs.set(name, makeNode({ name }))
          return inputs.get(name)
        }
        return null
      },
      querySelectorAll(selector) { return selector === 'textarea' ? [textarea] : [] },
      parentNode: { insertBefore() {} },
      click() { effects.submitClicks += 1 },
      submit() { effects.autoSubmits += 1 },
      requestSubmit() { effects.autoSubmits += 1 },
    })
    doc.querySelectorAll = (selector) => {
      if (selector === 'form') return [form]
      if (selector === 'textarea') return [textarea]
      return []
    }
    doc.querySelector = (selector) => {
      if (selector.includes('/enter') || selector.includes('handleOrEmail') || selector.includes('password')) return null
      if (selector.includes('textarea')) return textarea
      return null
    }
    doc.getElementById = (id) => id === 'oj-codeforces-browser-submit-notice' ? notice : null
    doc.createElement = (tag) => {
      const created = makeNode({ tagName: String(tag).toUpperCase() })
      if (tag === 'div') notice = created
      return created
    }
    return doc
  }
  return doc
}

function makeSystem({ preparePage, pendingNavigation = false } = {}) {
  const state = {
    listeners: [],
    imports: [],
    tabs: new Map(),
    pages: new Map(),
    nextTabId: 100,
    injected: [],
    createdTabs: [],
    runtimeMessages: [],
    storage: new Map(),
    storageWrites: [],
    prepareCount: 0,
    recordReads: [],
    snapshotReads: 0,
    manualSubmissions: 0,
    fillReady: deferred(),
    luoguSnapshot: null,
  }

  const appSender = (overrides = {}) => ({
    id: EXTENSION_ID,
    frameId: 0,
    tab: { id: APP_TAB_ID, url: APP_URL },
    ...overrides,
  })

  function ensurePage(tabId) {
    if (state.pages.has(tabId)) return state.pages.get(tabId)
    const tab = state.tabs.get(tabId)
    const effects = { submitClicks: 0, autoSubmits: 0 }
    const location = { href: tab.url, origin: '', pathname: '', hash: '' }
    const updateLocation = (url) => {
      const parsed = new URL(url)
      location.href = parsed.href
      location.origin = parsed.origin
      location.pathname = parsed.pathname
      location.hash = parsed.hash
    }
    updateLocation(tab.url)
    const document = makeOjDocument(tab.url, effects)
    const window = {
      location,
      fetch: async () => { throw new Error('synthetic page must not access the network') },
      setTimeout: quickTimeout,
      clearTimeout,
      addEventListener: () => {},
    }
    class SyntheticEvent {
      constructor(type, options = {}) { this.type = type; Object.assign(this, options) }
    }
    class SyntheticXHR {
      open() {}
      send() {}
      addEventListener() {}
    }
    const context = vm.createContext({
      window,
      document,
      location,
      chrome: { runtime: { id: EXTENSION_ID } },
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Event: SyntheticEvent,
      XMLHttpRequest: SyntheticXHR,
      AbortController,
      DOMParser: class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] } } },
      indexedDB: { databases: async () => [], open: () => { throw new Error('synthetic indexedDB is read only') } },
      crypto: crypto.webcrypto,
      getComputedStyle: () => ({ visibility: 'visible' }),
      setTimeout: quickTimeout,
      clearTimeout,
      console: { log() {}, warn() {}, error() {} },
    })
    const page = { context, window, document, effects, updateLocation }
    preparePage?.(page)
    state.pages.set(tabId, page)
    return page
  }

  function invokeWorker(message, sender = appSender()) {
    const listener = state.listeners[0]
    assert.equal(typeof listener, 'function', 'the actual background listener is registered')
    return new Promise((resolve, reject) => {
      let finished = false
      let returned
      let synchronous = true
      let immediateValue
      let responded = false
      let timer
      const done = (response) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve({ response: clone(response), returned })
      }
      const sendResponse = (response) => {
        if (synchronous) {
          responded = true
          immediateValue = response
        } else {
          done(response)
        }
      }
      try {
        returned = listener(message, sender, sendResponse)
      } catch (error) {
        reject(error)
        return
      }
      synchronous = false
      if (responded) done(immediateValue)
      else if (returned !== true) done(undefined)
      timer = setTimeout(() => {
        if (finished) return
        finished = true
        reject(new Error(`worker did not answer ${message?.type || 'message'} in time`))
      }, 3000)
      if (finished) clearTimeout(timer)
    })
  }

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      onMessage: { addListener(listener) { state.listeners.push(listener) } },
    },
    storage: {
      session: {
        async get(key) {
          if (typeof key === 'string') return { [key]: clone(state.storage.get(key)) }
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, clone(state.storage.get(item))]))
          return Object.fromEntries(Array.from(state.storage, ([item, value]) => [item, clone(value)]))
        },
        async set(values) {
          const saved = clone(values)
          state.storageWrites.push(saved)
          for (const [key, value] of Object.entries(saved)) state.storage.set(key, value)
        },
      },
    },
    tabs: {
      async create(options) {
        const tab = { id: state.nextTabId++, url: String(options.url), status: 'complete', active: options.active !== false }
        state.tabs.set(tab.id, tab)
        state.createdTabs.push(clone(tab))
        if (pendingNavigation) {
          const destination = tab.url
          Object.assign(tab, {url: 'about:blank', pendingUrl: destination, status: 'loading'})
          setTimeout(() => { Object.assign(tab, {url: destination, status: 'complete'}); delete tab.pendingUrl }, 10)
        }
        return clone(tab)
      },
      async get(tabId) {
        const tab = state.tabs.get(tabId)
        if (!tab) throw new Error(`tab ${tabId} is closed`)
        return clone(tab)
      },
      async update(tabId, change) {
        const tab = state.tabs.get(tabId)
        if (!tab) throw new Error(`tab ${tabId} is closed`)
        Object.assign(tab, change)
        state.pages.get(tabId)?.updateLocation(tab.url)
        return clone(tab)
      },
      async query() { return Array.from(state.tabs.values(), clone) },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      async executeScript(details) {
        const tabId = details.target.tabId
        const page = ensurePage(tabId)
        state.injected.push({
          tabId,
          files: details.files ? [...details.files] : undefined,
          world: details.world,
          funcSource: details.func?.toString(),
          args: clone(details.args || []),
        })
        if (details.files) {
          for (const filename of details.files) {
            const scriptPath = path.resolve(EXTENSION_DIR, filename)
            const script = fs.readFileSync(scriptPath, 'utf8')
            vm.runInContext(script, page.context, { filename: scriptPath })
          }
          return []
        }
        assert.equal(typeof details.func, 'function', 'executeScript receives the actual function')
        const serialized = vm.runInContext(`(${details.func.toString()})`, page.context)
        assert.equal(typeof serialized, 'function', 'executeScript function survives page-world serialization')
        const args = details.args || []
        const first = args[0]
        const source = details.func.toString()

        if (source.includes('function fillLuoguSubmitForm')) {
          // Exercise the serialized function's early validation path without any OJ page data or network access.
          const probe = await serialized({})
          assert.equal(probe.ok, false)
          state.prepareCount += 1
          const now = Date.now()
          const observation = { phase: 'waiting_user_submit', createdAt: now, sequence: 0 }
          return [{ result: { ok: true, remoteUid: '99', createdAt: now, phase: 'waiting_user_submit', submissionObservation: observation } }]
        }
        if (source.includes('OJLuoguSubmit.snapshot')) {
          state.snapshotReads += 1
          return [{ result: clone(state.luoguSnapshot) }]
        }
        if (source.includes('OJLuoguRecord.readFromPage')) {
          state.recordReads.push(clone(first))
          return [{ result: {
            ok: true,
            done: false,
            phase: 'judging',
            remoteSubmissionId: String(first.rid),
            remoteSubmissionUrl: `https://www.luogu.com.cn/record/${first.rid}`,
            remoteUid: String(first.remoteUid),
            pid: first.pid,
            remoteLanguageId: String(first.remoteLanguageId),
          } }]
        }

        const isSubmitFill = first && typeof first === 'object' && typeof first.sourceCode === 'string'
        if (isSubmitFill) {
          const result = await serialized(...args)
          assert.equal(page.effects.submitClicks, 0, 'platform preparation must not click the remote Submit button')
          assert.equal(page.effects.autoSubmits, 0, 'platform preparation must not call form submission APIs')
          state.fillReady.resolve({ tabId, result: clone(result), page })
          return [{ result: clone(result) }]
        }
        return [{ result: clone(await serialized(...args)) }]
      },
    },
  }

  function loadWorker() {
    state.listeners.length = 0
    state.imports.length = 0
    const context = vm.createContext({
      chrome,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout: quickTimeout,
      clearTimeout,
      console: { log() {}, warn() {}, error() {} },
    })
    context.importScripts = (...filenames) => {
      for (const filename of filenames) {
        state.imports.push(filename)
        const scriptPath = path.resolve(EXTENSION_DIR, filename)
        vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath })
      }
    }
    vm.runInContext(BACKGROUND_SOURCE, context, { filename: path.join(EXTENSION_DIR, 'background.js') })
    assert.equal(state.listeners.length, 1, 'the worker registers one runtime message listener')
    return context
  }

  function sendFromPage(message, sender, callback) {
    state.runtimeMessages.push(clone(message))
    invokeWorker(message, sender).then(({ response }) => callback(response), () => callback(undefined))
  }

  function manualSubmit(tabId, url) {
    const tab = state.tabs.get(tabId)
    assert.ok(tab, 'the remote tab is still open before the simulated human action')
    tab.url = url
    state.pages.get(tabId)?.updateLocation(url)
    state.manualSubmissions += 1
  }

  loadWorker()
  return { state, chrome, appSender, invokeWorker, sendFromPage, manualSubmit, loadWorker }
}

function makeBridge(system, appUrl = APP_URL) {
  const url = new URL(appUrl)
  const messageHandlers = []
  const clickHandlers = []
  const posts = []
  const window = {
    location: { origin: url.origin, href: url.href, pathname: url.pathname },
    addEventListener(type, handler) { if (type === 'message') messageHandlers.push(handler) },
    postMessage(data, targetOrigin) { posts.push({ data: clone(data), targetOrigin }) },
    setTimeout: quickTimeout,
    clearTimeout,
  }
  const document = {
    addEventListener(type, handler) { if (type === 'click') clickHandlers.push(handler) },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const pageChrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      sendMessage(message, callback) { system.sendFromPage(message, system.appSender(), callback) },
    },
  }
  const context = vm.createContext({
    window,
    document,
    chrome: pageChrome,
    URL,
    URLSearchParams,
    TextEncoder,
    Date,
    setTimeout: quickTimeout,
    clearTimeout,
  })
  vm.runInContext(PAGE_BRIDGE_SOURCE, context, { filename: path.join(EXTENSION_DIR, 'page-bridge.js') })

  return {
    window,
    posts,
    click(trusted = true) {
      for (const handler of clickHandlers) {
        handler({ isTrusted: trusted, target: { closest: (selector) => selector === '[data-browser-submit-action="true"]' ? {} : null } })
      }
    },
    emit(data, { origin = url.origin, source = window } = {}) {
      context.__messageJson = JSON.stringify(data)
      const inRealmData = vm.runInContext('JSON.parse(__messageJson)', context)
      delete context.__messageJson
      for (const handler of messageHandlers) handler({ source, origin, data: inRealmData })
    },
    result(source, requestId) {
      return posts.find((post) => post.data.source === source && post.data.requestId === requestId)?.data
    },
  }
}

function atcoderTask(requestId) {
  return {
    requestId,
    contestKey: 'abc123',
    taskKey: 'abc123_a',
    sourceCode: SOURCE_CODE,
    sourceUrl: 'https://atcoder.jp/contests/abc123/tasks/abc123_a',
    remoteLanguageId: '5001',
    remoteLanguageName: 'C++ 23',
  }
}

function codeforcesTask(requestId, { gym = false } = {}) {
  const contestId = gym ? '200001' : '200002'
  const prefix = gym ? '/gym' : '/contest'
  return {
    requestId,
    contestId,
    problemIndex: 'A',
    sourceCode: SOURCE_CODE,
    sourceUrl: `https://codeforces.com${prefix}/${contestId}/problem/A`,
    remoteLanguageId: '42',
    remoteLanguageName: 'GNU C++17',
  }
}

function bridgeMessages(platform, task, nonce) {
  const atcoder = platform === 'atcoder'
  const requestId = task.requestId
  const issuedAt = Date.now()
  const prefix = atcoder ? 'OJ_ATCODER_BROWSER_SUBMIT' : 'OJ_CODEFORCES_BROWSER_SUBMIT'
  return {
    ping: { source: `${prefix}_PING`, type: 'ping', requestId, nonce, issuedAt, userGesture: true },
    submit: {
      source: prefix,
      type: atcoder ? 'submit' : 'browserSubmitCodeforces',
      requestId,
      nonce,
      issuedAt,
      userGesture: true,
      task,
    },
    resultSource: `${prefix}_RESULT`,
  }
}

async function waitFor(check, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail(message)
}

async function exerciseBrowserRoute({ platform, gym = false, requestId, expectedSubmitUrl, finalUrl, recordViaDom }) {
  const system = makeSystem()
  const bridge = makeBridge(system)
  const task = platform === 'atcoder' ? atcoderTask(requestId) : codeforcesTask(requestId, { gym })
  const messages = bridgeMessages(platform, task, `nonce-${requestId}-0123456789`)

  bridge.click(true)
  bridge.emit(messages.ping)
  const pong = bridge.posts.find((post) => post.data.requestId === requestId)?.data
  assert.equal(pong?.ok, true, 'the page bridge accepts its own trusted-origin ping after a trusted click')
  assert.equal(pong?.nonce, messages.ping.nonce)

  bridge.emit(messages.submit)
  const fillOrResponse = await Promise.race([
    system.state.fillReady.promise.then((fill) => ({ fill })),
    waitFor(() => bridge.result(messages.resultSource, requestId), 'remote platform request received no worker response')
      .then((response) => ({ response })),
  ])
  assert.ok(fillOrResponse.fill, `worker returned before form preparation: ${fillOrResponse.response?.error || 'unknown error'}`)
  const fill = fillOrResponse.fill
  const tab = system.state.tabs.get(fill.tabId)
  assert.equal(tab.url, expectedSubmitUrl, 'the request reaches the platform-specific submit route')
  assert.equal(fill.result.ok, true, 'the actual serialized fill function succeeds in the synthetic page')
  if (platform === 'codeforces') {
    const form = fill.page.document.querySelectorAll('form')[0]
    assert.equal(form.querySelector('textarea[name="source"]').value, SOURCE_CODE)
    assert.equal(form.querySelector('select[name="programTypeId"]').value, task.remoteLanguageId)
    assert.equal(form.querySelector('select[name="submittedProblemIndex"]').value, task.problemIndex)
  }
  assert.equal(system.state.manualSubmissions, 0)
  assert.equal(fill.page.effects.submitClicks, 0)
  assert.equal(fill.page.effects.autoSubmits, 0)
  assert.equal(bridge.result(messages.resultSource, requestId), undefined, 'no final result is reported before a human submit event')

  if (recordViaDom) {
    // Keep the browser on the status list: the serialized MAIN-world observer
    // must identify the new row/link instead of taking the URL shortcut.
    const originalQuery = fill.page.document.querySelectorAll
    const link = makeNode({ getAttribute: (name) => name === 'href' ? new URL(finalUrl).pathname : null })
    const row = makeNode({
      textContent: `${task.contestId}A GNU C++17 Accepted`,
      getAttribute: (name) => name === 'data-submission-id' ? '881004' : null,
    })
    fill.page.document.querySelectorAll = (selector) => {
      if (recordViaDom === 'link' && selector === 'a[href]') return [link]
      if (recordViaDom === 'row' && selector.startsWith('tr[data-submission-id]')) return [row]
      return originalQuery(selector)
    }
    system.manualSubmit(fill.tabId, expectedSubmitUrl.replace(/\/submit$/, '/my'))
  } else {
    system.manualSubmit(fill.tabId, finalUrl)
  }
  const response = await waitFor(
    () => bridge.result(messages.resultSource, requestId),
    'the worker did not return after the synthetic human submit event',
  )
  assert.equal(response.ok, true, response.error)
  assert.equal(response.requestId, requestId)
  assert.equal(response.nonce, messages.submit.nonce)
  assert.equal(system.state.runtimeMessages.length, 1)
  assert.equal(system.state.runtimeMessages[0].requestId, requestId)
  assert.equal(system.state.runtimeMessages[0].nonce, messages.submit.nonce)
  assert.equal(system.state.createdTabs[0].url, expectedSubmitUrl)
  assert.equal(system.state.manualSubmissions, 1)
  assert.ok(system.state.imports.includes('platforms/atcoder.js'))
  assert.ok(system.state.imports.includes('platforms/codeforces.js'))
  return { system, response }
}

test('AtCoder page bridge dispatches a trusted request and preserves the manual-submit contract', async () => {
  const requestId = 'atc-route-001'
  const { system, response } = await exerciseBrowserRoute({
    platform: 'atcoder',
    requestId,
    expectedSubmitUrl: 'https://atcoder.jp/contests/abc123/submit?taskScreenName=abc123_a&lang=en',
    finalUrl: 'https://atcoder.jp/contests/abc123/submissions/881001',
  })
  assert.equal(response.remoteOj, 'atcoder')
  assert.equal(response.remoteSubmissionId, '881001')
  assert.equal(system.state.injected.some((call) => call.funcSource?.includes('fillAtCoderSubmitForm')), true)
})

test('AtCoder fills source without a pre-inserted hidden CSRF field', async () => {
  const system = makeSystem({preparePage(page) {
    const form = page.document.querySelector('form.form-code-submit')
    const query = form.querySelector
    form.querySelector = selector => {
      return selector.includes('csrf') ? null : query(selector)
    }
  }})
  const task = atcoderTask('atc-manual-without-token')
  const response = system.invokeWorker({
    type:'submitAtCoder', requestId:task.requestId, nonce:'nonce-atc-manual-without-token-1234',
    userGesture:true, issuedAt:Date.now(), task,
  })
  const fill = await Promise.race([
    system.state.fillReady.promise,
    response.then(outcome => {assert.fail(outcome.response?.error || 'returned before filling')}),
  ])
  system.manualSubmit(fill.tabId, 'https://atcoder.jp/contests/abc123/submissions/881040')
  const outcome = await response
  assert.equal(fill.result.ok, true, fill.result.error)
  assert.equal(fill.page.document.querySelector('textarea[name="sourceCode"]').value, SOURCE_CODE)
  assert.equal(outcome.response.ok, true)
})

test('AtCoder resolves the site language ID from a name-only C++17 mapping', async () => {
  const system = makeSystem({preparePage(page) {
    page.document.querySelector('#select-lang-abc123_a select').options = [
      {value:'6054', textContent:'C++ IOI-Style(GNU++20) (GCC 14.2.0)'},
      {value:'6018', textContent:'C++17 (GCC 14.2.0)'},
      {value:'6019', textContent:'C++20 (GCC 14.2.0)'},
    ]
  }})
  const task = {...atcoderTask('atc-name-only'), remoteLanguageId:null, remoteLanguageName:'C++17'}
  const response = system.invokeWorker({
    type:'submitAtCoder', requestId:task.requestId, nonce:'nonce-atc-name-only-1234',
    userGesture:true, issuedAt:Date.now(), task,
  })
  const fill = await system.state.fillReady.promise
  system.manualSubmit(fill.tabId, 'https://atcoder.jp/contests/abc123/submissions/881031')
  const outcome = await response
  assert.equal(fill.result.ok, true, fill.result.error)
  assert.equal(fill.page.document.querySelector('#select-lang-abc123_a select').value, '6018')
  assert.equal(fill.page.document.querySelector('textarea[name="sourceCode"]').value, SOURCE_CODE)
  assert.equal(outcome.response.ok, true)
})

test('AtCoder rejects removed C++17 and lists current C++ options without upgrading silently', async () => {
  const system = makeSystem({preparePage(page) {
    page.document.querySelector('#select-lang-abc123_a select').options = [
      {value:'6054', textContent:'C++ IOI-Style(GNU++20) (GCC 14.2.0)'},
      {value:'6017', textContent:'C++23 (GCC 15.2.0)'},
      {value:'6116', textContent:'C++23 (Clang 21.1.0)'},
    ]
  }})
  const task = {...atcoderTask('atc-removed-language'), remoteLanguageId:null, remoteLanguageName:'C++17'}
  const response = await system.invokeWorker({
    type:'submitAtCoder', requestId:task.requestId, nonce:'nonce-atc-removed-language-1234',
    userGesture:true, issuedAt:Date.now(), task,
  })
  assert.equal(response.response.ok, false)
  assert.match(response.response.error, /C\+\+17/)
  assert.match(response.response.error, /C\+\+23 \(GCC 15\.2\.0\)/)
  assert.match(response.response.error, /请更新本站语言映射/)
  const page = system.state.pages.get(system.state.createdTabs[0].id)
  assert.equal(page.document.querySelector('textarea[name="sourceCode"]').value, '')
  assert.equal(system.state.manualSubmissions, 0)
})

test('AtCoder waits for a newly created tab with only a pending navigation URL', async () => {
  const system = makeSystem({pendingNavigation: true})
  const task = atcoderTask('atc-pending-navigation')
  const response = system.invokeWorker({
    type: 'submitAtCoder', requestId: task.requestId, nonce: 'nonce-atc-pending-navigation-1234',
    userGesture: true, issuedAt: Date.now(), task,
  })
  const fill = await Promise.race([
    system.state.fillReady.promise,
    response.then(outcome => {assert.fail(outcome.response?.error || 'returned before filling')}),
  ])
  assert.equal(fill.result.ok, true)
  assert.equal(fill.page.document.querySelector('textarea[name="sourceCode"]').value, SOURCE_CODE)
  system.manualSubmit(fill.tabId, 'https://atcoder.jp/contests/abc123/submissions/881012')
  assert.equal((await response).response.ok, true)
})

test('AtCoder continues preparing after the user clears an initial verification page', async () => {
  const system = makeSystem({ preparePage(page) {
    const originalQuery = page.document.querySelector
    const challenge = makeNode()
    let verified = false
    page.document.querySelector = (selector) => {
      if (!verified && selector.includes('form')) return null
      if (!verified && selector.includes('cf-challenge')) return challenge
      return originalQuery(selector)
    }
    // Represents the original page becoming available after human verification.
    page.completeVerification = () => { verified = true }
  } })
  const task = atcoderTask('atc-human-verification')
  const response = system.invokeWorker({
    type: 'submitAtCoder', requestId: task.requestId, nonce: 'nonce-atc-human-verification-1234',
    userGesture: true, issuedAt: Date.now(), task,
  })
  const first = await system.state.fillReady.promise
  assert.equal(first.result.needVerification, true)
  first.page.completeVerification()
  const prepared = await waitFor(() => {
    const textarea = first.page.document.querySelector('textarea[name="sourceCode"]')
    return textarea.value === SOURCE_CODE
  }, 'source remains empty after verification was completed')
  assert.equal(prepared, true)
  system.manualSubmit(first.tabId, 'https://atcoder.jp/contests/abc123/submissions/881010')
  assert.equal((await response).response.ok, true)
})

test('AtCoder does not confuse a same-action Cloudflare form with the code submission form', async () => {
  const system = makeSystem({preparePage(page) {
    const originalQuery = page.document.querySelector
    const challenge = makeNode({id: 'challenge-form'})
    let verified = false
    page.document.querySelector = selector => {
      if (verified) return originalQuery(selector)
      if (selector === 'form.form-code-submit') return null
      if (selector === 'form[action*="/submit"]') return challenge
      if (selector.includes('cf-challenge')) return makeNode()
      return null
    }
    page.completeVerification = () => { verified = true }
  }})
  const task = atcoderTask('atc-challenge-form')
  const response = system.invokeWorker({
    type:'submitAtCoder', requestId:task.requestId, nonce:'nonce-atc-challenge-form-1234',
    userGesture:true, issuedAt:Date.now(), task,
  })
  const first = await system.state.fillReady.promise
  first.page.completeVerification()
  if (!first.result.retryable) {
    const outcome = await response
    assert.fail(`verification was treated as a final preparation failure: ${outcome.response?.error}`)
  }
  await waitFor(() => first.page.document.querySelector('textarea[name="sourceCode"]').value === SOURCE_CODE,
    'code was not filled after the Cloudflare form disappeared')
  system.manualSubmit(first.tabId, 'https://atcoder.jp/contests/abc123/submissions/881030')
  assert.equal((await response).response.ok, true)
})

test('AtCoder waits for Ace and fills both the visible model and the submission textarea', async () => {
  let source = 'previous submission'
  const system = makeSystem({ preparePage(page) {
    const originalQuery = page.document.querySelector
    const editorNode = makeNode()
    page.document.querySelector = (selector) => selector === '#editor' ? editorNode : originalQuery(selector)
    page.completeEditorInitialization = () => {
      page.window.ace = { edit(node) {
        assert.equal(node, editorNode)
        return { setValue(value) { source = value }, getValue() { return source } }
      } }
    }
  } })
  const task = atcoderTask('atc-delayed-ace')
  const response = system.invokeWorker({
    type: 'submitAtCoder', requestId: task.requestId, nonce: 'nonce-atc-delayed-ace-1234',
    userGesture: true, issuedAt: Date.now(), task,
  })
  const first = await system.state.fillReady.promise
  assert.equal(first.result.ok, false)
  assert.equal(first.result.retryable, true)
  assert.equal(source, 'previous submission')
  first.page.completeEditorInitialization()
  await waitFor(() => source === SOURCE_CODE, 'visible Ace model retains the historical source')
  assert.equal(first.page.document.querySelector('textarea[name="sourceCode"]').value, SOURCE_CODE)
  system.manualSubmit(first.tabId, 'https://atcoder.jp/contests/abc123/submissions/881011')
  assert.equal((await response).response.ok, true)
})

test('AtCoder reports a missing source editor instead of claiming preparation succeeded', async () => {
  const system = makeSystem({ preparePage(page) {
    const originalQuery = page.document.querySelector
    const form = originalQuery('form.form-code-submit')
    const originalFormQuery = form.querySelector
    form.querySelector = (selector) => selector.includes('textarea') ? null : originalFormQuery(selector)
    page.document.querySelector = (selector) => selector.includes('textarea') ? null : originalQuery(selector)
  } })
  const task = atcoderTask('atc-missing-editor')
  const response = system.invokeWorker({
    type: 'submitAtCoder', requestId: task.requestId, nonce: 'nonce-atc-missing-editor-1234',
    userGesture: true, issuedAt: Date.now(), task,
  })
  const { result } = await system.state.fillReady.promise
  system.manualSubmit(system.state.createdTabs[0].id, 'https://atcoder.jp/contests/abc123/submissions/881009')
  const outcome = await response
  assert.equal(result.ok, false, 'no editor means the requested code was never filled')
  assert.match(result.error, /source|editor/i)
  assert.equal(outcome.response.ok, false)
})

test('Codeforces waits for the created contest tab when Chrome reports a pending URL', async () => {
  const system = makeSystem({pendingNavigation:true,preparePage(page) {
    const form = page.document.querySelectorAll('form')[0]
    form.querySelector('select[name="programTypeId"]').options = [{value:'89',textContent:'GNU G++20 13.2 (64 bit, winlibs)'}]
  }})
  const task = {...codeforcesTask('cf-pending-navigation'), contestId:'2273',
    sourceUrl:'https://codeforces.com/contest/2273/problem/A',
    remoteLanguageId:'89', remoteLanguageName:'GNU G++20 13.2 (64 bit, winlibs)'}
  const response = system.invokeWorker({
    type:'browserSubmitCodeforces', requestId:task.requestId, nonce:'nonce-cf-pending-navigation-1234',
    userGesture:true, issuedAt:Date.now(), task,
  })
  const fill = await Promise.race([
    system.state.fillReady.promise,
    response.then(outcome => {assert.fail(outcome.response?.error || 'returned before filling')}),
  ])
  system.manualSubmit(fill.tabId, 'https://codeforces.com/contest/2273/submission/881050')
  const outcome = await response
  assert.equal(fill.result.ok, true, fill.result.error)
  assert.equal(fill.page.document.querySelector('textarea[name="source"]').value, SOURCE_CODE)
  assert.equal(outcome.response.remoteSubmissionId, '881050')
})

test('Codeforces shares one 60-second deadline across delayed page load, preparation and manual submit', async () => {
  const clock = makeManualClock()
  const startedAt = clock.now()
  const task = {
    ...codeforcesTask('cf-shared-deadline'),
    startedAt,
    timeoutMs: 60000,
  }
  const platform = makeClockedCodeforcesPlatform({
    clock,
    task,
    initiallyLoading: true,
    prepareAfterMs: 35000,
  })
  let status = 'pending'
  let response
  let failure
  const pending = platform.submit(task).then((value) => {
    status = 'resolved'
    response = value
  }, (error) => {
    status = 'rejected'
    failure = error
  })

  await waitUntil(() => clock.pendingCount() > 0, 'Codeforces waits for the original submit page to load')
  await clock.advanceTo(startedAt + 30000)
  assert.equal(platform.state.fillTimes.length, 0, 'the slow page consumes the same task budget')
  platform.tab.url = `https://codeforces.com/contest/${task.contestId}/submit`
  platform.tab.status = 'complete'
  delete platform.tab.pendingUrl

  await clock.advanceTo(startedAt + 35600)
  assert.ok(platform.state.fillTimes.at(-1) >= startedAt + 35000
    && platform.state.fillTimes.at(-1) < startedAt + 36000,
  `editor initialization remains within the shared deadline (${JSON.stringify({ now: clock.now(), fillTimes: platform.state.fillTimes, pending: clock.pendingCount() })})`)
  await clock.advanceTo(startedAt + 50000)
  assert.equal(status, 'pending', 'the user still has time to submit manually at second 50')
  platform.tab.url = `https://codeforces.com/contest/${task.contestId}/submission/881050`
  await clock.advanceTo(startedAt + 51000)
  assert.equal(platform.state.detectedAt, startedAt + 50100, 'the existing RID starts optional compile observation')
  await clock.advanceTo(startedAt + 65000)
  await pending

  assert.equal(status, 'resolved', failure?.message)
  assert.equal(response.remoteSubmissionId, '881050')
  assert.equal(response.compileError, 'fixture CE')
  assert.equal(platform.state.createCount, 1, 'timeout handling never opens a second submit task')
})

test('Codeforces task timeout includes preparation instead of granting a new manual-submit budget', async () => {
  const clock = makeManualClock()
  const startedAt = clock.now()
  const task = { ...codeforcesTask('cf-preparation-deadline'), startedAt, timeoutMs: 60000 }
  const platform = makeClockedCodeforcesPlatform({ clock, task, prepareAfterMs: 45000 })
  let status = 'pending'
  let failure
  const pending = platform.submit(task).then(() => { status = 'resolved' }, (error) => {
    status = 'rejected'
    failure = error
  })

  await waitUntil(() => clock.pendingCount() > 0, 'Codeforces begins form preparation')
  await clock.advanceTo(startedAt + 45000)
  assert.ok(platform.state.fillTimes.length > 1, 'preparation retries while the editor initializes')
  await clock.advanceTo(startedAt + 60000)
  await settleMicrotasks()
  assert.equal(status, 'rejected', 'the task ends at its original deadline after page and preparation time')
  assert.match(failure?.message || '', /timeout|timed out/i)
  await pending
})

test('Codeforces uses its default task budget for malformed timeout values', async () => {
  const clock = makeManualClock()
  const startedAt = clock.now()
  const task = { ...codeforcesTask('cf-invalid-timeout'), startedAt, timeoutMs: 'not-a-number' }
  const platform = makeClockedCodeforcesPlatform({ clock, task })
  let status = 'pending'
  const pending = platform.submit(task).then(() => { status = 'resolved' }, () => { status = 'rejected' })

  await waitUntil(() => platform.state.fillTimes.length > 0, 'Codeforces prepares the form before waiting for a manual submit')
  await settleMicrotasks()
  assert.equal(status, 'pending', 'an invalid timeout must not produce an immediate NaN deadline')
  await clock.advanceTo(startedAt + 59999)
  assert.equal(status, 'pending', 'malformed values fall back to the normal 60-second task budget')
  await clock.advanceTo(startedAt + 60000)
  await pending
  assert.equal(status, 'rejected')
})

test('Codeforces returns a terminal verdict quickly after preserving the detected RID', async () => {
  const clock = makeManualClock()
  const startedAt = clock.now()
  const task = { ...codeforcesTask('cf-terminal-fast'), startedAt, timeoutMs: 60000 }
  const platform = makeClockedCodeforcesPlatform({ clock, task, compileMode: 'terminal' })
  const pending = platform.submit(task)

  await waitUntil(() => platform.state.fillTimes.length > 0, 'Codeforces prepares the form')
  platform.tab.url = `https://codeforces.com/contest/${task.contestId}/submission/881051`
  await clock.advanceTo(startedAt + 1000)
  const response = await pending
  assert.equal(response.remoteSubmissionId, '881051')
  assert.ok(clock.now() - startedAt < 20000, 'a known non-CE terminal result skips the remaining compile detail wait')
})

test('Codeforces rejects a visible editor that refuses the requested code', async () => {
  const system = makeSystem({preparePage(page) {
    const originalQuery = page.document.querySelectorAll
    const mirror = makeNode({CodeMirror: {
      setValue() {},
      getValue() {return 'historical code'},
    }})
    page.document.querySelectorAll = selector => selector === '.CodeMirror' ? [mirror] : originalQuery(selector)
  }})
  const task = codeforcesTask('cf-source-refused')
  const outcome = await system.invokeWorker({
    type:'browserSubmitCodeforces', requestId:task.requestId, nonce:'nonce-cf-source-refused-123456',
    userGesture:true, issuedAt:Date.now(), task,
  })
  assert.equal(outcome.response.ok, false)
  assert.match(outcome.response.error, /editor.*retain/)
  const {page} = await system.state.fillReady.promise
  assert.equal(page.window.__ojLiteCodeforcesPreparation.phase, 'editor_failed')
  assert.equal(page.document.querySelector('textarea[name="source"]').value, '')
  assert.equal(system.state.manualSubmissions, 0)
})

test('Codeforces contest and Gym fill forms and return manually submitted record URLs', async () => {
  const cases = [
    {
      gym: false,
      requestId: 'cf-route-001',
      expectedSubmitUrl: 'https://codeforces.com/contest/200002/submit',
      finalUrl: 'https://codeforces.com/contest/200002/submission/881002',
      expectedResultUrl: 'https://codeforces.com/contest/200002/submission/881002',
    },
    {
      gym: true,
      requestId: 'gym-route-001',
      expectedSubmitUrl: 'https://codeforces.com/gym/200001/submit',
      finalUrl: 'https://codeforces.com/gym/200001/submission/881003',
      expectedResultUrl: 'https://codeforces.com/gym/200001/submission/881003',
    },
  ]
  for (const item of cases) {
    const { system, response } = await exerciseBrowserRoute({ platform: 'codeforces', ...item })
    assert.equal(response.remoteOj, 'codeforces')
    assert.equal(response.remoteSubmissionUrl, item.expectedResultUrl)
    assert.equal(response.remoteSubmissionId, item.gym ? '881003' : '881002')
    assert.equal(system.state.injected.some((call) => call.funcSource?.includes('fillCodeforcesSubmitForm')), true)
  }
})

test('Codeforces and Gym identify DOM links and row IDs after MAIN-world serialization', async () => {
  for (const gym of [false, true]) {
    for (const recordViaDom of ['link', 'row']) {
      const base = `https://codeforces.com/${gym ? 'gym/200001' : 'contest/200002'}`
      const { system, response } = await exerciseBrowserRoute({
        platform: 'codeforces', gym, recordViaDom,
        requestId: `dom-${gym}-${recordViaDom}`,
        expectedSubmitUrl: `${base}/submit`,
        finalUrl: `${base}/submission/881004`,
      })
      assert.equal(response.remoteSubmissionId, '881004')
      assert.equal(response.remoteSubmissionUrl, `${base}/submission/881004`)
      assert.equal(system.state.injected.some((call) => call.funcSource?.includes('detectCodeforcesSubmissionInDom')), true)
    }
  }
})

test('Gym verifies row timestamps against API epoch time before rejecting a fresh submission as too old', async () => {
  const now = Date.now()
  const displayed = new Date(now - 5 * 60 * 60 * 1000)
  const localText = `${displayed.getFullYear()}/${displayed.getMonth()+1}/${displayed.getDate()} ${displayed.getHours()}:${displayed.getMinutes()}:${displayed.getSeconds()}`
  let apiCalls=0
  let apiRecord={id:394709610,creationTimeSeconds:Math.floor(now/1000),
    problem:{contestId:106738,index:'J'},author:{members:[{handle:'fixture-user'}]},verdict:'OK'}
  const system=makeSystem({preparePage(page) {
    page.context.FormData=FormData
    page.context.fetch=async (url) => {
      if(String(url).startsWith('/api/user.status?')) {
        apiCalls++
        return {ok:true,json:async()=>({status:'OK',result:[apiRecord]})}
      }
      return {ok:true,json:async()=>''}
    }
    const form=page.document.querySelectorAll('form')[0]
    form.querySelector('select[name="submittedProblemIndex"]').options=[{value:'J',textContent:'J. Problem'}]
  }})
  const task={...codeforcesTask('gym-timezone',{gym:true}),contestId:'106738',problemIndex:'J',
    sourceUrl:'https://codeforces.com/gym/106738/problem/J',handle:'fixture-user',submittedAfter:now}
  const response=system.invokeWorker({type:'browserSubmitCodeforces',requestId:task.requestId,
    nonce:'nonce-gym-timezone-123456789',userGesture:true,issuedAt:Date.now(),task})
  const fill=await system.state.fillReady.promise
  const row=makeNode({textContent:'106738J GNU C++17 In queue',
    getAttribute:name=>name==='data-submission-id'?'394709610':null,
    querySelectorAll:selector=>selector==='td, th'?[makeNode({textContent:'394709610'}),makeNode({textContent:localText})]:[],
  })
  const query=fill.page.document.querySelectorAll
  fill.page.document.querySelectorAll=selector=>selector.startsWith('tr[data-submission-id]')?[row]:query(selector)
  system.manualSubmit(fill.tabId,'https://codeforces.com/gym/106738/my')
  try {
    const outcome=(await response).response
    assert.equal(outcome.ok,true,outcome.error)
    assert.equal(outcome.remoteSubmissionId,'394709610')
    assert.equal(apiCalls,2)
    assert.ok(Math.abs(Date.parse(outcome.remoteSubmittedAt)-now)<1000)
    const source=system.state.injected.find(call=>call.funcSource?.startsWith('async function detectCodeforcesSubmissionInDom')).funcSource
    const observe=vm.runInContext(`(${source})`,fill.page.context)
    const valid=apiRecord
    for(const [index,record] of [
      {...valid,creationTimeSeconds:Math.floor(now/1000)-3600},
      {...valid,author:{members:[{handle:'another-user'}]}},
      {...valid,problem:{contestId:106738,index:'K'}},
    ].entries()) {
      apiRecord=record
      const probe={...task,requestId:`gym-timezone-rejected-${index}`}
      const result=await observe(probe,'https://codeforces.com/gym/106738')
      assert.equal(result.ok,false,'old, wrong-account and wrong-problem records must remain rejected')
      const calls=apiCalls
      await observe(probe,'https://codeforces.com/gym/106738')
      assert.equal(apiCalls,calls,'repeated observation throttles the API lookup')
    }
  } finally {
    // End the old worker loop too when running this regression before the fix.
    system.manualSubmit(fill.tabId,'https://codeforces.com/gym/106738/submission/394709610')
  }
})

test('Gym /my reports the RID even when optional protocol fetch or JSON body never finishes', async () => {
  for (const mode of ['pending-request', 'pending-body', 'available']) {
    let signal
    let protocolCalls = 0
    const system = makeSystem({preparePage(page) {
      page.context.FormData = FormData
      page.context.fetch = async (_url, options) => {
        protocolCalls++
        signal = options.signal
        if (mode === 'pending-request') return new Promise(() => {})
        return {ok:true, json:async () => mode === 'pending-body' ? new Promise(() => {}) : 'Checker Log\nsynthetic compiler diagnostic'}
      }
      const form = page.document.querySelectorAll('form')[0]
      form.querySelector('select[name="submittedProblemIndex"]').options = [{value:'J',textContent:'J. Problem'}]
    }})
    const task = {...codeforcesTask(`gym-protocol-${mode}`, {gym:true}),contestId:'106738',problemIndex:'J',
      sourceUrl:'https://codeforces.com/gym/106738/problem/J'}
    const response = system.invokeWorker({
      type:'browserSubmitCodeforces',requestId:task.requestId,nonce:`nonce-${task.requestId}-123456789`,
      userGesture:true,issuedAt:Date.now(),task,
    })
    const fill = await system.state.fillReady.promise
    assert.equal(fill.result.ok,true)
    const query = fill.page.document.querySelectorAll
    const link = makeNode({getAttribute:name=>name==='href'?'/gym/106738/submission/394704185':null})
    fill.page.document.querySelectorAll = selector => selector === 'a[href]' ? [link] : query(selector)
    system.manualSubmit(fill.tabId,'https://codeforces.com/gym/106738/my')
    const outcome = (await response).response
    assert.equal(outcome.ok,true,outcome.error)
    assert.equal(outcome.remoteSubmissionId,'394704185')
    assert.equal(outcome.remoteSubmissionUrl,'https://codeforces.com/gym/106738/submission/394704185')
    assert.equal(protocolCalls,1)
    assert.equal(signal.aborted,true,'the optional request is cleaned up after the callback')
    if (mode==='available') assert.equal(outcome.compileError,'synthetic compiler diagnostic')
  }
})

test('page and worker gates reject invalid origin, frame, message source, task and nonce', async () => {
  const untrusted = makeSystem()
  const untrustedBridge = makeBridge(untrusted, 'https://evil.example/problem/P1001')
  untrustedBridge.click(true)
  const rejectedPing = bridgeMessages('atcoder', atcoderTask('reject-origin'), 'nonce-reject-origin-123456')
  untrustedBridge.emit(rejectedPing.ping)
  assert.equal(untrustedBridge.posts.length, 0, 'an untrusted page origin receives no bridge response')

  const system = makeSystem()
  const bridge = makeBridge(system)
  bridge.click(false)
  const requestId = 'reject-contract-001'
  const messages = bridgeMessages('codeforces', codeforcesTask(requestId), 'nonce-reject-1234567890')
  bridge.emit(messages.ping)
  assert.equal(bridge.posts.length, 0, 'an untrusted click cannot establish a request')

  bridge.click(true)
  bridge.emit(messages.ping)
  assert.equal(bridge.posts.at(-1)?.data.ok, true)
  bridge.emit(messages.submit, { origin: 'https://evil.example' })
  bridge.emit(messages.submit, { source: {} })
  bridge.emit({ ...messages.submit, source: 'OJ_UNKNOWN_SOURCE' })
  bridge.emit({ ...messages.submit, nonce: 'nonce-does-not-match-123456' })
  bridge.emit({ ...messages.submit, task: { ...messages.submit.task, sourceUrl: 'https://evil.example/contest/200002/problem/A' } })
  bridge.emit({ ...messages.submit, task: { ...messages.submit.task, requestId: 'different-task-id' } })
  assert.equal(system.state.runtimeMessages.length, 0, 'invalid page messages never reach the worker')

  const base = {
    type: 'browserSubmitCodeforces',
    requestId: 'worker-reject-001',
    nonce: 'nonce-worker-reject-123456',
    issuedAt: Date.now(),
    userGesture: true,
    task: codeforcesTask('worker-reject-001'),
  }
  const invalidCalls = [
    { message: base, sender: system.appSender({ frameId: 2 }) },
    { message: base, sender: system.appSender({ tab: { id: APP_TAB_ID, url: 'https://evil.example/problem/P1001' } }) },
    { message: { ...base, nonce: 'short' }, sender: system.appSender() },
    { message: { ...base, task: { ...base.task, sourceUrl: 'https://atcoder.jp/contests/200002/tasks/A' } }, sender: system.appSender() },
  ]
  for (const call of invalidCalls) {
    const { response } = await system.invokeWorker(call.message, call.sender)
    assert.equal(response?.ok, false)
  }
  assert.equal(system.state.createdTabs.length, 0, 'rejected worker requests do not route to an OJ')
})

test('Luogu start and poll keep source out of session storage and recover the pinned RID after worker restart', async () => {
  const system = makeSystem()
  const requestId = 'luogu-worker-001'
  const nonce = 'nonce-luogu-worker-123456'
  const task = {
    requestId,
    pid: 'P1001',
    remoteUid: '99',
    remoteLanguageId: '4',
    sourceSha256: SOURCE_SHA256,
    sourceCode: SOURCE_CODE,
    sequence: 0,
    createdAt: new Date().toISOString(),
  }
  const message = { type: 'browserSubmitLuogu', requestId, nonce, issuedAt: Date.now(), userGesture: true, task }
  const sender = system.appSender()

  const { response: started } = await system.invokeWorker(message, sender)
  assert.equal(started?.ok, true)
  assert.equal(started?.phase, 'waiting_user_submit')
  assert.equal(system.state.prepareCount, 1)
  assert.ok(system.state.injected.some((call) => call.files?.includes('platforms/luogu.js')))
  assert.ok(system.state.pages.get(system.state.createdTabs[0].id)?.context.OJLuoguSubmit)
  assert.ok(system.state.pages.get(system.state.createdTabs[0].id)?.context.OJLuoguRecord)

  for (const saved of system.state.storageWrites) {
    const serialized = JSON.stringify(saved)
    assert.equal(serialized.includes(SOURCE_CODE), false)
    assert.equal(/"sourceCode"\s*:/.test(serialized), false)
  }

  const wrongNonce = await system.invokeWorker({ type: 'observeLuogu', requestId, nonce: 'nonce-wrong-luogu-123456' }, sender)
  assert.equal(wrongNonce.response?.ok, false, 'polling is fenced by the task nonce')
  const wrongOwner = await system.invokeWorker({ type: 'observeLuogu', requestId, nonce }, system.appSender({ tab: { id: APP_TAB_ID + 1, url: APP_URL } }))
  assert.equal(wrongOwner.response?.ok, false, 'polling is fenced by the owning app tab')

  system.state.luoguSnapshot = {
    requestId,
    pid: 'P1001',
    remoteUid: '99',
    remoteLanguageId: '4',
    sourceSha256: SOURCE_SHA256,
    phase: 'rid_observed',
    createdAt: Date.now(),
    responseObservedAt: Date.now(),
    remoteSubmissionId: '881004',
  }
  const { response: polled } = await system.invokeWorker({ type: 'observeLuogu', requestId, nonce }, sender)
  assert.equal(polled?.ok, true)
  assert.equal(polled?.remoteSubmissionId, '881004')
  assert.equal(polled?.phase, 'judging')
  assert.equal(system.state.prepareCount, 1, 'polling observes the pinned task and never prepares it again')
  assert.equal(system.state.recordReads.at(-1)?.rid, '881004')

  const oldTabId = system.state.storage.get(`luogu:${requestId}`).tabId
  system.state.tabs.delete(oldTabId)
  system.loadWorker() // Recreate only the service worker; session storage and tabs are Chrome-owned state.
  const { response: recovered } = await system.invokeWorker(message, sender)
  assert.equal(recovered?.ok, true)
  assert.equal(recovered?.phase, 'judging')
  assert.equal(system.state.prepareCount, 1)
  assert.equal(system.state.createdTabs.at(-1)?.url, 'https://www.luogu.com.cn/record/881004')

  const { response: observedAgain } = await system.invokeWorker({ type: 'observeLuogu', requestId, nonce }, sender)
  assert.equal(observedAgain?.remoteSubmissionId, '881004')
  assert.equal(system.state.recordReads.at(-1)?.rid, '881004', 'restart recovery reads the persisted RID')
  for (const saved of system.state.storageWrites) {
    const serialized = JSON.stringify(saved)
    assert.equal(serialized.includes(SOURCE_CODE), false)
    assert.equal(/"sourceCode"\s*:/.test(serialized), false)
  }
})
