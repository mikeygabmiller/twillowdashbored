// The booking page facts check (Bookings → Settings). The saved settings that
// /book.html draws from were a week behind the website on 2026-10-02: $299 /
// $200 / $160, "First-timers ~3–4 hrs", an exterior that includes polish, the
// old add-ons, 39 reviews, 8 towns and a free-exterior headline. This runs the
// real worker against a copy of exactly that.
//
// What has to hold:
//   · every one of those is listed, in words he'd use
//   · "Match the website" fixes only those fields: ids, job lengths, start
//     times, switches, calendar and booking texts come through untouched
//   · after it, nothing is listed, and the public config shows the price book
//   · it never runs on its own: reading the settings writes nothing
//
//   node test/bookfacts.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
let writes = 0;
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { writes++; store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const M = new Function('__env__', src + '\n; ENV = __env__; return { bookFactsIssues, bookFactsApply, apiBookingFacts, apiBookingSettings, apiSaveBookingSettings, apiBookConfig, loadBookingConfig, bookingDefaults, BOOK_FACTS };')({ MESSAGES: kv });

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const body = async (r) => r.json();

// What /api/book-config served on 2026-10-02, plus the private bits it hides.
const LIVE = {
  tz: 'America/Los_Angeles', workDays: [1, 2, 3, 4, 5, 6], dayStart: '07:00', lastStart: '16:00', stepMin: 30, bufferMin: 60,
  maxJobsPerDay: 2, minLeadMin: 120, windowDays: 30,
  sizes: [{ id: 'sedan', label: 'Car / Sedan' }, { id: 'suv', label: 'SUV / Crossover' }, { id: 'truck', label: 'Truck / Van / XL' }],
  services: [
    { id: 'full', name: 'Full Detail — In & Out', enabled: true, popular: true, blurb: 'The works: deep interior + full exterior. First-timers ~3–4 hrs.', price: { sedan: 299, suv: 339, truck: 379 }, duration: { sedan: 180, suv: 210, truck: 240 } },
    { id: 'interior', name: 'Interior Detail', enabled: true, popular: false, blurb: 'Full vacuum, carpets & seats, all surfaces, windows, pet hair.', price: { sedan: 200, suv: 240, truck: 280 }, duration: { sedan: 90, suv: 110, truck: 120 } },
    { id: 'exterior', name: 'Exterior Detail', enabled: false, popular: false, blurb: 'Hand wash, wheels & tires, bug & tar, polish, spray wax.', price: { sedan: 160, suv: 200, truck: 240 }, duration: { sedan: 45, suv: 60, truck: 75 } },
  ],
  addons: [
    { id: 'add0', name: 'Carpet & upholstery shampoo', price: 20, enabled: true, popular: true, blurb: '' },
    { id: 'add1', name: 'Pet hair removal', price: 30, enabled: true, popular: false, blurb: '' },
    { id: 'add4', name: 'Headlight restoration', price: 50, enabled: true, popular: false, blurb: '' },
  ],
  cities: ['Everett', 'Bothell', 'Lake Stevens', 'Mill Creek', 'Monroe', 'Marysville', 'Duvall', 'Snohomish'],
  content: { businessName: "Mikey's Mobile Detailing", phoneDisplay: '(425) 600-7897', phone: '+14256007897',
    hook: 'First full detail? Your exter & wax (a $160 value) is free.', guarantee: "You don't pay until you love it.", urgency: true, freeWax: false },
  proof: { rating: '5.0', reviews: 39, cars: '300+' },
  calendar: { enabled: true, icalUrl: 'https://calendar.google.com/calendar/ical/secret/basic.ics' },
  blockedDates: ['2026-11-26'],
  slotRules: { on: true, days: { 0: [], 1: ['13:00'], 2: ['13:00'], 3: ['13:00'], 4: ['13:00'], 5: ['13:00'], 6: ['07:00', '13:00'] },
    jobMin: { exterior: 120, interior: 180, full: 270 }, outsideMin: { exterior: 120, interior: 0, full: 120 }, lights: false, cutoff: '21:00', autoConfirm: true },
  autoTexts: { confirm: true, remind24: true, remindAm: true, cancelled: true, declined: false },
};
store.set('bk:config', JSON.stringify(LIVE));

section('Everything that disagrees is listed');
writes = 0;
const g = await body(await M.apiBookingSettings());
const keys = g.facts.map((f) => f.key);
ok('reading the settings writes nothing', writes === 0, writes);
ok('Full Detail prices', keys.includes('price:full') && g.facts.find((f) => f.key === 'price:full').now === '$299 / $339 / $379' && g.facts.find((f) => f.key === 'price:full').want === '$369 / $409 / $449', g.facts.find((f) => f.key === 'price:full'));
ok('Interior prices', keys.includes('price:interior'));
ok('Exterior prices, even switched off', keys.includes('price:exterior'));
ok('"3–4 hours" on the Full Detail', keys.includes('time:full'));
ok('polish claimed as part of the exterior', keys.includes('polish'));
ok('the em dash in "Full Detail — In & Out"', keys.includes('dash:full'));
ok('size names (pickups are +$40, vans +$80)', keys.includes('sizes') && /Pickup/.test(g.facts.find((f) => f.key === 'sizes').want));
ok('add-ons', keys.includes('addons'));
ok('39 reviews', keys.includes('reviews') && g.facts.find((f) => f.key === 'reviews').now === '39');
ok('towns: the four missing ones named', /add Mukilteo, Woodinville, Granite Falls, Arlington/.test(g.facts.find((f) => f.key === 'cities').want), g.facts.find((f) => f.key === 'cities'));
ok('the old free-exterior headline', keys.includes('hook'));
ok('no em dash in anything it says', !/—/.test(JSON.stringify(g.facts.map((f) => [f.what, f.want]))));

section('Match the website');
const r = await body(await M.apiBookingFacts());
ok('it reports what it fixed', r.ok && r.changed === g.facts.length, r.changed);
ok('nothing is left to fix', r.facts.length === 0, r.facts);
const c = await M.loadBookingConfig();
const svc = (id) => c.services.find((s) => s.id === id);
ok('Full Detail $369 / $409 / $449', JSON.stringify(svc('full').price) === '{"sedan":369,"suv":409,"truck":449}', svc('full').price);
ok('Interior $249 / $289 / $329', JSON.stringify(svc('interior').price) === '{"sedan":249,"suv":289,"truck":329}');
ok('Exterior $199 / $239 / $279', JSON.stringify(svc('exterior').price) === '{"sedan":199,"suv":239,"truck":279}');
ok('Full Detail says 3–5 hours', /3–5 hours/.test(svc('full').blurb));
ok('Exterior no longer claims polish', !/polish/i.test(svc('exterior').blurb));
ok('service ids are untouched (the website books through them)', c.services.map((s) => s.id).join() === 'full,interior,exterior');
ok('size ids are untouched', c.sizes.map((z) => z.id).join() === 'sedan,suv,truck');
ok('size names follow the price book', c.sizes.map((z) => z.label).join(' / ') === 'Car / Sedan / SUV / Pickup / Van / 3-row');
ok('job lengths untouched', svc('full').duration.suv === 210 && svc('interior').duration.sedan === 90);
ok('a service he switched off stays off', svc('exterior').enabled === false);
ok('add-ons are the website\'s four', c.addons.map((a) => a.name + ' $' + a.price).join(', ') === 'Carpet Shampoo $20, Exterior Polish $30, Ceramic Wax $20, RainX Windows $10');
ok('41 reviews', c.proof.reviews === 41 && c.proof.rating === '5.0' && c.proof.cars === '300+');
ok('the twelve towns', c.cities.length === 12 && c.cities.includes('Arlington') && !c.cities.includes('Lynnwood'));
ok('no headline offer', c.content.hook === '');
ok('start times untouched', JSON.stringify(c.slotRules.days[6]) === '["07:00","13:00"]' && c.slotRules.jobMin.full === 270 && c.slotRules.autoConfirm === true && c.slotRules.lights === false);
ok('calendar sync untouched', c.calendar.enabled === true && /secret/.test(c.calendar.icalUrl));
ok('blocked days untouched', JSON.stringify(c.blockedDates) === '["2026-11-26"]');
ok('booking texts untouched', c.autoTexts.declined === false && c.autoTexts.remind24 === true);

section('The public page now gets the price book');
const pub = (await body(await M.apiBookConfig())).config;
ok('the booking page\'s Full Detail is $369', pub.services.find((s) => s.id === 'full').price.sedan === 369);
ok('it still hides the calendar address', !JSON.stringify(pub).includes('secret'));

section('Running it again does nothing');
writes = 0;
const again = await body(await M.apiBookingFacts());
ok('nothing to change, nothing written', again.changed === 0 && writes === 0, { again: again.changed, writes });

section('A normal save reports the facts too');
const saved = await body(await M.apiSaveBookingSettings({ json: async () => ({ config: Object.assign({}, c, { proof: Object.assign({}, c.proof, { reviews: 40 }) }) }) }));
ok('typing 40 reviews shows up as a mismatch right away', saved.facts.some((f) => f.key === 'reviews'), saved.facts);

section('Fresh installs start right');
const d = M.bookingDefaults();
ok('defaults are the price book', d.services[0].price.sedan === 369 && d.addons.length === 4 && d.cities.length === 12 && d.proof.reviews === 41 && d.content.hook === '');
ok('and pass their own check', M.bookFactsIssues(d).length === 0, M.bookFactsIssues(d));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
