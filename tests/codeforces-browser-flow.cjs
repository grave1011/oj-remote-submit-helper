// Real Chromium extension with synthetic CF/Gym pages. No OJ account or real submission.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const {chromium} = require('playwright')
const extension = process.env.CODEFORCES_EXTENSION_PATH || path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-flow-'))
const version = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version
const sourceCode = 'int main() { return 0; }'
const compileError = "Can't compile file:\nprogram.cpp: In function 'int main()':\nprogram.cpp:6:20: error: expected initializer before '}' token\n    6 | int main() {int n；}\n      |                    ^\n#include <bits/stdc++.h>"

function fixture(mode, verified, recordUrl) {
  const isGym = mode.startsWith('gym')
  if (mode === 'verification' && !verified) return `<!doctype html>
    <form id="challenge-form" action="${new URL(recordUrl).pathname.replace(/\/submission\/\d+$/, '/submit')}" method="post">
      <div class="cf-challenge">Verification</div>
      <button type="button" id="verify" onclick="location.replace(location.href+'?verified=1')">Verify</button>
    </form>`
  return `<!doctype html><span class="csrf-token" data-csrf="fixture-csrf"></span><a href="/profile/fixture-user">fixture-user</a>
    <form action="${new URL(recordUrl).pathname.replace(/\/submission\/\d+$/, '/submit')}" method="post">
      <select name="submittedProblemIndex"><option value="${isGym?'J':'A'}">${isGym?'J':'A'}. Problem</option></select>
      <select name="programTypeId"><option value="54">GNU G++17 7.3.0</option><option value="89">GNU G++20 13.2 (64 bit, winlibs)</option></select>
      <textarea name="source" style="display:none">historical code</textarea>
      <div class="${mode === 'ace' ? 'ace_editor' : 'CodeMirror'}" id="editor"><pre>historical code</pre></div>
      <button id="submit">Submit</button>
    </form><script>
    window.model='historical code';window.submitted=0;
    setTimeout(()=>{
      const editor={
        setValue(code){window.model=code;document.querySelector('#editor pre').textContent=code},
        getValue(){return window.model}
      };
      if(${JSON.stringify(mode)}==='ace')window.ace={edit(){return editor}};
      else document.querySelector('.CodeMirror').CodeMirror=editor;
    },600);
    document.querySelector('form').onsubmit=event=>{
      event.preventDefault();window.submitted++;
      document.querySelector('textarea').value=window.model;
      window.sentCode=window.model;
      ${isGym ? `sessionStorage.setItem('sentCode',window.sentCode);location.assign(${JSON.stringify(new URL(recordUrl).pathname.replace(/\/submission\/\d+$/, '/my'))});` : `history.pushState({},'',${JSON.stringify(new URL(recordUrl).pathname)});`}
    };
    </script>`
}

