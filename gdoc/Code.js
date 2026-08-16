/**
 * Money notepad → dashboard sync (Google Docs).
 *
 * The Sheets version is a form. This one is a notepad: open the doc, type (or
 * say) one line per thing, and a few minutes later each line grows a ✓ and the
 * amount it logged. Same ledger, same /api/money/entry, same totals.
 *
 *   250 job Dana venmo
 *   40 fuel
 *   8/14 120 job Mike full detail cash
 *
 * Why this is built as a poller and not a trigger: Google Docs has no edit
 * trigger. None — not simple, not installable. Sheets gets onEdit; Docs gets
 * onOpen and nothing else, and onOpen never fires in the mobile app. So the only
 * way a doc can sync from a phone is a clock trigger that reads it on a schedule.
 * That is the whole reason this feels slower than the Sheets one, and no amount
 * of cleverness gets around it.
 *
 * What Docs buys in exchange: the mic. Voice-typing a line while your hands are
 * wet is the one thing this does better than any grid of cells.
 *
 * Deliberately NOT synced: deleting a line does nothing to the ledger, same as
 * the sheet. The doc is an inbox, not the books.
 */

var P_URL = 'DASH_URL';
var P_PW = 'DASH_PW';
var P_COOKIE = 'DASH_COOKIE';
var P_FINAL = 'LAST_FINAL_LINE'; // the last line as of the previous sweep — see pickLines_
var P_STAMP = 'LAST_DOC_STAMP';  // doc's last-modified time, so idle sweeps cost nothing

var OK = '✓';
var BAD = '⚠';
var HEAD = '—'; // the numbers line this script writes at the top; never parsed as an entry

// Every word that names a thing, and what the ledger calls it. Written loose on
// purpose: this is fed by a microphone in a moving truck, so "gas", "chems" and
// "lunch" have to land as surely as the dropdown values do.
var WORDS = [
  ['job', { type: 'job' }], ['detail', { type: 'job' }], ['wash', { type: 'job' }],
  ['jp', { type: 'jp' }], ['labor', { type: 'jp' }], ['helper', { type: 'jp' }],
  ['fuel', { type: 'exp', cat: 'fuel' }], ['gas', { type: 'exp', cat: 'fuel' }],
  ['supplies', { type: 'exp', cat: 'supplies' }], ['soap', { type: 'exp', cat: 'supplies' }],
  ['chems', { type: 'exp', cat: 'supplies' }], ['chemicals', { type: 'exp', cat: 'supplies' }],
  ['equipment', { type: 'exp', cat: 'equipment' }], ['tools', { type: 'exp', cat: 'equipment' }],
  ['tool', { type: 'exp', cat: 'equipment' }],
  ['food', { type: 'exp', cat: 'food' }], ['lunch', { type: 'exp', cat: 'food' }],
  ['bills', { type: 'exp', cat: 'bills' }], ['bill', { type: 'exp', cat: 'bills' }],
  ['rent', { type: 'exp', cat: 'bills' }],
  ['marketing', { type: 'exp', cat: 'marketing' }], ['ads', { type: 'exp', cat: 'marketing' }],
  ['insurance', { type: 'exp', cat: 'insurance' }],
  ['phone', { type: 'exp', cat: 'phone' }], ['internet', { type: 'exp', cat: 'phone' }],
  ['misc', { type: 'exp', cat: 'misc' }],
  ['personal', { type: 'personal' }],
];
var METHODS = ['cash', 'venmo', 'zelle', 'check'];
var VEHICLES = ['sedan', 'suv', 'truck', 'van', 'boat', 'rv'];
var CAT_LABEL = { fuel: 'Fuel', supplies: 'Supplies', equipment: 'Equipment', food: 'Food',
  bills: 'Bills', marketing: 'Marketing', insurance: 'Insurance', phone: 'Phone/net', misc: 'Misc' };

// ---------------------------------------------------------------------------
// Pure helpers — the node suite runs everything in this block
// ---------------------------------------------------------------------------

