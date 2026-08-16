/**
 * Money log → dashboard sync.
 *
 * Paste this into a Google Sheet's Apps Script editor (Extensions → Apps Script),
 * run "Set it up" once from the 💵 menu, and the sheet becomes a second front door
 * to the same money ledger the dashboard writes to. Type a row in the cab, tap the
 * "Log it" box, and it lands in KV through the exact same /api/money/entry the
 * dashboard's Save button posts to — same validation, same de-dupe, same totals.
 *
 * Why a sheet at all: the dashboard's Log screen is faster once it's open, but
 * "open Sheets" is one tap from the home screen and works with a thumb on a
 * steering wheel. This is not a replacement ledger — the dashboard stays the
 * source of truth and this sheet is a keypad pointed at it.
 *
 * Deliberately NOT synced: deleting a row here does nothing to the ledger. A row
 * is one swipe from gone in the mobile Sheets app, and a swipe should never be
 * able to erase a month's income. Delete entries in the dashboard.
 *
 * Auth: no new key, no new endpoint. The script logs in with the dashboard
 * password exactly like a browser does and caches the session cookie in Script
 * Properties (private to this Google account — never in a cell, because a cell
 * travels with the sheet when it's shared).
 */

var P_URL = 'DASH_URL';       // https://…workers.dev
var P_PW = 'DASH_PW';         // dashboard password ('' when the worker has none)
var P_COOKIE = 'DASH_COOKIE'; // cached mkd_auth cookie

var SH_LOG = 'Log';
var SH_TODAY = 'Today';
var SH_MONTH = 'This month';

// The row, left to right. The first five columns are the whole job in the cab —
// everything after "Status" is the optional detail the dashboard hides behind
// "more", and can be ignored forever without breaking anything.
var HEADERS = ['Date', 'What', 'Amount', 'Log it', 'Status',
  'Customer', 'Phone', 'Service', 'Paid by', 'City', 'Vehicle',
  'Hours', 'JP cost', 'Materials', 'Still owed', 'Note', 'id'];
var C_DATE = 1, C_WHAT = 2, C_AMOUNT = 3, C_LOGIT = 4, C_STATUS = 5, C_ID = 17;

// Categories in the dashboard's own order and the dashboard's own words — these
// are the buttons on the Log screen, so the dropdown reads like the app does.
var CATS = [
  ['Fuel', 'fuel'], ['Supplies', 'supplies'], ['Equipment', 'equipment'],
  ['Food', 'food'], ['Bills', 'bills'], ['Marketing', 'marketing'],
  ['Insurance', 'insurance'], ['Phone/net', 'phone'], ['Misc', 'misc'],
];
var METHODS = ['Cash', 'Venmo', 'Zelle', 'Check'];
var VEHICLES = ['Sedan', 'SUV', 'Truck', 'Van', 'Boat/RV', 'Other'];
var SERVICES = ['Interior', 'Exterior', 'Full detail', 'Add-on'];

// ---------------------------------------------------------------------------
// Pure helpers (no Apps Script services in here — the node suite runs them)
// ---------------------------------------------------------------------------

// A sheet date cell can hand back a real Date or whatever the user typed. Dates
// use the local getters on purpose: Apps Script hands back a Date already shifted
// into the spreadsheet's timezone, so the calendar day showing in the cell is the
// day we want on the entry — toISOString() would drag it backwards overnight.
function dateStr_(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/); // 8/16 or 8/16/26
  if (m) {
    var y = m[3].length === 2 ? '20' + m[3] : m[3];
    return y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  }
  return '';
}

