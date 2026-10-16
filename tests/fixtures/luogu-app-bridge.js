// 测试夹具：对应 SDUSTJudge 的洛谷消息协议客户端，仅供合成页面回归。
// Uses the existing Lite page bridge; there is no extension UI or separate receiver.
export const runLuoguBrowserSubmit = async (remote, sourceCode, { userGestureAt, onReport } = {}) => {
  const task = { ...remote.browser_task, sourceCode }
  if (!task.requestId || !task.pid || !task.sourceSha256 || !sourceCode?.trim()) throw new Error('洛谷浏览器任务缺少必要信息，请刷新提交记录')
  if (!Number.isFinite(userGestureAt) || Date.now() - userGestureAt > 120000) throw new Error('请通过页面提交按钮发起洛谷浏览器任务')
  const nonce = crypto.randomUUID()
  const envelope = { requestId: task.requestId, nonce, userGesture: true, issuedAt: userGestureAt }
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', listener) }
    const listener = (event) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'OJ_LUOGU_BROWSER_SUBMIT_PONG' || event.data.nonce !== nonce || event.data.requestId !== task.requestId) return
      cleanup()
      event.data.ok ? resolve() : reject(new Error(event.data.error || '洛谷浏览器插件握手失败'))
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('未检测到支持洛谷的 Lite 插件，请加载最新插件并刷新本站页面')) }, 5000)
    window.addEventListener('message', listener)
    window.postMessage({ ...envelope, source: 'OJ_LUOGU_BROWSER_SUBMIT_PING', type: 'ping' }, location.origin)
  })
  return new Promise((resolve, reject) => {
    let chain = Promise.resolve()
    let settled = false
    const cleanup = () => { settled = true; clearTimeout(timer); window.removeEventListener('message', listener) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('洛谷观察已中断，请到结果页继续观察已有记录')) }, 21 * 60 * 1000)
    const listener = (event) => {
      const value = event.data
      if (event.source !== window || event.origin !== location.origin || value?.requestId !== task.requestId || value.nonce !== nonce
        || !['OJ_LUOGU_BROWSER_SUBMIT_PROGRESS', 'OJ_LUOGU_BROWSER_SUBMIT_RESULT'].includes(value.source)) return
      chain = chain.then(async () => {
        if (settled) return
        if (value.phase !== 'preparing' && value.remoteUid && Number.isSafeInteger(value.sequence) && value.sequence > 0) {
          await onReport?.({
            judge_generation: remote.judge_generation,
            remote_submission_id: value.remoteSubmissionId,
            browser_observation: {
              requestId: task.requestId, pid: task.pid, sourceSha256: task.sourceSha256,
              remoteLanguageId: task.remoteLanguageId, remoteUid: value.remoteUid,
              sequence: value.sequence, phase: value.phase, done: value.done === true,
              remoteSubmissionId: value.remoteSubmissionId,
              correlation: value.correlation, requestCodeMatched: value.requestCodeMatched,
              requestLanguageMatched: value.requestLanguageMatched,
              result: value,
            },
          })
        }
        if (value.source === 'OJ_LUOGU_BROWSER_SUBMIT_RESULT') {
          cleanup()
          if (value.ok && value.done) resolve(value)
          else reject(new Error(value.error || '洛谷结果尚未确认，请保留原站记录后继续观察，勿重复提交'))
        }
      }).catch((error) => { cleanup(); reject(error) })
    }
    window.addEventListener('message', listener)
    window.postMessage({ ...envelope, source: 'OJ_LUOGU_BROWSER_SUBMIT', type: 'browserSubmitLuogu', task }, location.origin)
  })
}
