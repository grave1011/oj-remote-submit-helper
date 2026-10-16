// Real Chromium extension with synthetic AtCoder pages; no OJ account or submission.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')
const extension = process.env.ATCODER_EXTENSION_PATH || path.resolve(__dirname, '..')
const languageTask = process.env.ATCODER_LANGUAGE_TASK_FILE
  ? JSON.parse(fs.readFileSync(process.env.ATCODER_LANGUAGE_TASK_FILE, 'utf8')) : null
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atcoder-flow-'))
const sourceCode = 'int main() { return 42; }'
let remotePosts = 0

function fixture(mode, verified = false) {
  return `<!doctype html><form id="challenge-form" action="/contests/abc123/submit" method="post"><div id="challenge" class="cf-challenge">Verification</div>
  <button type="button" id="verify" onclick="location.replace(location.pathname + location.search + '&verified=1')">Complete verification</button></form>
  <script>
  window.model = 'previous submission'; window.submitted = 0;
  window.prepare = () => {
    document.querySelector('#challenge-form').remove();
    const area = document.createElement('div'); area.innerHTML = \`
      <form class="form-code-submit" action="/contests/abc123/submit" method="post">
        <select name="data.TaskScreenName"><option value="abc123_a">A</option></select>
        <div id="select-lang-abc123_a"><select name="data.LanguageId">${['name-only','configured'].includes(mode) ? '<option value="6054">C++ IOI-Style(GNU++20) (GCC 14.2.0)</option><option value="6017">C++23 (GCC 15.2.0)</option>' : '<option value="5001">C++ 23</option>'}</select></div>
        ${mode === 'late-token' ? '' : '<input type="hidden" name="csrf_token" value="synthetic-token">'}
        <div id="editor" style="display:${mode === 'plain' ? 'none' : 'block'}">previous submission</div>
        <textarea id="plain-textarea" name="sourceCode" style="display:${mode === 'plain' ? 'block' : 'none'}">previous submission</textarea>
        <button id="submit">Submit</button>
      </form>\`;
    document.body.append(area);
    document.querySelector('form').onsubmit = event => {
      event.preventDefault(); window.submitted++;
      if (!document.querySelector('[name=csrf_token]')) {const token=document.createElement('input');token.name='csrf_token';token.type='hidden';token.value='synthetic-on-manual-submit';event.target.append(token)}
      if (${mode !== 'plain'}) document.querySelector('textarea').value = window.model;
      window.sentCode = document.querySelector('textarea').value;
      history.pushState({}, '', '/contests/abc123/submissions/881020');
    };
    setTimeout(() => {
      window.ace = {edit: () => ({setValue(code) {window.model=code;document.querySelector('#editor').textContent=code}, getValue() {return window.model}})};
    }, 700);
  };
  ${mode === 'verification' && !verified ? '' : 'prepare();'}
  </script>`
}