function num_(v) {
  if (v == null || v === '') return 0;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// "What" → the ledger's type/cat pair. Matched loosely on purpose: the dropdown
// says "Pay JP" but the JP name is configurable, and somebody will eventually
// type "gas" instead of picking "Fuel".
function whatToType_(label) {
  var s = String(label || '').trim().toLowerCase();
  if (!s) return null;
  if (s.indexOf('personal') === 0) return { type: 'personal' };
  if (s.indexOf('pay ') === 0 || s === 'jp' || s.indexOf('labor') === 0) return { type: 'jp' };
  if (s.indexOf('job') >= 0 || s.indexOf('detail') === 0) return { type: 'job' };
  for (var i = 0; i < CATS.length; i++) {
    if (CATS[i][0].toLowerCase() === s || CATS[i][1] === s) return { type: 'exp', cat: CATS[i][1] };
  }
  if (s === 'gas') return { type: 'exp', cat: 'fuel' };
  return null;
}

// One row → one entry the worker will accept, or an error string to drop in the
// Status cell. Only the three columns you actually fill in the cab are required.
function rowToEntry_(row) {
  var amount = num_(row.amount);
  if (!amount || amount <= 0) return { error: 'needs an amount' };
  var kind = whatToType_(row.what);
  if (!kind) return { error: 'pick a "What"' };
  var date = dateStr_(row.date);
  if (!date) return { error: 'bad date' };

  var e = { type: kind.type, amount: Math.round(amount * 100) / 100, date: date };
  if (kind.cat) e.cat = kind.cat;
  if (row.note) e.note = String(row.note).trim().slice(0, 200);
  // The hidden id cell carries "<id>|<date it was filed under>". The date half is
  // what lets a re-tick after changing the date to another month move the entry
  // instead of leaving a ghost behind in the old month's doc.
  if (row.id) {
    var parts = String(row.id).trim().split('|');
    if (parts[0]) e.id = parts[0].slice(0, 24);
    if (e.id) e.origDate = parts[1] || date;
  }

  // Personal spending has no fixed category list in the app — whatever you jot in
  // the note is the label, same as the free-text box on the dashboard's sheet.
  if (kind.type === 'personal' && row.note) e.cat = String(row.note).trim().slice(0, 30);
  if (kind.type === 'job') {
    if (row.customer) e.name = String(row.customer).trim().slice(0, 60);
    if (row.phone) e.phone = String(row.phone).trim();
    if (row.service) e.service = String(row.service).trim().slice(0, 32);
    if (row.method) e.method = String(row.method).trim().slice(0, 16);
    if (row.city) e.city = String(row.city).trim().slice(0, 40);
    if (row.vehicle) e.veh = String(row.vehicle).trim().slice(0, 20);
    if (num_(row.hours) > 0) e.hours = num_(row.hours);
    if (num_(row.jpCost) > 0) e.jp = num_(row.jpCost);
    if (num_(row.materials) > 0) e.mat = num_(row.materials);
    if (num_(row.owed) > 0) e.owed = num_(row.owed);
  }
  return { entry: e };
}

// UrlFetchApp hands Set-Cookie back as a string or an array depending on how many
// there were; both shapes have to work or the login silently stops sticking.
function parseSetCookie_(header) {
  if (!header) return '';
  var all = (Object.prototype.toString.call(header) === '[object Array]') ? header : [header];
  for (var i = 0; i < all.length; i++) {
    var m = String(all[i]).match(/mkd_auth=([^;]*)/);
    if (m && m[1]) return 'mkd_auth=' + m[1];
  }
  return '';
}

function money_(n) { return '$' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace(/\.00$/, ''); }

// ---------------------------------------------------------------------------
// Talking to the dashboard
// ---------------------------------------------------------------------------

function props_() { return PropertiesService.getScriptProperties(); }

function base_() {
  var u = String(props_().getProperty(P_URL) || '').replace(/\/+$/, '');
  if (!u) throw new Error('No dashboard URL saved yet — run 💵 Money sync → Set it up.');
  return u;
}

function login_() {
  var pw = props_().getProperty(P_PW) || '';
  var res = UrlFetchApp.fetch(base_() + '/api/login', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ password: pw }), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Login failed — check the password in Set it up.');
  var cookie = parseSetCookie_(res.getAllHeaders()['Set-Cookie'] || res.getAllHeaders()['set-cookie']);
  props_().setProperty(P_COOKIE, cookie); // '' is fine: a worker with no password needs none
  return cookie;
}

