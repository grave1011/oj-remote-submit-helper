// Codeforces / Gym adapter. Site behavior stays local to this file.
;(function (root) {
const CODEFORCES_ORIGIN = 'https://codeforces.com'
const CODEFORCES_COMPILE_DETAILS_TIMEOUT_MS = 20000

// Worker submission flow.
async function submitCodeforces(task) {
  const normalized = normalizeCodeforcesTask(task)
  const taskDeadlineAt = Date.now() + normalized.timeoutMs
  const submitUrl = buildCodeforcesSubmitUrl(normalized)
  let tab = await chrome.tabs.create({ url: submitUrl, active: true })
  console.log('[codeforces-submit] tab created', { tabId: tab.id, url: submitUrl, requestId: normalized.requestId })
  if (Date.now() >= taskDeadlineAt) throw new Error('Codeforces submit task timed out while opening the page')
  await waitForCodeforcesTabReady(tab.id, normalized, taskDeadlineAt)

  let fillResult
  while (Date.now() < taskDeadlineAt) {
    tab = await ensureCodeforcesTab(tab.id, normalized)
    if (Date.now() >= taskDeadlineAt) break
    if (tab.status !== 'complete') {
      await sleep(Math.min(500, Math.max(0, taskDeadlineAt - Date.now())))
      continue
    }
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillCodeforcesSubmitForm,
      args: [normalized],
      world: 'MAIN',
    })
    fillResult = execution?.result || {}
    if (fillResult.ok) break
    if (!fillResult.retryable) throw new Error(fillResult.error || 'failed to fill Codeforces submit form')
    // Only retry preparation after verification or editor initialization.
    // The original site's Submit action always remains manual.
    await sleep(Math.min(500, Math.max(0, taskDeadlineAt - Date.now())))
  }
  console.log('[codeforces-submit] page execution result', {
    tabId: tab.id,
    ok: fillResult?.ok,
    error: fillResult?.error,
    loggedInHandle: fillResult?.loggedInHandle,
  })
  if (!fillResult?.ok) {
    if (Date.now() >= taskDeadlineAt) throw new Error('Codeforces submit task timed out during form preparation')
    throw new Error(fillResult?.error || 'Codeforces submit task timed out during form preparation')
  }
  if (Date.now() >= taskDeadlineAt) throw new Error('Codeforces submit task timed out before manual submit')

  const observationTask = {
    ...normalized,
    handle: normalized.handle || fillResult.loggedInHandle,
  }
  const submission = await waitForCodeforcesSubmission(tab.id, observationTask, taskDeadlineAt)
  if (!submission.remoteSubmissionId) {
    throw new Error('Codeforces submission id was not detected after manual submit')
  }
  const compileDetails = await collectCodeforcesCompileError(tab.id, observationTask, submission)
  return {
    ok: true,
    requestId: normalized.requestId,
    remoteOj: 'codeforces',
    ...submission,
    ...compileDetails,
    remoteUsername: submission.remoteUsername || fillResult.loggedInHandle || normalized.handle,
    loggedInHandle: fillResult.loggedInHandle,
  }
}

// Compile diagnostics are optional. Pin the detected RID, allow compilation to
// finish briefly, and always return that RID even if the page or details vanish.
async function collectCodeforcesCompileError(tabId, task, submission) {
  const deadline = Date.now() + CODEFORCES_COMPILE_DETAILS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!codeforcesTabMatchesTask(tab.url, task)) break
      if (tab.status === 'complete') {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId },
          func: readCodeforcesCompileError,
          args: [submission.remoteSubmissionId, task.handle, deadline - Date.now()],
          world: 'MAIN',
        })
        const details = execution?.result || {}
        if (details.compileError) return { compileError: details.compileError }
        if (!details.pending) break
      }
    } catch {
      break
    }
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())))
  }
  return {}
}

