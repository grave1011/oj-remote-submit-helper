const ATCODER_ORIGIN = 'https://atcoder.jp'
const CODEFORCES_ORIGIN = 'https://codeforces.com'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type
  const isAtCoder = type === 'submitAtCoder' || type === 'browserSubmitAtCoder'
  const isCodeforces = type === 'submitCodeforces' || type === 'browserSubmitCodeforces'
  if (!isAtCoder && !isCodeforces) return false
  const remoteOj = isCodeforces ? 'codeforces' : 'atcoder'
  const logPrefix = isCodeforces ? '[codeforces-submit]' : '[atcoder-submit]'
  console.log(`${logPrefix} request received`, {
    requestId: message.task?.requestId,
    contestKey: message.task?.contestKey,
    contestId: message.task?.contestId,
    taskKey: message.task?.taskKey,
    problemIndex: message.task?.problemIndex,
    senderTabId: sender?.tab?.id,
  })
  const runner = isCodeforces ? submitCodeforces : submitAtCoder
  runner(message.task)
    .then((result) => {
      const response = { remoteOj, requestId: message.task?.requestId, ...result }
      console.log(`${logPrefix} request finished`, response)
      sendResponse(response)
    })
    .catch((error) => {
      console.error(`${logPrefix} request failed`, error)
      sendResponse({ ok: false, remoteOj, requestId: message.task?.requestId, error: error?.message || String(error) })
    })
  return true
})

async function submitAtCoder(task) {
  validateTask(task)
  const submitUrl = `${ATCODER_ORIGIN}/contests/${encodeURIComponent(task.contestKey)}/submit?taskScreenName=${encodeURIComponent(task.taskKey)}&lang=en`
  let tab = await chrome.tabs.create({ url: submitUrl, active: true })
  console.log('[atcoder-submit] tab created', { tabId: tab.id, url: submitUrl })
  await waitForTabReady(tab.id, task.contestKey)

  tab = await ensureAtCoderTab(tab.id, task.contestKey, task.taskKey)
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fillAtCoderSubmitForm,
    args: [task],
    world: 'MAIN',
  })
  const fillResult = execution?.result || {}
  console.log('[atcoder-submit] page execution result', {
    tabId: tab.id,
    ok: fillResult.ok,
    needVerification: fillResult.needVerification,
    error: fillResult.error,
  })
  if (!fillResult.ok) {
    throw new Error(fillResult.error || 'failed to fill AtCoder submit form')
  }

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

async function submitCodeforces(task) {
  const normalized = normalizeCodeforcesTask(task)
  const submitUrl = buildCodeforcesSubmitUrl(normalized)
  let tab = await chrome.tabs.create({ url: submitUrl, active: true })
  console.log('[codeforces-submit] tab created', { tabId: tab.id, url: submitUrl, requestId: normalized.requestId })
  await waitForCodeforcesTabReady(tab.id)

  tab = await ensureCodeforcesTab(tab.id, normalized)
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fillCodeforcesSubmitForm,
    args: [normalized],
    world: 'MAIN',
  })
  const fillResult = execution?.result || {}
  console.log('[codeforces-submit] page execution result', {
    tabId: tab.id,
    ok: fillResult.ok,
    error: fillResult.error,
    loggedInHandle: fillResult.loggedInHandle,
  })
  if (!fillResult.ok) {
    throw new Error(fillResult.error || 'failed to fill Codeforces submit form')
  }

  const submission = await waitForCodeforcesSubmission(tab.id, normalized)
  if (!submission.remoteSubmissionId) {
    throw new Error('Codeforces submission id was not detected after manual submit')
  }
  return {
    ok: true,
    requestId: normalized.requestId,
    remoteOj: 'codeforces',
    ...submission,
    remoteUsername: submission.remoteUsername || fillResult.loggedInHandle || normalized.handle,
    loggedInHandle: fillResult.loggedInHandle,
  }
}

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
    timeoutMs: Math.max(30000, Math.min(Number(task?.timeoutMs || 600000), 1800000)),
  }
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

