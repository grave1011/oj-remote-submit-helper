// Luogu adapter: original form preparation, request observation, record reading,
// and worker task orchestration. This file can also be injected in MAIN world.
;(function (root) {
// Submission observer. Its version guard retains an already armed task.
(function (root, factory) {
  if (root.OJLuoguSubmit?.version === 1) {
    if (typeof module === 'object' && module.exports) module.exports = root.OJLuoguSubmit
    return
  }
  const api = Object.freeze(factory())
  root.OJLuoguSubmit = api
  if (typeof module === 'object' && module.exports) module.exports = api
})(globalThis, function () {
  const ORIGIN = 'https://www.luogu.com.cn'
  const KEY = '__oj_lite_luogu_submission_v1__'
  const PHASES = new Set(['waiting_user_submit', 'submitting', 'waiting_verification', 'rid_observed', 'result_unknown', 'cancelled', 'failed'])
  let current = null
  let installed = false
  let pending = 0

  const validId = (value) => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,19}$/.test(String(value))
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
  function validate(expected) {
    if (!expected || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(expected.requestId || ''))
      || !/^[PB][1-9]\d*$/.test(String(expected.pid || ''))
      || !validId(expected.remoteUid) || !validId(expected.remoteLanguageId)
      || !/^[0-9a-f]{64}$/.test(String(expected.sourceSha256 || ''))) {
      fail('LUOGU_OBSERVER_TASK_INVALID', '提交观察任务缺少有效的请求标识、身份、题号、语言或源码指纹')
    }
    let url
    try { url = new URL(expected.submitUrl) } catch { /* Reject below. */ }
    if (!url || url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
      || url.pathname !== `/fe/api/problem/submit/${expected.pid}`) {
      fail('LUOGU_SUBMIT_ROUTE_MISMATCH', '提交路径与已确认的原站普通题接口不一致')
    }
  }

  function safeSnapshot(value) {
    if (!value || !PHASES.has(value.phase)) return null
    try { validate(value) } catch { return null }
    const result = {
      requestId: value.requestId, pid: value.pid,
      remoteUid: String(value.remoteUid), remoteLanguageId: String(value.remoteLanguageId),
      sourceSha256: value.sourceSha256, submitUrl: value.submitUrl,
      phase: value.phase, createdAt: value.createdAt, expiresAt: value.expiresAt,
      requestCount: value.requestCount, sequence: value.sequence,
      verificationStatus: 'client_reported', verificationScope: 'none',
    }
    for (const key of ['createdAt', 'expiresAt', 'requestCount', 'sequence']) {
      if (!Number.isSafeInteger(result[key]) || result[key] < 0) return null
    }
    if (value.expiresAt < value.createdAt) return null
    if (validId(value.remoteSubmissionId)) {
      result.remoteSubmissionId = String(value.remoteSubmissionId)
      result.remoteSubmissionUrl = `${ORIGIN}/record/${result.remoteSubmissionId}`
    }
    if (validId(value.unmatchedRecordId)) result.unmatchedRecordId = String(value.unmatchedRecordId)
    for (const key of ['requestStartedAt', 'responseObservedAt']) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key]
    }
    if (typeof value.errorCode === 'string' && /^LUOGU_[A-Z_]{1,80}$/.test(value.errorCode)) result.errorCode = value.errorCode
    if (typeof value.requestCodeMatched === 'boolean') result.requestCodeMatched = value.requestCodeMatched
    if (typeof value.requestLanguageMatched === 'boolean') result.requestLanguageMatched = value.requestLanguageMatched
    if (value.correlation === 'original_submit_response') result.correlation = value.correlation
    return result
  }

  function store() {
    current.sequence += 1
    try { sessionStorage.setItem(KEY, JSON.stringify(safeSnapshot(current))) } catch { /* In-memory capture remains available. */ }
  }
  function snapshot(requestId) {
    if (!current) {
      try { current = safeSnapshot(JSON.parse(sessionStorage.getItem(KEY) || 'null')) } catch { return null }
      // A new document cannot recover a response that belonged to its predecessor.
      if (current && !current.remoteSubmissionId
        && ['waiting_user_submit', 'waiting_verification', 'submitting'].includes(current.phase)) {
        current.phase = 'result_unknown'
        current.errorCode = 'LUOGU_PAGE_OBSERVATION_INTERRUPTED'
        store()
      }
    }
    if (!current || current.requestId !== requestId) return null
    if (!current.remoteSubmissionId && current.expiresAt <= Date.now()
      && ['waiting_user_submit', 'submitting', 'waiting_verification'].includes(current.phase)) {
      current.phase = 'result_unknown'
      current.errorCode = 'LUOGU_OBSERVATION_EXPIRED'
      store()
    }
    return safeSnapshot(current)
  }

  // Pure association rule. Callers hash only code/lang, never headers or captcha data.
  function classifyResponse(expected, observed) {
    validate(expected)
    let url
    try { url = new URL(observed.url) } catch { return { phase: 'unrelated' } }
    if (String(observed.method || '').toUpperCase() !== 'POST' || url.href !== expected.submitUrl) return { phase: 'unrelated' }
    const payload = observed.payload && typeof observed.payload === 'object' ? observed.payload : null
    const rid = validId(payload?.rid) ? String(payload.rid) : null
    if (observed.sourceSha256 !== expected.sourceSha256
      || String(observed.remoteLanguageId || '') !== String(expected.remoteLanguageId)) {
      return {
        phase: 'result_unknown', errorCode: 'LUOGU_SUBMIT_CONTENT_MISMATCH',
        requestCodeMatched: observed.sourceSha256 === expected.sourceSha256,
        requestLanguageMatched: String(observed.remoteLanguageId || '') === String(expected.remoteLanguageId),
        ...(rid && observed.status >= 200 && observed.status < 300 ? { unmatchedRecordId: rid } : {}),
      }
    }
    if (observed.status >= 200 && observed.status < 300 && rid) {
      return {
        phase: 'rid_observed', remoteSubmissionId: rid,
        remoteSubmissionUrl: `${ORIGIN}/record/${rid}`,
        correlation: 'original_submit_response', requestCodeMatched: true, requestLanguageMatched: true,
      }
    }
    const type = typeof payload?.errorType === 'string' ? payload.errorType : ''
    if (/(?:^|\\)(?:CaptchaNotMatchException|InvalidCaptchaException)$/.test(type)) {
      return { phase: 'waiting_verification', errorCode: 'LUOGU_USER_VERIFICATION_REQUIRED' }
    }
    return { phase: 'result_unknown', errorCode: 'LUOGU_SUBMIT_RID_NOT_OBSERVED' }
  }

  async function bodyIdentity(body) {
    if (typeof body !== 'string' || body.length > 512 * 1024) return {}
    let fields
    try { fields = JSON.parse(body) } catch { return {} }
    if (typeof fields?.code !== 'string' || new TextEncoder().encode(fields.code).length > 256 * 1024) return {}
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fields.code))
    return {
      sourceSha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
      remoteLanguageId: validId(fields.lang) ? String(fields.lang) : '',
    }
  }
  function begin(url, method, body) {
    if (!current || Date.now() >= current.expiresAt
      || !['waiting_user_submit', 'waiting_verification', 'submitting'].includes(current.phase)) return null
    let target
    try { target = new URL(url, ORIGIN) } catch { return null }
    if (target.href !== current.submitUrl || String(method).toUpperCase() !== 'POST') return null
    pending += 1
    current.requestCount += 1
    current.requestStartedAt = Date.now()
    current.phase = pending > 1 ? 'result_unknown' : 'submitting'
    if (pending > 1) current.errorCode = 'LUOGU_CONCURRENT_SUBMIT_REQUESTS'
    store()
    return { task: current, startedAt: current.requestStartedAt, identity: Promise.resolve(body).then(bodyIdentity).catch(() => ({})) }
  }
  async function finish(capture, status, payload) {
    if (!capture || capture.task !== current || capture.finished) return
    capture.finished = true
    const identity = await capture.identity
    const observation = classifyResponse(capture.task, {
      url: capture.task.submitUrl, method: 'POST', status, payload, ...identity,
    })
    pending = Math.max(0, pending - 1)
    const interrupted = ['result_unknown', 'cancelled', 'failed'].includes(current.phase)
    if (current.remoteSubmissionId && observation.remoteSubmissionId
      && current.remoteSubmissionId !== observation.remoteSubmissionId) {
      current.phase = 'result_unknown'
      current.errorCode = 'LUOGU_MULTIPLE_RECORDS_OBSERVED'
      current.unmatchedRecordId = observation.remoteSubmissionId
    } else {
      const oldPhase = current.phase
      const oldError = current.errorCode
      Object.assign(current, observation)
      if (interrupted) {
        current.phase = oldPhase
        if (oldError) current.errorCode = oldError
      } else if (!observation.errorCode) delete current.errorCode
    }
    current.responseObservedAt = Date.now()
    store()
  }
  const parsePayload = (body) => {
    if (typeof body !== 'string' || body.length > 64 * 1024) return null
    try { return JSON.parse(body) } catch { return null }
  }

  function install() {
    if (installed) return
    if (typeof window.fetch !== 'function' || typeof globalThis.XMLHttpRequest?.prototype?.open !== 'function'
      || typeof globalThis.XMLHttpRequest?.prototype?.send !== 'function') {
      fail('LUOGU_OBSERVER_UNAVAILABLE', '当前页面不支持原站提交请求观察')
    }
    installed = true
    const originalFetch = window.fetch
    window.fetch = function (input, init) {
      // Clone only the matching request body. Never inspect request headers.
      let capture = null
      try {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
        const method = init?.method || input?.method || 'GET'
        if (current && url && new URL(url, location.href).href === current.submitUrl && String(method).toUpperCase() === 'POST') {
          let body = init?.body
          if (body === undefined && typeof input?.clone === 'function') {
            try { body = input.clone().text() } catch { body = undefined }
          }
          capture = begin(url, method, body)
        }
      } catch { /* Observation must not change the original fetch call. */ }
      let promise
      try { promise = originalFetch.apply(this, arguments) } catch (failure) {
        if (capture) finish(capture, 0, null).catch(() => {})
        throw failure
      }
      if (capture) promise.then(async (response) => {
        const body = await response.clone().text()
        await finish(capture, response.status, parsePayload(body))
      }, () => finish(capture, 0, null)).catch(() => finish(capture, 0, null).catch(() => {}))
      return promise // The original caller receives the original promise unchanged.
    }
    const requests = new WeakMap()
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (method, url) {
      const result = originalOpen.apply(this, arguments)
      try { requests.set(this, { method, url: new URL(String(url), location.href).href }) } catch { requests.delete(this) }
      return result
    }
    XMLHttpRequest.prototype.send = function (body) {
      const request = requests.get(this)
      const capture = request ? begin(request.url, request.method, body) : null
      if (capture) this.addEventListener('loadend', () => {
        let payload = null
        let status = 0
        try {
          status = this.status
          payload = this.responseType === 'json' ? this.response : parsePayload(this.responseText)
        } catch { /* Unknown response. */ }
        finish(capture, status, payload).catch(() => {})
      }, { once: true })
      try { return originalSend.apply(this, arguments) } catch (failure) {
        if (capture) finish(capture, 0, null).catch(() => {})
        throw failure
      }
    }
  }

  function arm(expected) {
    validate(expected)
    if (location.origin !== ORIGIN || location.pathname !== `/problem/${expected.pid}`) {
      fail('LUOGU_OBSERVER_PAGE_MISMATCH', '请在本任务对应的洛谷题目页准备提交')
    }
    const previous = snapshot(expected.requestId)
    if (current && !previous) fail('LUOGU_OBSERVER_TASK_EXISTS', '此标签页已有其他提交任务，请保留其记录并使用新的任务标签页')
    if (previous) {
      if (previous.sourceSha256 !== expected.sourceSha256 || previous.pid !== expected.pid
        || previous.remoteUid !== String(expected.remoteUid) || previous.remoteLanguageId !== String(expected.remoteLanguageId)) {
        fail('LUOGU_OBSERVER_TASK_MISMATCH', '恢复任务的身份或源码指纹与原任务不一致')
      }
      if (['waiting_user_submit', 'waiting_verification'].includes(previous.phase)) install()
      return previous // Bound/unknown tasks are never silently armed for a new submission.
    }
    current = {
      requestId: expected.requestId, pid: expected.pid, remoteUid: String(expected.remoteUid),
      remoteLanguageId: String(expected.remoteLanguageId), sourceSha256: expected.sourceSha256,
      submitUrl: expected.submitUrl, phase: 'waiting_user_submit', createdAt: Date.now(),
      expiresAt: Date.now() + 20 * 60 * 1000, requestCount: 0, sequence: 0,
    }
    store()
    install()
    return safeSnapshot(current)
  }
  function disarm(requestId) {
    if (!snapshot(requestId)) return null
    current.phase = 'cancelled'
    store()
    return safeSnapshot(current) // A known RID is retained after local cancellation.
  }
  return { version: 1, arm, snapshot, disarm, classifyResponse }
})
;