;(async () => {
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<button data-browser-submit-action="true" id="go">Start</button>')})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  let browser
  try {
    browser=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-sandbox']})
    const worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker')
    await worker.evaluate(()=>{
      const create=chrome.tabs.create.bind(chrome.tabs)
      chrome.tabs.create=async options=>{
        const tab=await create({...options,url:'about:blank'})
        await new Promise(resolve=>setTimeout(resolve,500))
        return chrome.tabs.update(tab.id,{url:options.url})
      }
    })
    const modes=process.env.CODEFORCES_FLOW_MODE ? [process.env.CODEFORCES_FLOW_MODE] : ['contest','verification','gym','gym-protocol-pending','gym-timezone','ace','ce','ce-source','gym-ce','ce-unavailable']
    for(const mode of modes) {
      let remotePosts=0
      let timeLookups=0
      const isGym=mode.startsWith('gym')
      const isCe=mode.includes('ce') && mode!=='ace'
      const contestId=isGym?'106738':'2273'
      const prefix=isGym?'gym':'contest'
      const submissionId=isGym?'394704185':'881060'
      const problemIndex=isGym?'J':'A'
      const recordUrl=`https://codeforces.com/${prefix}/${contestId}/submission/${submissionId}`
      let releaseProtocol
      const protocolGate=new Promise(resolve=>{releaseProtocol=resolve})
      await browser.route('https://codeforces.com/**',route=>{
        if(route.request().method()==='POST')remotePosts++
        const url=new URL(route.request().url())
        if(url.pathname==='/api/user.status') {
          timeLookups++
          assert.equal(url.searchParams.get('handle'),'fixture-user')
          return route.fulfill({json:{status:'OK',result:[{
            id:Number(submissionId),creationTimeSeconds:Math.floor(Date.now()/1000),
            problem:{contestId:Number(contestId),index:problemIndex},author:{members:[{handle:'fixture-user'}]},
            verdict:isCe ? (timeLookups===1?'TESTING':'COMPILATION_ERROR') : 'OK',
          }]}})
        }
        if(url.pathname==='/data/submitSource') {
          const params=new URLSearchParams(route.request().postData())
          assert.equal(params.get('submissionId'),submissionId)
          assert.equal(params.get('csrf_token'),'fixture-csrf')
          if(mode==='ce-unavailable')return route.fulfill({status:403,body:'Forbidden'})
          return route.fulfill({json:{submissionProtocol:mode==='ce'?'':compileError.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),source:'never return original source'}})
        }
        if(url.pathname==='/data/judgeProtocol') {
          if(mode==='gym-protocol-pending')return protocolGate.then(()=>route.fulfill({json:''})).catch(()=>{})
          if(isCe) {
            const params=new URLSearchParams(route.request().postData())
            if(params.get('csrf_token')!=='fixture-csrf'||mode==='ce-unavailable')return route.fulfill({status:403,body:'Forbidden'})
            return route.fulfill({json:compileError})
          }
          return route.fulfill({json:''})
        }
        if(isGym && url.pathname.endsWith('/my')) {
          const date=new Date(Date.now()-5*60*60*1000)
          const wallTime=`${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`
          return route.fulfill({contentType:'text/html',body:`<!doctype html><span class="csrf-token" data-csrf="fixture-csrf"></span>
          <table class="status-frame-datatable"><tr><th>#</th></tr>
            <tr data-submission-id="${submissionId}">${mode==='gym-timezone' ? `
              <td>${submissionId}</td><td>${wallTime}</td><td><a href="/profile/fixture-user">fixture-user</a></td>
              <td><a href="/gym/${contestId}/problem/J">J. Problem</a></td><td>GNU G++20</td>
              <td class="verdict">In queue</td>` : `<td><a href="${new URL(recordUrl).pathname}">${submissionId}</a></td>`}</tr>
          </table>`})
        }
        return route.fulfill({contentType:'text/html',body:fixture(mode,new URL(route.request().url()).searchParams.has('verified'),recordUrl)})
      })
      const app=await browser.newPage()
      await app.goto(`http://127.0.0.1:${server.address().port}/problem/147`)
      await app.evaluate(({mode,contestId,prefix,problemIndex,sourceCode})=>{
        const requestId=`cf-browser-${mode}`,nonce=`nonce-${requestId}-123456789`
        const task={requestId,contestId,problemIndex,sourceCode,sourceUrl:`https://codeforces.com/${prefix}/${contestId}/problem/${problemIndex}`,remoteLanguageId:'89',remoteLanguageName:'GNU G++20 13.2 (64 bit, winlibs)'}
        window.addEventListener('message',event=>{
          if(event.source!==window||event.origin!==location.origin||event.data?.requestId!==requestId)return
          if(event.data.source==='OJ_CODEFORCES_BROWSER_SUBMIT_PONG')window.postMessage({source:'OJ_CODEFORCES_BROWSER_SUBMIT',type:'browserSubmitCodeforces',requestId,nonce,issuedAt:Date.now(),userGesture:true,task},location.origin)
          if(event.data.source==='OJ_CODEFORCES_BROWSER_SUBMIT_RESULT')window.result=event.data
        })
        go.onclick=()=>window.postMessage({source:'OJ_CODEFORCES_BROWSER_SUBMIT_PING',type:'ping',requestId,nonce,issuedAt:Date.now(),userGesture:true},location.origin)
      },{mode,contestId,prefix,problemIndex,sourceCode})
      const opened=browser.waitForEvent('page')
      await app.click('#go')
      const remote=await opened
      await remote.waitForURL('https://codeforces.com/**')
      if(mode==='verification') {
        await remote.waitForSelector('#verify')
        await remote.waitForTimeout(700)
        assert.equal(await app.evaluate(()=>window.result),undefined)
        await remote.click('#verify')
      }
      await remote.waitForFunction(code=>window.model===code&&document.querySelector('textarea')?.value===code,sourceCode,{timeout:10000})
      assert.equal(await app.evaluate(()=>window.result),undefined)
      assert.equal(await remote.evaluate(()=>window.submitted),0)
      assert.equal(await remote.locator('[name="programTypeId"]').inputValue(),'89')
      assert.equal(await remote.locator('[name="submittedProblemIndex"]').inputValue(),problemIndex)
      assert.equal(await remote.locator('#oj-codeforces-browser-submit-notice').count(),0)
      assert.equal(remotePosts,0)
      const diagnostics=await remote.evaluate(()=>window.__ojLiteCodeforcesPreparation)
      assert.equal(diagnostics.version,version)
      assert.equal(diagnostics.phase,'filled_waiting_manual_submit')
      assert.equal(JSON.stringify(diagnostics).includes(sourceCode),false)
      await remote.click('#submit')
      if(isGym) {
        await remote.waitForURL(`https://codeforces.com/gym/${contestId}/my`)
        assert.equal(await remote.evaluate(()=>window.__ojLiteCodeforcesPreparation??null),null)
      }
      try {
        await app.waitForFunction(()=>window.result,null,{timeout:mode==='ce-unavailable'?25000:(isCe?10000:5000)})
      } finally {
        releaseProtocol()
      }
      const result=await app.evaluate(()=>window.result)
      assert.equal(result.ok,true,result.error)
      assert.equal(result.remoteSubmissionId,submissionId)
      assert.equal(result.remoteSubmissionUrl,recordUrl)
      if(isGym&&!isCe)assert.equal(remotePosts,1,'the optional protocol lookup runs once after the human submits')
      if(isCe) {
        assert.equal(result.compileError,mode==='ce-unavailable'?undefined:compileError,'return the exact compiler log, or preserve the RID when diagnostics remain unavailable')
        assert.equal(JSON.stringify(result).includes('never return original source'),false)
        assert.equal(JSON.stringify(result).includes('fixture-csrf'),false)
        const observation=await remote.evaluate(()=>window.__ojLiteCodeforcesCompileObservation)
        assert.equal(observation.phase,mode==='ce-unavailable'?'waiting_protocol':'received')
        assert.equal(JSON.stringify(observation).includes(compileError),false)
        assert.equal(JSON.stringify(observation).includes('fixture-csrf'),false)
      }
      if(mode==='gym-timezone') {
        assert.equal(timeLookups,2)
        assert.equal(result.remoteStatus,'In queue','the RID callback does not wait for judging to finish')
      }
      assert.equal(await remote.evaluate(isGym=>isGym?sessionStorage.getItem('sentCode'):window.sentCode,isGym),sourceCode)
      await remote.close();await app.close();await browser.unroute('https://codeforces.com/**')
    }
    console.log(JSON.stringify({passed:true,realSubmissions:0,modes,checks:['manual submit and RID callback','Gym /my document replacement','row time verified against API epoch','bounded optional protocol request','CE after TESTING via source popup and judge protocol','compiler indentation and C++ angle brackets','RID preserved when CE details are unavailable','language and source values','no injected interface']}))
  } finally {
    await browser?.close()
    await new Promise(resolve=>server.close(resolve))
    fs.rmSync(profile,{recursive:true,force:true})
  }
})().catch(error=>{console.error(error);process.exitCode=1})