// One call, with a single silent re-login when the 90-day cookie ages out.
function api_(path, payload) {
  var send = function (cookie) {
    var opts = { muteHttpExceptions: true, headers: cookie ? { Cookie: cookie } : {} };
    if (payload) { opts.method = 'post'; opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
    return UrlFetchApp.fetch(base_() + path, opts);
  };
  var res = send(props_().getProperty(P_COOKIE) || '');
  if (res.getResponseCode() === 401) res = send(login_());
  var body = res.getContentText();
  if (res.getResponseCode() !== 200) throw new Error('Dashboard said ' + res.getResponseCode() + ': ' + body.slice(0, 120));
  var data = JSON.parse(body);
  if (!data.ok) throw new Error(data.error || 'refused');
  return data;
}

// ---------------------------------------------------------------------------
// Menu + setup
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('💵 Money sync')
    .addItem('Log the ticked rows now', 'pushPending')
    .addItem('Pull today + this month', 'pullFromDashboard')
    .addSeparator()
    .addItem('Set it up', 'setUp')
    .addItem('Tidy up synced rows', 'clearSyncedRows')
    .addToUi();
}

function setUp() {
  var ui = SpreadsheetApp.getUi();
  var p = props_();
  var u = ui.prompt('Dashboard URL', 'e.g. https://texting.mikeysdetailingsnohomish.workers.dev', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  p.setProperty(P_URL, u.getResponseText().trim());
  var pw = ui.prompt('Dashboard password', 'The same one you type to open the dashboard. Leave blank if it does not ask for one.', ui.ButtonSet.OK_CANCEL);
  if (pw.getSelectedButton() !== ui.Button.OK) return;
  p.setProperty(P_PW, pw.getResponseText());
  p.deleteProperty(P_COOKIE);

  var cfg = null;
  try { login_(); cfg = api_('/api/money/config').config; }
  catch (err) { ui.alert('Could not reach the dashboard: ' + err.message); return; }

  buildSheets_(cfg);
  installTriggers_();
  ui.alert('Ready. Fill a row on the Log tab and tick "Log it" — it posts straight to the dashboard.');
}

function installTriggers_() {
  var ss = SpreadsheetApp.getActive();
  var have = ScriptApp.getProjectTriggers();
  for (var i = 0; i < have.length; i++) ScriptApp.deleteTrigger(have[i]);
  // An installable edit trigger, not a simple onEdit: simple triggers cannot call
  // out to the network, and the whole point is the network call.
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss).onEdit().create();
  // The safety net. Edits made with no signal queue up in the mobile app and land
  // later; this sweeps up anything ticked whose trigger never got to run.
  ScriptApp.newTrigger('pushPending').timeBased().everyMinutes(10).create();
}