function codeforcesTabMatchesTask(url, task) {
  const value = String(url || '')
  if (!value.startsWith(`${CODEFORCES_ORIGIN}/`)) return false
  const sourceUrl = String(task?.sourceUrl || '')
  if (sourceUrl && value.startsWith(sourceUrl.replace(/\/problem\/[^/]+$/, '/'))) return true
  const contestId = String(task?.contestId || '')
  if (!contestId) return false
  return new RegExp(`/(?:contest|gym)/${escapeRegExp(contestId)}(?:/|$)`).test(value)
}

async function waitForCodeforcesTabReady(tabId) {
  const tab = await ensureCodeforcesTab(tabId)
  if (tab.status === 'complete') return
  await waitForCodeforcesTabComplete(tab.id)
}

function waitForCodeforcesTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('Codeforces page load timeout'))
    }, 60000)
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function ensureCodeforcesTab(tabId, task) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab?.id) return tab
  } catch (error) {
    console.warn('[codeforces-submit] tab id is no longer available, trying URL lookup', { tabId, error: error?.message || String(error) })
  }
  const tabs = await chrome.tabs.query({ url: 'https://codeforces.com/*' })
  const matched = tabs.find((item) => codeforcesTabMatchesTask(item.url, task)) || tabs[0]
  if (!matched?.id) {
    throw new Error(`Codeforces tab was closed or unavailable: ${tabId}`)
  }
  console.log('[codeforces-submit] recovered tab by URL', { oldTabId: tabId, tabId: matched.id, url: matched.url })
  return matched
}

async function waitForCodeforcesSubmission(tabId, task) {
  const deadline = Date.now() + task.timeoutMs
  let lastUrl = ''
  let lastStatus = ''
  let lastDiagnostics = ''
  while (Date.now() < deadline) {
    const tab = await ensureCodeforcesTab(tabId, task)
    if (tab.url !== lastUrl) {
      console.log('[codeforces-submit] tab url observed', { tabId: tab.id, url: tab.url })
      lastUrl = tab.url || ''
    }
    const urlSubmission = parseCodeforcesSubmissionFromUrl(tab.url, task)
    if (urlSubmission.remoteSubmissionId) return urlSubmission

    if (tab.status === 'complete') {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: detectCodeforcesSubmissionInDom,
        args: [task],
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
    await sleep(1000)
  }
  throw new Error('Codeforces manual submit was not detected before timeout')
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

function validateTask(task) {
  if (!task?.contestKey || !task?.taskKey) throw new Error('missing AtCoder contest/task key')
  if (!String(task.sourceCode || '').trim()) throw new Error('source code is empty')
}

async function waitForTabReady(tabId, contestKey) {
  const tab = await ensureAtCoderTab(tabId, contestKey)
  if (tab.status === 'complete') return
  await waitForTabComplete(tab.id)
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('AtCoder submit page load timeout'))
    }, 60000)
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function ensureAtCoderTab(tabId, contestKey, taskKey) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab?.id) return tab
  } catch (error) {
    console.warn('[atcoder-submit] tab id is no longer available, trying URL lookup', { tabId, error: error?.message || String(error) })
  }
  const patterns = [
    `https://atcoder.jp/contests/${contestKey}/submit*`,
    `https://atcoder.jp/contests/${contestKey}/submissions/*`,
  ]
  const tabs = await chrome.tabs.query({ url: patterns })
  const matched = tabs.find((item) => (
    String(item.url || '').includes(`/contests/${contestKey}/submit`)
    && (!taskKey || String(item.url || '').includes(`taskScreenName=${taskKey}`))
  )) || tabs.find((item) => String(item.url || '').includes(`/contests/${contestKey}/submissions/`)) || tabs[0]
  if (!matched?.id) {
    throw new Error(`AtCoder tab was closed or unavailable: ${tabId}`)
  }
  console.log('[atcoder-submit] recovered tab by URL', { oldTabId: tabId, tabId: matched.id, url: matched.url })
  return matched
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

