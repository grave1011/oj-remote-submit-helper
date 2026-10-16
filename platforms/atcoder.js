// AtCoder adapter. Site behavior stays local to this file.
;(function (root) {
const ATCODER_ORIGIN = 'https://atcoder.jp'

// Worker submission flow.
async function submitAtCoder(task) {
  validateAtCoderTask(task)
  const submitUrl = `${ATCODER_ORIGIN}/contests/${encodeURIComponent(task.contestKey)}/submit?taskScreenName=${encodeURIComponent(task.taskKey)}&lang=en`
  let tab = await chrome.tabs.create({ url: submitUrl, active: true })
  console.log('[atcoder-submit] tab created', { tabId: tab.id, url: submitUrl })
  await waitForTabReady(tab.id, task.contestKey)

  const preparationDeadline = Date.now() + Math.max(30000, Math.min(Number(task.timeoutMs || 60000), 1800000))
  let fillResult
  do {
    tab = await ensureAtCoderTab(tab.id, task.contestKey, task.taskKey)
    if (tab.status !== 'complete') {
      await sleep(500)
      continue
    }
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillAtCoderSubmitForm,
      args: [task],
      world: 'MAIN',
    })
    fillResult = execution?.result || {}
    if (fillResult.ok) break
    if (!fillResult.retryable || Date.now() >= preparationDeadline) {
      throw new Error(fillResult.error || 'failed to fill AtCoder submit form')
    }
    // Verification and editor initialization may finish after the initial load.
    // Recheck preparation only; the original Submit action remains manual.
    await sleep(500)
  } while (Date.now() < preparationDeadline)
  if (!fillResult?.ok) throw new Error(fillResult?.error || 'AtCoder form preparation timed out')

  tab = await ensureAtCoderTab(tab.id, task.contestKey, task.taskKey)
  const submission = await waitForAtCoderSubmission(tab.id, task)
  if (!submission.remoteSubmissionId) {
    throw new Error('AtCoder manual submit was not detected before timeout')
  }
  return {
    ok: true,
    remoteSubmissionId: submission.remoteSubmissionId,
    remoteSubmissionUrl: submission.remoteSubmissionUrl,
  }
}

// Task validation and original-tab lifecycle.
function validateAtCoderTask(task) {
  if (!task?.contestKey || !task?.taskKey) throw new Error('missing AtCoder contest/task key')
  if (!String(task.sourceCode || '').trim()) throw new Error('source code is empty')
}

async function waitForTabReady(tabId, contestKey) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const tab = await ensureAtCoderTab(tabId, contestKey)
    if (tab.status === 'complete') return
    await sleep(100)
  }
  throw new Error('AtCoder submit page load timeout')
}

async function ensureAtCoderTab(tabId, contestKey, taskKey) {
  try {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.status === 'loading' ? (tab.pendingUrl || tab.url) : tab.url
    if (tab?.id && atCoderTabMatchesTask(url, contestKey, taskKey)) return tab
  } catch (error) {
    console.warn('[atcoder-submit] tab id is no longer available, trying URL lookup', { tabId, error: error?.message || String(error) })
  }
  const patterns = [
    `https://atcoder.jp/contests/${contestKey}/submit*`,
    `https://atcoder.jp/contests/${contestKey}/submissions/*`,
  ]
  const tabs = await chrome.tabs.query({ url: patterns })
  const matched = tabs.find((item) => atCoderTabMatchesTask(
    item.status === 'loading' ? (item.pendingUrl || item.url) : item.url, contestKey, taskKey,
  ))
  if (!matched?.id) {
    throw new Error(`AtCoder tab was closed or unavailable: ${tabId}`)
  }
  console.log('[atcoder-submit] recovered tab by URL', { oldTabId: tabId, tabId: matched.id, url: matched.url })
  return matched
}

function atCoderTabMatchesTask(rawUrl, contestKey, taskKey) {
  try {
    const url = new URL(String(rawUrl || ''))
    if (url.origin !== ATCODER_ORIGIN) return false
    const prefix = '/contests/' + encodeURIComponent(String(contestKey || '')) + '/'
    if (!url.pathname.startsWith(prefix)) return false
    if (url.pathname.endsWith('/submit')) {
      return !taskKey || url.searchParams.get('taskScreenName') === String(taskKey)
    }
    return url.pathname.includes('/submissions/')
  } catch (_error) {
    return false
  }
}

async function waitForSubmissionUrl(tabId, contestKey, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  const pattern = new RegExp(`/contests/${escapeRegExp(contestKey)}/submissions/(\\d+)`)
  while (Date.now() < deadline) {
    const tab = await ensureAtCoderTab(tabId, contestKey)
    const match = String(tab.url || '').match(pattern)
    if (match) {
      return {
        remoteSubmissionId: match[1],
        remoteSubmissionUrl: tab.url,
      }
    }
    await sleep(1000)
  }
  return {}
}

