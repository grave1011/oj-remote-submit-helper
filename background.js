// Shared worker entry: trusted app messages, validation and platform dispatch.
// Platform adapters own site-specific selectors, language handling and records.
importScripts('platforms/atcoder.js', 'platforms/codeforces.js', 'platforms/luogu.js')

const REQUEST_TTL_MS = 2 * 60 * 1000
const MAX_MESSAGE_BYTES = 512 * 1024
const MAX_SOURCE_BYTES = 256 * 1024
const consumedRequests = new Map()

function byteLength(value) {
  try {
    return new TextEncoder().encode(String(value || '')).byteLength
  } catch (_error) {
    return String(value || '').length
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isValidRequestId(value) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(String(value || ''))
}

function isValidNonce(value) {
  return /^[A-Za-z0-9._:-]{16,256}$/.test(String(value || ''))
}

function isRecentUserGesture(value) {
  return Number.isFinite(Number(value))
    && Number(value) <= Date.now() + 5000
    && Date.now() - Number(value) <= REQUEST_TTL_MS
}

function isTrustedAppUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    const hostname = String(url.hostname || '').toLowerCase()
    const trustedHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
      || hostname === 'sdustjudge.cn'
      || hostname.endsWith('.sdustjudge.cn')
    if (!trustedHost) return false
    return (
      /^\/problem\/[^/]+(?:\/|$)/.test(url.pathname)
      || /^\/solution\/[^/]+(?:\/|$)/.test(url.pathname)
      || /^\/contests\/[^/]+\/problems\/[^/]+(?:\/|$)/.test(url.pathname)
      || /^\/courses\/[^/]+\/(?:homework|contests|exams)\/[^/]+\/problems\/[^/]+(?:\/|$)/.test(url.pathname)
    )
  } catch (_error) {
    return false
  }
}

function isAllowedRemoteSourceUrl(value, origin) {
  if (!value) return true
  try {
    const url = new URL(String(value))
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && url.origin === origin
  } catch (_error) {
    return false
  }
}

function validateBridgeTask(task, remoteOj, requestId) {
  if (!isPlainObject(task) || task.requestId !== requestId || !isValidRequestId(task.requestId)) return false
  if (typeof task.sourceCode !== 'string' || !task.sourceCode.trim() || byteLength(task.sourceCode) > MAX_SOURCE_BYTES) return false
  if (remoteOj === 'luogu') {
    return OJLuoguPlatform.validateTask(task) && byteLength(JSON.stringify(task)) <= MAX_MESSAGE_BYTES
  }
  const contestKey = String(task.contestKey || task.contestId || '').trim()
  const taskKey = String(task.taskKey || task.problemIndex || '').trim()
  if (!contestKey || contestKey.length > 128 || !taskKey || taskKey.length > 128) return false
  const expectedOrigin = remoteOj === 'codeforces' ? OJCodeforcesPlatform.origin : OJAtCoderPlatform.origin
  if (!isAllowedRemoteSourceUrl(task.sourceUrl, expectedOrigin)) return false
  for (const key of ['contestKey', 'contestId', 'taskKey', 'problemIndex', 'remoteLanguageId', 'remoteLanguageName', 'handle']) {
    if (task[key] !== undefined && String(task[key]).length > 256) return false
  }
  try {
    return byteLength(JSON.stringify(task)) <= MAX_MESSAGE_BYTES
  } catch (_error) {
    return false
  }
}

function validateRequest(message, sender, remoteOj) {
  if (sender?.id !== chrome.runtime.id || sender?.frameId !== 0 || !sender?.tab?.id) return false
  if (!isTrustedAppUrl(sender.tab.url || sender.documentUrl)) return false
  if (!isPlainObject(message) || !isValidRequestId(message.requestId) || !isValidNonce(message.nonce)) return false
  if (message.userGesture !== true || !isRecentUserGesture(message.issuedAt)) return false
  if (!validateBridgeTask(message.task, remoteOj, message.requestId)) return false
  try {
    return byteLength(JSON.stringify(message)) <= MAX_MESSAGE_BYTES
  } catch (_error) {
    return false
  }
}

function requestKey(message, sender) {
  return String(sender?.tab?.id || 'no-tab') + ':' + String(message?.requestId || 'no-request')
}

function cleanupConsumedRequests() {
  const now = Date.now()
  for (const [key, expiresAt] of consumedRequests) {
    if (expiresAt <= now) consumedRequests.delete(key)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type
  if (type === 'browserSubmitLuogu' || type === 'observeLuogu') {
    const start = message.type === 'browserSubmitLuogu'
    if (sender?.id !== chrome.runtime.id || sender?.frameId !== 0 || !sender?.tab?.id
      || !isTrustedAppUrl(sender.tab.url) || !isValidRequestId(message.requestId) || !isValidNonce(message.nonce)
      || (start && !validateRequest(message, sender, 'luogu'))) {
      sendResponse({ ok: false, phase: 'failed', error: '洛谷浏览器任务来源或格式无效' })
      return false
    }
    ;(start ? OJLuoguPlatform.start(message, sender) : OJLuoguPlatform.observe(message, sender))
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, done: false, phase: 'result_unknown', error: '洛谷观察暂不可用，请保留原站记录后继续观察；不要自动重复提交' }))
    return true
  }
  const isAtCoder = type === 'submitAtCoder'
  const isCodeforces = type === 'browserSubmitCodeforces'
  if (!isAtCoder && !isCodeforces) return false
  const remoteOj = isCodeforces ? 'codeforces' : 'atcoder'
  cleanupConsumedRequests()
  const key = requestKey(message, sender)
  if (!validateRequest(message, sender, remoteOj) || consumedRequests.has(key)) {
    sendResponse({ ok: false, remoteOj, requestId: message?.requestId, error: '浏览器提交请求来源或格式无效。' })
    return false
  }
  consumedRequests.set(key, Date.now() + REQUEST_TTL_MS)
  const logPrefix = isCodeforces ? '[codeforces-submit]' : '[atcoder-submit]'
  console.log(`${logPrefix} request received`, {
    requestId: message.task?.requestId,
    contestKey: message.task?.contestKey,
    contestId: message.task?.contestId,
    taskKey: message.task?.taskKey,
    problemIndex: message.task?.problemIndex,
    senderTabId: sender?.tab?.id,
  })
  const runner = isCodeforces ? OJCodeforcesPlatform.submit : OJAtCoderPlatform.submit
  runner(message.task)
    .then((result) => {
      const response = { remoteOj, requestId: message.requestId, nonce: message.nonce, ...result }
      console.log(`${logPrefix} request finished`, response)
      sendResponse(response)
    })
    .catch((error) => {
      console.error(`${logPrefix} request failed`, error)
      sendResponse({ ok: false, remoteOj, requestId: message.requestId, nonce: message.nonce, error: error?.message || String(error) })
    })
  return true
})