// Self-contained MAIN-world reader. Only diagnostics leave the original page;
// cookies, CSRF tokens and the source returned by submitSource stay on that page.
async function readCodeforcesCompileError(submissionId, handle, budgetMs) {
  const id = String(submissionId || '')
  if (!/^\d+$/.test(id)) return {}
  const diagnostic = { version: '0.3.11', submissionId: id, phase: 'checking_verdict', httpStatus: {} }
  window.__ojLiteCodeforcesCompileObservation = diagnostic
  const finish = (phase, result = {}) => { diagnostic.phase = phase; return result }
  const deadline = Date.now() + Math.max(0, budgetMs)
  const requestJson = async (url, options = {}) => {
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, { ...options, credentials: 'include', signal: controller.signal })
          diagnostic.httpStatus[String(url).split('?')[0]] = response.status
          return response.ok ? await response.json() : null
        })(),
        new Promise((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(null) }, Math.max(0, Math.min(1500, deadline - Date.now())))
        }),
      ])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  const row = document.querySelector(`tr[data-submission-id="${id}"]`)
  const statusNode = row?.querySelector('[submissionverdict], .submissionVerdictWrapper, .verdict, .status-cell')
  let verdict = String(statusNode?.getAttribute('submissionverdict') || statusNode?.textContent || '').trim().toUpperCase()
  const isCe = (value) => /^(?:COMPILATION_ERROR|COMPILATION ERROR|COMPILE ERROR)$/.test(value)
  if (!isCe(verdict)) {
    if (!handle) return finish('missing_handle')
    const payload = await requestJson(`/api/user.status?${new URLSearchParams({ handle, from: '1', count: '50' })}`)
    if (payload?.status !== 'OK' || !Array.isArray(payload.result)) return finish('verdict_unavailable')
    const record = payload.result.find((item) => String(item.id) === id
      && item.author?.members?.some((member) => String(member.handle).toLowerCase() === String(handle).toLowerCase()))
    if (!record) return finish('waiting_record', { pending: true })
    verdict = String(record.verdict || '').toUpperCase()
  }
  if (!verdict || ['TESTING', 'SUBMITTED'].includes(verdict)) return finish('waiting_verdict', { pending: true })
  if (!isCe(verdict)) return finish('not_compile_error')

  let csrf = ''
  try { csrf = window.Codeforces?.getCsrfToken?.() || '' } catch { /* Try the original page fields. */ }
  csrf ||= document.querySelector('span.csrf-token')?.getAttribute('data-csrf')
    || document.querySelector('input[name="csrf_token"]')?.value || ''
  if (!csrf) return finish('missing_page_token')
  const post = (path) => requestJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ submissionId: id, csrf_token: csrf }).toString(),
  })
  const details = await post('/data/submitSource')
  let protocol = typeof details?.submissionProtocol === 'string' ? details.submissionProtocol : ''
  if (protocol) {
    // The source popup inserts this field into <pre> as HTML. Decode entities
    // in a textarea so literal C++ angle brackets are never stripped as tags.
    const decoder = document.createElement('textarea')
    decoder.innerHTML = protocol.replace(/<br\s*\/?>/gi, '\n')
    protocol = decoder.value
  }
  if (!protocol.trim()) {
    const fallback = await post('/data/judgeProtocol')
    protocol = typeof fallback === 'string' ? fallback : ''
  }
  // Treat compiler output as text: template names such as <vector> are not HTML.
  const compileError = protocol.replace(/\r\n/g, '\n').trim().slice(0, 32000)
  if (!compileError || /<!doctype|<html\b/i.test(compileError)) return finish('waiting_protocol', { pending: true })
  return finish('received', { compileError })
}

// Task normalization and Codeforces / Gym URLs.
function normalizeCodeforcesTask(task) {
  const contestId = String(task?.contestId || task?.contestKey || task?.remoteContestKey || '').trim()
  let problemIndex = String(task?.problemIndex || task?.remoteIndex || task?.taskKey || task?.problemKey || '').trim()
  if (contestId && problemIndex.toUpperCase().startsWith(contestId.toUpperCase())) {
    problemIndex = problemIndex.slice(contestId.length).trim()
  }
  const sourceCode = String(task?.sourceCode || '')
  if (!contestId) throw new Error('missing Codeforces contestId')
  if (!problemIndex) throw new Error('missing Codeforces problemIndex')
  if (!sourceCode.trim()) throw new Error('source code is empty')
  return {
    ...task,
    requestId: task?.requestId,
    contestId,
    problemIndex,
    problemCode: `${contestId}${problemIndex}`,
    sourceCode,
    remoteLanguageId: String(task?.remoteLanguageId || '').trim(),
    remoteLanguageName: String(task?.remoteLanguageName || '').trim(),
    handle: String(task?.handle || task?.remoteHandle || task?.remoteUsername || '').trim(),
    submittedAfter: Number(task?.submittedAfter || Date.now()),
    timeoutMs: normalizeCodeforcesTimeoutMs(task?.timeoutMs),
  }
}

function normalizeCodeforcesTimeoutMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 60000
  return Math.max(30000, Math.min(parsed, 1800000))
}

function buildCodeforcesSubmitUrl(task) {
  try {
    const sourceUrl = new URL(String(task.sourceUrl || ''))
    if (sourceUrl.origin === CODEFORCES_ORIGIN) {
      const problemPathMatch = sourceUrl.pathname.match(/^(.+)\/problem\/[^/]+$/)
      if (problemPathMatch) return `${CODEFORCES_ORIGIN}${problemPathMatch[1]}/submit`
      if (sourceUrl.pathname.startsWith('/problemset/')) return `${CODEFORCES_ORIGIN}/problemset/submit`
      const contestPathMatch = sourceUrl.pathname.match(/^\/(contest|gym)\/(\d+)/)
      if (contestPathMatch) return `${CODEFORCES_ORIGIN}/${contestPathMatch[1]}/${contestPathMatch[2]}/submit`
    }
  } catch {
    // Fall through to the canonical contest submit URL.
  }
  return `${CODEFORCES_ORIGIN}/contest/${encodeURIComponent(task.contestId)}/submit`
}