function buildSheets_(cfg) {
  var ss = SpreadsheetApp.getActive();
  var jp = (cfg && cfg.jpName) || 'JP';
  var services = (cfg && cfg.serviceTypes && cfg.serviceTypes.length) ? cfg.serviceTypes : SERVICES;
  var off = (cfg && cfg.catsOff) || [];

  // The dropdown mirrors the dashboard's Log screen: job first, then labor, then
  // the expense buttons in their configured order (hidden ones stay hidden here
  // too), personal last.
  var whats = ['Detail job', 'Pay ' + jp];
  for (var i = 0; i < CATS.length; i++) if (off.indexOf(CATS[i][1]) < 0) whats.push(CATS[i][0]);
  if (!cfg || cfg.personalEnabled !== false) whats.push('Personal');

  // Re-running Set it up must never eat rows that haven't posted yet, so this
  // only ever rewrites the header and the dropdowns — never the body.
  var sh = ss.getSheetByName(SH_LOG) || ss.insertSheet(SH_LOG, 0);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#111827').setFontColor('#f9fafb');
  sh.setFrozenRows(1);
  sh.hideColumns(C_ID);

  var rows = Math.max(sh.getMaxRows() - 1, 200);
  if (sh.getMaxRows() < 201) sh.insertRowsAfter(sh.getMaxRows(), 201 - sh.getMaxRows());
  var body = function (col) { return sh.getRange(2, col, rows, 1); };

  body(C_DATE).setNumberFormat('yyyy-mm-dd');
  body(C_AMOUNT).setNumberFormat('$#,##0.00');
  body(C_LOGIT).insertCheckboxes();
  var list = function (col, values) {
    body(col).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(values, true).setAllowInvalid(true).build());
  };
  list(C_WHAT, whats);
  list(8, services);
  list(9, METHODS);
  list(11, VEHICLES);

  sh.setColumnWidth(C_DATE, 110);
  sh.setColumnWidth(C_WHAT, 130);
  sh.setColumnWidth(C_AMOUNT, 110);
  sh.setColumnWidth(C_LOGIT, 70);
  sh.setColumnWidth(C_STATUS, 150);

  // Today's date pre-filled on the first empty row is the difference between
  // three taps and four, every single time.
  primeNextRow_(sh);

  if (!ss.getSheetByName(SH_TODAY)) ss.insertSheet(SH_TODAY);
  if (!ss.getSheetByName(SH_MONTH)) ss.insertSheet(SH_MONTH);
  pullFromDashboard();
}

// ---------------------------------------------------------------------------
// Pushing rows up
// ---------------------------------------------------------------------------

function onEditInstalled(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SH_LOG) return;
  if (e.range.getColumn() !== C_LOGIT || e.range.getRow() < 2) return;
  if (e.range.getValue() !== true) return; // the un-tick we do ourselves lands here too
  syncRow_(sh, e.range.getRow());
}

// Sweeps every ticked row. Safe to run any time — a row only ever posts once per
// tick, because a successful post clears the tick.
function pushPending() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH_LOG);
  if (!sh) return;
  var last = sh.getLastRow();
  if (last < 2) return;
  var ticks = sh.getRange(2, C_LOGIT, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < ticks.length; i++) if (ticks[i][0] === true) { syncRow_(sh, i + 2); n++; }
  if (n) SpreadsheetApp.getActive().toast(n + (n === 1 ? ' entry' : ' entries') + ' sent to the dashboard');
}

function readRow_(sh, r) {
  var v = sh.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  return {
    date: v[0], what: v[1], amount: v[2], customer: v[5], phone: v[6], service: v[7],
    method: v[8], city: v[9], vehicle: v[10], hours: v[11], jpCost: v[12],
    materials: v[13], owed: v[14], note: v[15], id: v[16],
  };
}

function syncRow_(sh, r) {
  var built = rowToEntry_(readRow_(sh, r));
  if (built.error) { markRow_(sh, r, '⚠ ' + built.error, false); return; }
  try {
    var res = api_('/api/money/entry', built.entry);
    var when = Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'h:mm a');
    sh.getRange(r, C_ID).setValue(res.entry ? res.entry.id + '|' + res.entry.date : '');
    markRow_(sh, r, '✓ logged ' + when, true);
    if (r === sh.getLastRow()) primeNextRow_(sh);
  } catch (err) {
    // The tick stays on so the 10-minute sweep retries it — a dead cell signal
    // should cost a delay, not the entry.
    markRow_(sh, r, '⚠ ' + String(err.message || err).slice(0, 80), false);
  }
}

