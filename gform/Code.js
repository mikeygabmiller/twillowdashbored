/**
 * Money log → dashboard sync (Google Forms).
 *
 * The closest of the three to the dashboard's own Log screen: big tap targets for
 * what it was, a number pad for how much, Submit. Three taps and it's in the
 * ledger — and unlike the doc, Forms has a real submit trigger, so it lands in
 * about a second.
 *
 * Paste this into a blank Form's Apps Script (Extensions → Apps Script), then run
 * 💵 Money → Set it up from the form editor. It builds all the questions itself,
 * wires the branching, installs the triggers and hands back the URL to put on the
 * home screen. You don't hand-build a single question.
 *
 * The shape of the form is the whole design:
 *
 *   page 1   What?  ·  How much?  ·  Who / what for?  ·  [Anything else?]
 *   page 2   only if you asked for it — paid by, service, vehicle, hours,
 *            labor cost, materials, still owed, date, note
 *
 * Leave "Anything else?" alone and page 1 submits straight through. That is the
 * cab case, and it is the one that has to be three taps.
 *
 * Nothing is ever lost. Forms keeps every response forever, each one is stamped
 * with an id once it reaches the ledger, and a clock trigger re-sends anything
 * that didn't make it — so a submit during a dead spot arrives late rather than
 * never.
 */

var P_URL = 'DASH_URL';
var P_PW = 'DASH_PW';
var P_COOKIE = 'DASH_COOKIE';
var P_SYNCED = 'SYNCED_IDS';  // response ids already in the ledger — the de-dupe
var P_PENDING = 'PENDING_N';  // how many are still stuck, shown on the next confirm
var SYNC_CAP = 300;           // ids kept; a few days of logging at any sane rate

var Q_WHAT = 'What was it?';
var Q_AMOUNT = 'How much?';
var Q_WHO = 'Who / what for?';
var Q_MORE = 'Anything else?';
var Q_METHOD = 'Paid by';
var Q_SERVICE = 'Service';
var Q_VEHICLE = 'Vehicle';
var Q_HOURS = 'Hours worked';
var Q_LABOR = 'Labor cost';
var Q_MAT = 'Materials cost';
var Q_OWED = 'Still owes you';
var Q_DATE = 'Date';
var Q_NOTE = 'Note';

var MORE_YES = 'Add detail →';
var MORE_NO = 'Nope — log it';

// The Log screen's buttons, in the Log screen's order and words.
var CATS = [
  ['Fuel', 'fuel'], ['Supplies', 'supplies'], ['Equipment', 'equipment'],
  ['Food', 'food'], ['Bills', 'bills'], ['Marketing', 'marketing'],
  ['Insurance', 'insurance'], ['Phone/net', 'phone'], ['Misc', 'misc'],
];
var METHODS = ['Cash', 'Venmo', 'Zelle', 'Check'];
var VEHICLES = ['Sedan', 'SUV', 'Truck', 'Van', 'Boat/RV', 'Other'];
var SERVICES = ['Interior', 'Exterior', 'Full detail', 'Add-on'];

// ---------------------------------------------------------------------------
// Pure helpers — the node suite runs everything in this block
// ---------------------------------------------------------------------------