function buildCodeforcesSubmissionBaseUrl(task, origin = CODEFORCES_ORIGIN) {
  try {
    const sourceUrl = new URL(String(task?.sourceUrl || ''), origin)
    if (sourceUrl.origin === CODEFORCES_ORIGIN) {
      const problemPathMatch = sourceUrl.pathname.match(/^(.+)\/problem\/[^/]+$/)
      if (problemPathMatch) return `${CODEFORCES_ORIGIN}${problemPathMatch[1]}`
      const contestPathMatch = sourceUrl.pathname.match(/^\/(group\/[^/]+\/(?:contest|gym)\/\d+|(?:contest|gym)\/\d+)/)
      if (contestPathMatch) return `${CODEFORCES_ORIGIN}/${contestPathMatch[1]}`
    }
  } catch {
    // Fall through to the canonical contest submission URL.
  }
  return `${CODEFORCES_ORIGIN}/contest/${encodeURIComponent(task.contestId)}`
}

function buildCodeforcesSubmissionUrl(task, submissionId, origin = CODEFORCES_ORIGIN) {
  return `${buildCodeforcesSubmissionBaseUrl(task, origin)}/submission/${submissionId}`
}

// Original-tab lifecycle.
function codeforcesTabMatchesTask(url, task) {
  const value = String(url || '')
  if (!value.startsWith(`${CODEFORCES_ORIGIN}/`)) return false
  const sourceUrl = String(task?.sourceUrl || '')
  if (sourceUrl && value.startsWith(sourceUrl.replace(/\/problem\/[^/]+$/, '/'))) return true
  const contestId = String(task?.contestId || '')
  if (!contestId) return false
  return new RegExp(`/(?:contest|gym)/${escapeRegExp(contestId)}(?:/|$)`).test(value)
}

async function waitForCodeforcesTabReady(tabId, task, deadlineAt) {
  while (Date.now() < deadlineAt) {
    const tab = await ensureCodeforcesTab(tabId, task)
    if (Date.now() >= deadlineAt) break
    if (tab.status === 'complete') return
    await sleep(Math.min(100, Math.max(0, deadlineAt - Date.now())))
  }
  throw new Error('Codeforces submit task timed out while the page was loading')
}