// Original-page record reader.
(function (root, factory) {
  const api = Object.freeze(factory())
  root.OJLuoguRecord = api
  if (typeof module === 'object' && module.exports) module.exports = api
})(globalThis, function () {
  const ORIGIN = 'https://www.luogu.com.cn'
  const PARSER_VERSION = 'luogu-record-1'
  const ALIASES = new Map([
    ['AC', ['AC', 'Accepted', '答案正确', '通过']],
    ['WA', ['WA', 'Wrong Answer', '答案错误']],
    ['CE', ['CE', 'Compile Error', 'Compilation Error', '编译错误']],
    ['TLE', ['TLE', 'Time Limit Exceeded', '时间超限']],
    ['MLE', ['MLE', 'Memory Limit Exceeded', '内存超限']],
    ['RE', ['RE', 'Runtime Error', '运行错误']],
    ['OLE', ['OLE', 'Output Limit Exceeded', '输出超限']],
    ['PE', ['PE', 'Presentation Error', '格式错误']],
    ['SE', ['SE', 'System Error', '系统错误']],
    ['UKE', ['UKE', 'Unknown Error', '未知错误']],
    ['UNACCEPTED', ['UNAC', 'Unaccepted', '部分通过']],
    ['WAITING', ['WAITING', 'PENDING', 'WJ', 'Waiting', '等待评测', '等待中']],
    ['JUDGING', ['JUDGING', 'RUNNING', 'COMPILING', 'Judging', '评测中', '正在评测', '编译中']],
  ])
  const normalizedLabel = (value) => String(value || '').replace(/[\s_.-]+/g, '').toUpperCase()
  const labels = new Map(Array.from(ALIASES).flatMap(([verdict, names]) => names.map((name) => [normalizedLabel(name), verdict])))
  const TERMINAL = new Set(['AC', 'WA', 'CE', 'TLE', 'MLE', 'RE', 'OLE', 'PE', 'SE', 'UKE', 'UNACCEPTED'])
  const error = (code, message) => Object.assign(new Error(message), { code })
  const id = (value) => typeof value === 'string' || Number.isSafeInteger(value)
    ? (/^[1-9]\d{0,19}$/.test(String(value)) ? String(value) : '') : ''
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined
  const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))

  function validateExpected(expected) {
    if (!expected || !id(expected.rid) || !id(expected.remoteUid)
      || !id(expected.remoteLanguageId) || !/^[PB][1-9]\d*$/.test(String(expected.pid || ''))) {
      throw error('LUOGU_RECORD_TASK_INVALID', '记录观察任务缺少明确的 RID、UID、题号或语言')
    }
    if (expected.sourceSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expected.sourceSha256)) {
      throw error('LUOGU_RECORD_TASK_INVALID', '记录观察任务的源码指纹无效')
    }
    for (const key of ['submittedAfter', 'submittedBefore']) {
      if (expected[key] !== undefined && (typeof expected[key] !== 'number'
        || !Number.isFinite(expected[key]) || expected[key] < 0)) {
        throw error('LUOGU_RECORD_TASK_INVALID', '记录观察任务的时间范围无效')
      }
    }
    if (expected.submittedAfter !== undefined && expected.submittedBefore !== undefined
      && expected.submittedBefore < expected.submittedAfter) {
      throw error('LUOGU_RECORD_TASK_INVALID', '记录观察任务的时间范围无效')
    }
  }

  function statusInfo(rawStatus, config) {
    if (!Number.isSafeInteger(rawStatus) || !config || typeof config !== 'object') return { verdict: null, name: undefined }
    const entries = Object.values(config).filter((entry) => entry && typeof entry === 'object' && entry.id === rawStatus)
    let entry = entries.length === 1 ? entries[0] : null
    if (!entry && entries.length === 0 && config[String(rawStatus)] && typeof config[String(rawStatus)] === 'object') {
      const candidate = config[String(rawStatus)]
      if (candidate.id === undefined || candidate.id === rawStatus) entry = candidate
    }
    if (!entry) return { verdict: null, name: undefined }
    const short = labels.get(normalizedLabel(entry.shortName))
    const long = labels.get(normalizedLabel(entry.name))
    // A contradictory current config must not turn a pending status into AC.
    const disagree = short && long && short !== long
      && (TERMINAL.has(short) || TERMINAL.has(long))
    const verdict = disagree ? null : long || short || null
    return { verdict, name: text(entry.name, 128) || text(entry.shortName, 128) }
  }

  function normalizeRecord(context, expected, configs) {
    validateExpected(expected)
    const data = context?.data
    const record = data?.record
    if (context?.template !== 'record.show' || !record || id(record.id) !== id(expected.rid)) {
      throw error('LUOGU_RECORD_MISMATCH', '原站返回的记录与已绑定 RID 不一致')
    }
    if (id(record.user?.uid) !== id(expected.remoteUid) || record.problem?.pid !== expected.pid
      || id(record.language) !== id(expected.remoteLanguageId) || record.contest) {
      throw error('LUOGU_RECORD_IDENTITY_MISMATCH', '记录的提交人、题号、语言或提交范围与任务不一致')
    }
    if (data.canViewStatus !== true) throw error('LUOGU_RESULT_PRIVATE', '当前原站会话无权读取此记录的评测结果')
    const submittedMs = typeof record.submitTime === 'number' ? record.submitTime * 1000 : NaN
    if (!Number.isFinite(submittedMs) || submittedMs <= 0 || submittedMs > 8.64e15) {
      throw error('LUOGU_RECORD_TIME_INVALID', '原站记录缺少可识别的提交时间')
    }
    if ((Number.isFinite(expected.submittedAfter) && submittedMs + 1000 < expected.submittedAfter)
      || (Number.isFinite(expected.submittedBefore) && submittedMs > expected.submittedBefore)) {
      throw error('LUOGU_RECORD_TIME_MISMATCH', '记录提交时间不在本任务的允许范围内')
    }
    const warnings = new Set()
    const statuses = configs?.RecordStatus
    const rootStatus = statusInfo(record.status, statuses)
    if (!rootStatus.verdict) warnings.add('UNKNOWN_RECORD_STATUS')
    const done = TERMINAL.has(rootStatus.verdict)
    const detail = record.detail && typeof record.detail === 'object' ? record.detail : {}
    const compile = detail.compileResult && typeof detail.compileResult === 'object' ? detail.compileResult : {}
    if (typeof compile.message === 'string' && compile.message.length > 32768) warnings.add('DETAILS_TRUNCATED')
    const judge = detail.judgeResult && typeof detail.judgeResult === 'object' ? detail.judgeResult : {}
    const asList = (value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : null
    let remainingCases = 2000
    const caseResult = (item) => {
      const status = statusInfo(item?.status, statuses)
      if (!status.verdict) warnings.add('UNKNOWN_CASE_STATUS')
      return defined({
        id: integer(item?.id), rawStatus: integer(item?.status),
        verdict: status.verdict || undefined, statusName: status.name,
        score: number(item?.score), timeMs: number(item?.time), memoryKiB: number(item?.memory),
      })
    }
    const rawSubtasks = asList(judge.subtasks)
    let subtasks
    if (rawSubtasks) {
      if (rawSubtasks.length > 256) warnings.add('DETAILS_TRUNCATED')
      subtasks = rawSubtasks.slice(0, 256).map((subtask) => {
        const status = statusInfo(subtask?.status, statuses)
        if (!status.verdict) warnings.add('UNKNOWN_SUBTASK_STATUS')
        const cases = asList(subtask?.testCases)
        const kept = cases?.slice(0, remainingCases)
        if (cases && kept.length !== cases.length) warnings.add('DETAILS_TRUNCATED')
        remainingCases -= kept?.length || 0
        return defined({
          id: integer(subtask?.id), rawStatus: integer(subtask?.status),
          verdict: status.verdict || undefined, statusName: status.name,
          score: number(subtask?.score), timeMs: number(subtask?.time), memoryKiB: number(subtask?.memory),
          testCases: kept?.map(caseResult),
        })
      })
    }
    const languages = configs?.CodeLanguage
    const language = languages && typeof languages === 'object'
      ? Object.values(languages).find((entry) => entry && id(entry.id) === id(record.language)) : null
    return defined({
      ok: true, parserVersion: PARSER_VERSION,
      remoteSubmissionId: id(record.id), remoteSubmissionUrl: `${ORIGIN}/record/${id(record.id)}`,
      remoteUid: id(record.user.uid), pid: record.problem.pid,
      remoteLanguageId: id(record.language), remoteLanguageName: text(language?.name, 128),
      remoteSubmittedAt: new Date(submittedMs).toISOString(),
      rawStatus: integer(record.status), remoteStatusName: rootStatus.name,
      done, phase: done ? 'completed' : rootStatus.verdict ? 'judging' : 'result_unknown',
      verdict: done ? rootStatus.verdict : null,
      score: number(record.score), timeMs: number(record.time), memoryKiB: number(record.memory),
      compileSuccess: typeof compile.success === 'boolean' ? compile.success : undefined,
      compileError: text(compile.message, 32768),
      finishedCaseCount: integer(judge.finishedCaseCount), subtasks,
      detailsTruncated: warnings.has('DETAILS_TRUNCATED'), parseWarnings: Array.from(warnings),
      resultSource: 'browser_observed', resultTransport: 'browser_observer',
      verificationStatus: 'client_reported', verificationScope: 'none',
    })
  }

  async function readConfigs() {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
    const configDatabase = ['lfeConfig', 'lentilleConfig'].find((name) => databases.some((database) => database.name === name))
    if (!configDatabase) {
      throw error('LUOGU_CONFIG_UNAVAILABLE', '原站状态配置缓存尚不可用')
    }
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(configDatabase)
      let db = null
      let settled = false
      const finish = (failure, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        db?.close()
        if (failure) reject(failure)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(error('LUOGU_CONFIG_UNAVAILABLE', '原站状态配置读取超时')), 5000)
      open.onupgradeneeded = () => open.transaction.abort()
      open.onerror = () => finish(error('LUOGU_CONFIG_UNAVAILABLE', '无法读取原站公开状态配置'))
      open.onblocked = () => finish(error('LUOGU_CONFIG_UNAVAILABLE', '原站公开状态配置正被锁定'))
      open.onsuccess = () => {
        db = open.result
        if (settled) { db.close(); return }
        if (!db.objectStoreNames.contains('keyvaluepairs')) {
          finish(error('LUOGU_CONFIG_UNAVAILABLE', '原站配置缓存结构已改变'))
          return
        }
        const transaction = db.transaction('keyvaluepairs', 'readonly')
        const store = transaction.objectStore('keyvaluepairs')
        const statuses = store.get('RecordStatus')
        const languages = store.get('CodeLanguage')
        const version = store.get('_version')
        transaction.onerror = () => {}
        transaction.onabort = () => finish(error('LUOGU_CONFIG_UNAVAILABLE', '读取原站公开状态配置失败'))
        transaction.oncomplete = () => finish(null, {
          RecordStatus: statuses.result, CodeLanguage: languages.result,
          version: typeof version.result === 'string' ? version.result.slice(0, 128) : undefined,
        })
      }
    })
  }

  async function readFromPage(expected) {
    let controller
    let timer
    try {
      validateExpected(expected)
      if (location.origin !== ORIGIN) throw error('LUOGU_ORIGIN_MISMATCH', '记录观察必须在洛谷原站标签页运行')
      controller = new AbortController()
      timer = setTimeout(() => controller.abort(), 10000)
      // Always read the pinned RID, even if the tab navigated to another record.
      const response = await fetch(`${ORIGIN}/record/${id(expected.rid)}`, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
        redirect: 'error', headers: { Accept: 'text/html' }, signal: controller.signal,
      })
      if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) {
        throw error('LUOGU_RECORD_UNAVAILABLE', '原站记录暂不可读取，请在原站检查登录与访问权限')
      }
      const html = await response.text()
      if (html.length > 3 * 1024 * 1024) throw error('LUOGU_RECORD_TOO_LARGE', '原站记录数据超过本次读取范围')
      const node = new DOMParser().parseFromString(html, 'text/html')
        .querySelector('script#lentille-context[type="application/json"]')
      let context
      try { context = JSON.parse(node?.textContent || 'null') } catch { /* Normalize below rejects it. */ }
      if (id(context?.user?.uid) !== id(expected.remoteUid)) {
        throw error('LUOGU_ACCOUNT_CHANGED', '当前洛谷登录账号已变化或已退出，记录观察已暂停')
      }
      const configs = await readConfigs()
      const result = normalizeRecord(context, expected, configs)
      const source = context.data.record.sourceCode
      let sourceMatches = null
      if (expected.sourceSha256 && context.data.canViewCode === true && typeof source === 'string') {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
        const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
        if (fingerprint !== expected.sourceSha256) throw error('LUOGU_SOURCE_MISMATCH', '原站记录源码与本站任务指纹不一致')
        sourceMatches = true
      }
      return { ...result, sourceMatches, observedAt: new Date().toISOString(), configVersion: configs.version }
    } catch (failure) {
      return {
        ok: false, done: false, phase: 'result_unknown', parserVersion: PARSER_VERSION,
        errorCode: typeof failure.code === 'string' && failure.code.startsWith('LUOGU_') ? failure.code : 'LUOGU_RECORD_READ_FAILED',
        error: typeof failure.code === 'string' && failure.code.startsWith('LUOGU_') ? failure.message : '原站记录读取失败，请稍后恢复观察',
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return { normalizeRecord, readFromPage, parserVersion: PARSER_VERSION }
})
;

