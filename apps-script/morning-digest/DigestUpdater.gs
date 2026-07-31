/**
 * DIGEST UPDATER — pulls MorningDigest.gs from GitHub into your Apps Script
 * project, so you never paste code again.
 *
 * This is the ONE file you ever paste by hand. It updates a *different*
 * project (a script cannot safely rewrite itself while it is running), and it
 * never needs to change, so this is a one-time job.
 *
 * ── SETUP (all in the browser, no terminal) ────────────────────────────────
 *
 * 1. Turn on the Apps Script API — one toggle, once per Google account:
 *      https://script.google.com/home/usersettings   →   API ON
 *    Without this every push fails with a 403.
 *
 * 2. Make a NEW Apps Script project (script.google.com → New project). Name it
 *    "Digest Updater". Paste this file into Code.gs.
 *
 * 3. Show the manifest so you can add scopes:
 *      Project Settings (gear) → tick "Show appsscript.json"
 *    Then open appsscript.json in the editor and make it look like this —
 *    the scopes are NOT auto-detected, so you must add them yourself:
 *
 *      {
 *        "timeZone": "America/Los_Angeles",
 *        "exceptionLogging": "STACKDRIVER",
 *        "runtimeVersion": "V8",
 *        "oauthScopes": [
 *          "https://www.googleapis.com/auth/script.projects",
 *          "https://www.googleapis.com/auth/script.external_request"
 *        ]
 *      }
 *
 * 4. Project Settings → Script Properties → add:
 *      TARGET_SCRIPT_ID = the digest project's Script ID
 *                         (open the digest project → Project Settings →
 *                          "Script ID", or grab it from the editor URL:
 *                          script.google.com/home/projects/<THIS BIT>/edit)
 *      SOURCE_URL       = the raw GitHub URL of MorningDigest.gs
 *                         (on GitHub: open the file → "Raw" → copy the address)
 *      GITHUB_TOKEN     = only if the repo is private. Leave it out entirely
 *                         for a public repo.
 *
 * 5. Pick `pullNow` in the function dropdown and Run. Approve the permission
 *    prompt (it will warn about an unverified app — that is your own script).
 *    Check the log: it tells you exactly what changed.
 *
 * 6. Optional: pick `watchForUpdates` and Run once. That checks hourly and
 *    pushes only when the source actually changed.
 *
 * ── IF STEP 5 FAILS ────────────────────────────────────────────────────────
 * "Apps Script API has not been used in project ... " → you skipped step 1, or
 * this account needs the updater attached to a standard Cloud project:
 * Project Settings → Google Cloud Platform (GCP) Project → Change project, and
 * paste any GCP project number from console.cloud.google.com. Still no
 * terminal, but it is the one step that occasionally bites.
 */

// The target file inside the digest project. Must match the .gs tab name there.
const TARGET_FILE = 'MorningDigest';

// A push is refused unless the fetched text contains this. It is the seatbelt
// that stops a GitHub error page or a truncated download from wiping your
// working digest — the failure mode that actually matters here.
const SENTINEL = 'function sendMorningDigest';
const MIN_BYTES = 4000;

const SCRIPT_API = 'https://script.googleapis.com/v1/projects/';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Fetch from GitHub and push into the digest project. Run this by hand. */
function pullNow() {
  Logger.log(sync(false));
}

/** Report what would change, push nothing. Safe to run any time. */
function checkOnly() {
  Logger.log(sync(true));
}

/** Check hourly, push only on a real change. Run once to install. */
function watchForUpdates() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'pullIfChanged'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pullIfChanged').timeBased().everyHours(1).create();
  Logger.log('Watching. Checks hourly, pushes only when the source changes.');
}

function stopWatching() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'pullIfChanged'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Stopped watching.');
}

/** Trigger target. Silent when nothing changed. */
function pullIfChanged() {
  var result = sync(false);
  if (result.indexOf('no change') === -1) Logger.log(result);
}