// Observe the original submission URL or DOM after the user submits.
async function waitForAtCoderSubmission(tabId, task) {
  const timeoutMs = Math.max(30000, Math.min(Number(task?.timeoutMs || 60000), 1800000))
  const deadline = Date.now() + timeoutMs
  let lastUrl = ''
  let lastDiagnostics = ''
  while (Date.now() < deadline) {
    const tab = await ensureAtCoderTab(tabId, task.contestKey)
    if (tab.url !== lastUrl) {
      console.log('[atcoder-submit] tab url observed', { tabId: tab.id, url: tab.url })
      lastUrl = tab.url || ''
    }
    const urlSubmission = parseAtCoderSubmissionFromUrl(tab.url, task.contestKey)
    if (urlSubmission.remoteSubmissionId) return urlSubmission

    if (tab.status === 'complete') {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectAtCoderSubmissionInDom,
        args: [task],
        world: 'MAIN',
      })
      const domResult = execution?.result || {}
      if (domResult.remoteSubmissionId) return domResult
      if (domResult.diagnostics && domResult.diagnostics !== lastDiagnostics) {
        console.log('[atcoder-submit] detection diagnostics', {
          tabId: tab.id,
          diagnostics: domResult.diagnostics,
        })
        lastDiagnostics = domResult.diagnostics
      }
    }
    await sleep(1000)
  }
  return {}
}

function parseAtCoderSubmissionFromUrl(url, contestKey) {
  const pattern = new RegExp(`/contests/${escapeRegExp(contestKey)}/submissions/(\\d+)`)
  const match = String(url || '').match(pattern)
  if (!match) return {}
  return {
    remoteSubmissionId: match[1],
    remoteSubmissionUrl: `${ATCODER_ORIGIN}/contests/${contestKey}/submissions/${match[1]}`,
    remoteStatus: 'submitted',
  }
}

function detectAtCoderSubmissionInDom(task) {
  const normalizeTextLocal = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const escapeRegExpLocal = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const contestKey = String(task?.contestKey || '').trim()
  const taskKey = String(task?.taskKey || '').trim()
  const submittedAfter = Number(task?.submittedAfter || 0)
  const parseSubmissionHrefLocal = (href) => {
    try {
      const url = new URL(href || '', window.location.origin)
      const pattern = new RegExp(`/contests/${escapeRegExpLocal(contestKey)}/submissions/(\\d+)$`)
      const match = url.pathname.match(pattern)
      if (!match) return null
      return {
        id: match[1],
        url: `${url.origin}/contests/${contestKey}/submissions/${match[1]}`,
      }
    } catch {
      return null
    }
  }
  const parseSubmittedAtLocal = (value) => {
    const text = normalizeTextLocal(value)
    const isoLike = text.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:[+-]\d{4})?/)
    if (!isoLike) return 0
    const normalized = isoLike[0].replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    const timestamp = Date.parse(normalized)
    return Number.isFinite(timestamp) ? timestamp : 0
  }
  const extractStatusLocal = (row) => {
    const candidates = Array.from(row.querySelectorAll('td, span, time'))
      .map((item) => normalizeTextLocal(item.textContent))
      .filter(Boolean)
    const known = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'WJ', 'Judging', 'Waiting', 'Accepted', 'Wrong Answer', 'Compilation Error']
    return candidates.find((text) => known.some((item) => text.toLowerCase().includes(item.toLowerCase()))) || 'submitted'
  }
  const rowCandidates = Array.from(document.querySelectorAll('tr'))
    .map((row) => {
      const links = Array.from(row.querySelectorAll('a[href]')).map((link) => ({
        href: link.getAttribute('href') || link.href || '',
        text: normalizeTextLocal(link.textContent),
      }))
      const submission = links.map((link) => parseSubmissionHrefLocal(link.href)).find(Boolean)
      if (!submission) return { reason: 'missing_submission_link' }
      const text = normalizeTextLocal(row.textContent)
      const taskMatches = !taskKey || text.includes(taskKey) || links.some((link) => {
        try {
          const url = new URL(link.href, window.location.origin)
          return url.pathname.endsWith(`/tasks/${taskKey}`) || normalizeTextLocal(link.text) === taskKey
        } catch {
          return false
        }
      })
      if (!taskMatches) return { reason: 'task_mismatch' }
      const submittedAt = Array.from(row.querySelectorAll('td, th, time'))
        .map((cell) => parseSubmittedAtLocal(cell.textContent))
        .find(Boolean) || 0
      if (submittedAt && submittedAfter && submittedAt < submittedAfter - 30000) return { reason: 'too_old' }
      return {
        remoteSubmissionId: submission.id,
        remoteSubmissionUrl: submission.url,
        remoteStatus: extractStatusLocal(row),
        remoteSubmittedAt: submittedAt ? new Date(submittedAt).toISOString() : undefined,
        score: submittedAt || Number(submission.id),
      }
    })
  const matches = rowCandidates
    .filter((item) => item.remoteSubmissionId)
    .sort((a, b) => b.score - a.score)
  if (matches[0]) return matches[0]
  const diagnostics = rowCandidates.reduce((acc, item) => {
    if (item.reason) acc[item.reason] = (acc[item.reason] || 0) + 1
    return acc
  }, {})
  return {
    remoteStatus: 'waiting_manual_submit',
    diagnostics: JSON.stringify(diagnostics),
  }
}