// Original-page form preparation (serialized by chrome.scripting).
// Serialized by chrome.scripting.executeScript({ func, world: 'MAIN' }).
// OJLuoguSubmit must be injected first. Preparation never submits.
async function fillLuoguSubmitForm(task) {
  const ORIGIN = 'https://www.luogu.com.cn'
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const fail = (code, message) => {
    const error = new Error(message)
    error.code = code
    throw error
  }
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
  }
  const text = (element) => String(element?.textContent || '').replace(/\s+/g, ' ').trim()
  const readContext = async () => {
    // The in-DOM script is an initial snapshot and can survive SPA navigation.
    // Fetch a fresh, same-origin document; never treat that old script as live identity.
    const pathname = location.pathname
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`${ORIGIN}${pathname}`, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin',
        cache: 'no-store', redirect: 'error', headers: { Accept: 'text/html' },
        signal: controller.signal,
      })
      if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) {
        fail('LUOGU_CONTEXT_UNAVAILABLE', '无法读取原站当前页面，请确认已登录且页面正常可访问')
      }
      const html = await response.text()
      if (html.length > 3 * 1024 * 1024) fail('LUOGU_CONTEXT_UNAVAILABLE', '原站页面数据过大，无法确认当前提交上下文')
      const node = new DOMParser().parseFromString(html, 'text/html')
        .querySelector('script#lentille-context[type="application/json"]')
      let context = null
      try { context = JSON.parse(node?.textContent || 'null') } catch { /* Fail below. */ }
      if (location.pathname !== pathname) fail('LUOGU_CONTEXT_CHANGED', '读取期间原站地址发生变化，请从本站重新发起')
      if (!context) fail('LUOGU_CONTEXT_UNAVAILABLE', '原站未返回可识别的当前页面数据')
      return context
    } catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('LUOGU_')) throw error
      fail('LUOGU_CONTEXT_UNAVAILABLE', '无法确认原站当前页面数据，请稍后重试')
    } finally {
      clearTimeout(timer)
    }
  }
  const findView = (element) => {
    const content = element.querySelector('.cm-content')
    // The current Luogu cdmr bundle uses cmTile.root.view, as does
    // CodeMirror's EditorView.findFromDOM. Older CodeMirror 6 uses cmView.
    const view = content?.cmTile?.root?.view || content?.cmView?.rootView?.view
    if (!view || view.dom !== element || view.contentDOM !== content
      || typeof view.dispatch !== 'function' || typeof view.state?.sliceDoc !== 'function') return null
    return view
  }
  const readPublicPageConfig = async () => {
    if (typeof indexedDB.databases !== 'function') {
      fail('LUOGU_CONFIG_UNAVAILABLE', '浏览器不能只读定位洛谷语言缓存，请更新浏览器后重试')
    }
    const databases = await indexedDB.databases()
    const configDatabase = ['lfeConfig', 'lentilleConfig'].find((name) => databases.some((database) => database.name === name))
    if (!configDatabase) {
      fail('LUOGU_CONFIG_UNAVAILABLE', '洛谷语言缓存尚未加载，请等待原站语言菜单加载后重试')
    }
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(configDatabase)
      let db = null
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        db?.close()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(Object.assign(new Error('洛谷语言缓存读取超时'), { code: 'LUOGU_CONFIG_UNAVAILABLE' })), 5000)
      open.onupgradeneeded = () => open.transaction.abort() // Never create/change a database.
      open.onerror = () => finish(Object.assign(new Error('无法读取洛谷公开语言缓存'), { code: 'LUOGU_CONFIG_UNAVAILABLE' }))
      open.onblocked = () => finish(Object.assign(new Error('洛谷公开语言缓存正被锁定'), { code: 'LUOGU_CONFIG_UNAVAILABLE' }))
      open.onsuccess = () => {
        db = open.result
        if (settled) {
          db.close()
          return
        }
        if (!db.objectStoreNames.contains('keyvaluepairs')) {
          finish(Object.assign(new Error('洛谷公开语言缓存结构已改变'), { code: 'LUOGU_CONFIG_UNAVAILABLE' }))
          return
        }
        const transaction = db.transaction('keyvaluepairs', 'readonly')
        const store = transaction.objectStore('keyvaluepairs')
        const languageRequest = store.get('CodeLanguage')
        const routeRequest = store.get('route')
        transaction.onabort = () => finish(Object.assign(new Error('读取洛谷公开语言缓存失败'), { code: 'LUOGU_CONFIG_UNAVAILABLE' }))
        transaction.onerror = () => {} // onabort reports a bounded error without cache contents.
        transaction.oncomplete = () => finish(null, { CodeLanguage: languageRequest.result, route: routeRequest.result })
      }
    })
  }

  let openedControl = null
  let armedRequestId = null
  let verifiedUid = null
  try {
    const pid = String(task?.pid || task?.taskKey || '').trim().toUpperCase()
    const sourceCode = task?.sourceCode
    const languageId = String(task?.remoteLanguageId || '')
    if (location.origin !== ORIGIN || !/^[PB][1-9]\d*$/.test(pid)
      || location.pathname !== `/problem/${pid}`) {
      fail('LUOGU_PROBLEM_MISMATCH', '洛谷页面题号与本站提交任务不一致')
    }
    if (typeof sourceCode !== 'string' || !sourceCode.trim()
      || new TextEncoder().encode(sourceCode).length > 256 * 1024
      || !/^[1-9]\d{0,5}$/.test(languageId)
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(task.requestId || ''))) {
      fail('LUOGU_TASK_INVALID', '洛谷任务缺少有效的源码或明确语言 ID')
    }
    if (globalThis.OJLuoguSubmit?.version !== 1) {
      fail('LUOGU_OBSERVER_UNAVAILABLE', '原站提交观察器尚未加载，不能宣布代填就绪')
    }
    const context = await readContext()
    if (context?.template !== 'problem.show' || context.data?.problem?.pid !== pid
      || context.data?.contest) {
      fail('LUOGU_PAGE_UNSUPPORTED', '当前页面不是本任务对应的洛谷普通题提交页')
    }
    const uid = String(context.user?.uid || '')
    if (!/^[1-9]\d*$/.test(uid)) fail('LUOGU_LOGIN_REQUIRED', '请先在此浏览器登录洛谷，再从本站发起提交')
    if (task.remoteUid && String(task.remoteUid) !== uid) {
      fail('LUOGU_ACCOUNT_MISMATCH', '当前洛谷账号与本站任务期望账号不一致')
    }
    verifiedUid = uid
    const accepted = context.data.problem.acceptLanguages
    if (!Array.isArray(accepted) || !accepted.some((id) => String(id) === languageId)) {
      fail('LUOGU_LANGUAGE_UNAVAILABLE', '原站当前题目不允许所选语言')
    }
    // Document load does not wait for Luogu's asynchronous public config cache.
    // A fresh tab can be ready before its CodeLanguage/route entries are committed.
    let pageConfig
    const configDeadline = Date.now() + 12000
    while (Date.now() < configDeadline) {
      try {
        pageConfig = await readPublicPageConfig()
        if (pageConfig.CodeLanguage && pageConfig.route?.['api.problem.submit']) break
      } catch (error) {
        if (error.code !== 'LUOGU_CONFIG_UNAVAILABLE') throw error
      }
      await pause(200)
    }
    if (!pageConfig?.CodeLanguage || !pageConfig?.route?.['api.problem.submit']) {
      fail('LUOGU_CONFIG_UNAVAILABLE', '洛谷语言配置加载超时，请等待原站加载完成后继续')
    }
    const config = pageConfig.CodeLanguage
    const languages = config && typeof config === 'object' ? Object.values(config) : []
    const matched = languages.filter((language) => language && String(language.id) === languageId)
    if (matched.length !== 1 || matched[0].disabled || Number(languageId) === 5
      || typeof matched[0].name !== 'string' || !matched[0].name.trim()) {
      fail('LUOGU_LANGUAGE_UNAVAILABLE', '原站当前语言配置没有唯一可用的目标语言')
    }
    const languageName = matched[0].name.replace(/\s+/g, ' ').trim()
    const routeTemplate = pageConfig.route?.['api.problem.submit']
    if (typeof routeTemplate !== 'string' || !routeTemplate.startsWith('/') || routeTemplate.startsWith('//')) {
      fail('LUOGU_SUBMIT_ROUTE_UNAVAILABLE', '原站配置中没有可识别的正式提交路径')
    }
    const route = routeTemplate.replace(/\{pid\}/g, encodeURIComponent(pid))
    const submitUrl = new URL(route, ORIGIN)
    if (/[{}]/.test(route) || submitUrl.origin !== ORIGIN || submitUrl.search || submitUrl.hash) {
      fail('LUOGU_SUBMIT_ROUTE_UNAVAILABLE', '原站正式提交路径与普通题模式不兼容')
    }
    if (location.hash !== '#submit') location.hash = 'submit'
    const deadline = Date.now() + 15000
    let control
    let editor
    while (Date.now() < deadline) {
      const controls = Array.from(document.querySelectorAll('.combo-wrapper.lang-select')).filter(visible)
      const editors = Array.from(document.querySelectorAll('.cm-editor')).filter(visible)
      if (controls.length > 1 || editors.length > 1) {
        fail('LUOGU_PAGE_AMBIGUOUS', '页面存在多个提交控件，无法唯一确定代填位置')
      }
      if (controls.length === 1 && editors.length === 1) {
        control = controls[0]
        editor = editors[0]
        break
      }
      await pause(100)
    }
    if (!control || !editor) fail('LUOGU_EDITOR_UNAVAILABLE', '洛谷提交区域尚未出现可识别的语言控件和编辑器')
    if (control.classList.contains('disabled') || !findView(editor)) {
      fail('LUOGU_EDITOR_UNAVAILABLE', '无法访问洛谷当前 CodeMirror 编辑器模型或语言控件')
    }
    if (text(control.querySelector('.text')) !== languageName) {
      if (!control.classList.contains('shown')) {
        control.click() // Only the original language dropdown; never the Submit button.
        openedControl = control
      }
      await pause(100)
      const menus = Array.from(document.querySelectorAll('#app .dropdown')).filter(visible)
        .map((menu) => Array.from(menu.querySelectorAll('li')).filter(visible)
          .filter((item) => text(item) === languageName))
        .filter((items) => items.length > 0)
      if (menus.length !== 1 || menus[0].length !== 1) {
        fail('LUOGU_LANGUAGE_MENU_MISMATCH', '原站语言菜单中未找到唯一的目标语言；不进行相近语言替换')
      }
      menus[0][0].click() // Original LCombo handler updates the submitted language value.
      await pause(100)
      if (text(control.querySelector('.text')) !== languageName) {
        fail('LUOGU_LANGUAGE_NOT_RETAINED', '原站没有保留所选语言，请重新检查页面')
      }
    }
    const sourceDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceCode))
    const sourceSha256 = Array.from(new Uint8Array(sourceDigest), (value) => value.toString(16).padStart(2, '0')).join('')
    if (task.sourceSha256 !== sourceSha256) fail('LUOGU_TASK_HASH_MISMATCH', '本站任务源码指纹与待填代码不匹配')
    const current = await readContext()
    if (location.pathname !== `/problem/${pid}` || current.template !== 'problem.show'
      || current.data?.problem?.pid !== pid || current.data?.contest
      || String(current.user?.uid || '') !== uid
      || !Array.isArray(current.data.problem.acceptLanguages)
      || !current.data.problem.acceptLanguages.some((id) => String(id) === languageId)) {
      fail('LUOGU_CONTEXT_CHANGED', '代填期间原站题目、账号或允许语言发生变化，请从本站重新发起')
    }
    // Language changes or navigation can recreate the editor. Resolve it after awaits.
    const editors = Array.from(document.querySelectorAll('.cm-editor')).filter(visible)
    if (editors.length !== 1) fail('LUOGU_EDITOR_UNAVAILABLE', '语言切换后无法唯一确定代码编辑器')
    const view = findView(editors[0])
    if (!view || view.state.readOnly || view.contentDOM.getAttribute('contenteditable') !== 'true') {
      fail('LUOGU_EDITOR_UNAVAILABLE', '洛谷代码编辑器不可写')
    }
    if (!control.isConnected) fail('LUOGU_CONTEXT_CHANGED', '原站语言控件已变化，请从本站重新发起')
    const observation = globalThis.OJLuoguSubmit.arm({
      requestId: task.requestId, pid, remoteUid: uid, remoteLanguageId: languageId,
      sourceSha256, submitUrl: submitUrl.href,
    })
    if (observation.phase !== 'waiting_user_submit' || observation.requestCount !== 0) {
      fail('LUOGU_TASK_ALREADY_STARTED', '此任务已有提交观察记录，请继续观察原记录，不要重新代填或提交')
    }
    armedRequestId = task.requestId
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sourceCode } })
    await pause(100)
    if (location.pathname !== `/problem/${pid}` || !view.dom.isConnected
      || view.state.sliceDoc() !== sourceCode || text(control.querySelector('.text')) !== languageName) {
      fail('LUOGU_FILL_NOT_RETAINED', '原站编辑器或语言状态与提交任务不一致，未宣布代填成功')
    }
    view.focus()
    return {
      ok: true,
      stage: 'filled',
      requiresUserSubmit: true,
      pid,
      remoteUid: uid,
      remoteLanguageId: languageId,
      remoteLanguageName: languageName,
      sourceMatches: true,
      sourceSha256,
      submitUrl: submitUrl.href,
      submissionObservation: globalThis.OJLuoguSubmit.snapshot(task.requestId),
    }
  } catch (error) {
    const submissionObservation = armedRequestId ? globalThis.OJLuoguSubmit.disarm(armedRequestId) : null
    return {
      ok: false, stage: 'prepare', remoteUid: verifiedUid, errorCode: error.code || 'LUOGU_PREPARE_FAILED',
      error: error.code ? error.message : '洛谷页面准备失败，请检查页面结构是否变化',
      ...(submissionObservation ? { submissionObservation } : {}),
    }
  } finally {
    if (openedControl?.isConnected && openedControl.classList.contains('shown')) openedControl.click()
  }
}

