// Money-side behaviour: the "won but never logged" prompt (#12) and the blast
// cost preview (#11).
//
//   npm install && node test/money.test.js
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
 {phone:'+15551110000',name:'Won NoMoney',unread:0,ts:now,status:'won',lastDir:'out',lastTs:now,messages:[{id:'a',dir:'out',body:'all done',ts:now}]},
 {phone:'+15552220000',name:'Won Paid',unread:0,ts:now,status:'won',lastDir:'out',lastTs:now,messages:[{id:'b',dir:'out',body:'thanks',ts:now}]},
 {phone:'+15553330000',name:'Just Active',unread:0,ts:now,status:'active',lastDir:'out',lastTs:now,messages:[{id:'c',dir:'out',body:'hi',ts:now}]},
 {phone:'+15554440000',name:'Quote Cold',unread:0,ts:now,status:'active',lastDir:'out',lastTs:now,
  quote:{id:'q1',total:240,service:'Full detail',at:now-6*86400000},messages:[{id:'e',dir:'out',body:'quote sent',ts:now}]},
 {phone:'+15555550000',name:'Quote Fresh',unread:0,ts:now,status:'active',lastDir:'out',lastTs:now,
  quote:{id:'q2',total:180,service:'Interior',at:now-3600000},messages:[{id:'f',dir:'out',body:'quote sent',ts:now}]},
 {phone:'+15556660000',name:'Quote Won',unread:0,ts:now,status:'won',lastDir:'out',lastTs:now,
  quote:{id:'q3',total:300,service:'Full detail',at:now-9*86400000},messages:[{id:'g',dir:'out',body:'booked',ts:now}]},
];
let PASS=0,FAIL=0;const check=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?PASS++:FAIL++;console.log(`${ok?'  PASS':'  FAIL'}  ${n}${ok?'':`\n     got ${JSON.stringify(g)} want ${JSON.stringify(w)}`}`)};
(async()=>{
await new Promise(r=>server.listen(8785,'127.0.0.1',r));
const b=await chromium.launch({executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({...devices['Galaxy S9+'],viewport:{width:360,height:780}});
const page=await ctx.newPage();const errs=[];page.on('pageerror',e=>errs.push(e.message));
await page.route('**/api/**',route=>{const u=new URL(route.request().url());let po={};try{po=JSON.parse(route.request().postData()||'{}')}catch(_){}
 if(u.pathname==='/api/money/by-phone'){
   const ph=u.searchParams.get('phone');
   const paid=ph==='+15552220000';
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,jobs:paid?2:0,total:paid?380:0,entries:[]})});
 }
 const ph=u.searchParams.get('phone')||po.phone;const body={ok:true,threads:T};if(ph)body.thread=T.find(t=>t.phone===ph);
 route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})});
await page.goto('http://127.0.0.1:8785/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(600);
await page.keyboard.type('1234');await page.keyboard.press('Enter');await page.waitForTimeout(800);
const open=async(who)=>{if(await page.evaluate(()=>document.body.classList.contains('viewing'))){await page.locator('#backBtn').click();await page.waitForTimeout(250)}
 await page.locator('.navitem[data-tab="messages"]').click();await page.waitForTimeout(300);
 await page.getByText(who,{exact:true}).first().click();await page.waitForTimeout(700)};

console.log('\n=== won job with nothing logged (#12) ===');
await open('Won NoMoney');
check('banner shown', await page.locator('#logJobBanner').isVisible(), true);
check('says what is wrong', /nothing logged/i.test(await page.locator('#logJobBanner').textContent()||''), true);
await open('Won Paid');
check('hidden once money is logged', await page.locator('#logJobBanner').isVisible(), false);
await open('Just Active');
check('hidden when not won', await page.locator('#logJobBanner').isVisible(), false);

console.log('\n=== a quote nobody answered (#13) ===');
await open('Quote Cold');
check('banner shown once it goes quiet', await page.locator('#quoteBanner').isVisible(), true);
check('says how long and how much', /no answer/i.test(await page.locator('#quoteBanner').textContent()||'') && /240/.test(await page.locator('#quoteBanner').textContent()||''), true);
await page.locator('#quoteBanner .qb-go').click();
await page.waitForTimeout(250);
check('nudge drafts a follow-up', /circling back/i.test(await page.inputValue('#msgInput')), true);
await open('Quote Fresh');
check('quiet for a day is not "cold"', await page.locator('#quoteBanner').isVisible(), false);
await open('Quote Won');
check('hidden once the lead is won', await page.locator('#quoteBanner').isVisible(), false);

console.log('\n=== what a blast costs (#11) ===');
// The segment maths itself is covered by the counter tests in compose.test.js;
// what matters here is that the blast sheet actually applies it per recipient
// before the send, and that the confirm repeats the number.
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('cost line exists in the blast sheet', /id="blCost"/.test(SRC), true);
check('cost is per recipient',               /info\.segments\s*\*\s*n/.test(SRC), true);
check('priced at a per-segment rate',        /segs\s*\*\s*BLAST_RATE/.test(SRC), true);
check('recalculates as the message changes', /#blBody"\)\.addEventListener\("input",count\)/.test(SRC), true);
check('a unicode message is called out',     /makes it unicode/.test(SRC), true);
check('the confirm names the cost',          /cs\+" message"/.test(SRC), true);

console.log('\njs errors: '+(errs.length?JSON.stringify(errs):'none'));
console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
await b.close();server.close();process.exit(FAIL?1:0);
})();
