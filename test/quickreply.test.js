// Contextual quick replies above the keyboard (#8): offered when the ball is in
// Mikey's court, matched against his own saved templates, hidden otherwise.
//
//   npm install && node test/quickreply.test.js
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
const T=[
 {phone:'+15551110000',name:'Asks Price',unread:0,ts:now,lastDir:'in',lastTs:now,messages:[{id:'a',dir:'in',body:'how much for an SUV detail?',ts:now}]},
 {phone:'+15552220000',name:'You Spoke Last',unread:0,ts:now,lastDir:'out',lastTs:now,messages:[{id:'b',dir:'in',body:'how much?',ts:now-5000},{id:'c',dir:'out',body:'$180',ts:now}]},
 {phone:'+15553330000',name:'Opted Out',unread:0,ts:now,optedOut:true,lastDir:'in',lastTs:now,messages:[{id:'d',dir:'in',body:'how much?',ts:now}]},
];
let PASS=0,FAIL=0;const check=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?PASS++:FAIL++;console.log(`${ok?'  PASS':'  FAIL'}  ${n}${ok?'':`\n     got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`)};
(async()=>{
await new Promise(r=>server.listen(8784,'127.0.0.1',r));
const b=await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({...devices['Galaxy S9+'],viewport:{width:360,height:780}});
const page=await ctx.newPage();const errs=[];page.on('pageerror',e=>errs.push(e.message));
await page.route('**/api/**',route=>{const u=new URL(route.request().url());let po={};try{po=JSON.parse(route.request().postData()||'{}')}catch(_){}
 const ph=u.searchParams.get('phone')||po.phone;const body={ok:true,threads:T};if(ph)body.thread=T.find(t=>t.phone===ph);
 route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})});
await page.goto('http://127.0.0.1:8784/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(600);
await page.keyboard.type('1234');await page.keyboard.press('Enter');await page.waitForTimeout(800);
const open=async(who)=>{if(await page.evaluate(()=>document.body.classList.contains('viewing'))){await page.locator('#backBtn').click();await page.waitForTimeout(250)}
 await page.locator('.navitem[data-tab="messages"]').click();await page.waitForTimeout(300);
 await page.getByText(who,{exact:true}).first().click();await page.waitForTimeout(600)};

console.log('\n=== quick replies above the keyboard (#8) ===');
await open('Asks Price');
check('chips are offered', await page.locator('#qReply').isVisible(), true);
const labels=await page.locator('#qReply button').allTextContents();
check('at most three', labels.length<=3 && labels.length>0, true);
check('price question surfaces a pricing reply', /pric|quote|cost/i.test(labels.join(' ')), true);
await page.locator('#qReply button').first().click();
await page.waitForTimeout(300);
check('tapping one loads it into the box', (await page.inputValue('#msgInput')).length>0, true);

console.log('\n=== and stay out of the way otherwise ===');
await open('You Spoke Last');
check('hidden when you spoke last', await page.locator('#qReply').isVisible(), false);
await open('Opted Out');
check('hidden when they opted out', await page.locator('#qReply').isVisible(), false);

console.log('\njs errors: '+(errs.length?JSON.stringify(errs):'none'));
console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
await b.close();server.close();process.exit(FAIL?1:0);
})();