// MAIN-world injection installs only the page adapters above. Runtime messaging
// and task storage belong to the extension worker.
if (typeof importScripts !== 'function' || !root.chrome?.runtime?.id) return

// Worker orchestration.
// Short runtime messages and session metadata survive MV3 worker suspension.
// Source code is held only during preparation, never in extension storage.
const luoguTaskLocks = new Set()
const luoguStartLocks = new Set()
const luoguStorageKey = (id) => `luogu:${id}`
const luoguOrigin = 'https://www.luogu.com.cn'

async function luoguSave(entry) {
  await chrome.storage.session.set({ [luoguStorageKey(entry.requestId)]: entry })
}
async function luoguLoad(id) {
  return (await chrome.storage.session.get(luoguStorageKey(id)))[luoguStorageKey(id)]
}
function luoguOwner(entry, sender) {
  return entry && entry.appTabId === sender.tab.id && entry.appOrigin === new URL(sender.tab.url).origin
}
async function luoguReady(tabId) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('洛谷页面加载超时，请保留原标签页后继续观察')
}
function luoguEnvelope(entry, report = {}) {
  const observed = report.submissionObservation || {}
  const rid = report.remoteSubmissionId || observed.remoteSubmissionId || entry.remoteSubmissionId
  return {
    ...report, requestId: entry.requestId, pid: entry.pid,
    remoteUid: report.remoteUid || observed.remoteUid || entry.remoteUid,
    remoteLanguageId: entry.remoteLanguageId, sourceSha256: entry.sourceSha256,
    sequence: entry.sequence, remoteSubmissionId: rid || undefined,
    remoteSubmissionUrl: rid ? `${luoguOrigin}/record/${rid}` : undefined,
    correlation: rid ? 'original_submit_response' : undefined,
    requestCodeMatched: rid ? true : undefined, requestLanguageMatched: rid ? true : undefined,
    verificationStatus: 'client_reported', verificationScope: 'none',
  }
}
async function luoguStart(message, sender) {
  const id = message.requestId
  if (luoguTaskLocks.has(id) || luoguStartLocks.has(id)) throw new Error('任务正在处理，请等待已有观察完成')
  luoguStartLocks.add(id)
  try { return await luoguStartOnce(message, sender) } finally { luoguStartLocks.delete(id) }
}
async function luoguStartOnce(message, sender) {
  const task = message.task
  let entry = await luoguLoad(message.requestId)
  if (entry) {
    if (!luoguOwner(entry, sender) || entry.sourceSha256 !== task.sourceSha256 || entry.pid !== task.pid
      || entry.remoteLanguageId !== String(task.remoteLanguageId)) throw new Error('恢复任务与原洛谷任务不匹配')
    entry.nonce = message.nonce
    entry.sequence = Math.max(entry.sequence, Number(task.sequence) || 0)
    try { await chrome.tabs.get(entry.tabId) } catch {
      if (!entry.remoteSubmissionId) throw new Error('原提交标签页已关闭且尚未绑定 RID，无法确认是否已提交，请勿自动重提')
      const tab = await chrome.tabs.create({ url: `${luoguOrigin}/record/${entry.remoteSubmissionId}`, active: true })
      entry.tabId = tab.id
      await luoguReady(tab.id)
    }
    await luoguSave(entry)
    return luoguEnvelope(entry, { ok: true, done: false, phase: entry.remoteSubmissionId ? 'judging' : 'waiting_user_submit' })
  }
  if (!task.remoteSubmissionId && Number(task.sequence) > 0) throw new Error('原观察状态已经丢失且尚未绑定 RID，无法确认是否提交，请勿自动重新代填')
  if (luoguTaskLocks.has(task.requestId)) throw new Error('洛谷任务正在准备，请等待现有任务')
  luoguTaskLocks.add(task.requestId)
  try {
    // Only a user-initiated start may open a tab. Recovery with a known RID is read-only.
    const rid = task.remoteSubmissionId
    const tab = await chrome.tabs.create({ url: rid ? `${luoguOrigin}/record/${rid}` : `${luoguOrigin}/problem/${task.pid}#submit`, active: true })
    entry = {
      requestId: task.requestId, appTabId: sender.tab.id, appOrigin: new URL(sender.tab.url).origin,
      nonce: message.nonce, tabId: tab.id, pid: task.pid,
      remoteLanguageId: String(task.remoteLanguageId), sourceSha256: task.sourceSha256,
      remoteUid: task.remoteUid || null, remoteSubmissionId: rid || null,
      createdAt: Number.isFinite(Date.parse(task.createdAt)) ? Date.parse(task.createdAt) : Date.now(),
      sequence: Number(task.sequence) || 0, phase: 'preparing',
    }
    await luoguSave(entry) // Record before awaiting page load; never open another task after a worker restart.
    await luoguReady(tab.id)
    if (rid) {
      entry.phase = 'judging'
      entry.sequence += 1
      await luoguSave(entry)
      return luoguEnvelope(entry, { ok: true, done: false, phase: entry.phase })
    }
    const prepared = await prepareLuoguInTab(tab.id, task)
    const observed = prepared.submissionObservation
    if (!prepared.ok) {
      entry.phase = 'failed'
      entry.remoteUid = observed?.remoteUid || prepared.remoteUid || null
      entry.remoteSubmissionId = observed?.remoteSubmissionId || null
      entry.sequence += 1
      await luoguSave(entry)
      return luoguEnvelope(entry, { ...prepared, phase: 'failed', done: false })
    }
    entry.remoteUid = prepared.remoteUid
    entry.createdAt = observed.createdAt
    entry.phase = 'waiting_user_submit'
    entry.sequence += 1
    await luoguSave(entry)
    return luoguEnvelope(entry, { ok: true, done: false, phase: entry.phase })
  } finally { luoguTaskLocks.delete(task.requestId) }
}
async function luoguPoll(message, sender) {
  const entry = await luoguLoad(message.requestId)
  if (!luoguOwner(entry, sender) || entry.nonce !== message.nonce) throw new Error('洛谷观察任务来源或握手标识不匹配')
  if (luoguTaskLocks.has(entry.requestId) || luoguStartLocks.has(entry.requestId)) return luoguEnvelope(entry, { ok: true, done: false, phase: 'preparing' })
  luoguTaskLocks.add(entry.requestId)
  try {
    if (entry.ambiguous) return luoguEnvelope(entry, { ok: false, done: false, phase: 'result_unknown', error: '原提交关联存在歧义，不能自动选取记录或重复提交' })
    let result
    if (entry.remoteSubmissionId && entry.remoteUid) {
      result = await readLuoguRecordInTab(entry.tabId, {
        rid: entry.remoteSubmissionId, pid: entry.pid, remoteUid: entry.remoteUid,
        remoteLanguageId: entry.remoteLanguageId, sourceSha256: entry.sourceSha256,
        submittedAfter: entry.createdAt,
      })
    } else {
      result = await observeLuoguInTab(entry.tabId, entry.requestId)
    }
    const observed = result.submissionObservation || result
    if (['LUOGU_CONCURRENT_SUBMIT_REQUESTS', 'LUOGU_MULTIPLE_RECORDS_OBSERVED', 'LUOGU_SUBMIT_CONTENT_MISMATCH'].includes(observed.errorCode)) entry.ambiguous = true
    if (observed.remoteSubmissionId) entry.remoteSubmissionId = observed.remoteSubmissionId
    if (observed.remoteUid) entry.remoteUid = observed.remoteUid
    entry.phase = result.phase || 'result_unknown'
    entry.sequence += 1
    await luoguSave(entry)
    return luoguEnvelope(entry, result)
  } finally { luoguTaskLocks.delete(entry.requestId) }
}