// MAIN-world form preparation; final submission remains manual.
async function fillAtCoderSubmitForm(task) {
  const finish = (phase, result) => {
    // Read-only troubleshooting state; never retain source text or credentials.
    window.__ojLiteAtCoderPreparation = {
      version: '0.3.11', phase, ok: Boolean(result.ok), error: result.error || null,
      requestedLanguageId: String(task.remoteLanguageId || ''),
      requestedLanguageName: String(task.remoteLanguageName || ''),
      selectedLanguageId: result.selectedLanguageId || null,
    }
    return result
  }
  finish('checking_form', { ok: false })
  const cssEscapeLocal = (value) => {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }
  const findVerificationElementLocal = () => document.querySelector([
    '.cf-challenge',
    '.cf-turnstile',
    'input[name="cf-turnstile-response"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
  ].join(','))
  const findLanguageSelectLocal = (taskKey, languageId, languageName) => {
    const scoped = document.querySelector(`#select-lang-${cssEscapeLocal(taskKey)} select`)
    if (scoped) return scoped
    const current = document.querySelector('#select-lang select.current, select[name="data.LanguageId"]')
    if (current) return current
    const selects = Array.from(document.querySelectorAll('select'))
    const exact = selects.find((select) => Array.from(select.options || []).some((option) => String(option.value) === languageId))
    if (exact) return exact
    return selects.find((select) => Array.from(select.options || []).some((option) => languageNameMatchesLocal(option.textContent, languageName))) || null
  }
  const languageNameMatchesLocal = (label, name) => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, '')
    const target = normalize(name)
    const comparable = normalize(label)
    if (!target) return false
    if (comparable === target) return true
    const start = comparable.indexOf(target)
    // Generic mappings such as C++17/Python3 may omit compiler/version details.
    return start >= 0 && !/[a-z0-9]/.test(comparable.charAt(start + target.length))
  }
  const ensureHiddenInputLocal = (targetForm, name, value) => {
    let input = targetForm.querySelector(`input[name="${name}"]`)
    if (!input) {
      input = document.createElement('input')
      input.type = 'hidden'
      input.name = name
      targetForm.appendChild(input)
    }
    input.value = value
  }
  const fallbackForm = document.querySelector('form[action*="/submit"]')
  // A Cloudflare challenge can POST to the same /submit URL. Its action alone
  // does not identify the original code form; require a source-code control.
  const form = document.querySelector('form.form-code-submit')
    || (fallbackForm?.querySelector('textarea[name="sourceCode"], #sourceCode, #plain-textarea') ? fallbackForm : null)
  if (!form) {
    const turnstile = findVerificationElementLocal()
    return finish('waiting_for_form', {
      ok: false,
      needVerification: Boolean(turnstile),
      retryable: true,
      error: turnstile ? 'waiting for AtCoder verification' : 'AtCoder submit form was not found',
    })
  }

  const turnstileResponse = document.querySelector('input[name="cf-turnstile-response"]')
  const needVerification = Boolean(
    (turnstileResponse && !turnstileResponse.value)
    || (!turnstileResponse && findVerificationElementLocal()),
  )

  const preferredId = String(task.remoteLanguageId || '').trim()
  const languageSelect = findLanguageSelectLocal(task.taskKey, preferredId, task.remoteLanguageName)
  const options = Array.from(languageSelect?.options || []).filter((option) => option.value && !option.disabled)
  const option = (preferredId && options.find((item) => String(item.value) === preferredId))
    || options.find((item) => languageNameMatchesLocal(item.textContent, task.remoteLanguageName))
  if (!option) {
    const requested = String(task.remoteLanguageName || preferredId || '未配置')
    const relevant = requested.toLowerCase().includes('c++')
      ? options.filter((item) => String(item.textContent).toLowerCase().includes('c++')) : options
    const available = relevant.slice(0, 8).map((item) => String(item.textContent).replace(/\s+/g, ' ').trim()).join('、')
    return finish('language_unavailable', { ok: false, error: `AtCoder 未找到语言映射：${requested}。当前题目可选语言：${available || '无匹配选项'}。请更新本站语言映射。` })
  }
  const languageId = String(option.value)

  const textarea = form.querySelector('textarea[name="sourceCode"], textarea#plain-textarea')
    || document.querySelector('textarea[name="sourceCode"], textarea#plain-textarea')
  const editorNode = document.querySelector('#editor')
  const editorVisible = editorNode && getComputedStyle(editorNode).display !== 'none'
  let editor
  if (editorNode && typeof window.ace?.edit === 'function') {
    try { editor = window.ace.edit(editorNode) } catch { /* Wait for the original editor to finish initializing. */ }
  }
  if (editorVisible && (!editor || typeof editor.getValue !== 'function')) {
    return finish('waiting_for_editor', { ok: false, retryable: true, error: 'waiting for AtCoder source editor initialization' })
  }
  if (!textarea && !editor) return finish('editor_missing', { ok: false, error: 'AtCoder source editor was not found' })

  const taskSelect = form.querySelector('select[name="data.TaskScreenName"]')
  if (taskSelect) {
    taskSelect.value = task.taskKey
    taskSelect.dispatchEvent(new Event('change', { bubbles: true }))
  }
  languageSelect.value = languageId
  languageSelect.dispatchEvent(new Event('change', { bubbles: true }))
  // The site's active language select already submits this field when named.
  if (languageSelect.name !== 'data.LanguageId') ensureHiddenInputLocal(form, 'data.LanguageId', languageId)

  const sourceCode = String(task.sourceCode || '')
  try {
    if (editor) editor.setValue(sourceCode, -1)
    if (textarea) {
      textarea.value = sourceCode
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if ((editorVisible && editor.getValue() !== sourceCode) || (textarea && textarea.value !== sourceCode)) {
      return finish('source_mismatch', { ok: false, error: 'AtCoder source code could not be verified after filling' })
    }
  } catch {
    return finish('editor_write_failed', { ok: false, error: 'AtCoder source editor could not be filled' })
  }

  return finish('filled_waiting_manual_submit', {
    ok: true,
    needVerification,
    requiresManualSubmit: true,
    selectedLanguageId: languageId,
  })
}