async function waitForAtCoderSubmission(tabId, task) {
  const timeoutMs = Math.max(30000, Math.min(Number(task?.timeoutMs || 600000), 1800000))
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

async function fillAtCoderSubmitForm(task) {
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
    const selects = Array.from(document.querySelectorAll('select'))
    const exact = selects.find((select) => Array.from(select.options || []).some((option) => String(option.value) === languageId))
    if (exact) return exact
    const name = String(languageName || '').trim().toLowerCase()
    if (!name) return null
    return selects.find((select) => Array.from(select.options || []).some((option) => String(option.textContent || '').trim().toLowerCase() === name)) || null
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
  const setAceSourceLocal = (sourceCode) => {
    try {
      if (!window.ace) return
      const editorNode = document.querySelector('#editor')
      if (!editorNode) return
      window.ace.edit(editorNode).setValue(sourceCode, -1)
    } catch {
      // Plain textarea assignment below is sufficient when Ace is unavailable.
    }
  }

  const form = document.querySelector('form.form-code-submit') || document.querySelector('form[action*="/submit"]')
  if (!form) {
    const turnstile = findVerificationElementLocal()
    return {
      ok: false,
      needVerification: Boolean(turnstile),
      error: turnstile ? 'waiting for AtCoder verification' : 'AtCoder submit form was not found',
    }
  }

  const turnstileResponse = document.querySelector('input[name="cf-turnstile-response"]')
  const needVerification = Boolean(
    (turnstileResponse && !turnstileResponse.value)
    || (!turnstileResponse && findVerificationElementLocal()),
  )

  const taskSelect = form.querySelector('select[name="data.TaskScreenName"]')
  if (taskSelect) {
    taskSelect.value = task.taskKey
    taskSelect.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const languageId = String(task.remoteLanguageId || '').trim()
  if (!languageId) return { ok: false, error: 'missing AtCoder language id' }
  const languageSelect = findLanguageSelectLocal(task.taskKey, languageId, task.remoteLanguageName)
  if (languageSelect) {
    languageSelect.value = languageId
    languageSelect.dispatchEvent(new Event('change', { bubbles: true }))
  }
  ensureHiddenInputLocal(form, 'data.LanguageId', languageId)

  const sourceCode = String(task.sourceCode || '')
  const textarea = form.querySelector('textarea[name="sourceCode"]') || document.querySelector('textarea[name="sourceCode"]')
  if (textarea) {
    textarea.value = sourceCode
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
  }
  setAceSourceLocal(sourceCode)

  const csrf = form.querySelector('input[name="csrf_token"]')
  if (!csrf?.value) return { ok: false, error: 'AtCoder csrf_token was not found' }
  return {
    ok: true,
    needVerification,
    requiresManualSubmit: true,
  }
}

async function fillCodeforcesSubmitForm(task) {
  const normalizeTextLocal = (value) => String(value || '').replace(/\s+/g, ' ').trim()
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
      || String(form.getAttribute('action') || '').includes('/submit')
    )) || null
  }
  const selectOptionLocal = (select, preferredId, preferredName) => {
    if (!select) return { ok: false, error: 'Codeforces language selector was not found' }
    const options = Array.from(select.options || [])
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
    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
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
  const setCodeMirrorLocal = (sourceCode) => {
    try {
      const wrappers = Array.from(document.querySelectorAll('.CodeMirror'))
      for (const wrapper of wrappers) {
        if (wrapper.CodeMirror) {
          wrapper.CodeMirror.setValue(sourceCode)
          return true
        }
      }
    } catch {
      // Textarea assignment below is the stable fallback.
    }
    return false
  }
  const setAceLocal = (sourceCode) => {
    try {
      if (!window.ace) return false
      const editorNode = document.querySelector('#editor, .ace_editor')
      if (!editorNode) return false
      window.ace.edit(editorNode).setValue(sourceCode, -1)
      return true
    } catch {
      return false
    }
  }
  const setSourceLocal = (form, sourceCode) => {
    const textareas = Array.from(form.querySelectorAll('textarea')).concat(Array.from(document.querySelectorAll('textarea')))
    const textarea = textareas.find((item) => /source|program|code/i.test(String(item.name || item.id || item.className || ''))) || textareas[0]
    if (textarea) {
      textarea.value = sourceCode
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const editorSet = setCodeMirrorLocal(sourceCode) || setAceLocal(sourceCode)
    return Boolean(textarea || editorSet)
  }
  const ensureManualNoticeLocal = (form) => {
    const id = 'oj-codeforces-browser-submit-notice'
    let notice = document.getElementById(id)
    if (!notice) {
      notice = document.createElement('div')
      notice.id = id
      notice.style.cssText = [
        'border:2px solid #f0a500',
        'background:#fff7db',
        'color:#3d2b00',
        'padding:12px 14px',
        'margin:12px 0',
        'font-size:14px',
        'line-height:1.5',
        'font-weight:600',
      ].join(';')
      form.parentNode?.insertBefore(notice, form)
    }
    notice.textContent = 'OJ 已自动填入 Codeforces 提交信息。插件不会替你点击 Submit，也不会读取或上传 Cookie/CSRF；请检查题号、语言和源码后，手动点击 Codeforces 页面上的 Submit。'
  }

  if (isLoggedOutLocal()) {
    return { ok: false, error: 'Codeforces user is not logged in; please log in in this Chrome profile first' }
  }
  const loggedInHandle = findLoggedInHandleLocal()
  if (task.handle && loggedInHandle && String(task.handle).toLowerCase() !== String(loggedInHandle).toLowerCase()) {
    return { ok: false, error: `Codeforces logged-in handle mismatch: expected ${task.handle}, got ${loggedInHandle}` }
  }
  const form = findSubmitFormLocal()
  if (!form) {
    return { ok: false, error: 'Codeforces submit form was not found; page structure may have changed' }
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
    if (!option) return { ok: false, error: `Codeforces problem was not found: ${task.contestId}${task.problemIndex}` }
    problemSelect.value = option.value
    problemSelect.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const languageSelect = form.querySelector('select[name="programTypeId"], select[name*="programType"], select[name*="language"]')
  const languageResult = selectOptionLocal(languageSelect, task.remoteLanguageId, task.remoteLanguageName)
  if (!languageResult.ok) return languageResult

  if (!setSourceLocal(form, task.sourceCode)) {
    return { ok: false, error: 'Codeforces source editor was not found; page structure may have changed' }
  }
  ensureManualNoticeLocal(form)

  return {
    ok: true,
    requestId: task.requestId,
    remoteOj: 'codeforces',
    loggedInHandle,
    selectedLanguageId: languageResult.selectedLanguageId,
    selectedLanguageName: languageResult.selectedLanguageName,
    error: 'filled Codeforces form; waiting for manual Submit click',
  }
}

async function detectCodeforcesSubmissionInDom(task) {
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
  const parseSubmissionHrefLocal = (href) => {
    try {
      const url = new URL(href, window.location.origin)
      let match = url.pathname.match(new RegExp(`/(?:contest|gym)/${task.contestId}/submission/(\\d+)`))
      if (match) return { id: match[1], url: buildCodeforcesSubmissionUrl(task, match[1], window.location.origin) }
      match = url.pathname.match(/\/problemset\/submission\/(\d+)\/(\d+)/)
      if (match && String(match[1]) === String(task.contestId)) {
        return { id: match[2], url: buildCodeforcesSubmissionUrl(task, match[2], window.location.origin) }
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
    try {
      const formData = new FormData()
      formData.set('submissionId', String(submissionId))
      const response = await fetch('/data/judgeProtocol', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (!response.ok) return {}
      const payload = await response.json()
      return parseJudgeProtocolLocal(typeof payload === 'string' ? payload : String(payload || ''))
    } catch {
      return readOpenJudgeProtocolLocal()
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
      return { id: directId, url: buildCodeforcesSubmissionUrl(task, directId, window.location.origin) }
    }
    const attrId = extractSubmissionIdFromTextLocal([
      row.getAttribute('id'),
      row.getAttribute('onclick'),
      row.getAttribute('data-a'),
      row.getAttribute('data-submission-id'),
      row.outerHTML,
    ].filter(Boolean).join(' '))
    if (attrId) {
      return { id: attrId, url: buildCodeforcesSubmissionUrl(task, attrId, window.location.origin) }
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
      return { id: numericId, url: buildCodeforcesSubmissionUrl(task, numericId, window.location.origin) }
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
    const submittedAt = cells.map((cell) => parseTimeLocal(cell.textContent)).find(Boolean)
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
  const extracted = rows.map(extractRowLocal).filter(Boolean)
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