// clear=true unticks the box, which is what makes the tick mean "send this now":
// change an amount later, tick again, and it updates the same entry by id.
function markRow_(sh, r, status, clear) {
  sh.getRange(r, C_STATUS).setValue(status);
  if (clear) sh.getRange(r, C_LOGIT).setValue(false);
  sh.getRange(r, 1, 1, HEADERS.length - 1)
    .setBackground(clear ? '#f0fdf4' : '#fef2f2');
}

function primeNextRow_(sh) {
  var r = Math.max(sh.getLastRow() + 1, 2);
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  if (!sh.getRange(r, C_DATE).getValue()) sh.getRange(r, C_DATE).setValue(new Date());
}

function clearSyncedRows() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SH_LOG);
  var last = sh.getLastRow();
  if (last < 2) return;
  var st = sh.getRange(2, C_STATUS, last - 1, 1).getValues();
  for (var i = st.length - 1; i >= 0; i--) {
    if (String(st[i][0]).indexOf('✓') === 0) sh.deleteRow(i + 2);
  }
  primeNextRow_(sh);
  SpreadsheetApp.getActive().toast('Tidied. Nothing was removed from the dashboard.');
}

// ---------------------------------------------------------------------------
// Pulling the numbers back down
// ---------------------------------------------------------------------------

function pullFromDashboard() {
  var d = api_('/api/money');
  var ss = SpreadsheetApp.getActive();
  var s = d.summary || {}, w = d.week || {}, at = d.allTime || {};
  var start = (d.config && d.config.hero && d.config.hero.startingBalance) || 0;

  var t = ss.getSheetByName(SH_TODAY) || ss.insertSheet(SH_TODAY);
  t.clear();
  var head = [
    ['Money you have now', money_((at.net || 0) + start)],
    ['', ''],
    ['This month — income', money_(s.gross)],
    ['This month — spent', money_((s.exp || 0) + (s.jp || 0))],
    ['This month — profit', money_(s.net)],
    ['Jobs this month', s.jobs || 0],
    ['Customers still owe you', money_(s.owed)],
    ['', ''],
    ['This week — income', money_(w.gross)],
    ['This week — profit', money_(w.net)],
    ['', ''],
    ['Last pulled', Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'EEE MMM d, h:mm a')],
  ];
  t.getRange(1, 1, head.length, 2).setValues(head);
  t.getRange(1, 1, 1, 2).setFontWeight('bold').setFontSize(14);
  t.setColumnWidth(1, 210); t.setColumnWidth(2, 140);

  var m = ss.getSheetByName(SH_MONTH) || ss.insertSheet(SH_MONTH);
  m.clear();
  var cols = ['Date', 'What', 'Amount', 'Customer', 'Service', 'Paid by', 'Note'];
  m.getRange(1, 1, 1, cols.length).setValues([cols])
    .setFontWeight('bold').setBackground('#111827').setFontColor('#f9fafb');
  m.setFrozenRows(1);
  var rows = (d.entries || []).map(function (e) {
    return [e.date, entryLabel_(e, d.config), e.amount, e.name || '', e.service || '', e.method || '', e.note || ''];
  });
  if (rows.length) {
    m.getRange(2, 1, rows.length, cols.length).setValues(rows);
    m.getRange(2, 3, rows.length, 1).setNumberFormat('$#,##0.00');
  }
  return d;
}

function entryLabel_(e, cfg) {
  if (e.type === 'job') return 'Detail job';
  if (e.type === 'jp') return 'Pay ' + ((cfg && cfg.jpName) || 'JP');
  if (e.type === 'personal') return 'Personal';
  for (var i = 0; i < CATS.length; i++) if (CATS[i][1] === e.cat) return CATS[i][0];
  return 'Misc';
}

// The node suite exercises the pure half of this file; Apps Script has no
// `module`, so the guard makes this a no-op there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rowToEntry_: rowToEntry_, whatToType_: whatToType_, dateStr_: dateStr_,
    parseSetCookie_: parseSetCookie_, num_: num_, entryLabel_: entryLabel_, HEADERS: HEADERS, CATS: CATS };
}