function isMarked_(text) {
  var s = String(text || '');
  return s.indexOf(OK) >= 0 || s.indexOf(BAD) >= 0;
}

// Which lines are safe to send this sweep.
//
// The last line of the doc is the one the cursor is probably sitting in, and half
// a typed line is worse than a late one. So it only goes when it reads exactly the
// same as it did on the previous sweep — i.e. he stopped typing. Every line above
// it is finished by definition: he pressed Enter.
function pickLines_(lines, lastFinal) {
  var lastIdx = -1;
  for (var i = 0; i < lines.length; i++) if (String(lines[i]).trim()) lastIdx = i;
  var out = [];
  for (var j = 0; j < lines.length; j++) {
    var t = String(lines[j]);
    if (!t.trim()) continue;
    if (t.trim().charAt(0) === HEAD) continue; // our own numbers line
    if (isMarked_(t)) continue;
    if (j === lastIdx && t !== lastFinal) continue; // still being typed
    out.push({ i: j, text: t });
  }
  return { lines: out, finalText: lastIdx >= 0 ? String(lines[lastIdx]) : '' };
}

// A date written at the front of the line: 8/14, 8/14/26, today, yesterday.
// A bare m/d that lands in the future is last year's — logging December on the
// 2nd of January is a real thing that happens.
function leadingDate_(tokens, today) {
  if (!tokens.length) return null;
  var t = String(tokens[0]).toLowerCase().replace(/[:,]$/, '');
  var day = function (iso, delta) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };
  if (t === 'today') return { date: today, used: 1 };
  if (t === 'yesterday') return { date: day(today, -1), used: 1 };
  var m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2}|\d{4}))?$/);
  if (!m) return null;
  var mo = +m[1], dd = +m[2];
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return null;
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  var year;
  if (m[3]) year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  else {
    year = +today.slice(0, 4);
    if (p(mo) + '-' + p(dd) > today.slice(5)) year--; // still ahead of us — it was last year
  }
  return { date: year + '-' + p(mo) + '-' + p(dd), used: 1 };
}

function amountOf_(tok) {
  var m = String(tok).match(/^\$?(\d{1,6}(?:\.\d{1,2})?)$/);
  return m ? parseFloat(m[1]) : null;
}

