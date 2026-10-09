/* Shared by every page of the new app (2026-10-08): the bar, sign-in, the API
   helpers and the customer sheet. Each page is its own file at its own address
   (Mikey's call: "completely different urls for each core thing"), so this is
   the one place the pages agree on how things look and behave.

   Plain ES5-ish JS like the rest of the repo: no build step, no framework. */
(function(){
  "use strict";
  // The old app lives on at /?classic=1 for everything that hasn't moved yet:
  // settings, money, the playbook, the deep reports. ?classic=1 is what stops
  // the switch (see index.html) bouncing him straight back here.
  var CLASSIC = "/?classic=1";

  var ICONS = {
    inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    trend:'<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    gear:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    phone:'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    phoneMissed:'<path d="m23 1-6 6M17 1l6 6"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    voicemail:'<circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><path d="M6 16h12"/>',
    back:'<path d="m15 18-6-6 6-6"/>',
    send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    check:'<path d="M20 6 9 17l-5-5"/>',
    archive:'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    sparkles:'<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    spell:'<path d="m4 15 4-10 4 10"/><path d="M5.5 11h5"/><path d="m14 15 2.5 3L22 10"/>',
    car:'<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M9 17h6"/>',
    pin:'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    star:'<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    route:'<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    dollar:'<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    msg:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    x:'<path d="M18 6 6 18M6 6l12 12"/>',
    download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    ext:'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    map:'<path d="M14.1 4.6 9.9 2.4a2 2 0 0 0-1.8 0L3.6 4.7A1 1 0 0 0 3 5.6V20a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.2a2 2 0 0 0 1.8 0l4.5-2.3a1 1 0 0 0 .6-.9V4a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0Z"/><path d="M9 2.4v16.6M15 5v16.6"/>',
    sign:'<path d="M12 13v8"/><path d="M5 3h14l2 5-2 5H5z"/>',
    door:'<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.56v16.16a.6.6 0 0 1-.78.57l-5.8-1.75A2 2 0 0 1 5 17.62V6.13a2 2 0 0 1 1.5-1.94l5.28-1.32a1 1 0 0 1 1.22.97Z"/>',
    file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    bolt:'<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'
  };
  function icon(name, cls){ return '<svg class="ic'+(cls?' '+cls:'')+'" viewBox="0 0 24 24" aria-hidden="true">'+(ICONS[name]||'')+'</svg>'; }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  function el(id){ return document.getElementById(id); }

  // One login for every page: the dashboard's own cookie. A 401 anywhere shows
  // the sign-in screen; a helper PIN is sent to the helper page, which is the
  // only thing it opens.
  var loginShown = false;
  function api(path, opts){
    opts = opts || {};
    opts.credentials = "include";
    return fetch(path, opts).then(function(r){
      if (r.status === 401) { showLogin(); return { ok:false, unauthorized:true }; }
      if (r.status === 403) return r.json().catch(function(){return {ok:false};}).then(function(d){
        if (d && d.error === "helper_not_allowed") location.replace("/helper.html");
        return d || { ok:false };
      });
      return r.json().catch(function(){ return { ok:false, error:"bad_response" }; });
    }).catch(function(){ return { ok:false, error:"offline" }; });
  }
  function post(path, body){
    return api(path, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body||{}) });
  }
  function showLogin(){
    if (loginShown) return; loginShown = true;
    var d = document.createElement("div");
    d.className = "login"; d.id = "login";
    d.innerHTML = '<form id="loginForm" autocomplete="on"><div class="brandmark">M</div><h1>Mikey\'s Detailing</h1>'+
      '<input class="input" id="loginPw" type="password" inputmode="text" autocomplete="current-password" placeholder="Password" aria-label="Password">'+
      '<button class="btn primary" type="submit">Sign in</button><div class="err" id="loginErr"></div></form>';
    document.body.appendChild(d);
    el("loginPw").focus();
    el("loginForm").addEventListener("submit", function(e){
      e.preventDefault();
      var pw = el("loginPw").value;
      fetch("/api/login", { method:"POST", credentials:"include", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ password:pw }) })
        .then(function(r){ return r.json().then(function(j){ return { s:r.status, j:j }; }); })
        .then(function(x){
          if (x.j && x.j.ok) { if (x.j.role === "helper") location.replace("/helper.html"); else location.reload(); return; }
          el("loginErr").textContent = (x.j && x.j.error === "locked") ? ("Too many tries. Wait " + (x.j.minutes || 15) + " minutes.") : "That password didn't work.";
        }).catch(function(){ el("loginErr").textContent = "Can't reach the server. Check your signal."; });
    });
  }

  // ---- time and names --------------------------------------------------
  var DAY = 86400000;
  function startOfDay(t){ var d = new Date(t); d.setHours(0,0,0,0); return d.getTime(); }
  function clock(t){ return new Date(t).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }).replace(" ", " "); }
  function when(t){
    if (!t) return "";
    var now = Date.now(), d0 = startOfDay(now);
    if (t >= d0) return clock(t);
    if (t >= d0 - DAY) return "Yesterday";
    if (t >= d0 - 6*DAY) return new Date(t).toLocaleDateString([], { weekday:"short" });
    return new Date(t).toLocaleDateString([], { month:"short", day:"numeric" });
  }
  function ago(t){
    var m = Math.max(0, Math.round((Date.now()-t)/60000));
    if (m < 60) return m + "m";
    var h = Math.round(m/60); if (h < 24) return h + "h";
    return Math.round(h/24) + "d";
  }
  function dayLabel(t){
    var d0 = startOfDay(Date.now()), d = startOfDay(t);
    if (d === d0) return "Today";
    if (d === d0 + DAY) return "Tomorrow";
    if (d === d0 - DAY) return "Yesterday";
    return new Date(t).toLocaleDateString([], { weekday:"long", month:"short", day:"numeric" });
  }
  function fmtPhone(p){
    var m = String(p||"").replace(/\D/g,"").match(/^1?(\d{3})(\d{3})(\d{4})$/);
    return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : String(p||"");
  }
  function displayName(r){ return (r && r.name && String(r.name).trim()) || fmtPhone(r && r.phone); }
  function initials(r){
    var n = (r && r.name || "").trim();
    if (!n) return "#";
    var p = n.split(/\s+/);
    return (p[0][0] + (p.length > 1 ? p[p.length-1][0] : "")).toUpperCase();
  }
  // A colour per person, stable across pages, so a face is findable in a list.
  var AV = ["#c2410c","#0e7490","#7c3aed","#15803d","#b91c1c","#1d4ed8","#a16207","#be185d","#4d7c0f","#334155"];
  function avColor(seed){ var h = 0, s = String(seed||""); for (var i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0; return AV[h % AV.length]; }
  function avatar(r, sm, unread){
    return '<span class="av'+(sm?' sm':'')+'" style="background:'+avColor(r && r.phone)+'">'+esc(initials(r))+(unread?'<span class="udot"></span>':'')+'</span>';
  }
  function money(n){ n = Number(n)||0; return "$" + (Math.round(n) === n ? n.toLocaleString() : n.toFixed(2)); }
  function mapsUrl(addr){ return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr); }

  // ---- toast + sheet ----------------------------------------------------
  var toastT = 0;
  function toast(msg){
    var t = el("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role","status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(function(){ t.classList.remove("on"); }, 2600);
  }
  function sheet(html, onClose){
    closeSheet();
    var s = document.createElement("div"); s.className = "scrim"; s.id = "scrim";
    var p = document.createElement("div"); p.className = "sheet"; p.id = "sheet"; p.setAttribute("role","dialog"); p.setAttribute("aria-modal","true");
    p.innerHTML = '<div class="grab"></div>' + html;
    document.body.appendChild(s); document.body.appendChild(p);
    s.addEventListener("click", closeSheet);
    sheet._onClose = onClose || null;
    requestAnimationFrame(function(){ s.classList.add("on"); p.classList.add("on"); });
    return p;
  }
  function closeSheet(){
    var s = el("scrim"), p = el("sheet");
    if (s) s.remove(); if (p) p.remove();
    if (sheet._onClose) { var f = sheet._onClose; sheet._onClose = null; f(); }
  }
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeSheet(); });

  // ---- the frame --------------------------------------------------------
  var TABS = [["inbox","Inbox","/inbox","inbox"],["customers","Customers","/customers","users"],["schedule","Schedule","/schedule","calendar"],["grow","Grow","/grow","trend"]];
  function frame(active, title, actionsHtml){
    document.body.insertAdjacentHTML("afterbegin",
      '<div class="app">'+
        '<header class="topbar"><span class="brandmark" aria-hidden="true">M</span><h1 id="pageTitle">'+esc(title)+'</h1>'+
          '<span id="topActions">'+(actionsHtml||'')+'</span>'+
          '<a class="iconbtn" href="'+CLASSIC+'&open=settings" title="Settings" aria-label="Settings">'+icon("gear")+'</a></header>'+
        '<main class="content" id="view"></main>'+
      '</div>'+
      '<nav class="tabbar" aria-label="Main">'+TABS.map(function(t){
        return '<a class="tab'+(t[0]===active?' on':'')+'" href="'+t[2]+'"'+(t[0]===active?' aria-current="page"':'')+' data-tab="'+t[0]+'">'+icon(t[3])+'<span>'+t[1]+'</span><span class="dot" id="dot-'+t[0]+'" hidden></span></a>';
      }).join('')+'</nav>');
    // The Inbox badge on every page: people waiting on him. Read off the list
    // row, which is the cheap surface; nothing here opens a conversation.
    api("/api/threads").then(function(d){
      if (!d || !d.ok) return;
      var n = needsYou(d.threads || []).length;
      var b = el("dot-inbox"); if (b && n) { b.textContent = n > 99 ? "99+" : n; b.hidden = false; }
    });
  }

  // Who is waiting on Mikey, oldest wait first (his answer: "filtered by people
  // who texted 3 days ago and I forgot to respond, after that newest first").
  // awaitingReply and waitSince are the server's own reading of "waiting on
  // you", the same one the alerts use, so the badge and the emails agree.
  function needsYou(rows){
    return rows.filter(function(r){
      if (r.archived || r.optedOut) return false;
      return !!(r.awaitingReply || r.needsYou || (r.unread && r.lastDir === "in"));
    }).sort(function(a,b){ return (a.waitSince || a.lastTs || 0) - (b.waitSince || b.lastTs || 0); });
  }

  // ---- the customer card ------------------------------------------------
  // One card, opened from the Inbox header and from every row on Customers, so
  // "who is this" has one answer wherever he asks it. It reads with peek=1 so
  // opening a card never marks their texts read.
  function customerSheet(phone, opts){
    opts = opts || {};
    var p = sheet('<div class="empty">Loading…</div>');
    Promise.all([
      api("/api/thread?peek=1&phone=" + encodeURIComponent(phone)),
      api("/api/money/by-phone?phone=" + encodeURIComponent(phone))
    ]).then(function(res){
      var t = (res[0] && res[0].thread) || { phone:phone };
      var mo = res[1] && res[1].ok ? res[1] : null;
      var g = t.garage || {};
      var cars = (g.vehicles || []).map(function(v){
        return [v.year, v.make, v.model].filter(Boolean).join(" ") + (v.color ? " · " + v.color : "") + (v.notes ? " · " + v.notes : "");
      }).filter(Boolean);
      var addr = [g.address, g.city, g.zip].filter(Boolean).join(", ");
      var ins = (t.messages || []).filter(function(m){ return m.dir === "in"; });
      var first = (t.messages && t.messages[0] && t.messages[0].ts) || t.createdAt;
      var rows = [];
      rows.push(["Phone", '<a href="tel:'+esc(phone)+'">'+esc(fmtPhone(phone))+'</a>']);
      if (cars.length) rows.push(["Car", cars.map(esc).join("<br>")]);
      if (addr) rows.push(["Address", '<a href="'+esc(mapsUrl(addr))+'" target="_blank" rel="noopener">'+esc(addr)+'</a>']);
      if (g.gate || g.parking) rows.push(["Access", esc([g.gate && ("Gate " + g.gate), g.parking].filter(Boolean).join(" · "))]);
      if (t.appointmentAt) rows.push(["Booked", esc(dayLabel(t.appointmentAt) + " " + clock(t.appointmentAt))]);
      if (t.quote && (t.quote.total || t.quote.service)) rows.push(["Quote", esc([t.quote.total ? money(t.quote.total) : "", t.quote.service].filter(Boolean).join(" · "))]);
      if (t.plan) rows.push(["Clean Club", esc((t.plan.price ? money(t.plan.price) + " every " : "every ") + Math.round((t.plan.every || 56)/7) + " weeks")]);
      if (mo && mo.jobs) rows.push(["Paid", esc(money(mo.total) + " over " + mo.jobs + " job" + (mo.jobs === 1 ? "" : "s"))]);
      if (t.source) rows.push(["Came from", esc(t.source)]);
      if (first) rows.push(["Since", esc(new Date(first).toLocaleDateString([], { month:"short", day:"numeric", year:"numeric" }))]);
      rows.push(["Texts", esc((t.messages || []).length + " (" + ins.length + " from them)")]);
      p.innerHTML = '<div class="grab"></div>'+
        '<div style="display:flex;align-items:center;gap:12px;margin:4px 0 14px">'+avatar(t, false)+
          '<input class="input" id="cuName" value="'+esc(t.name || "")+'" placeholder="Add their name" aria-label="Name" style="font-weight:700;font-size:17px"></div>'+
        '<dl class="kv">'+rows.map(function(r){ return '<dt>'+r[0]+'</dt><dd>'+r[1]+'</dd>'; }).join('')+'</dl>'+
        '<div class="section-label">Notes</div>'+
        '<textarea class="textarea" id="cuNotes" rows="3" placeholder="Gate code, where the spigot is, the dog, anything">'+esc(t.notes || "")+'</textarea>'+
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">'+
          '<button class="btn primary" id="cuSave">Save</button>'+
          (opts.fromCustomers ? '<a class="btn" href="/inbox?c='+encodeURIComponent(phone)+'">'+icon("msg")+'Text</a>' : '')+
          '<a class="btn" href="'+CLASSIC+'&c='+encodeURIComponent(phone)+'">'+icon("ext")+'Everything else</a>'+
        '</div>';
      el("cuSave").onclick = function(){
        var btn = this; btn.disabled = true;
        post("/api/meta", { phone:phone, name:el("cuName").value.trim(), notes:el("cuNotes").value }).then(function(d){
          btn.disabled = false;
          if (d && d.ok !== false) { toast("Saved"); closeSheet(); if (opts.onSaved) opts.onSaved(); }
          else toast("Didn't save. Try again.");
        });
      };
    });
  }

  window.App = {
    customerSheet:customerSheet,
    CLASSIC:CLASSIC, icon:icon, esc:esc, el:el, api:api, post:post, frame:frame, toast:toast, sheet:sheet, closeSheet:closeSheet,
    when:when, ago:ago, clock:clock, dayLabel:dayLabel, startOfDay:startOfDay, DAY:DAY, fmtPhone:fmtPhone, displayName:displayName,
    avatar:avatar, money:money, mapsUrl:mapsUrl, needsYou:needsYou, showLogin:showLogin
  };
})();