// ---------------------------------------------------------------------------
// The actual work
// ---------------------------------------------------------------------------
function sync(dryRun) {
  var props = PropertiesService.getScriptProperties();
  var scriptId = props.getProperty('TARGET_SCRIPT_ID');
  var sourceUrl = props.getProperty('SOURCE_URL');
  if (!scriptId) return 'Set TARGET_SCRIPT_ID in Script Properties.';
  if (!sourceUrl) return 'Set SOURCE_URL in Script Properties.';

  var incoming = fetchSource(sourceUrl, props.getProperty('GITHUB_TOKEN'));
  if (incoming.error) return 'Source fetch failed — ' + incoming.error;

  // Refuse to push anything that does not look like the digest. A 404 page is
  // valid text and would otherwise overwrite a working script with HTML.
  var body = incoming.text;
  if (body.length < MIN_BYTES) {
    return 'Refused: source is only ' + body.length + ' bytes. Wrong URL?';
  }
  if (body.indexOf(SENTINEL) === -1) {
    return 'Refused: source does not contain "' + SENTINEL + '". Wrong URL, or ' +
           'a private repo returning a login page — set GITHUB_TOKEN.';
  }

  var project = getContent(scriptId);
  if (project.error) return 'Could not read the target project — ' + project.error;

  var files = project.files;
  var target = null;
  for (var i = 0; i < files.length; i++) {
    if (files[i].name === TARGET_FILE && files[i].type === 'SERVER_JS') target = files[i];
  }

  if (!target) {
    // First run against a fresh project: add the file rather than failing.
    target = { name: TARGET_FILE, type: 'SERVER_JS', source: '' };
    files.push(target);
  }

  if (normalize(target.source) === normalize(body)) {
    return 'Up to date — no change (' + body.length + ' bytes).';
  }

  var summary = 'Changed: ' + target.source.length + ' → ' + body.length + ' bytes, ' +
                countLines(target.source) + ' → ' + countLines(body) + ' lines.';
  if (dryRun) return 'DRY RUN. ' + summary + ' Nothing pushed.';

  target.source = body;

  // The API replaces the whole project, so every file has to go back — drop
  // one and you delete it, manifest included.
  var pushed = putContent(scriptId, files);
  if (pushed.error) return 'Push failed — ' + pushed.error;

  return 'Pushed to ' + TARGET_FILE + '.gs. ' + summary +
         ' The digest project is live with the new code; its triggers are untouched.';
}

function fetchSource(url, token) {
  var params = { muteHttpExceptions: true, headers: {} };
  // A fine-grained PAT with read-only Contents access is enough for a private
  // repo. The raw host wants the token as a bearer header.
  if (token) params.headers.Authorization = 'Bearer ' + token;

  try {
    var res = UrlFetchApp.fetch(url, params);
    if (res.getResponseCode() !== 200) {
      return { error: 'HTTP ' + res.getResponseCode() + ' from ' + url };
    }
    return { text: res.getContentText() };
  } catch (err) {
    return { error: String(err) };
  }
}

function getContent(scriptId) {
  var res = callApi('get', SCRIPT_API + scriptId + '/content');
  if (res.error) return res;
  return { files: res.body.files || [] };
}

function putContent(scriptId, files) {
  return callApi('put', SCRIPT_API + scriptId + '/content', { files: files });
}

function callApi(method, url, payload) {
  var params = {
    method: method,
    muteHttpExceptions: true,
    contentType: 'application/json',
    // This is the whole trick: the updater's own OAuth token, already scoped
    // to script.projects by the manifest. No key, no service account, no
    // stored refresh token anywhere.
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
  };
  if (payload) params.payload = JSON.stringify(payload);

  try {
    var res = UrlFetchApp.fetch(url, params);
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code !== 200) return { error: 'HTTP ' + code + ': ' + explain(code, text) };
    return { body: JSON.parse(text) };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Turns the two errors you will actually hit into instructions. */
function explain(code, text) {
  if (code === 403 && text.indexOf('Apps Script API') !== -1) {
    return 'the Apps Script API is off. Turn it on at ' +
           'script.google.com/home/usersettings, then run again.';
  }
  if (code === 403) {
    return 'permission denied. Check the manifest has the script.projects scope, ' +
           'and that this Google account owns the target script. Raw: ' + text.slice(0, 200);
  }
  if (code === 404) {
    return 'no project with that Script ID. Recheck TARGET_SCRIPT_ID.';
  }
  return text.slice(0, 300);
}

// Line-ending and trailing-whitespace noise should not count as a change.
function normalize(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function countLines(s) {
  return String(s || '').split('\n').length;
}