async function ensureCodeforcesTab(tabId, task) {
  try {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.status === 'loading' ? (tab.pendingUrl || tab.url) : tab.url
    if (tab?.id && codeforcesTabMatchesTask(url, task)) return tab
  } catch (error) {
    console.warn('[codeforces-submit] tab id is no longer available, trying URL lookup', { tabId, error: error?.message || String(error) })
  }
  const tabs = await chrome.tabs.query({ url: 'https://codeforces.com/*' })
  const matched = tabs.find((item) => codeforcesTabMatchesTask(
    item.status === 'loading' ? (item.pendingUrl || item.url) : item.url, task,
  ))
  if (!matched?.id) {
    throw new Error(`Codeforces tab was closed or unavailable: ${tabId}`)
  }
  console.log('[codeforces-submit] recovered tab by URL', { oldTabId: tabId, tabId: matched.id, url: String(matched.url || '').split(/[?#]/)[0] })
  return matched
}

// Observe the original submission URL or DOM after the user submits.
async function waitForCodeforcesSubmission(tabId, task, deadlineAt) {
  let lastUrl = ''
  let lastStatus = ''
  let lastDiagnostics = ''
  while (Date.now() < deadlineAt) {
    const tab = await ensureCodeforcesTab(tabId, task)
    if (Date.now() >= deadlineAt) break
    if (tab.url !== lastUrl) {
      console.log('[codeforces-submit] tab url observed', { tabId: tab.id, url: String(tab.url || '').split(/[?#]/)[0] })
      lastUrl = tab.url || ''
    }
    const urlSubmission = parseCodeforcesSubmissionFromUrl(tab.url, task)
    if (urlSubmission.remoteSubmissionId) return urlSubmission

    if (tab.status === 'complete') {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectCodeforcesSubmissionInDom,
        args: [task, buildCodeforcesSubmissionBaseUrl(task)],
        world: 'MAIN',
      })
      const domResult = execution?.result || {}
      if (domResult.remoteStatus && domResult.remoteStatus !== lastStatus) {
        console.log('[codeforces-submit] remote status observed', {
          tabId: tab.id,
          remoteStatus: domResult.remoteStatus,
          remoteSubmissionId: domResult.remoteSubmissionId,
        })
        lastStatus = domResult.remoteStatus
      }
      if (domResult.diagnostics && domResult.diagnostics !== lastDiagnostics) {
        console.log('[codeforces-submit] detection diagnostics', {
          tabId: tab.id,
          diagnostics: domResult.diagnostics,
        })
        lastDiagnostics = domResult.diagnostics
      }
      if (domResult.remoteSubmissionId) return domResult
    }
    await sleep(Math.min(1000, Math.max(0, deadlineAt - Date.now())))
  }
  throw new Error('Codeforces manual submit was not detected before the task timeout')
}

function parseCodeforcesSubmissionFromUrl(url, task) {
  const value = String(url || '')
  const contestPattern = new RegExp(`/(?:contest|gym)/${escapeRegExp(task.contestId)}/submission/(\\d+)`)
  const contestMatch = value.match(contestPattern)
  if (contestMatch) {
    return {
      remoteSubmissionId: contestMatch[1],
      remoteSubmissionUrl: value,
      remoteStatus: 'submitted',
    }
  }
  const problemsetMatch = value.match(/\/problemset\/submission\/(\d+)\/(\d+)/)
  if (problemsetMatch && String(problemsetMatch[1]) === String(task.contestId)) {
    return {
      remoteSubmissionId: problemsetMatch[2],
      remoteSubmissionUrl: buildCodeforcesSubmissionUrl(task, problemsetMatch[2]),
      remoteStatus: 'submitted',
    }
  }
  const submissionsMatch = value.match(/\/submissions\/(\d+)/)
  if (submissionsMatch) {
    return {
      remoteSubmissionId: submissionsMatch[1],
      remoteSubmissionUrl: value,
      remoteStatus: 'submitted',
    }
  }
  return {}
}

// MAIN-world form preparation; final submission remains manual.
async function fillCodeforcesSubmitForm(task) {
  const normalizeTextLocal = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const finishLocal = (phase, result) => {
    window.__ojLiteCodeforcesPreparation = {
      version: '0.3.11',
      phase,
      ok: Boolean(result.ok),
      error: result.error || null,
      requestedLanguageId: String(task.remoteLanguageId || ''),
      requestedLanguageName: String(task.remoteLanguageName || ''),
      selectedLanguageId: result.selectedLanguageId || null,
    }
    return result
  }
  const findLoggedInHandleLocal = () => {
    const links = Array.from(document.querySelectorAll('a[href^="/profile/"], a[href*="codeforces.com/profile/"]'))
    const candidates = links
      .map((link) => {
        try {
          const url = new URL(link.getAttribute('href'), window.location.origin)
          const match = url.pathname.match(/^\/profile\/([^/]+)/)
          return match ? decodeURIComponent(match[1]) : ''
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    return candidates[0] || ''
  }
  const isLoginPageLocal = () => (
    /\/enter\b/.test(window.location.pathname)
    || Boolean(document.querySelector('form[action*="/enter"], input[name="handleOrEmail"], input[name="password"]'))
  )
  const isLoggedOutLocal = () => (
    isLoginPageLocal()
    || Boolean(Array.from(document.querySelectorAll('a')).find((item) => normalizeTextLocal(item.textContent).toLowerCase() === 'enter'))
  )
  const findSubmitFormLocal = () => {
    const forms = Array.from(document.querySelectorAll('form'))
    return forms.find((form) => (
      form.querySelector('select[name="programTypeId"], select[name*="programType"]')
      || form.querySelector('textarea[name="source"], textarea[name="sourceCode"], textarea[name*="source"]')
    )) || null
  }
  const selectOptionLocal = (select, preferredId, preferredName) => {
    if (!select) return { ok: false, error: 'Codeforces language selector was not found' }
    const options = Array.from(select.options || []).filter((option) => !option.disabled)
    const id = String(preferredId || '').trim()
    const name = normalizeTextLocal(preferredName).toLowerCase()
    let option = id ? options.find((item) => String(item.value) === id) : null
    if (!option && name) {
      option = options.find((item) => normalizeTextLocal(item.textContent).toLowerCase() === name)
        || options.find((item) => normalizeTextLocal(item.textContent).toLowerCase().includes(name))
    }
    if (!option) {
      return { ok: false, error: preferredName ? `Codeforces language was not found: ${preferredName}` : 'missing Codeforces language id/name' }
    }
    if (select.value !== option.value) {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return { ok: true, selectedLanguageId: option.value, selectedLanguageName: normalizeTextLocal(option.textContent) }
  }
  const setInputLocal = (form, names, value) => {
    const input = names.map((name) => form.querySelector(`[name="${name}"]`)).find(Boolean)
    if (!input) return false
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  const isVisibleLocal = (node) => {
    if (!node) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
      && (!node.getClientRects || node.getClientRects().length > 0)
  }
  const setSourceLocal = (form, sourceCode) => {
    const sameCode = (value) => String(value).replace(/\r\n?/g, '\n') === sourceCode.replace(/\r\n?/g, '\n')
    const textareas = Array.from(form.querySelectorAll('textarea')).concat(Array.from(document.querySelectorAll('textarea')))
    const textarea = textareas.find((item) => /source|program|code/i.test(String(item.name || item.id || item.className || ''))) || textareas[0]
    const mirror = Array.from(document.querySelectorAll('.CodeMirror')).find(isVisibleLocal)
    const aceNode = Array.from(document.querySelectorAll('#editor, .ace_editor')).find(isVisibleLocal)
    let editor = null
    if (mirror) editor = mirror.CodeMirror
    else if (aceNode && window.ace?.edit) editor = window.ace.edit(aceNode)
    if ((mirror || aceNode) && (!editor?.setValue || !editor?.getValue)) {
      return { ok: false, retryable: true, error: 'Codeforces editor is still initializing' }
    }
    if (editor) {
      editor.setValue(sourceCode, -1)
      if (!sameCode(editor.getValue())) return { ok: false, error: 'Codeforces editor did not retain the requested source code' }
    } else if (!textarea || !isVisibleLocal(textarea)) {
      return { ok: false, retryable: true, error: 'Codeforces source editor is not ready' }
    }
    if (textarea) {
      textarea.value = sourceCode
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
      if (!sameCode(textarea.value)) return { ok: false, error: 'Codeforces source field did not retain the requested source code' }
    }
    if (editor && !sameCode(editor.getValue())) return { ok: false, error: 'Codeforces editor changed after synchronizing the source field' }
    return { ok: true }
  }

  if (isLoggedOutLocal()) {
    return finishLocal('login_required', { ok: false, error: 'Codeforces user is not logged in; please log in in this Chrome profile first' })
  }
  const loggedInHandle = findLoggedInHandleLocal()
  if (task.handle && loggedInHandle && String(task.handle).toLowerCase() !== String(loggedInHandle).toLowerCase()) {
    return finishLocal('account_mismatch', { ok: false, error: `Codeforces logged-in handle mismatch: expected ${task.handle}, got ${loggedInHandle}` })
  }
  const form = findSubmitFormLocal()
  if (!form) {
    return finishLocal('waiting_form', { ok: false, retryable: true, error: 'Waiting for Codeforces verification and submit form' })
  }

  setInputLocal(form, ['submittedProblemCode'], task.problemCode || `${task.contestId}${task.problemIndex}`)
  setInputLocal(form, ['submittedProblemIndex', 'problemIndex', 'index'], task.problemIndex)
  setInputLocal(form, ['contestId'], task.contestId)

  const problemSelect = form.querySelector('select[name="submittedProblemCode"], select[name="submittedProblemIndex"], select[name="problemIndex"], select[name="index"]')
  if (problemSelect) {
    const options = Array.from(problemSelect.options || [])
    const option = options.find((item) => String(item.value).toUpperCase() === String(task.problemIndex).toUpperCase())
      || options.find((item) => String(item.value).toUpperCase() === String(task.problemCode).toUpperCase())
      || options.find((item) => normalizeTextLocal(item.textContent).toUpperCase().startsWith(String(task.problemIndex).toUpperCase()))
      || options.find((item) => normalizeTextLocal(item.textContent).toUpperCase().includes(String(task.problemCode).toUpperCase()))
    if (!option) return finishLocal('problem_unavailable', { ok: false, error: `Codeforces problem was not found: ${task.contestId}${task.problemIndex}` })
    if (problemSelect.value !== option.value) {
      problemSelect.value = option.value
      problemSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  const languageSelect = form.querySelector('select[name="programTypeId"], select[name*="programType"], select[name*="language"]')
  if (!languageSelect || !languageSelect.options?.length) {
    return finishLocal('waiting_form', { ok: false, retryable: true, error: 'Waiting for Codeforces language selector' })
  }
  const languageResult = selectOptionLocal(languageSelect, task.remoteLanguageId, task.remoteLanguageName)
  if (!languageResult.ok) return finishLocal('language_unavailable', languageResult)

  let sourceResult
  try {
    sourceResult = setSourceLocal(form, task.sourceCode)
  } catch (_error) {
    sourceResult = { ok: false, error: 'Codeforces source editor could not be filled' }
  }
  if (!sourceResult.ok) return finishLocal(sourceResult.retryable ? 'waiting_editor' : 'editor_failed', sourceResult)

  return finishLocal('filled_waiting_manual_submit', {
    ok: true,
    requestId: task.requestId,
    remoteOj: 'codeforces',
    loggedInHandle,
    selectedLanguageId: languageResult.selectedLanguageId,
    selectedLanguageName: languageResult.selectedLanguageName,
    error: 'filled Codeforces form; waiting for manual Submit click',
  })
}

// MAIN-world record and judge-protocol observation.
async function detectCodeforcesSubmissionInDom(task, submissionBaseUrl) {
  // executeScript serializes this function without the worker's lexical scope.
  const submissionUrlLocal = (id) => `${submissionBaseUrl}/submission/${id}`
  const normalizeTextLocal = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const escapeRegExpLocal = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parseNumberLocal = (value) => {
    const parsed = Number(String(value || '').replace(/[^\d]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  const parseTimeLocal = (value) => {
    const text = normalizeTextLocal(value)
    if (!text) return null
    const parsed = Date.parse(text.replace(/(\w{3})\/(\d{2})\/(\d{4})/, '$1 $2 $3'))
    return Number.isFinite(parsed) ? parsed : null
  }
  let verifiedTimes = new Map()
  const verifyRowTimesLocal = async () => {
    if (!task.handle) return
    const key = `${task.requestId}:${task.handle}:${task.contestId}:${task.problemIndex}`
    const cached = window.__ojLiteCodeforcesTimeLookup
    if (cached?.key === key && Date.now() - cached.checkedAt < 3000) {
      verifiedTimes = new Map(cached.times)
      return
    }
    const controller = new AbortController()
    let timer
    try {
      const times = await Promise.race([
        (async () => {
          const params = new URLSearchParams({ handle: task.handle, from: '1', count: '50' })
          const response = await fetch(`/api/user.status?${params}`, { signal: controller.signal })
          if (!response.ok) return []
          const payload = await response.json()
          if (payload.status !== 'OK' || !Array.isArray(payload.result)) return []
          return payload.result.filter((item) => (
            String(item.problem?.contestId || item.contestId) === String(task.contestId)
            && String(item.problem?.index || '').toUpperCase() === String(task.problemIndex).toUpperCase()
            && item.author?.members?.some((member) => String(member.handle).toLowerCase() === String(task.handle).toLowerCase())
            && Number.isFinite(Number(item.creationTimeSeconds))
          )).map((item) => [String(item.id), Number(item.creationTimeSeconds) * 1000])
        })(),
        new Promise((resolve) => { timer = setTimeout(() => resolve([]), 1500) }),
      ])
      verifiedTimes = new Map(times)
    } catch (_error) {
      // An unavailable API cannot justify accepting a row classified as old.
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    // Keep only bounded public IDs and epoch times; throttle lookups per page/task.
    window.__ojLiteCodeforcesTimeLookup = { key, checkedAt: Date.now(), times: [...verifiedTimes] }
  }
  const parseSubmissionHrefLocal = (href) => {
    try {
      const url = new URL(href, window.location.origin)
      let match = url.pathname.match(new RegExp(`/(?:contest|gym)/${task.contestId}/submission/(\\d+)`))
      if (match) return { id: match[1], url: submissionUrlLocal(match[1]) }
      match = url.pathname.match(/\/problemset\/submission\/(\d+)\/(\d+)/)
      if (match && String(match[1]) === String(task.contestId)) {
        return { id: match[2], url: submissionUrlLocal(match[2]) }
      }
      match = url.pathname.match(/\/submissions\/(\d+)/)
      if (match) return { id: match[1], url: url.href }
    } catch {
      return null
    }
    return null
  }
  const parseMemoryKbLocal = (value) => {
    const text = normalizeTextLocal(value).toLowerCase()
    const number = Number((text.match(/[\d.]+/) || ['0'])[0])
    if (!Number.isFinite(number)) return 0
    if (text.includes('mb')) return Math.round(number * 1024)
    return Math.round(number)
  }
  const parseJudgeProtocolLocal = (protocol) => {
    const htmlToTextLocal = (value) => {
      const raw = String(value || '')
      if (!/[<>]/.test(raw)) return raw
      const withBreaks = raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:div|p|pre|li|tr|h\d)>/gi, '\n')
      const node = document.createElement('div')
      node.innerHTML = withBreaks
      return node.textContent || ''
    }
    const normalizeBlockLocal = (value) => String(value || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/g, '').replace(/^\s+/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const text = normalizeBlockLocal(htmlToTextLocal(protocol))
    const resultList = []
    const testPattern = /Test:\s*#(\d+),\s*time:\s*([0-9.]+)\s*ms\.?,\s*memory:\s*([0-9.]+)\s*(KB|MB)\b[\s\S]*?verdict:\s*([A-Z_]+)/gi
    let match
    while ((match = testPattern.exec(text)) !== null) {
      resultList.push({
        case_id: Number(match[1]),
        case_name: `Test: #${match[1]}`,
        verdict: match[5],
        time_ms: Math.round(Number(match[2]) || 0),
        memory_kb: parseMemoryKbLocal(`${match[3]} ${match[4]}`),
      })
    }
    const checkerLogMatch = text.match(/(?:^|\n)Checker Log\s*\n([\s\S]*)$/i)
    const beforeFirstTest = text.split(/\n\s*Test:\s*#\d+,/i)[0] || ''
    const compileError = normalizeBlockLocal(checkerLogMatch?.[1] || beforeFirstTest)
    return {
      compileError: compileError || undefined,
      resultList,
      judgeProtocol: text || undefined,
    }
  }
  const readOpenJudgeProtocolLocal = () => {
    const node = document.querySelector([
      '#facebox .information-box .protocol pre',
      '#facebox .ttypography',
      '#facebox',
      '.modal .information-box .protocol pre',
      '.modal .ttypography',
      '.modal',
      '.ttypography',
    ].join(','))
    return node ? parseJudgeProtocolLocal(node.innerText || node.textContent || '') : {}
  }
  const fetchJudgeProtocolLocal = async (submissionId) => {
    const controller = new AbortController()
    let timer
    try {
      // The RID is already known. Optional protocol details must not prevent
      // its callback, including when response headers arrive but the body stalls.
      return await Promise.race([
        (async () => {
          const formData = new FormData()
          formData.set('submissionId', String(submissionId))
          const response = await fetch('/data/judgeProtocol', {
            method: 'POST',
            credentials: 'include',
            body: formData,
            signal: controller.signal,
          })
          if (!response.ok) return {}
          const payload = await response.json()
          return parseJudgeProtocolLocal(typeof payload === 'string' ? payload : String(payload || ''))
        })(),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve(readOpenJudgeProtocolLocal())
          }, 1500)
        }),
      ])
    } catch {
      return readOpenJudgeProtocolLocal()
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  const collectCanonicalSubmissionLinksLocal = () => {
    const collected = new Map()
    const addMatch = (submissionId, url) => {
      const id = String(submissionId || '').trim()
      const href = String(url || '').trim()
      if (!id || !href) return
      if (!collected.has(id)) collected.set(id, href)
    }
    const hrefPattern = new RegExp(`https?://codeforces\\.com/(?:contest|gym)/${escapeRegExpLocal(task.contestId)}/submission/(\\d+)`, 'ig')
    for (const link of Array.from(document.querySelectorAll('a[href]'))) {
      const href = String(link.getAttribute('href') || link.href || '').trim()
      if (!href) continue
      const parsed = parseSubmissionHrefLocal(href)
      if (parsed?.id) {
        addMatch(parsed.id, parsed.url)
        continue
      }
      let match
      while ((match = hrefPattern.exec(href)) !== null) {
        addMatch(match[1], `https://codeforces.com/${href.replace(/^https?:\/\/codeforces\.com\//i, '')}`)
      }
      hrefPattern.lastIndex = 0
    }
    const html = String(document.body?.innerHTML || '')
    let match
    while ((match = hrefPattern.exec(html)) !== null) {
      addMatch(match[1], `https://codeforces.com/${match[0].replace(/^https?:\/\/codeforces\.com\//i, '')}`)
    }
    return Array.from(collected.entries())
      .map(([id, url]) => ({ id, url }))
      .sort((a, b) => Number(b.id) - Number(a.id))
  }
  const extractSubmissionIdFromTextLocal = (value) => {
    const text = String(value || '')
    const patterns = [
      new RegExp(`/(?:contest|gym)/${escapeRegExpLocal(task.contestId)}/submission/(\\d+)`, 'i'),
      /\/problemset\/submission\/\d+\/(\d+)/i,
      /\/submissions\/(\d+)/i,
      /\bdata-submission-id\s*=\s*["']?(\d+)["']?/i,
      /\bdata-submissionid\s*=\s*["']?(\d+)["']?/i,
      /\bsubmission[_-]?id\s*[:=]\s*["']?(\d+)["']?/i,
      /\bsubmission-(\d+)\b/i,
      /\bsubmissions?\/(\d+)\b/i,
    ]
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match) return String(match[1] || '').trim()
    }
    return ''
  }
  const extractRowSubmissionLocal = (row) => {
    const directId = String(
      row.getAttribute('data-submission-id')
      || row.getAttribute('data-submissionid')
      || row.getAttribute('submissionid')
      || row.dataset?.submissionId
      || ''
    ).trim()
    if (directId) {
      return { id: directId, url: submissionUrlLocal(directId) }
    }
    const attrId = extractSubmissionIdFromTextLocal([
      row.getAttribute('id'),
      row.getAttribute('onclick'),
      row.getAttribute('data-a'),
      row.getAttribute('data-submission-id'),
      row.outerHTML,
    ].filter(Boolean).join(' '))
    if (attrId) {
      return { id: attrId, url: submissionUrlLocal(attrId) }
    }
    const cellTexts = Array.from(row.querySelectorAll('td, th'))
      .map((cell) => normalizeTextLocal(cell.textContent))
      .filter(Boolean)
    const numericId = cellTexts
      .map((value) => {
        const match = value.match(/\b(\d{6,})\b/)
        return match ? match[1] : ''
      })
      .find(Boolean)
    if (numericId) {
      return { id: numericId, url: submissionUrlLocal(numericId) }
    }
    return null
  }
  const extractRowLocal = (row) => {
    const cells = Array.from(row.querySelectorAll('td, th'))
    const text = normalizeTextLocal(row.textContent)
    const link = Array.from(row.querySelectorAll('a[href]'))
      .map((item) => parseSubmissionHrefLocal(item.getAttribute('href') || item.href || ''))
      .find(Boolean)
      || extractRowSubmissionLocal(row)
    if (!link) return { reason: 'missing_submission_link' }
    const rowHandles = Array.from(row.querySelectorAll('a[href^="/profile/"], a[href*="codeforces.com/profile/"]'))
      .map((item) => {
        try {
          const url = new URL(item.getAttribute('href'), window.location.origin)
          const match = url.pathname.match(/^\/profile\/([^/]+)/)
          return match ? decodeURIComponent(match[1]).toLowerCase() : ''
        } catch {
          return ''
        }
      })
      .filter(Boolean)
    if (task.handle && rowHandles.length && !rowHandles.includes(String(task.handle).toLowerCase())) return { reason: 'handle_mismatch' }
    const problemCode = String(task.problemCode || `${task.contestId}${task.problemIndex}`).toUpperCase()
    const problemIndexPattern = new RegExp(`(?:^|\\W)${escapeRegExpLocal(String(task.problemIndex).toUpperCase())}(?:$|\\W)`)
    const problemMatches = text.toUpperCase().includes(problemCode)
      || problemIndexPattern.test(text.toUpperCase())
      || Array.from(row.querySelectorAll('a[href*="/problem/"]')).some((item) => {
        const url = new URL(item.getAttribute('href') || item.href || '', window.location.origin)
        const path = url.pathname.toUpperCase()
        return path.endsWith(`/PROBLEM/${String(task.problemIndex).toUpperCase()}`)
          || path.includes(`/${String(task.contestId).toUpperCase()}/PROBLEM/${String(task.problemIndex).toUpperCase()}`)
      })
    if (!problemMatches) return { reason: 'problem_mismatch' }
    const languageName = normalizeTextLocal(task.remoteLanguageName).toLowerCase()
    const languageCell = cells[4] ? normalizeTextLocal(cells[4].textContent) : ''
    const languageMatches = !languageName || text.toLowerCase().includes(languageName)
    const submittedAt = verifiedTimes.get(String(link.id)) ?? cells.map((cell) => parseTimeLocal(cell.textContent)).find(Boolean)
    if (submittedAt && submittedAt < Number(task.submittedAfter || 0) - 30000) return { reason: 'too_old' }
    const statusNode = row.querySelector('[submissionverdict], .submissionVerdictWrapper, .verdict, .status-cell')
    const submissionVerdict = statusNode?.getAttribute?.('submissionVerdict')
    return {
      remoteSubmissionId: link.id,
      remoteSubmissionUrl: link.url,
      remoteStatus: submissionVerdict || normalizeTextLocal(statusNode?.textContent) || extractStatusFromRowTextLocal(text),
      remoteSubmittedAt: submittedAt ? new Date(submittedAt).toISOString() : undefined,
      remoteUsername: rowHandles[0],
      remoteLanguage: languageCell,
      languageMatches,
      score: submittedAt || parseNumberLocal(link.id),
    }
  }
  const extractStatusFromRowTextLocal = (text) => {
    const known = ['Accepted', 'Wrong answer', 'Time limit exceeded', 'Memory limit exceeded', 'Runtime error', 'Compilation error', 'Running', 'In queue', 'Judgement failed']
    return known.find((item) => text.toLowerCase().includes(item.toLowerCase())) || 'submitted'
  }
  const canonicalLinks = collectCanonicalSubmissionLinksLocal()
  if (canonicalLinks[0]) {
    const protocol = await fetchJudgeProtocolLocal(canonicalLinks[0].id)
    return {
      ok: true,
      requestId: task.requestId,
      remoteOj: 'codeforces',
      remoteSubmissionId: canonicalLinks[0].id,
      remoteSubmissionUrl: canonicalLinks[0].url,
      remoteStatus: 'submitted',
      compileError: protocol.compileError,
      resultList: protocol.resultList,
      judgeProtocol: protocol.judgeProtocol,
    }
  }
  const rows = Array.from(document.querySelectorAll('tr[data-submission-id], table.status-frame-datatable tr, table tr'))
  let extracted = rows.map(extractRowLocal).filter(Boolean)
  if (!extracted.some((item) => item.remoteSubmissionId) && extracted.some((item) => item.reason === 'too_old')) {
    // CF wall-clock text has no reliable browser timezone. Verify the same RID
    // using API epoch time instead of widening the historical-submission window.
    await verifyRowTimesLocal()
    extracted = rows.map(extractRowLocal).filter(Boolean)
  }
  const matches = extracted
    .filter((item) => item.remoteSubmissionId)
    .sort((a, b) => b.score - a.score)
  if (matches[0]) {
    const protocol = await fetchJudgeProtocolLocal(matches[0].remoteSubmissionId)
    return {
      ok: true,
      requestId: task.requestId,
      remoteOj: 'codeforces',
      remoteSubmissionId: matches[0].remoteSubmissionId,
      remoteSubmissionUrl: matches[0].remoteSubmissionUrl,
      remoteStatus: matches[0].remoteStatus,
      remoteSubmittedAt: matches[0].remoteSubmittedAt,
      remoteUsername: matches[0].remoteUsername,
      remoteLanguage: matches[0].remoteLanguage,
      languageMatches: matches[0].languageMatches,
      compileError: protocol.compileError,
      resultList: protocol.resultList,
      judgeProtocol: protocol.judgeProtocol,
    }
  }
  const diagnostics = extracted.reduce((acc, item) => {
    if (item.reason) acc[item.reason] = (acc[item.reason] || 0) + 1
    return acc
  }, {})
  return {
    ok: false,
    requestId: task.requestId,
    remoteOj: 'codeforces',
    remoteStatus: 'waiting_manual_submit',
    diagnostics: JSON.stringify(diagnostics),
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

root.OJCodeforcesPlatform = Object.freeze({ origin: CODEFORCES_ORIGIN, submit: submitCodeforces })
})(globalThis)