// Page injection and observation.
async function prepareLuoguInTab(tabId, task) {
  await chrome.scripting.executeScript({
    target: { tabId }, files: ['platforms/luogu.js'], world: 'MAIN',
  })
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId }, func: fillLuoguSubmitForm, args: [task], world: 'MAIN',
  })
  return execution?.result || { ok: false, errorCode: 'LUOGU_PREPARE_FAILED', error: '未取得原站代填结果' }
}

async function observeLuoguInTab(tabId, requestId) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (new URL(tab.url).origin !== 'https://www.luogu.com.cn') throw new Error('unavailable')
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['platforms/luogu.js'], world: 'MAIN',
    })
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (id) => globalThis.OJLuoguSubmit.snapshot(id), args: [requestId],
    })
    const observation = execution?.result
    if (!observation || observation.requestId !== requestId) throw new Error('unavailable')
    if (observation.phase !== 'rid_observed') return { ok: true, done: false, ...observation }
    const result = await readLuoguRecordInTab(tabId, {
      rid: observation.remoteSubmissionId, pid: observation.pid,
      remoteUid: observation.remoteUid, remoteLanguageId: observation.remoteLanguageId,
      sourceSha256: observation.sourceSha256,
      submittedAfter: observation.createdAt,
      submittedBefore: observation.responseObservedAt + 5000,
    })
    return { ...result, submissionObservation: observation }
  } catch {
    return { ok: false, done: false, phase: 'result_unknown', errorCode: 'LUOGU_OBSERVATION_INTERRUPTED', error: '洛谷提交观察已中断，请保留原记录并恢复观察，勿自动重复提交' }
  }
}

