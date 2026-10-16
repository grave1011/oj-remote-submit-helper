// Uses the repository's Playwright and Chromium with synthetic pages only.
const path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const fs=require('fs'),http=require('http'),assert=require('node:assert/strict'),crypto=require('crypto');
const base=process.env.LUOGU_EXTENSION_PATH || path.resolve(__dirname,'..');
const configDatabase=process.env.LUOGU_CONFIG_DATABASE || 'lfeConfig';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'luogu-flow-'));
let submitCount=0;
const code='int main() { return 0; }'; const hash=crypto.createHash('sha256').update(code).digest('hex');
const task={requestId:'lg-browser-fixture-g1',pid:'P1001',remoteLanguageId:'4',sourceSha256:hash,sequence:0,createdAt:new Date().toISOString()};
const context={template:'problem.show',user:{uid:99},data:{problem:{pid:'P1001',acceptLanguages:[4]},contest:null}};
const record={template:'record.show',user:{uid:99},data:{canViewStatus:true,canViewCode:true,record:{id:123456789,user:{uid:99},problem:{pid:'P1001'},language:4,submitTime:Math.floor(Date.now()/1000),status:12,score:100,time:5,memory:128,sourceCode:code,detail:{compileResult:{success:true},judgeResult:{subtasks:[{id:1,status:12,testCases:[{id:1,status:12,time:5,memory:128}]}]}}}}};
const html=c=>`<!doctype html><script type="application/json" id="lentille-context">${JSON.stringify(c)}</script>`;
const problem=html(context)+`<div id="app"><div class="combo-wrapper lang-select"><div class="text">C</div></div><div class="dropdown" hidden><ul><li>C++11</li></ul></div><div class="cm-editor" style="min-height:60px"><div class="cm-content" contenteditable="true"></div></div><button id="submit">Submit</button></div><script>
const editor=document.querySelector('.cm-editor'), content=document.querySelector('.cm-content');let code='';
const view={dom:editor,contentDOM:content,state:{doc:{length:0},sliceDoc:()=>code},dispatch({changes}){code=changes.insert;this.state.doc.length=code.length;content.textContent=code},focus(){}};content.cmTile={root:{view}};
const control=document.querySelector('.lang-select'),menu=document.querySelector('.dropdown');control.onclick=()=>{control.classList.toggle('shown');menu.hidden=!menu.hidden};menu.querySelector('li').onclick=()=>{control.querySelector('.text').textContent='C++11';menu.hidden=true;control.classList.remove('shown')};
const req=indexedDB.open('${configDatabase}',1);req.onupgradeneeded=()=>req.result.createObjectStore('keyvaluepairs');req.onsuccess=()=>{const db=req.result,tx=db.transaction('keyvaluepairs','readwrite'),s=tx.objectStore('keyvaluepairs');s.put([{id:4,name:'C++11'}],'CodeLanguage');s.put({'api.problem.submit':'/fe/api/problem/submit/{pid}'},'route');s.put({12:{id:12,name:'Accepted',shortName:'AC'}},'RecordStatus');tx.oncomplete=()=>db.close()};
submit.onclick=()=>{const xhr=new XMLHttpRequest();xhr.open('POST','/fe/api/problem/submit/P1001');xhr.onload=()=>history.pushState({},'', '/record/123456789');xhr.send(JSON.stringify({lang:4,code}))};</script>`;
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<button data-browser-submit-action="true" id="go">Start</button>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try{
 browser=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${base}`,`--load-extension=${base}`,'--no-sandbox']});
 // Delay the fixture's initial navigation until Playwright has attached routing to the extension-created tab.
 // All preparation, observation, messaging and MAIN-world script injection use production code.
 const worker=browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
 await worker.evaluate(()=>{const create=chrome.tabs.create.bind(chrome.tabs);chrome.tabs.create=async options=>{const tab=await create({...options,url:'about:blank'});await new Promise(r=>setTimeout(r,500));return chrome.tabs.update(tab.id,{url:options.url})}});
 await browser.route('https://www.luogu.com.cn/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/fe/api/')){submitCount++;record.data.record.submitTime=Math.floor(Date.now()/1000);return route.fulfill({contentType:'application/json',body:'{"rid":123456789}'});}await route.fulfill({contentType:'text/html',body:path.startsWith('/record/')?html(record):problem})});
 const app=await browser.newPage();await app.goto(`http://127.0.0.1:${server.address().port}/problem/146`);
 await app.addScriptTag({content:fs.readFileSync(path.join(__dirname,'fixtures/luogu-app-bridge.js'),'utf8').replace('export const','window.runLuoguBrowserSubmit =') .replace('window.runLuoguBrowserSubmit = runLuoguBrowserSubmit =','window.runLuoguBrowserSubmit =')});
 await app.evaluate(({task,code})=>{window.reports=[];go.onclick=()=>{window.runLuoguBrowserSubmit({judge_generation:1,browser_task:task},code,{userGestureAt:Date.now(),onReport:async p=>window.reports.push(p)}).then(x=>window.outcome=x).catch(e=>window.failure=e.message);history.pushState({},'','/solution/74')}},{task,code});
 await app.click('#go');
 await app.waitForFunction(()=>reports.length||window.failure,{},{timeout:30000});
 const first=await app.evaluate(()=>({reports,failure:window.failure}));assert.equal(first.failure,undefined);assert.equal(submitCount,0,'Preparation must never submit');assert.ok(first.reports.length,'Prepared status must reach app before manual submit');
 const luogu=browser.pages().find(p=>p.url().includes('luogu.com.cn'));
 assert.equal(await luogu.locator('.cm-content').textContent(),code);
 assert.equal(await luogu.locator('.lang-select .text').textContent(),'C++11');
 await luogu.click('#submit');
 await app.waitForFunction(()=>window.outcome||window.failure,{},{timeout:20000});
 const result=await app.evaluate(()=>({reports:reports.map(x=>({phase:x.browser_observation.phase,rid:x.browser_observation.remoteSubmissionId})),outcome:window.outcome,failure:window.failure}));assert.equal(result.outcome?.verdict,'AC');
 assert.equal(submitCount,1);assert.equal(result.outcome.remoteSubmissionId,'123456789');
 const databases=await luogu.evaluate(()=>indexedDB.databases());assert.deepEqual(databases.map(x=>x.name),[configDatabase]);
 console.log(JSON.stringify({passed:true,database:configDatabase,realSubmissions:0,phases:result.reports.map(x=>x.phase),checks:['C to C++11 language selection','exact CodeMirror replacement','no automatic submission','manual XHR RID capture across SPA navigation','pinned record and serialized completion callback','cache read never creates databases']}));
 }finally{await browser?.close();server.close();fs.rmSync(profile,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