function num_(v) {
  if (v == null || v === '') return 0;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Thousands separators here, unlike the other two scripts: this one ends up in a
// sentence on a confirmation page rather than next to a number in a cell.
function money_(n) {
  var s = (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace(/\.00$/, '');
  var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
  var parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + parts.join('.');
}

// The choices on the "What was it?" question, built from live config so the form
// says the helper's real name and hides the categories switched off in the app.
function whatChoices_(cfg) {
  cfg = cfg || {};
  var out = ['Detail job', 'Pay ' + (cfg.jpName || 'JP')];
  var off = cfg.catsOff || [];
  for (var i = 0; i < CATS.length; i++) if (off.indexOf(CATS[i][1]) < 0) out.push(CATS[i][0]);
  if (cfg.personalEnabled !== false) out.push('Personal');
  return out;
}

// Matched loosely for the same reason the other two are: the label carries a
// configurable name, and a renamed helper must not silently stop being labor.
function whatToKind_(label, jpName) {
  var s = String(label || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'personal') return { type: 'personal' };
  if (s === 'pay ' + String(jpName || 'JP').toLowerCase() || s.indexOf('pay ') === 0) return { type: 'jp' };
  if (s === 'detail job' || s.indexOf('job') >= 0) return { type: 'job' };
  for (var i = 0; i < CATS.length; i++) if (CATS[i][0].toLowerCase() === s) return { type: 'exp', cat: CATS[i][1] };
  return null;
}

// One submitted response → one entry. `a` is the answers keyed by question title.
function answersToEntry_(a, opts) {
  a = a || {}; opts = opts || {};
  var kind = whatToKind_(a[Q_WHAT], opts.jpName);
  if (!kind) return { error: 'no "what"' };
  var amount = num_(a[Q_AMOUNT]);
  if (!amount || amount <= 0) return { error: 'no amount' };

  var date = /^\d{4}-\d{2}-\d{2}$/.test(String(a[Q_DATE] || '')) ? String(a[Q_DATE]) : (opts.today || '');
  if (!date) return { error: 'no date' };

  var e = { type: kind.type, amount: Math.round(amount * 100) / 100, date: date };
  if (kind.cat) e.cat = kind.cat;

  var who = String(a[Q_WHO] || '').trim();
  var note = String(a[Q_NOTE] || '').trim();

  if (kind.type === 'job') {
    // On a job the free-text box is the customer; the note is its own field on
    // page 2, so the two never fight over the same words.
    if (who) e.name = who.slice(0, 60);
    if (a[Q_METHOD]) e.method = String(a[Q_METHOD]).slice(0, 16);
    if (a[Q_SERVICE]) e.service = String(a[Q_SERVICE]).slice(0, 32);
    if (a[Q_VEHICLE]) e.veh = String(a[Q_VEHICLE]).slice(0, 20);
    if (num_(a[Q_HOURS]) > 0) e.hours = Math.min(99, num_(a[Q_HOURS]));
    if (num_(a[Q_LABOR]) > 0) e.jp = num_(a[Q_LABOR]);
    if (num_(a[Q_MAT]) > 0) e.mat = num_(a[Q_MAT]);
    if (num_(a[Q_OWED]) > 0) e.owed = num_(a[Q_OWED]);
    if (note) e.note = note.slice(0, 200);
  } else {
    // On anything else it is what the money went on — which is the note, and for
    // personal spending doubles as the label, same as the app's free-text box.
    var text = [who, note].filter(function (x) { return x; }).join(' — ');
    if (text) e.note = text.slice(0, 200);
    if (kind.type === 'personal' && who) e.cat = who.slice(0, 30);
  }
  return { entry: e, label: labelFor_(a[Q_WHAT]) };
}

function labelFor_(what) { return String(what || '').trim() || 'Entry'; }

// Bounded, and newest-last so the oldest ids fall off first. Unbounded would
// eventually blow the 9KB-per-property limit and take the de-dupe with it.
function rememberSynced_(list, id, cap) {
  var out = (list || []).slice();
  if (out.indexOf(id) >= 0) return out;
  out.push(id);
  return out.length > (cap || SYNC_CAP) ? out.slice(out.length - (cap || SYNC_CAP)) : out;
}

// The page you see after tapping Submit. It is one entry behind by nature — the
// response page is served before the trigger has run — so it says when it was
// true rather than pretending to be live.
function confirmationText_(d, stamp, pending) {
  if (!d) {
    return '✓ Logged.' + (pending ? '\n\n⚠ ' + pending + ' entr' + (pending > 1 ? 'ies have' : 'y has') +
      ' not reached the dashboard yet. They will re-send on their own.' : '');
  }
  var s = d.summary || {}, at = d.allTime || {};
  var start = (d.config && d.config.hero && d.config.hero.startingBalance) || 0;
  var lines = ['✓ Logged.', '',
    'As of ' + stamp + ':',
    'You have ' + money_((at.net || 0) + start),
    'This month — in ' + money_(s.gross) + ', out ' + money_((s.exp || 0) + (s.jp || 0)) + ', profit ' + money_(s.net),
    (s.jobs || 0) + ' jobs' + (s.owed > 0 ? ' · owed you ' + money_(s.owed) : '')];
  if (pending) lines.push('', '⚠ ' + pending + ' entr' + (pending > 1 ? 'ies have' : 'y has') + ' not reached the dashboard yet. They will re-send on their own.');
  return lines.join('\n');
}

function parseSetCookie_(header) {
  if (!header) return '';
  var all = (Object.prototype.toString.call(header) === '[object Array]') ? header : [header];
  for (var i = 0; i < all.length; i++) {
    var m = String(all[i]).match(/mkd_auth=([^;]*)/);
    if (m && m[1]) return 'mkd_auth=' + m[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Talking to the dashboard (same door as the other two — no new key)
// ---------------------------------------------------------------------------

function props_() { return PropertiesService.getScriptProperties(); }

function base_() {
  var u = String(props_().getProperty(P_URL) || '').replace(/\/+$/, '');
  if (!u) throw new Error('No dashboard URL saved yet — run 💵 Money → Set it up.');
  return u;
}

function login_() {
  var res = UrlFetchApp.fetch(base_() + '/api/login', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ password: props_().getProperty(P_PW) || '' }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Login failed — check the password in Set it up.');
  var cookie = parseSetCookie_(res.getAllHeaders()['Set-Cookie'] || res.getAllHeaders()['set-cookie']);
  props_().setProperty(P_COOKIE, cookie);
  return cookie;
}

function api_(path, payload) {
  var send = function (cookie) {
    var opts = { muteHttpExceptions: true, headers: cookie ? { Cookie: cookie } : {} };
    if (payload) { opts.method = 'post'; opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
    return UrlFetchApp.fetch(base_() + path, opts);
  };
  var res = send(props_().getProperty(P_COOKIE) || '');
  if (res.getResponseCode() === 401) res = send(login_());
  var body = res.getContentText();
  if (res.getResponseCode() !== 200) throw new Error('dashboard said ' + res.getResponseCode());
  var data = JSON.parse(body);
  if (!data.ok) throw new Error(data.error || 'refused');
  return data;
}

function tz_() { return Session.getScriptTimeZone() || 'America/Los_Angeles'; }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }

// ---------------------------------------------------------------------------
// Menu + building the form
// ---------------------------------------------------------------------------

function onOpen() {
  FormApp.getUi().createMenu('💵 Money')
    .addItem('Set it up', 'setUp')
    .addItem('Re-send anything stuck', 'drainUnsent')
    .addItem('Show me the link', 'showLink')
    .addToUi();
}

function setUp() {
  var ui = FormApp.getUi();
  var p = props_();
  var u = ui.prompt('Dashboard URL', 'e.g. https://texting.mikeysdetailingsnohomish.workers.dev', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  p.setProperty(P_URL, u.getResponseText().trim());
  var pw = ui.prompt('Dashboard password', 'The same one you type to open the dashboard. Leave blank if it never asks.', ui.ButtonSet.OK_CANCEL);
  if (pw.getSelectedButton() !== ui.Button.OK) return;
  p.setProperty(P_PW, pw.getResponseText());
  p.deleteProperty(P_COOKIE);

  var cfg;
  try { login_(); cfg = api_('/api/money/config').config; }
  catch (err) { ui.alert('Could not reach the dashboard: ' + err.message); return; }

  buildForm_(cfg);
  installTriggers_();
  refreshConfirmation_();
  ui.alert('Ready.\n\nPut this on your phone\'s home screen:\n\n' + FormApp.getActiveForm().getPublishedUrl());
}

function showLink() {
  FormApp.getUi().alert('Open this on your phone and "Add to Home Screen":\n\n' + FormApp.getActiveForm().getPublishedUrl());
}

function buildForm_(cfg) {
  var form = FormApp.getActiveForm();
  var services = (cfg && cfg.serviceTypes && cfg.serviceTypes.length) ? cfg.serviceTypes : SERVICES;
  var jp = (cfg && cfg.jpName) || 'JP';

  // Rebuilt from scratch every time so re-running Set it up after changing your
  // categories in the app actually re-shapes the form. Responses already
  // submitted are untouched — Forms keeps those independently of the questions.
  var items = form.getItems();
  for (var i = items.length - 1; i >= 0; i--) form.deleteItem(items[i]);

  form.setTitle('Money')
    .setDescription('Tap what it was, type how much, Submit.')
    .setAcceptingResponses(true)
    .setAllowResponseEdits(false)
    .setLimitOneResponsePerUser(false)   // or the second job of the day is refused
    .setShowLinkToRespondAgain(true)     // logging three things in a row is one tap each
    .setProgressBar(false)
    .setCollectEmail(false);

  form.addMultipleChoiceItem().setTitle(Q_WHAT).setRequired(true)
    .setChoiceValues(whatChoices_(cfg));

  var money = FormApp.createTextValidation().setHelpText('Numbers only.').requireNumberGreaterThan(0).build();
  form.addTextItem().setTitle(Q_AMOUNT).setRequired(true).setValidation(money);

  form.addTextItem().setTitle(Q_WHO)
    .setHelpText('The customer on a job. What the money went on for anything else. Skip it if you want.');

  // Page 2 has to exist before the branching can point at it.
  var page2 = form.addPageBreakItem().setTitle('Detail')
    .setHelpText('All optional — fill what matters, skip the rest.');

  var more = form.addMultipleChoiceItem().setTitle(Q_MORE);
  more.setChoices([
    more.createChoice(MORE_NO, FormApp.PageNavigationType.SUBMIT),
    more.createChoice(MORE_YES, page2),
  ]);
  // Left blank it submits too, which is what makes the fast path three taps.
  form.getItems(FormApp.ItemType.PAGE_BREAK)[0].setGoToPage(FormApp.PageNavigationType.SUBMIT);

  form.addMultipleChoiceItem().setTitle(Q_METHOD).setChoiceValues(METHODS);
  form.addMultipleChoiceItem().setTitle(Q_SERVICE).setChoiceValues(services);
  form.addMultipleChoiceItem().setTitle(Q_VEHICLE).setChoiceValues(VEHICLES);
  var plain = FormApp.createTextValidation().setHelpText('Numbers only.').requireNumber().build();
  form.addTextItem().setTitle(Q_HOURS).setValidation(plain);
  form.addTextItem().setTitle(Q_LABOR).setHelpText("What this job cost you in " + jp + "'s pay.").setValidation(plain);
  form.addTextItem().setTitle(Q_MAT).setValidation(plain);
  form.addTextItem().setTitle(Q_OWED).setHelpText('A deposit or pay-later balance still outstanding.').setValidation(plain);
  form.addDateItem().setTitle(Q_DATE).setHelpText('Only if it was not today.');
  form.addParagraphTextItem().setTitle(Q_NOTE);
}

function installTriggers_() {
  var form = FormApp.getActiveForm();
  var have = ScriptApp.getProjectTriggers();
  for (var i = 0; i < have.length; i++) ScriptApp.deleteTrigger(have[i]);
  ScriptApp.newTrigger('onSubmit').forForm(form).onFormSubmit().create();
  // The safety net. A submit that goes out in a dead spot still reaches the
  // ledger, just later — Forms holds the response either way.
  ScriptApp.newTrigger('drainUnsent').timeBased().everyMinutes(10).create();
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function answersOf_(response) {
  var out = {};
  var rs = response.getItemResponses();
  for (var i = 0; i < rs.length; i++) {
    var v = rs[i].getResponse();
    out[rs[i].getItem().getTitle()] = (Object.prototype.toString.call(v) === '[object Array]') ? v.join(', ') : v;
  }
  return out;
}

function synced_() {
  try { return JSON.parse(props_().getProperty(P_SYNCED) || '[]'); } catch (e) { return []; }
}

// Returns true when it reached the ledger. Callers use that to decide whether to
// count it pending, never to decide whether to retry — the id set does that.
function sendResponse_(response, cfg) {
  var id = response.getId();
  var seen = synced_();
  if (seen.indexOf(id) >= 0) return true; // already in — never post it twice
  var built = answersToEntry_(answersOf_(response), { jpName: (cfg && cfg.jpName) || 'JP', today: today_() });
  if (built.error) {
    // A response that can't be read is not going to read any better in ten
    // minutes, so it is marked done rather than retried forever. The required
    // fields make this near-impossible; it is here so a stuck queue can't happen.
    props_().setProperty(P_SYNCED, JSON.stringify(rememberSynced_(seen, id)));
    return true;
  }
  api_('/api/money/entry', built.entry);
  props_().setProperty(P_SYNCED, JSON.stringify(rememberSynced_(seen, id)));
  return true;
}

function onSubmit(e) {
  var cfg = null;
  try { cfg = api_('/api/money/config').config; } catch (err) { /* offline — the sweep gets it */ }
  try {
    if (e && e.response) sendResponse_(e.response, cfg);
  } catch (err) { /* left unsent on purpose; drainUnsent retries */ }
  refreshConfirmation_();
}

// Walks every response the form still holds and sends whatever isn't in the id
// set. Idempotent, so running it by hand is always safe.
function drainUnsent() {
  var form = FormApp.getActiveForm();
  var cfg = null;
  try { cfg = api_('/api/money/config').config; } catch (err) { return; }
  var all = form.getResponses();
  var seen = synced_();
  var start = Math.max(0, all.length - SYNC_CAP); // older than the id set is long done
  var stuck = 0;
  for (var i = start; i < all.length; i++) {
    if (seen.indexOf(all[i].getId()) >= 0) continue;
    try { sendResponse_(all[i], cfg); seen = synced_(); }
    catch (err) { stuck++; }
  }
  props_().setProperty(P_PENDING, String(stuck));
  refreshConfirmation_();
}

function refreshConfirmation_() {
  var pending = parseInt(props_().getProperty(P_PENDING) || '0', 10) || 0;
  var d = null;
  try { d = api_('/api/money'); } catch (err) { /* show the plain confirm */ }
  var stamp = Utilities.formatDate(new Date(), tz_(), 'EEE h:mm a');
  try { FormApp.getActiveForm().setConfirmationMessage(confirmationText_(d, stamp, pending)); }
  catch (err) { /* not fatal — the entry already landed */ }
}

// Apps Script has no `module`; this is inert there and gives the node suite a
// handle on the pure half.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { answersToEntry_: answersToEntry_, whatToKind_: whatToKind_, whatChoices_: whatChoices_,
    rememberSynced_: rememberSynced_, confirmationText_: confirmationText_, num_: num_, money_: money_,
    parseSetCookie_: parseSetCookie_, CATS: CATS,
    Q: { WHAT: Q_WHAT, AMOUNT: Q_AMOUNT, WHO: Q_WHO, MORE: Q_MORE, METHOD: Q_METHOD, SERVICE: Q_SERVICE,
      VEHICLE: Q_VEHICLE, HOURS: Q_HOURS, LABOR: Q_LABOR, MAT: Q_MAT, OWED: Q_OWED, DATE: Q_DATE, NOTE: Q_NOTE } };
}
