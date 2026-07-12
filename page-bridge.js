(function () {
  const REQUEST_SOURCE = 'OJ_ATCODER_BROWSER_SUBMIT'
  const RESULT_SOURCE = 'OJ_ATCODER_BROWSER_SUBMIT_RESULT'
  const CODEFORCES_REQUEST_SOURCE = 'OJ_CODEFORCES_BROWSER_SUBMIT'
  const CODEFORCES_RESULT_SOURCE = 'OJ_CODEFORCES_BROWSER_SUBMIT_RESULT'

  const postResult = (resultSource, task, payload) => {
    const targetOrigin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*'
    window.postMessage({
      source: resultSource,
      requestId: task?.requestId,
      ...payload,
    }, targetOrigin)
  }

  const bridgeError = (error) => {
    const message = error?.message || String(error || '')
    if (/extension context invalidated|receiving end does not exist|context invalid/i.test(message)) {
      return `${message}. 请刷新 OJ 页面并在扩展管理页确认 OJ Remote Submit Helper Lite 已启用。`
    }
    return message || 'browser extension bridge is unavailable'
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const isAtCoder = event.data?.source === REQUEST_SOURCE && event.data?.type === 'submit'
    const isCodeforces = (
      event.data?.source === CODEFORCES_REQUEST_SOURCE
      || event.data?.type === 'submitCodeforces'
      || event.data?.type === 'browserSubmitCodeforces'
      || String(event.data?.task?.remoteOj || event.data?.task?.platformCode || '').toLowerCase() === 'codeforces'
    )
    if (!isAtCoder && !isCodeforces) return
    const resultSource = isCodeforces ? CODEFORCES_RESULT_SOURCE : RESULT_SOURCE
    const task = event.data.task
    try {
      if (!globalThis.chrome?.runtime?.id) {
        postResult(resultSource, task, {
          ok: false,
          error: 'browser extension bridge is unavailable. 请刷新 OJ 页面并确认 OJ Remote Submit Helper Lite 已安装启用。',
        })
        return
      }
      chrome.runtime.sendMessage(
        {
          type: isCodeforces ? 'browserSubmitCodeforces' : 'submitAtCoder',
          task,
        },
        (response) => {
          const lastError = chrome.runtime.lastError
          if (lastError) {
            postResult(resultSource, task, {
              ok: false,
              error: bridgeError(lastError),
            })
            return
          }
          postResult(resultSource, task, response || { ok: false, error: 'empty extension response' })
        },
      )
    } catch (error) {
      postResult(resultSource, task, {
        ok: false,
        error: bridgeError(error),
      })
    }
  })
}())
