(function () {
  const REQUEST_SOURCE = 'OJ_ATCODER_BROWSER_SUBMIT'
  const RESULT_SOURCE = 'OJ_ATCODER_BROWSER_SUBMIT_RESULT'
  const PING_REQUEST_SOURCE = 'OJ_ATCODER_BROWSER_SUBMIT_PING'
  const PING_RESULT_SOURCE = 'OJ_ATCODER_BROWSER_SUBMIT_PONG'
  const CODEFORCES_REQUEST_SOURCE = 'OJ_CODEFORCES_BROWSER_SUBMIT'
  const CODEFORCES_RESULT_SOURCE = 'OJ_CODEFORCES_BROWSER_SUBMIT_RESULT'
  const CODEFORCES_PING_REQUEST_SOURCE = 'OJ_CODEFORCES_BROWSER_SUBMIT_PING'
  const CODEFORCES_PING_RESULT_SOURCE = 'OJ_CODEFORCES_BROWSER_SUBMIT_PONG'

  const REQUEST_TTL_MS = 2 * 60 * 1000
  const MAX_MESSAGE_BYTES = 512 * 1024
  const MAX_SOURCE_BYTES = 256 * 1024
  const pendingRequests = new Map()
  const consumedRequests = new Map()
  let lastTrustedSubmitGestureAt = 0

  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target?.closest?.('[data-browser-submit-action="true"]')) {
      lastTrustedSubmitGestureAt = Date.now()
    }
  }, true)

  const cleanupRequests = () => {
    const now = Date.now()
    for (const [requestId, request] of pendingRequests) {
      if (request.expiresAt <= now) pendingRequests.delete(requestId)
    }
    for (const [requestId, expiresAt] of consumedRequests) {
      if (expiresAt <= now) consumedRequests.delete(requestId)
    }
  }

  const isTrustedAppOrigin = () => {
    if (!window.location?.origin || window.location.origin === 'null') return false
    let url
    try {
      url = new URL(window.location.origin)
    } catch (_error) {
      return false
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const hostname = String(url.hostname || '').toLowerCase()
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true
    return hostname === 'sdustjudge.cn' || hostname.endsWith('.sdustjudge.cn')
  }

  const isTrustedMessageEvent = (event) => (
    isTrustedAppOrigin()
    && event?.source === window
    && event?.origin === window.location.origin
  )

  const isPlainObject = (value) => (
    Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )

  const byteLength = (value) => {
    try {
      return new TextEncoder().encode(String(value || '')).byteLength
    } catch (_error) {
      return String(value || '').length
    }
  }

  const isBoundedString = (value, maxLength) => typeof value === 'string' && value.length > 0 && value.length <= maxLength

  const isValidRequestId = (value) => /^[A-Za-z0-9._:-]{1,128}$/.test(String(value || ''))
  const isValidNonce = (value) => /^[A-Za-z0-9._:-]{16,256}$/.test(String(value || ''))

  const isRecentUserGesture = (issuedAt) => (
    Number.isFinite(Number(issuedAt))
    && Number(issuedAt) <= Date.now() + 5000
    && Date.now() - Number(issuedAt) <= REQUEST_TTL_MS
  )

  const isAllowedRemoteUrl = (value, origin) => {
    if (!value) return true
    try {
      const url = new URL(value)
      return (
        ['http:', 'https:'].includes(url.protocol)
        && !url.username
        && !url.password
        && url.origin === origin
      )
    } catch (_error) {
      return false
    }
  }

  const validateTask = (task, platform, requestId) => {
    if (!isPlainObject(task) || task.requestId !== requestId) return false
    if (!isValidRequestId(task.requestId)) return false
    if (!isBoundedString(task.sourceCode, MAX_SOURCE_BYTES) || byteLength(task.sourceCode) > MAX_SOURCE_BYTES) return false

    const contestKey = String(task.contestKey || task.contestId || '').trim()
    const taskKey = String(task.taskKey || task.problemIndex || '').trim()
    if (!contestKey || contestKey.length > 128 || !taskKey || taskKey.length > 128) return false
    if (!isAllowedRemoteUrl(task.sourceUrl, platform === 'codeforces' ? 'https://codeforces.com' : 'https://atcoder.jp')) return false

    for (const key of ['contestKey', 'contestId', 'taskKey', 'problemIndex', 'remoteLanguageId', 'remoteLanguageName', 'handle']) {
      if (task[key] !== undefined && (!isBoundedString(String(task[key]), 256) || byteLength(String(task[key])) > 1024)) return false
    }

    try {
      return byteLength(JSON.stringify(task)) <= MAX_MESSAGE_BYTES
    } catch (_error) {
      return false
    }
  }

  const validateEnvelope = (data) => (
    isPlainObject(data)
    && isValidRequestId(data.requestId)
    && isValidNonce(data.nonce)
    && data.userGesture === true
    && isRecentUserGesture(data.issuedAt)
    && lastTrustedSubmitGestureAt >= Number(data.issuedAt) - 250
  )

  const postResult = (resultSource, requestId, nonce, payload) => {
    if (!isTrustedAppOrigin()) return
    window.postMessage({
      source: resultSource,
      requestId,
      nonce,
      ...payload,
    }, window.location.origin)
  }

  const bridgeError = (error) => {
    const message = error?.message || String(error || '')
    if (/extension context invalidated|receiving end does not exist|context invalid/i.test(message)) {
      return '浏览器插件上下文已失效，请刷新 OJ 页面并确认插件已启用。'
    }
    return '浏览器插件通信失败，请刷新 OJ 页面并确认插件已启用。'
  }

  window.addEventListener('message', (event) => {
    if (!isTrustedMessageEvent(event)) return
    cleanupRequests()

    const data = event.data
    if (!isPlainObject(data)) return
    try {
      if (byteLength(JSON.stringify(data)) > MAX_MESSAGE_BYTES) return
    } catch (_error) {
      return
    }

    const isLuoguPing = data.source === 'OJ_LUOGU_BROWSER_SUBMIT_PING' && data.type === 'ping'
    const isAtCoderPing = data.source === PING_REQUEST_SOURCE && data.type === 'ping'
    const isCodeforcesPing = data.source === CODEFORCES_PING_REQUEST_SOURCE && data.type === 'ping'
    if (isAtCoderPing || isCodeforcesPing || isLuoguPing) {
      if (!validateEnvelope(data) || pendingRequests.has(data.requestId) || consumedRequests.has(data.requestId)) return
      pendingRequests.set(data.requestId, {
        nonce: data.nonce,
        expiresAt: Date.now() + REQUEST_TTL_MS,
      })
      const resultSource = isLuoguPing ? 'OJ_LUOGU_BROWSER_SUBMIT_PONG' : isCodeforcesPing ? CODEFORCES_PING_RESULT_SOURCE : PING_RESULT_SOURCE
      if (!globalThis.chrome?.runtime?.id) {
        postResult(resultSource, data.requestId, data.nonce, {
          ok: false,
          error: '未检测到浏览器插件运行环境，请刷新 OJ 页面并确认插件已启用。',
        })
      } else {
        postResult(resultSource, data.requestId, data.nonce, { ok: true, type: 'pong' })
      }
      return
    }

    if (data.source === 'OJ_LUOGU_BROWSER_SUBMIT' && data.type === 'browserSubmitLuogu') {
      if (!validateEnvelope(data) || !isPlainObject(data.task) || data.task.requestId !== data.requestId
        || !/^[PB][1-9]\d*$/.test(data.task.pid || '')
        || !/^[0-9a-f]{64}$/.test(data.task.sourceSha256 || '')
        || !/^[1-9]\d{0,5}$/.test(String(data.task.remoteLanguageId || ''))
        || !isBoundedString(data.task.sourceCode, MAX_SOURCE_BYTES) || byteLength(data.task.sourceCode) > MAX_SOURCE_BYTES) return
      const pending = pendingRequests.get(data.requestId)
      if (!pending || pending.nonce !== data.nonce || pending.expiresAt <= Date.now()) return
      pendingRequests.delete(data.requestId)
      consumedRequests.set(data.requestId, Date.now() + REQUEST_TTL_MS)
      const deadline = Date.now() + 20 * 60 * 1000
      const relay = (type, task) => {
        try {
          chrome.runtime.sendMessage({ type, requestId: data.requestId, nonce: data.nonce,
            issuedAt: data.issuedAt, userGesture: true, ...(task ? { task } : {}) }, (response) => {
            const failed = chrome.runtime.lastError
            const value = failed || !response ? { ok: false, done: false, phase: 'result_unknown', error: bridgeError(failed) } : response
            postResult('OJ_LUOGU_BROWSER_SUBMIT_PROGRESS', data.requestId, data.nonce, value)
            if (value.done || !value.ok || ['result_unknown', 'cancelled', 'failed'].includes(value.phase) || Date.now() >= deadline) {
              postResult('OJ_LUOGU_BROWSER_SUBMIT_RESULT', data.requestId, data.nonce,
                Date.now() >= deadline ? { ...value, ok: false, done: false, phase: 'result_unknown', error: '观察已超时，请保留原站记录后继续观察' } : value)
              return
            }
            window.setTimeout(() => relay('observeLuogu'), 2000)
          })
        } catch (error) {
          postResult('OJ_LUOGU_BROWSER_SUBMIT_RESULT', data.requestId, data.nonce, { ok: false, done: false, phase: 'result_unknown', error: bridgeError(error) })
        }
      }
      relay('browserSubmitLuogu', data.task)
      return
    }

    const isAtCoder = data.source === REQUEST_SOURCE && data.type === 'submit'
    const isCodeforces = data.source === CODEFORCES_REQUEST_SOURCE && data.type === 'browserSubmitCodeforces'
    if (!isAtCoder && !isCodeforces) return
    if (!validateEnvelope(data) || !validateTask(data.task, isCodeforces ? 'codeforces' : 'atcoder', data.requestId)) return

    const pending = pendingRequests.get(data.requestId)
    if (!pending || pending.nonce !== data.nonce || pending.expiresAt <= Date.now()) return
    pendingRequests.delete(data.requestId)
    consumedRequests.set(data.requestId, Date.now() + REQUEST_TTL_MS)

    const resultSource = isCodeforces ? CODEFORCES_RESULT_SOURCE : RESULT_SOURCE
    try {
      if (!globalThis.chrome?.runtime?.id) {
        postResult(resultSource, data.requestId, data.nonce, {
          ok: false,
          error: '未检测到浏览器插件运行环境，请刷新 OJ 页面并确认插件已安装启用。',
        })
        return
      }
      chrome.runtime.sendMessage(
        {
          type: isCodeforces ? 'browserSubmitCodeforces' : 'submitAtCoder',
          requestId: data.requestId,
          nonce: data.nonce,
          issuedAt: data.issuedAt,
          userGesture: true,
          task: data.task,
        },
        (response) => {
          const lastError = chrome.runtime.lastError
          if (lastError) {
            postResult(resultSource, data.requestId, data.nonce, {
              ok: false,
              error: bridgeError(lastError),
            })
            return
          }
          postResult(resultSource, data.requestId, data.nonce, response || {
            ok: false,
            error: '浏览器插件未返回结果，请稍后重试。',
          })
        },
      )
    } catch (error) {
      postResult(resultSource, data.requestId, data.nonce, {
        ok: false,
        error: bridgeError(error),
      })
    }
  })
}())

// Luogu uses short runtime requests so MV3 worker suspension does not lose a long callback.
// Reuse the same trusted-click, nonce and origin checks in the original bridge.