;(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<button data-browser-submit-action="true" id="go">Start</button>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    })
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker')
    // Let Playwright install routing on extension-created tabs before navigation.
    await worker.evaluate(() => {
      const create = chrome.tabs.create.bind(chrome.tabs)
      chrome.tabs.create = async options => {
        const tab = await create({...options, url: 'about:blank'})
        await new Promise(resolve => setTimeout(resolve, 500))
        return chrome.tabs.update(tab.id, {url: options.url})
      }
    })
    const modes = languageTask ? ['configured'] : ['verification', 'ace', 'plain', 'name-only', 'late-token']
    for (const mode of modes) {
      await browser.route('https://atcoder.jp/**', route => {
        if (route.request().method() === 'POST') remotePosts++
        return route.fulfill({contentType: 'text/html', body: fixture(mode, new URL(route.request().url()).searchParams.has('verified'))})
      })
      const app = await browser.newPage()
      await app.goto(`http://127.0.0.1:${server.address().port}/problem/146`)
      await app.evaluate(({mode, sourceCode, languageTask}) => {
        const requestId = `atc-browser-${mode}`
        const nonce = `nonce-${requestId}-123456789`
        const task = {requestId, contestKey:'abc123', taskKey:'abc123_a', sourceCode, remoteLanguageId:mode === 'name-only' ? null : '5001', remoteLanguageName:mode === 'name-only' ? 'C++23' : 'C++ 23', sourceUrl:'https://atcoder.jp/contests/abc123/tasks/abc123_a'}
        if(languageTask)Object.assign(task,languageTask)
        window.addEventListener('message', event => {
          if (event.source !== window || event.origin !== location.origin || event.data?.requestId !== requestId) return
          if (event.data.source === 'OJ_ATCODER_BROWSER_SUBMIT_PONG') {
            window.postMessage({source:'OJ_ATCODER_BROWSER_SUBMIT', type:'submit', requestId, nonce, issuedAt:Date.now(), userGesture:true, task}, location.origin)
          }
          if (event.data.source === 'OJ_ATCODER_BROWSER_SUBMIT_RESULT') window.result = event.data
        })
        go.onclick = () => window.postMessage({source:'OJ_ATCODER_BROWSER_SUBMIT_PING', type:'ping', requestId, nonce, issuedAt:Date.now(), userGesture:true}, location.origin)
      }, {mode, sourceCode, languageTask})
      const remotePromise = browser.waitForEvent('page')
      await app.click('#go')
      const remote = await remotePromise
      await remote.waitForURL('https://atcoder.jp/**')
      if (mode === 'verification') {
        await remote.waitForSelector('#verify')
        await remote.waitForTimeout(700) // Ensure the original verification document was observed.
        assert.equal(await app.evaluate(() => window.result), undefined)
        await remote.click('#verify')
      }
      try {
        await remote.waitForFunction(code => {
          const text = document.querySelector('textarea')
          return text?.value === code && (getComputedStyle(document.querySelector('#editor')).display === 'none' || window.model === code)
        }, sourceCode, {timeout: 10000})
      } catch(error) {
        throw new Error(`AtCoder source was not filled: ${JSON.stringify(await remote.evaluate(()=>window.__ojLiteAtCoderPreparation??null))}`)
      }
      assert.equal(await app.evaluate(() => window.result), undefined)
      assert.equal(await remote.evaluate(() => window.submitted), 0)
      assert.equal(remotePosts, 0)
      if (mode === 'late-token') assert.equal(await remote.locator('[name=csrf_token]').count(), 0)
      const preparation = await remote.evaluate(() => window.__ojLiteAtCoderPreparation)
      assert.equal(preparation.phase, 'filled_waiting_manual_submit')
      assert.equal(preparation.version, JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version)
      assert.equal(JSON.stringify(preparation).includes(sourceCode), false)
      assert.equal(await remote.locator('[name="data.LanguageId"]').count(), 1)
      assert.equal(await remote.locator('[name="data.LanguageId"]').inputValue(), mode === 'configured' ? String(languageTask.remoteLanguageId) : mode === 'name-only' ? '6017' : '5001')
      await remote.click('#submit')
      await app.waitForFunction(() => window.result, null, {timeout:10000})
      const result = await app.evaluate(() => window.result)
      assert.equal(result.ok, true, result.error)
      assert.equal(result.remoteSubmissionId, '881020')
      assert.equal(await remote.evaluate(() => window.sentCode), sourceCode)
      await remote.close()
      await app.close()
      await browser.unroute('https://atcoder.jp/**')
    }
    console.log(JSON.stringify({passed:true,realSubmissions:0,checks:['same-action challenge form and full-document verification redirect','name-only language mapping','delayed Ace initialization','plain textarea','source filling without a pre-inserted CSRF field','safe preparation diagnostics','submitted source matches','manual submission and RID callback']}))
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(profile, {recursive:true,force:true})
  }
})().catch(error => {console.error(error);process.exitCode=1})