// One typed line → one entry, or a reason it can't be. Order-free on purpose:
// "250 job Dana" and "job Dana 250" both work, because dictation reorders things.
function parseLine_(text, opts) {
  opts = opts || {};
  var today = opts.today || '1970-01-01';
  var services = opts.services || ['Interior', 'Exterior', 'Full detail', 'Add-on'];
  var jpName = String(opts.jpName || 'JP').toLowerCase();

  var raw = String(text || '').replace(/[‘’]/g, "'").trim();
  if (!raw) return { skip: true };

  var tokens = raw.split(/\s+/);
  var lead = leadingDate_(tokens, today);
  if (lead) tokens = tokens.slice(lead.used);
  var date = lead ? lead.date : today;

  // Nothing numeric anywhere means this is a note to self, a heading, a shopping
  // list. Those get left alone rather than papered with warnings.
  if (!/\d/.test(tokens.join(' '))) return { skip: true };

  var amount = null, kind = null, method = '', service = '', veh = '', rest = [];
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    var bare = tok.toLowerCase().replace(/[.,!?]+$/, '');
    var amt = amountOf_(tok.replace(/[,]$/, ''));
    if (amount === null && amt !== null && amt > 0) { amount = amt; continue; }

    var hit = null;
    for (var k = 0; k < WORDS.length; k++) if (WORDS[k][0] === bare) { hit = WORDS[k][1]; break; }
    if (!hit && bare === jpName) hit = { type: 'jp' };
    if (hit && !kind) { kind = hit; continue; }
    if (hit && kind) continue; // a second "what" on one line — first one wins

    if (!method && METHODS.indexOf(bare) >= 0) { method = bare.charAt(0).toUpperCase() + bare.slice(1); continue; }
    if (!veh && VEHICLES.indexOf(bare) >= 0) { veh = bare === 'suv' || bare === 'rv' ? bare.toUpperCase() : bare.charAt(0).toUpperCase() + bare.slice(1); continue; }
    // Services can be two words ("Full detail"). The first word alone names it,
    // because nobody dictates the second — but the extra word only gets eaten if
    // it is actually there, or "full truck cash" loses the truck.
    var svc = null, svcSpan = 1;
    for (var s = 0; s < services.length; s++) {
      var parts = String(services[s]).toLowerCase().split(/\s+/);
      if (bare !== parts[0]) continue;
      var span = 1;
      for (var q = 1; q < parts.length; q++) {
        var nxt = String(tokens[i + q] || '').toLowerCase().replace(/[.,!?]+$/, '');
        if (nxt !== parts[q]) break;
        span++;
      }
      svc = services[s]; svcSpan = span;
      break;
    }
    if (!service && svc) { service = svc; i += svcSpan - 1; continue; }
    rest.push(tok);
  }

  if (amount === null) return { error: 'no amount' };
  if (!kind) return { error: 'what was it?' };

  var e = { type: kind.type, amount: Math.round(amount * 100) / 100, date: date };
  if (kind.cat) e.cat = kind.cat;
  var leftover = rest.join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (kind.type === 'job') {
    if (leftover) e.name = leftover;
    if (method) e.method = method;
    if (service) e.service = service;
    if (veh) e.veh = veh;
  } else if (leftover) {
    e.note = leftover.slice(0, 200);
    if (kind.type === 'personal') e.cat = leftover.slice(0, 30);
  }
  return { entry: e, label: labelFor_(e, opts.jpName) };
}

function labelFor_(e, jpName) {
  if (e.type === 'job') return 'Detail job';
  if (e.type === 'jp') return 'Pay ' + (jpName || 'JP');
  if (e.type === 'personal') return 'Personal';
  return CAT_LABEL[e.cat] || 'Misc';
}

function money_(n) { return '$' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace(/\.00$/, ''); }

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
// Talking to the dashboard (identical to the Sheets script — same door, no key)
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

// ---------------------------------------------------------------------------
// Menu + setup
// ---------------------------------------------------------------------------

function onOpen() {
  DocumentApp.getUi().createMenu('💵 Money')
    .addItem('Sync now', 'syncNow')
    .addItem('Show my numbers', 'showNumbers')
    .addSeparator()
    .addItem('Set it up', 'setUp')
    .addItem('Check every minute instead of every 5', 'fastMode')
    .addToUi();
}