// Adapter-local helpers (including retained legacy helpers).
function findLanguageSelect(taskKey, languageId, languageName) {
  const scoped = document.querySelector(`#select-lang-${cssEscape(taskKey)} select`)
  if (scoped) return scoped
  const selects = Array.from(document.querySelectorAll('select'))
  const exact = selects.find((select) => Array.from(select.options || []).some((option) => String(option.value) === languageId))
  if (exact) return exact
  const name = String(languageName || '').trim().toLowerCase()
  if (!name) return null
  return selects.find((select) => Array.from(select.options || []).some((option) => String(option.textContent || '').trim().toLowerCase() === name)) || null
}

function ensureHiddenInput(form, name, value) {
  let input = form.querySelector(`input[name="${name}"]`)
  if (!input) {
    input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    form.appendChild(input)
  }
  input.value = value
}

function setAceSource(sourceCode) {
  try {
    if (!window.ace) return
    const editorNode = document.querySelector('#editor')
    if (!editorNode) return
    window.ace.edit(editorNode).setValue(sourceCode, -1)
  } catch {
    // AtCoder can render the plain textarea without Ace; textarea assignment above is sufficient there.
  }
}

function findVerificationElement() {
  return document.querySelector([
    '.cf-challenge',
    '.cf-turnstile',
    'input[name="cf-turnstile-response"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
  ].join(','))
}

function isVerificationMessage(message) {
  return /waiting for atcoder verification|cloudflare|turnstile|challenge/i.test(String(message || ''))
}

function parseSubmissionFromUrl(url, contestKey) {
  const pattern = new RegExp(`/contests/${escapeRegExp(contestKey)}/submissions/(\\d+)`)
  const match = String(url || '').match(pattern)
  if (!match) return {}
  return {
    remoteSubmissionId: match[1],
    remoteSubmissionUrl: url,
  }
}

function parseSubmissionFromHtml(html, contestKey) {
  const pattern = new RegExp(`/contests/${escapeRegExp(contestKey)}/submissions/(\\d+)`)
  const match = String(html || '').match(pattern)
  if (!match) return {}
  return {
    remoteSubmissionId: match[1],
    remoteSubmissionUrl: `${ATCODER_ORIGIN}/contests/${contestKey}/submissions/${match[1]}`,
  }
}

function extractSubmitError(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  const candidates = Array.from(doc.querySelectorAll('.alert-danger, .error, .has-error .help-block, .text-danger'))
    .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return candidates[0] || ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

root.OJAtCoderPlatform = Object.freeze({ origin: ATCODER_ORIGIN, submit: submitAtCoder })
})(globalThis)
