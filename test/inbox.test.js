// Inbox behaviour: the "Waiting on me" filter (#14), landing on the first
// unread in a long thread (#9), and the mic being reachable (#10).
//
//   npm install && node test/inbox.test.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium, devices;
try { ({ chromium, devices } = await import('playwright-core')); }
catch { console.error('playwright-core is missing — run `npm install` first.'); process.exit(2); }
const ROOT = path.join(__dirname, '..', 'public');
const server=http.createServer((q,r)=>{let p=q.url.split('?')[0];if(p==='/')p='/index.html';const f=path.join(ROOT,p);if(!fs.existsSync(f)){r.writeHead(404);return r.end('nf')}r.writeHead(200,{'content-type':p.endsWith('.html')?'text/html':'text/javascript'});r.end(fs.readFileSync(f))});
const now=Date.now();
const many=[];for(let i=0;i<25;i++)many.push({id:'o'+i,dir:'out',body:'older message '+i,ts:now-86400000*3+i*1000});
for(let i=0;i<15;i++)many.push({id:'u'+i,dir:'in',body:'new one '+i,ts:now-3600000+i*1000});
const T=[
 {phone:'+15551110000',name:'Dave Reyes',unread:15,ts:now,lastDir:'in',lastTs:now-3600000,messages:many},
 {phone:'+15552220000',name:'Old Quiet',unread:0,ts:now-8*86400000,lastDir:'in',lastTs:now-8*86400000,messages:[{id:'q1',dir:'in',body:'still there?',ts:now-8*86400000}]},
 {phone:'+15553330000',name:'Held Sabine',unread:0,ts:now,lastDir:'in',lastTs:now-2*86400000,heldUntil:now+5*86400000,holdReason:'doing her car in August',messages:[{id:'h1',dir:'in',body:'hi',ts:now-2*86400000}]},
 {phone:'+15554440000',name:'You Replied',unread:0,ts:now,lastDir:'out',lastTs:now-1000,messages:[{id:'r1',dir:'out',body:'all set',ts:now-1000}]},
];
let PASS=0,FAIL=0;const check=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?PASS++:FAIL++;console.log(`${ok?'  PASS':'  FAIL'}  ${n}${ok?'':`\n     got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`)};
(async()=>{
await new Promise(r=>server.listen(8786,'127.0.0.1',r));
const b=await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({...devices['Galaxy S9+'],viewport:{width:360,height:780}});
const page=await ctx.newPage();const errs=[];page.on('pageerror',e=>errs.push(e.message));
await page.route('**/api/**',route=>{const u=new URL(route.request().url());let po={};try{po=JSON.parse(route.request().postData()||'{}')}catch(_){}
 const ph=u.searchParams.get('phone')||po.phone;const body={ok:true,threads:T};if(ph)body.thread=T.find(t=>t.phone===ph);route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})});
await page.goto('http://127.0.0.1:8786/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(600);
await page.keyboard.type('1234');await page.keyboard.press('Enter');await page.waitForTimeout(800);
await page.locator('.navitem[data-tab="messages"]').click();await page.waitForTimeout(400);

console.log('\n=== "Waiting on me" filter (#14) ===');
const chips=await page.locator('#filters .chip').allTextContents();
check('the chip exists', chips.some(c=>/Waiting on me/.test(c)), true);
check('it counts only who is owed', /Waiting on me3/.test(chips.join('')), true);
await page.getByText(/^Waiting on me/).first().click();await page.waitForTimeout(400);
const names=await page.evaluate(()=>[...document.querySelectorAll('#scroll .conv .nm')].map(x=>x.textContent.trim()));
check('held customer excluded', names.includes('Held Sabine'), false);
check('you-replied excluded',   names.includes('You Replied'), false);
check('longest wait first',     names, ['Old Quiet','Dave Reyes']);

console.log('\n=== jump to where you left off (#9) ===');
await page.getByText('Dave Reyes',{exact:true}).first().click();await page.waitForTimeout(700);
check('a "new" divider is drawn', (await page.locator('.newmark').count())>0, true);
check('divider says how many', (await page.locator('.newmark').first().textContent()||'').trim(), '15 new');
const pos=await page.evaluate(()=>{const b=document.getElementById('messages');const m=b.querySelector('.newmark');
 return {scroll:Math.round(b.scrollTop), markTop:Math.round(m.offsetTop), atBottom: b.scrollTop>=b.scrollHeight-b.clientHeight-5}});
check('did not dump you at the bottom', pos.atBottom, false);
check('landed on the divider', Math.abs(pos.scroll-(pos.markTop-24))<8, true);
check('the divider is on screen', await page.evaluate(()=>{const b=document.getElementById('messages');const m=b.querySelector('.newmark');
  const top=m.offsetTop-b.scrollTop;return top>=0&&top<=b.clientHeight}), true);

console.log('\n=== mic is out of the drawer (#10) ===');
check('mic visible when supported', await page.evaluate(()=>{
  const m=document.getElementById('micBtn');
  const supported=!!(window.SpeechRecognition||window.webkitSpeechRecognition);
  return supported ? getComputedStyle(m).display!=='none' : 'unsupported-in-this-browser';
}), await page.evaluate(()=>!!(window.SpeechRecognition||window.webkitSpeechRecognition))?true:'unsupported-in-this-browser');

console.log('\njs errors: '+(errs.length?JSON.stringify(errs):'none'));
console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
await b.close();server.close();process.exit(FAIL?1:0);
})();