function setUp() {
  var ui = DocumentApp.getUi();
  var p = props_();
  var u = ui.prompt('Dashboard URL', 'e.g. https://texting.mikeysdetailingsnohomish.workers.dev', ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  p.setProperty(P_URL, u.getResponseText().trim());
  var pw = ui.prompt('Dashboard password', 'The same one you type to open the dashboard. Leave blank if it never asks.', ui.ButtonSet.OK_CANCEL);
  if (pw.getSelectedButton() !== ui.Button.OK) return;
  p.setProperty(P_PW, pw.getResponseText());
  p.deleteProperty(P_COOKIE);
  p.deleteProperty(P_FINAL);
  p.deleteProperty(P_STAMP);

  try { login_(); api_('/api/money/config'); }
  catch (err) { ui.alert('Could not reach the dashboard: ' + err.message); return; }

  installTrigger_(5);
  showNumbers();
  ui.alert('Ready. Type one thing per line — "250 job Dana venmo", "40 fuel" — and each line gets a ✓ once it lands.');
}

function fastMode() {
  installTrigger_(1);
  DocumentApp.getUi().alert('Now checking every minute. Heads up: a free Google account gets 90 minutes of background script time a day. This skips instantly when the doc has not changed, so it fits — but if Google ever emails you about a quota, put it back to 5 with Set it up.');
}

function installTrigger_(mins) {
  var have = ScriptApp.getProjectTriggers();
  for (var i = 0; i < have.length; i++) {
    if (have[i].getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(have[i]);
  }
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(mins).create();
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

function syncNow() {
  var doc = DocumentApp.getActiveDocument();
  var p = props_();

  // The cheap early-out that makes frequent polling affordable: if Drive says the
  // doc has not been touched since the last sweep, there is nothing to read.
  var stamp = '';
  try { stamp = String(DriveApp.getFileById(doc.getId()).getLastUpdated().getTime()); } catch (e) { stamp = ''; }
  if (stamp && stamp === p.getProperty(P_STAMP)) return;

  var body = doc.getBody();
  var paras = body.getParagraphs();
  var texts = paras.map(function (x) { return x.getText(); });
  var picked = pickLines_(texts, p.getProperty(P_FINAL) || '');
  p.setProperty(P_FINAL, picked.finalText);

  var cfg = null;
  try { cfg = api_('/api/money/config').config; } catch (err) { return; } // offline: try again next sweep
  var opts = {
    today: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'),
    jpName: cfg.jpName || 'JP',
    services: (cfg.serviceTypes && cfg.serviceTypes.length) ? cfg.serviceTypes : null,
  };

  var n = 0;
  for (var i = 0; i < picked.lines.length; i++) {
    var line = picked.lines[i];
    var built = parseLine_(line.text, opts);
    if (built.skip) continue;
    if (built.error) { paras[line.i].appendText('   ' + BAD + ' ' + built.error); continue; }
    try {
      api_('/api/money/entry', built.entry);
      paras[line.i].appendText('   ' + OK + ' ' + built.label + ' ' + money_(built.entry.amount));
      n++;
    } catch (err) {
      // Left unmarked on purpose. A parse problem needs a human and gets a ⚠; a
      // network problem just needs another minute, so the line stays eligible.
      break;
    }
  }
  if (n) {
    p.setProperty(P_FINAL, ''); // the marks changed the text; re-read fresh next sweep
    showNumbers();
  }
  try { p.setProperty(P_STAMP, String(DriveApp.getFileById(doc.getId()).getLastUpdated().getTime())); } catch (e) { /* best effort */ }
}

function tz_() {
  var t = DocumentApp.getActiveDocument().getId() && Session.getScriptTimeZone();
  return t || 'America/Los_Angeles';
}

// One line at the very top of the doc with the real numbers, rewritten in place.
// It starts with an em dash, which is how the parser knows to leave it alone.
function showNumbers() {
  var d = api_('/api/money');
  var s = d.summary || {}, at = d.allTime || {};
  var start = (d.config && d.config.hero && d.config.hero.startingBalance) || 0;
  var line = HEAD + ' You have ' + money_((at.net || 0) + start) +
    ' · this month in ' + money_(s.gross) +
    ', out ' + money_((s.exp || 0) + (s.jp || 0)) +
    ', profit ' + money_(s.net) +
    ' · ' + (s.jobs || 0) + ' jobs' +
    (s.owed > 0 ? ' · owed you ' + money_(s.owed) : '') +
    ' · ' + Utilities.formatDate(new Date(), tz_(), 'EEE h:mm a');

  var body = DocumentApp.getActiveDocument().getBody();
  var first = body.getParagraphs()[0];
  if (first && first.getText().trim().charAt(0) === HEAD) first.setText(line);
  else body.insertParagraph(0, line).setForegroundColor('#6b7280');
}

// Apps Script has no `module`, so this is inert there and gives the node suite
// something to require.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLine_: parseLine_, pickLines_: pickLines_, isMarked_: isMarked_,
    leadingDate_: leadingDate_, amountOf_: amountOf_, labelFor_: labelFor_,
    parseSetCookie_: parseSetCookie_, WORDS: WORDS, CAT_LABEL: CAT_LABEL };
}