async function readLuoguRecordInTab(tabId, expected) {
  try {
    const tab = await chrome.tabs.get(tabId)
    const origin = (() => {
      try { return new URL(String(tab.url || '')).origin } catch { return '' }
    })()
    if (origin !== 'https://www.luogu.com.cn') {
      return { ok: false, done: false, phase: 'result_unknown', errorCode: 'LUOGU_TAB_UNAVAILABLE', error: '原洛谷标签页已关闭或离开原站，需恢复记录观察' }
    }
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['platforms/luogu.js'], world: 'MAIN',
    })
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (task) => globalThis.OJLuoguRecord.readFromPage(task), args: [expected],
    })
    const result = execution?.result
    if (!result || (result.ok && String(result.remoteSubmissionId) !== String(expected.rid))) {
      return { ok: false, done: false, phase: 'result_unknown', errorCode: 'LUOGU_RECORD_MISMATCH', error: '原站观察结果与绑定记录不一致' }
    }
    return result
  } catch {
    return { ok: false, done: false, phase: 'result_unknown', errorCode: 'LUOGU_OBSERVATION_INTERRUPTED', error: '洛谷记录观察已中断，请恢复原站标签页后继续' }
  }
}


function validateLuoguTask(task) {
  if (!/^[PB][1-9]\d*$/.test(task.pid || '') || !/^[1-9]\d{0,5}$/.test(String(task.remoteLanguageId || ''))
    || !/^[0-9a-f]{64}$/.test(task.sourceSha256 || '')) return false
  if (task.remoteSubmissionId && (!/^[1-9]\d{0,19}$/.test(String(task.remoteSubmissionId)) || !/^[1-9]\d{0,19}$/.test(String(task.remoteUid || '')))) return false
  return true
}

root.OJLuoguPlatform = Object.freeze({
  origin: luoguOrigin,
  validateTask: validateLuoguTask,
  start: luoguStart,
  observe: luoguPoll,
})
})(globalThis)
