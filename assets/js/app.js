// The Dojo Bay — directory UI. Loads data/*.json and content/*.md at runtime.
// Requires: assets/js/qrcode.js (global `qrcode`) and assets/js/markdown.js (global `markdown`).
(function(){
  "use strict";
async function loadJSON(url){
    const r = await fetch(url, {cache:"no-store"});
    if(!r.ok) throw new Error(url+" -> HTTP "+r.status);
    return await r.json();
  }
  async function loadText(url){
    const r = await fetch(url, {cache:"no-store"});
    if(!r.ok) throw new Error(url+" -> HTTP "+r.status);
    return await r.text();
  }

  const esc = s => String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  function flag(cc){ if(!cc) return ""; return cc.toUpperCase().replace(/./g,c=>String.fromCodePoint(127397+c.charCodeAt(0))); }
  function uptime(checks){ if(!checks||!checks.length) return {pct:null,up:0,total:0}; const up=checks.filter(c=>c.up).length; return {pct:Math.round(up/checks.length*1000)/10,up,total:checks.length}; }
  function copyFallback(text){
    const ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();
    try{document.execCommand("copy")}catch(e){}document.body.removeChild(ta);return Promise.resolve();
  }
  function copy(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text).catch(()=>copyFallback(text));
    return copyFallback(text);
  }
  function flash(btn,t){const o=btn.innerHTML;btn.innerHTML=t;btn.classList.add("done");setTimeout(()=>{btn.innerHTML=o;btn.classList.remove("done")},1500);}

  function qrSVG(text, px, ec){
    // ec "H" (30% recovery) is required for QRs carrying a centre avatar; the
    // overlay covers ~5% of the symbol, leaving ample margin for scanners.
    const qr = qrcode(0, ec||"M"); qr.addData(text); qr.make();
    const n=qr.getModuleCount(), margin=2, total=n+margin*2, cell=px/total;
    let r="";
    for(let row=0;row<n;row++) for(let col=0;col<n;col++) if(qr.isDark(row,col)){
      r+='<rect x="'+((col+margin)*cell).toFixed(2)+'" y="'+((row+margin)*cell).toFixed(2)+'" width="'+(cell+0.6).toFixed(2)+'" height="'+(cell+0.6).toFixed(2)+'" fill="#0a0a0a"/>';
    }
    return '<svg width="'+px+'" height="'+px+'" viewBox="0 0 '+px+' '+px+'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pairing QR code"><rect width="'+px+'" height="'+px+'" fill="#fff"/>'+r+'</svg>';
  }

  /* ---------------- site config (edit these) ----------------
     REPO_URL  : the GitHub repository the footer mark links to.
     ONION_URL : this site's own .onion address. Leave "" to hide the
                 header pill (e.g. while testing, or when the site is
                 served onion-only and the pill would be redundant). */
  const REPO_URL  = "https://github.com/Dojobay/dojobay";
  const ONION_URL = "http://dojobayeryasshgghz537de5ckgd5hhi4z5sdeil3roeh65fwhdnu2yd.onion/";
  // PayNym profile links point at the paynym.rs onion, so a visitor stays on Tor.
  const PAYNYM_WEB = "http://paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion";
  const SRC_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6M18 11.2c0 3.2-2.6 4.3-5.6 4.3H10"/></svg>`;
  const GH_LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.36-1.34-1.73-1.34-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.5.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.34 1.24-3.17-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.3-1.21 3.3-1.21.66 1.64.24 2.86.12 3.16.77.83 1.24 1.88 1.24 3.17 0 4.54-2.81 5.54-5.49 5.83.43.36.81 1.09.81 2.2 0 1.59-.01 2.87-.01 3.26 0 .31.21.68.83.56C20.56 21.88 24 17.48 24 12.29 24 5.78 18.63.5 12 .5z"/></svg>`;

  // Header/hero brand mark. Same torii as favicon.svg and the PWA icons, minus
  // the rounded background chip (it sits on the page, not on a tile) and themed
  // via the accent variables. viewBox frames the shared artwork paths.
  const LOGO = `
  <svg width="34" height="34" viewBox="34 89.5 252 252" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g fill="var(--accent)">
      <path d="M40 96 Q160 112 280 96 L280 116 Q160 132 40 116 Z"/>
      <path d="M154 116 H166 V124 H154 Z"/>
      <path d="M74 124 H246 V144 H74 Z"/>
      <path d="M104 126 H124 L118 250 H98 Z"/>
      <path d="M196 126 H216 L222 250 H202 Z"/>
    </g>
    <g stroke="var(--accent-2)" stroke-width="14" stroke-linecap="round" fill="none">
      <path d="M50 272 q13.75 -13 27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0"/>
      <path d="M50 300 q13.75 -13 27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0" opacity="0.72"/>
      <path d="M50 328 q13.75 -13 27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0 t27.5 0" opacity="0.48"/>
    </g>
  </svg>`;

  const MODAL_META = {
    about:      {title:"About The Dojo Bay",         file:"content/about.md"},
    faq:        {title:"Frequently asked questions", file:"content/faq.md"},
  };
  const modalCache = {};

  let DOJOS=null, HIST=null, net="mainnet";
  // Mobile menu: state read by the header template at render time (the same
  // pattern as the Manage button and the build hash), never DOM-poked.
  let menuOpen=false;

  // Is the published data still current?
  //
  // The updater rewrites data/dojos.json every interval_minutes. If that timer
  // dies, nginx keeps serving the last file indefinitely and every badge stays
  // confidently green, which is the one failure this directory must not have:
  // the whole proposition is that the status is real. Past a few intervals we
  // stop asserting status and say so.
  //
  // A clock that is behind makes generated_at look like the future, which is
  // simply not stale. A clock far ahead can produce a false warning, so the
  // banner mentions it rather than insisting the site is broken.
  const STALE_INTERVALS = 3;
  function freshness(doc){
    const iv = Number(doc && doc.interval_minutes) > 0 ? Number(doc.interval_minutes) : 10;
    const t = Date.parse((doc && doc.generated_at) || "");
    if(!isFinite(t)) return { stale:true, unknown:true, intervalMin:iv, ageMin:null };
    const ageMin = (Date.now() - t) / 60000;
    return { stale: ageMin > iv*STALE_INTERVALS, unknown:false, intervalMin:iv, ageMin };
  }
  function humanAge(mins){
    if(mins==null) return "an unknown time";
    if(mins < 90) return Math.max(1,Math.round(mins)) + " minutes";
    if(mins < 60*36) return Math.round(mins/60) + " hours";
    return Math.round(mins/1440) + " days";
  }

  // Payment codes are 116 characters and no card is that wide, so the chip shows
  // as much as actually fits and elides the middle — the head and tail are what
  // identify a code by eye. The amount is measured rather than fixed, so a wide
  // window shows more than a narrow one and nothing is hardcoded to a layout.
  // The markup ships a conservative default, so a browser where measurement is
  // unavailable still renders something sensible.
  function middleTruncate(str, max){
    const s = String(str || "");
    if(!(max > 0) || max >= s.length) return s;
    if(max < 9) return s.slice(0, Math.max(1, max - 1)) + "…";
    const keep = max - 1;                       // one character for the ellipsis
    const head = Math.ceil(keep / 2);
    return s.slice(0, head) + "…" + s.slice(s.length - (keep - head));
  }

  let FIT_CTX = null;
  function fitPaymentCodes(){
    const els = document.querySelectorAll(".pcode[data-v]");
    if(!els.length) return;
    try{ FIT_CTX = FIT_CTX || document.createElement("canvas").getContext("2d"); }
    catch(e){ return; }                          // no canvas: keep the default
    if(!FIT_CTX) return;
    els.forEach((el)=>{
      const code = el.getAttribute("data-v");
      if(!code) return;
      const cs = getComputedStyle(el);
      FIT_CTX.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
      // measureText knows nothing about letter-spacing, and the chip has some.
      // Leaving it out made the text a shade too wide, so the browser applied
      // its OWN ellipsis on top of ours: "PM8T…text…". Add it, and keep a pixel
      // of slack for sub-pixel rounding.
      const ls = parseFloat(cs.letterSpacing) || 0;
      const ch = FIT_CTX.measureText("0").width + ls;   // monospace: one width fits all
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const avail = (el.clientWidth || 0) - pad - 2;
      if(!(ch > 0) || !(avail > 0)) return;
      el.textContent = middleTruncate(code, Math.floor(avail / ch));
    });
  }

  let FIT_TIMER = null;
  window.addEventListener("resize", ()=>{
    clearTimeout(FIT_TIMER);
    FIT_TIMER = setTimeout(fitPaymentCodes, 120);
  });

  // One renderer for every endpoint row, so all three look and behave the same.
  // A row is always present: with a usable URL it shows the value and a working
  // copy button; without one it reads N/A with the copy button greyed out and
  // inert, keeping the row's three-column geometry. Anything that is not an
  // http(s)/tcp/ssl URL counts as absent, which covers a payload that carries
  // an explorer with an empty or placeholder url rather than omitting it.
  function epRow(label, url, naNote){
    const ok = typeof url === "string" && /^(https?|tcp|ssl):\/\//i.test(url.trim());
    if(!ok) return `<div class="ep"><span class="k">${esc(label)}</span>`
      + `<span class="u na" title="${esc(naNote)}">N/A</span>`
      + `<button class="copybtn" disabled title="Nothing to copy: ${esc(naNote.toLowerCase())}">copy</button></div>`;
    const u = url.trim();
    return `<div class="ep"><span class="k">${esc(label)}</span>`
      + `<span class="u" title="${esc(u)}">${esc(u)}</span>`
      + `<button class="copybtn" data-act="copyurl" data-v="${esc(u)}">copy</button></div>`;
  }

  // Electrum/indexer endpoint for the card: whatever build-public.mjs published
  // as indexer_url, which is only ever what the updater read from the node's
  // /support/services. The payload shapes are deliberately NOT read as a
  // fallback: nothing signs them, so an endpoint nobody probed must never be
  // rendered as though it had been, however old the file being read is.
  function indexerUrl(n){
    const ok = (u) => (typeof u === "string" && /^(tcp|ssl):\/\/[a-z2-7]{56}\.onion:\d{2,5}(\/.*)?$/i.test(u)) ? u : null;
    return ok(n.indexer_url);
  }

  // ---- 90-day daily history (lazily fetched once, cached) -------------------
  let HIST90 = null, DAILY = {nodes:{}};
  function loadHist90(){
    if(!HIST90) HIST90 = loadJSON("data/history-daily.json").catch(()=>({nodes:{}})).then(d=>{DAILY=d;return d;});
    return HIST90;
  }
  function heightSparkline(days){
    const pts = days.map((d,i)=>({i,h:d.close})).filter(p=>typeof p.h==="number");
    if(pts.length<2) return "";
    const W=280,H=32,pad=2, hs=pts.map(p=>p.h), min=Math.min(...hs), max=Math.max(...hs), span=(max-min)||1, n=(days.length-1)||1;
    const coords=pts.map(p=>{const x=pad+(p.i/n)*(W-2*pad); const y=H-pad-((p.h-min)/span)*(H-2*pad); return x.toFixed(1)+","+y.toFixed(1);});
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-label="closing block height over 90 days"><polyline points="${coords.join(" ")}" fill="none" stroke="var(--accent-2)" stroke-width="1.5"/></svg>`;
  }
  // The two thresholds behind every reliability figure on a card, named because
  // they were previously three unrelated numbers in two places that disagreed
  // with each other in the same widget.
  //
  // DAY_UP_PCT is what "a day was up" means, and it is deliberately shared: the
  // 90-day strip paints these days green and the footer counts exactly these
  // days, so the strip is now a picture of the number printed under it. 95%
  // rather than 99% because a node re-checked every ten minutes takes 144
  // checks a day, so 99% left no room for one missed probe or a short restart;
  // 95% allows about seven misses, roughly an hour.
  //
  // DAY_PARTIAL_PCT is not a second definition of "up". It subdivides the days
  // that were NOT up, so a reader can tell a wobble from an outage: a day that
  // managed most of its checks is amber, a day that lost more than half is red.
  // Both are counted as down in the footer. Reading amber as a pass is the
  // mistake this pair exists to prevent, which is why the tooltip states the
  // threshold rather than saying "up".
  const DAY_UP_PCT = 95, DAY_PARTIAL_PCT = 50;
  async function renderHist90(mount, id){
    if(!mount) return;
    const body = mount.querySelector(".h90-body");
    let data; try{ data = await loadHist90(); }catch(e){ if(body) body.innerHTML='<span class="faint">No history yet.</span>'; return; }
    const days = (data.nodes && data.nodes[id] && data.nodes[id].days) || [];
    if(!days.length){ if(body) body.innerHTML='<span class="faint">No daily history yet.</span>'; return; }
    const view = days.slice(-90);
    const bars = view.map(d=>{
      const pct = d.pct==null?null:d.pct;
      const cls = pct==null?"na":(pct>=DAY_UP_PCT?"up":(pct>=DAY_PARTIAL_PCT?"mid":"down"));
      const t = `${d.d}: ${pct==null?"no data":pct+"% up"}${d.close!=null?", close "+Number(d.close).toLocaleString("en-GB"):""}`;
      return `<span class="d90 ${cls}" title="${esc(t)}"></span>`;
    }).join("");
    const closes = view.filter(d=>d.close!=null).map(d=>d.close);
    const latest = closes.length?closes[closes.length-1]:null;
    // The footer counts the SAME days the strip paints green, so the two can
    // never disagree about what a good day is.
    const withData = view.filter(d=>d.pct!=null);
    const upDays = withData.filter(d=>Number(d.pct)>=DAY_UP_PCT).length;
    const relTxt = withData.length
      ? (p=>`${p%1===0?p:p.toFixed(1)}% · ${upDays}/${withData.length} days`)(100*upDays/withData.length)
      : `${view.length} day${view.length>1?"s":""}`;
    if(body) body.innerHTML =
      `<div class="d90strip">${bars}</div>`+
      `<div class="d90foot"><span class="faint" title="days with at least ${DAY_UP_PCT}% of their checks up, of days with data">${relTxt}</span>`+
      (latest!=null?`<span class="faint">closing height ${Number(latest).toLocaleString("en-GB")}</span>`:"")+`</div>`+
      heightSparkline(view);
  }

  function relStrip(checks){
    const u=uptime(checks);
    const bars=(checks||[]).map(c=>`<div class="b ${c.up?"up":"down"}" title="${esc(c.t)} · ${c.up?"up":"down"}"></div>`).join("");
    const pct=u.pct==null?"—":(u.pct%1===0?u.pct:u.pct.toFixed(1))+"%";
    return `<div class="rel">
      <div class="rel-head"><span class="eyebrow">Reliability · 24h</span><span class="pct">${pct} <span class="n">${u.up}/${u.total}</span></span></div>
      <div class="rel-bars">${bars}</div>
      <div class="rel-axis"><span>24h ago</span><span>now</span></div></div>`;
  }

  function card(n){
    const checks=(HIST.nodes[n.id]||{}).checks||[];
    const pn=n.paynym
      ?`<a class="pn" href="${PAYNYM_WEB}/${esc(n.paynym)}" target="_blank" rel="noopener">${esc(n.paynym)}</a>`
      :`<span class="nopn">no PayNym</span>`;
    const jur=n.jurisdiction?`<span class="jur">${n.country?`<span class="flag">${flag(n.country)}</span>`:""}${esc(n.jurisdiction)}</span>`:"";
    // Card title: the node's short name alone ("yellow"). Names are unique
    // per network and the PayNym (linked) plus payment-code chip sit directly
    // beneath, so the composite "+paynym · name" title proved redundant.
    const title = n.name || n.paynym || n.id;
    return `<div class="card ${n.status}" data-id="${esc(n.id)}" data-pc="${esc(n.paymentCode||"")}">
      <div class="ctop">
        <span class="sd ${n.status}"></span>
        <span class="cname" title="${esc(title)}">${esc(title)}</span>
        <span class="cbadge ${n.status}">${n.status==="active"?"Active":"Inactive"}</span>
      </div>
      <div class="csub">${pn}${jur?'<span style="color:var(--faint)">·</span>'+jur:""}</div>
      ${n.paymentCode?`<button class="pcode mono" data-act="copycode" data-v="${esc(n.paymentCode)}" title="${esc(n.paymentCode)} — click to copy">${esc(n.paymentCode.slice(0,8))}…${esc(n.paymentCode.slice(-8))}</button>`:""}
      ${(n.operator_domain||n.operator_domain_proof)?`<div class="vrow">
        ${n.operator_domain?`<a class="vdomain" href="https://${esc(n.operator_domain)}" target="_blank" rel="noopener noreferrer" title="The operator proved control of ${esc(n.operator_domain)}: a TXT record on the domain names their payment code, and they signed a statement naming the domain. This proves control of the domain, not that the operator is trustworthy.">✓ ${esc(n.operator_domain)}</a>`:""}
        ${n.operator_domain_proof?`<button class="vproof" data-act="domproof" title="Check this claim yourself: the DNS lookup and the signature to verify">verify</button>`:""}
      </div>`:""}
      ${relStrip(checks)}
      <div class="hist90" data-hist="${esc(n.id)}"><div class="eyebrow">Reliability · 90 days</div><div class="h90-body"><span class="loading">Loading…</span></div></div>
      <div class="meta">
        <div class="full"><div class="eyebrow">Hardware</div><div class="v">${esc(n.hardware||"—")}</div></div>
        <div><div class="eyebrow">Dojo version</div><div class="v">v${esc(n.version||"?")}</div></div>
        <div><div class="eyebrow">Block height</div><div class="v">${n.block_height!=null?Number(n.block_height).toLocaleString("en-GB"):"—"}</div></div>
        <div class="full"><div class="eyebrow">Last checked</div><div class="v">${esc((n.checked_at||"").replace("T"," ").replace("Z",""))}</div></div>
      </div>
      <div class="eps card-eps">
        ${epRow("Dojo API", n.payload.pairing && n.payload.pairing.url, "This node publishes no Dojo API endpoint")}
        ${epRow("Explorer", n.payload.explorer && n.payload.explorer.url, "This node publishes no block explorer")}
        ${epRow("Electrum Server", indexerUrl(n), "This node does not publish an Electrum endpoint, or runs a Dojo older than v1.27.0")}
      </div>
      <button class="reveal" data-act="pair">Pairing details</button>
      ${n.payload && n.payload.pairing && n.payload.pairing.apikey
        ? `<button class="reveal secondary" data-act="checkself" title="Ask the node yourself, over Tor, for the values shown here">Check it yourself</button>
           <button class="reveal secondary" data-act="rescan" title="Commands to ask this Dojo to rescan an XPUB, run from your own terminal">Rescan XPUB</button>` : ""}
    </div>`;
  }

  function pairHTML(n){
    const pairingOnly = JSON.stringify({pairing:n.payload.pairing, explorer:n.payload.explorer}, null, 2);
    const qr = qrSVG(JSON.stringify(n.payload), 208, "H");
    // NOT loading="lazy": this sits at the centre of a QR in a popup that has
    // just opened, so deferring the fetch costs a visible Tor round trip at
    // exactly the wrong moment. High priority and eager decoding instead; the
    // file is small, same-origin and cached for a day by nginx, and the card's
    // Pairing details button warms it on hover (see warmAvatar).
    const avatar = n.paymentCode
      ? `<img class="qr-avatar" alt="" fetchpriority="high" decoding="async" src="data/avatars/${encodeURIComponent(n.paymentCode)}.png" onerror="this.remove()">`
      : "";
    const signedBox = n.signed ? `
      <div class="box signed">
        <div class="lbl"><span class="t">Signed message</span><button class="copybtn" data-act="copysigned" data-id="${esc(n.id)}">Copy</button></div>
        <pre>${esc(n.signed)}</pre>
      </div>` : "";
    return `<div class="pair">
      <div class="qr"><div class="tile">${qr}${avatar}</div><span class="cap">Scan to pair</span></div>
      <div class="box">
        <div class="lbl"><span class="t">Pairing code</span><button class="copybtn" data-act="copypairing" data-id="${esc(n.id)}">Copy</button></div>
        <pre>${esc(pairingOnly)}</pre>
      </div>
      ${signedBox}
    </div>`;
  }

  // "For the machines among us": how to check a domain badge without trusting
  // this site. Both halves are independently checkable — the TXT record comes
  // from the operator's own DNS, and the signature verifies against the payment
  // code already shown on the card. Neither step involves this instance, and
  // neither puts paynym.rs on the request path.
  function domainProofHTML(n){
    const p = n.operator_domain_proof;
    if(!p) return "<p>No published proof for this node.</p>";
    const msg = (p.signed.match(/SIGNED MESSAGE-----\n([\s\S]*?)\n-----BEGIN BITCOIN SIGNATURE/)||["",""])[1];
    const addr = (p.signed.match(/Address:\s*(\S+)/)||["",""])[1];
    const sig = (p.signed.match(/\n([A-Za-z0-9+/=]{80,})\n*-----END BITCOIN SIGNATURE/)||["",""])[1];
    const blk = (label, body) =>
      `<div class="proofblk"><div class="k">${esc(label)}</div>`
      + `<pre class="mono">${esc(body)}</pre>`
      + `<button class="copybtn" data-act="copyurl" data-v="${esc(body)}">copy</button></div>`;
    return `<p class="dnote">The operator of this node claims <b>${esc(p.domain)}</b>. Two independent
        checks prove it, and you can run both yourself without trusting this directory.</p>
      <h3>1. The domain names the payment code</h3>
      <p class="dnote">Look up the TXT record from the operator's own DNS. It must contain the payment
        code shown on the card.</p>
      ${blk("with dig", "dig +short TXT " + p.txt_name)}
      ${blk("or over HTTPS, no dig required",
        "curl -sH 'accept: application/dns-json' \\\n  'https://cloudflare-dns.com/dns-query?name=" + p.txt_name + "&type=TXT'")}
      ${blk("expected to contain", p.txt_value)}
      <h3>2. The payment code names the domain</h3>
      <p class="dnote">The operator signed this text with the notification address of that payment code.
        Verify it with any Bitcoin message verifier, for example the
        <a href="https://paymentcode.io/lab" target="_blank" rel="noopener noreferrer">BIP47 lab</a>,
        or <span class="mono">bitcoin-cli verifymessage</span>.</p>
      ${blk("message", msg)}
      ${blk("signing address", addr)}
      ${blk("signature", sig)}
      ${blk("or verify the whole block at once", p.signed)}
      <p class="dnote">Both must hold. The TXT record alone shows only that whoever controls the domain
        published a code; the signature alone shows only that the code's owner mentioned the domain.
        Together they show the same party holds both. This proves control of a domain, not that the
        operator is trustworthy.${p.verified_at?" This instance last confirmed it on "+esc(p.verified_at.slice(0,10))+".":""}</p>`;
  }

  // "Check it yourself": the commands to ask the node directly for the things
  // this card asserts about it.
  //
  // Most of a listing is operator-signed and independently checkable, but the
  // Electrum endpoint and the running version are OUR prober's word — we read
  // The Tor SOCKS port a reader is running on. Two presets because there are two
  // answers in practice: a standalone tor daemon listens on 9050 and Tor Browser
  // on 9150.
  //
  // It is a variable rather than prose telling you to edit the commands, which
  // is what this used to be. The page stated 9050, added a sentence saying to
  // change it if you were on Tor Browser, and then handed over five commands
  // containing 9050 and a copy button beside each. Knowing you were on the other
  // port still left you editing every block, or editing the text on screen and
  // then copying the unedited original, which is the worse failure because it
  // looks like it worked.
  //
  // Deliberately not persisted. The site keeps nothing in localStorage, and a
  // remembered preference is a small stored fact about a reader that buys very
  // little; for the length of a visit is enough.
  let TOR_PORT = 9150;
  const socksArg = () => `--socks5-hostname 127.0.0.1:${TOR_PORT}`;

  // Rendered at the top of both command popups. Re-renders whichever popup is
  // open, so the visible commands and the text behind every copy button change
  // together: a control that updated only what you can see would be worse than
  // no control at all.
  const portPicker = () =>
    `<div class="portpick"><span class="k">Tor SOCKS port</span>`
    + [[9050, "standalone tor"], [9150, "Tor Browser"]].map(([p, what]) =>
        `<button class="pbtn${TOR_PORT === p ? " on" : ""}" data-act="torport" data-v="${p}"`
        + ` aria-pressed="${TOR_PORT === p}">${p}<span class="w">${what}</span></button>`).join("")
    + `</div>`;

  // them and publish them. These commands run the same two requests against the
  // node, so a reader can compare and never has to take our display on trust.
  // The apikey and onion are already on the card, so nothing new is disclosed.
  function checkSelfHTML(n){
    const pr = (n.payload && n.payload.pairing) || {};
    if(!pr.url || !pr.apikey) return "<p>This node publishes no API key, so it cannot be queried directly.</p>";
    let base;
    try{ const u = new URL(pr.url); base = u.origin + (u.pathname||"/v2").replace(/\/+$/,""); }
    catch(e){ return "<p>This node's pairing URL could not be parsed.</p>"; }
    const S = socksArg();
    const blk = (label, body) =>
      `<div class="proofblk"><div class="k">${esc(label)}</div>`
      + `<pre class="mono">${esc(body)}</pre>`
      + `<button class="copybtn" data-act="copyurl" data-v="${esc(body)}">copy</button></div>`;
    const iu = indexerUrl(n);
    const ours = ["the <b>Dojo version</b>", "the <b>block height</b>"].concat(iu ? ["the <b>Electrum endpoint</b>"] : []);
    return `<p class="dnote">Nearly everything on this card is signed by the operator and checkable without us.
        These are not: ${ours.slice(0,-1).join(", ")} and ${ours[ours.length-1]} are values our checker read from
        the node and republished. The commands below ask the node the same questions over Tor, so you can compare
        its answers with ours.</p>
      <p class="dnote">You need a Tor SOCKS proxy. Pick the port you are running on and every command below,
        including what the copy buttons put on your clipboard, changes to match. The API key and onion address
        here are already published on this card.</p>
      ${portPicker()}
      <p class="dnote">If a command answers
        <span class="mono">Failed to connect to 127.0.0.1 port ${TOR_PORT}: Connection refused</span>,
        nothing is listening there: try the other port. If neither works, Tor is not running, or is on a port
        of its own, which some packaged builds choose.</p>

      <h3>1. Log in, and read the version header</h3>
      <p class="dnote">Every Dojo response carries <span class="mono">X-Dojo-Version</span>, so <span class="mono">-i</span>
        shows the running version and the reply carries the token for step 2.</p>
      ${blk("login", `curl -si ${S} \\\n  -d "apikey=${pr.apikey}" \\\n  ${base}/auth/login`)}
      ${blk("we show this version", n.version ? "v" + n.version : "(none published)")}

      <h3>2. Ask for the chain tip</h3>
      <p class="dnote">Substitute the <span class="mono">access_token</span> from step 1. This is where the block
        height on the card comes from; it moves on, so expect it to be at or above what we show.</p>
      ${blk("latest block", `curl -s ${S} \\\n  -H "Authorization: Bearer <ACCESS_TOKEN>" \\\n  ${base}/latest-block`)}
      ${blk("we show this height", n.block_height != null ? String(n.block_height) : "(none yet)")}

      ${iu ? `<h3>3. Ask for the Electrum endpoint</h3>
      <p class="dnote">The indexer entry is the Electrum server.</p>
      ${blk("services", `curl -s ${S} \\\n  -H "Authorization: Bearer <ACCESS_TOKEN>" \\\n  ${base}/support/services`)}
      ${blk("we show this endpoint", iu)}` : `<p class="dnote">This node publishes no Electrum endpoint, so the card
        shows N/A and there is nothing to check on that count. Either its operator does not expose an indexer, or it
        runs a Dojo older than v1.27.0, which has no such route.</p>`}

      <h3>All of it at once</h3>
      <p class="dnote">With <span class="mono">jq</span> installed:</p>
      ${blk("one-liner", `TOKEN=$(curl -s ${S} -d "apikey=${pr.apikey}" ${base}/auth/login | jq -r .authorizations.access_token)\n`
        + `curl -s ${S} -H "Authorization: Bearer $TOKEN" ${base}/latest-block | jq -r .height`
        + (iu ? `\ncurl -s ${S} -H "Authorization: Bearer $TOKEN" ${base}/support/services | jq -r '.services[]|select(.type=="indexer")|.url'` : ""))}
      <p class="dnote">Without <span class="mono">jq</span>, the replies are small enough to read as they are.</p>

      <p class="dnote">One caveat, stated rather than glossed over: running these opens your own Tor circuit to the
        node, so the operator sees a request. That is inherent to checking anything directly, not an extra exposure,
        and no wallet key or XPUB is involved.</p>`;
  }

  // "Rescan XPUB": the commands, never a field.
  //
  // This page does not ask for an XPUB and never will. An XPUB reveals every
  // address an account has ever used or will use, and a directory that invited
  // people to paste one into a web form would be teaching the exact habit that
  // makes phishing clones profitable — even if this particular page were honest,
  // the next one that looks like it would not be.
  //
  // So the popup hands over commands the reader runs in their own terminal,
  // against the operator's node, with this instance nowhere on the path.
  function rescanHTML(n){
    const pr = (n.payload && n.payload.pairing) || {};
    if(!pr.url || !pr.apikey) return "<p>This node publishes no API key, so it cannot be asked to do anything.</p>";
    let base;
    try{ const u = new URL(pr.url); base = u.origin + (u.pathname||"/v2").replace(/\/+$/,""); }
    catch(e){ return "<p>This node's pairing URL could not be parsed.</p>"; }
    const S = socksArg();
    const blk = (label, body) =>
      `<div class="proofblk"><div class="k">${esc(label)}</div>`
      + `<pre class="mono">${esc(body)}</pre>`
      + `<button class="copybtn" data-act="copyurl" data-v="${esc(body)}">copy</button></div>`;
    return `<p class="dnote"><b>Your wallet normally does this for you.</b> Pairing with a Dojo registers your
        account and imports its history, and if a balance looks wrong the usual fix is to re-pair in
        Samourai or Ashigaru. What follows is for people who would rather drive the API directly.</p>

      <div class="warnbox">
        <b>Never paste an XPUB into a web page, including this one.</b>
        An XPUB reveals every address an account has used and every one it will use in future. This page
        does not ask for yours and has no field to type it into: the commands below run in your own
        terminal, and this directory never sees the value. Be equally suspicious of any site that does ask.
      </div>

      <p class="dnote">Two things follow from that. Your XPUB does go to <b>this operator's node</b>, which
        is inherent to using someone else's Dojo rather than a new exposure — it is the same thing pairing
        does. And a rescan is real work for their machine, so it is not something to run repeatedly.</p>

      ${portPicker()}
      <p class="dnote">Pick the port your Tor is listening on and every command below changes to match,
        including what the copy buttons put on your clipboard. A standalone <span class="mono">tor</span>
        daemon uses <span class="mono">9050</span> and Tor Browser uses <span class="mono">9150</span>;
        <span class="mono">Connection refused</span> means nothing is listening on the one you chose.</p>

      <h3>1. Log in</h3>
      ${blk("token", `TOKEN=$(curl -s ${S} -d "apikey=${pr.apikey}" ${base}/auth/login | jq -r .authorizations.access_token)`)}

      <h3>2. Ask for the rescan</h3>
      <p class="dnote">Pick the scheme matching the account: <span class="mono">bip84</span> for native
        segwit (addresses starting <span class="mono">bc1</span>), <span class="mono">bip49</span> for
        wrapped segwit (<span class="mono">3…</span>), <span class="mono">bip44</span> for legacy
        (<span class="mono">1…</span>). A wallet usually has all three, and each is a separate XPUB.
        <br><span class="mono">type=restore</span> is the rescan; <span class="mono">type=new</span> registers
        an account with no history to look for.</p>
      ${blk("restore", `curl -s ${S} \\\n  -H "Authorization: Bearer $TOKEN" \\\n`
        + `  -d "xpub=<YOUR_XPUB>" \\\n  -d "type=restore" \\\n  -d "segwit=bip84" \\\n  ${base}/xpub/`)}
      <p class="dnote">Add <span class="mono">-d "force=true"</span> only if the account is already known to
        this Dojo and you want its records rebuilt from scratch.</p>

      <h3>3. Watch it finish</h3>
      <p class="dnote">A restore walks the derivation looking for used addresses, so it takes a while.</p>
      ${blk("status", `curl -s ${S} -H "Authorization: Bearer $TOKEN" \\\n  ${base}/xpub/<YOUR_XPUB>/import/status`)}

      <p class="dnote">If any of this fails, the node may be down, may be running a Dojo too old for the
        route, or may have been given an XPUB it cannot parse. Nothing here is retried for you, and nothing
        here is recorded by this directory.</p>`;
  }

  // The two popups that carry shell commands record how to rebuild themselves,
  // because changing the Tor port has to redraw the one that is open. Cleared on
  // close so a stale closure cannot repaint a dialog nobody is looking at.
  let MODAL_REOPEN = null;

  function openRescan(n){
    document.getElementById("ov-title").textContent = (n.name||n.id) + " · rescan an XPUB";
    MODAL_REOPEN = () => { document.getElementById("ov-body").innerHTML = rescanHTML(n); };
    MODAL_REOPEN();
    showOverlay();
  }

  function openCheckSelf(n){
    document.getElementById("ov-title").textContent = (n.name||n.id) + " · check it yourself";
    MODAL_REOPEN = () => { document.getElementById("ov-body").innerHTML = checkSelfHTML(n); };
    MODAL_REOPEN();
    showOverlay();
  }

  function openDomainProof(n){
    document.getElementById("ov-title").textContent = (n.operator_domain||"domain") + " · verify";
    document.getElementById("ov-body").innerHTML = domainProofHTML(n);
    showOverlay();
  }

  // Pairing details open in the shared popup (the same surface as Verify)
  // rather than expanding beneath the card.
  function openPair(n){
    document.getElementById("ov-title").textContent = (n.name||n.id) + " · pairing";
    document.getElementById("ov-body").innerHTML = pairHTML(n);
    showOverlay();
  }

  // Card ordering: 7-day uptime desc, then 24h uptime desc, then name. A node
  // with NO history ranks as 0.5% on the missing figure: below anything alive,
  // above a long-standing dead node sitting at 0%, so fresh listings gather
  // near the end without looking worse than known-dead ones.
  const NO_HISTORY_PCT = 0.5;
  function pct7(id){
    const days=(((DAILY||{}).nodes||{})[id]||{}).days||[];
    const last=days.slice(-7);
    if(!last.length) return null;
    return last.reduce((a,d)=>a+(Number(d.pct)||0),0)/last.length;
  }
  function pct24(id){
    const c=((HIST.nodes||{})[id]||{}).checks||[];
    if(!c.length) return null;
    return 100*c.filter(x=>x.up).length/c.length;
  }
  function byUptime(a,b){
    const a7=pct7(a.id)??NO_HISTORY_PCT, b7=pct7(b.id)??NO_HISTORY_PCT;
    if(a7!==b7) return b7-a7;
    const a24=pct24(a.id)??NO_HISTORY_PCT, b24=pct24(b.id)??NO_HISTORY_PCT;
    if(a24!==b24) return b24-a24;
    return String(a.name||a.id).localeCompare(String(b.name||b.id),"en",{sensitivity:"base"});
  }

  // A directory with nothing in it. Reached in two ways that look identical to
  // this function but mean opposite things to a reader: a freshly installed
  // instance that has not yet run its first rebuild, and an established one
  // whose selected network happens to hold no listings. Say which, because
  // "nothing here" reads as a fault otherwise, and a new operator staring at a
  // blank page has no way to tell a working install from a broken one.
  function emptyState(){
    const other = net==="mainnet" ? "testnet" : "mainnet";
    const anyElsewhere = (DOJOS.nodes||[]).some(n=>n.network===other);
    const fresh = !(DOJOS.nodes||[]).length && !DOJOS.generated_at;
    return '<div class="empty">'
      + (fresh
          ? '<p><b>Nothing published yet.</b> This directory has not completed its first refresh. '
            + 'If you have just installed it, run the rebuild and wait for one probe cycle; listings appear here as they are approved.</p>'
          : '<p><b>No '+esc(net)+' Dojos are listed right now.</b>'
            + (anyElsewhere ? ' There are listings on '+esc(other)+': use the network switch above.' : '')
            + '</p>')
      + '<p class="empty-cta">If you run a Dojo, you can list it yourself: '
      + '<button class="lnk" data-act="manage">Manage my Dojo</button>.</p>'
      + '</div>';
  }

  function render(){
    const list=DOJOS.nodes.filter(n=>n.network===net).sort(byUptime);
    const active=list.filter(n=>n.status==="active").length;
    const gen=(DOJOS.generated_at||"").replace("T"," ").slice(0,16)+" UTC";
    const FRESH=freshness(DOJOS);

    document.getElementById("root").innerHTML = `

    <header><div class="wrap">
      <button class="burger" data-act="burger" aria-label="Menu" aria-expanded="${menuOpen}">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          ${menuOpen?'<path d="M6 6 L18 18 M18 6 L6 18"/>':'<path d="M4 7h16 M4 12h16 M4 17h16"/>'}
        </svg>
      </button>
      <a class="brand" href="./" aria-label="The Dojo Bay">${LOGO}
        <span><div class="name disp">THE DOJO BAY</div><div class="sub mono">public dojo directory</div></span></a>
      <nav class="${menuOpen?"open":""}">
        <button class="lnk" data-modal="about">About</button>
        <button class="lnk" data-modal="faq">FAQ</button>
        <button class="lnk" id="manage-link" data-act="manage"${BACKEND?"":" hidden"}>Manage my Dojo</button>
        <a class="onion-pill" href="data/dojos.json" download="dojos.json" title="Download the directory as JSON">JSON ↓</a>
      </nav>
    </div></header>

    <div class="wrap controls">
      <div class="seg">
        <button data-net="mainnet" class="${net==="mainnet"?"on":""}">mainnet</button>
        <button data-net="testnet" class="${net==="testnet"?"on":""}">testnet</button>
      </div>
      <div class="fresh${FRESH.stale?" stale":""}"><span class="dot"></span><b>${active}</b> of ${list.length} active
        <span class="sep">·</span> checked ${esc(gen)}
        <span class="sep">·</span> re-checks every ${FRESH.intervalMin} min</div>
    </div>

    <main class="wrap">
      ${DOJOS.probe_fault?`<div class="stale-banner" role="status">
        <b>This directory could not reach any node at ${esc(String(DOJOS.probe_fault.at).replace("T"," ").replace("Z"," UTC"))}.</b>
        All ${Number(DOJOS.probe_fault.nodes)||0} of them failing together is almost certainly a fault here rather
        than every operator at once, so nothing was recorded and the statuses below are from the last check that
        reached something. They may be out of date. This resolves itself when the fault does.
      </div>`:""}
      ${FRESH.stale?`<div class="stale-banner" role="status">
        <b>These statuses are out of date.</b>
        This directory last refreshed ${esc(humanAge(FRESH.ageMin))} ago${FRESH.unknown?"":`, and should refresh every ${FRESH.intervalMin} minutes`}.
        This page refetches on the same cadence the directory publishes, so either the checker has stopped
        or we have been unable to reach it. Either way the badges below are greyed out: treat every node
        as unknown rather than up or down.
        (If your device's clock is wrong, this warning can appear on a healthy directory.)
      </div>`:""}
      ${list.length
        ? `<div class="grid${FRESH.stale?" stale":""}">${list.map(card).join("")}</div>`
        : emptyState()}
      <p class="note">The Dojo Bay is a federation of independent operators across different jurisdictions, and every node is reachable over Tor. Nodes go up and down without notice, and only the operator can restart one. Pairing exposes your XPUBs to that node, so do your own due diligence, or <a href="https://dojo-osp.org/install/requirements" target="_blank" rel="noopener">run your own Dojo</a>.</p>
    </main>

    <footer><div class="wrap">
      ${OPERATOR&&OPERATOR.paymentCode?`<img class="op-avatar" alt="" title="Directory operator's PayNym" src="data/avatars/${encodeURIComponent(OPERATOR.paymentCode)}.png" onerror="this.remove()">`:""}
      <button class="lnk verify-link" data-act="verify" title="Verify this directory's onion address is signed by its operator">Verify</button>
      <span class="foot-spacer"></span>
      <a class="gh" href="data/dojobay-src.zip" download="dojobay-src.zip" aria-label="Download this instance's source code (zip)" title="Download this instance's source code (zip)">${SRC_ICON}</a>
      <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="Source code on GitHub" title="Source code on GitHub">${GH_LOGO}</a>
      <span class="ver">${VERSION?`<a href="${REPO_URL}/commit/${esc(VERSION.commit)}" target="_blank" rel="noopener" title="${esc(VERSION.built||"")}">build ${esc(VERSION.commit)}</a>`:""}</span>
    </div></footer>

    <div class="ov" id="ov"><div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2 id="ov-title"></h2><button class="x" data-act="closemodal" aria-label="Close">✕</button></div>
      <div class="modal-body" id="ov-body"></div>
    </div></div>`;

    // 90-day strips: one lazily-cached fetch of history-daily.json fills every
    // card; re-renders re-hydrate from the same cached promise.
    document.querySelectorAll(".hist90[data-hist]").forEach(m=>renderHist90(m, m.getAttribute("data-hist")));

    // Now the cards have a width, show as much of each payment code as fits.
    fitPaymentCodes();
  }

  async function openModal(key){
    const m=MODAL_META[key]; if(!m) return;
    document.getElementById("ov-title").textContent=m.title;
    const body=document.getElementById("ov-body");
    showOverlay();
    if(modalCache[key]==null){
      body.innerHTML='<p class="loading">Loading\u2026</p>';
      try{ modalCache[key]=markdown.render(await loadText(m.file)); }
      catch(e){ modalCache[key]='<p class="loading">Could not load content ('+e.message+').</p>'; }
    }
    body.innerHTML=modalCache[key];
  }
  function showLoadError(err){
    const local = location.protocol==="file:" || location.hostname==="localhost" || location.hostname==="127.0.0.1";
    if(local) return showServeHint(err);
    document.getElementById("root").innerHTML =
      '<div style="max-width:640px;margin:14vh auto;padding:0 22px">'
      + '<h1 class="disp" style="font-size:22px;margin-bottom:14px">Directory data unavailable</h1>'
      + '<p style="color:#a0a0a0;line-height:1.7">The node list could not be loaded. If this persists, the server\'s <code style="color:#e6a39b">data/dojos.json</code> is missing or unreadable.</p>'
      + '<p style="color:#6b6b6b;font-family:\'JetBrains Mono\',monospace;font-size:12px;margin-top:14px">'+esc(String(err && err.message || err))+'</p></div>';
  }
  function showServeHint(err){
    document.getElementById("root").innerHTML =
      '<div style="max-width:640px;margin:14vh auto;padding:0 22px">'
      + '<h1 class="disp" style="font-size:22px;margin-bottom:14px">Serve this over HTTP</h1>'
      + '<p style="color:#a0a0a0;line-height:1.7">The directory loads its data and text from separate files, which browsers block when the page is opened straight from disk. From the project folder run:</p>'
      + '<pre style="background:#070707;border:1px solid #2a2a2a;border-radius:8px;padding:13px;color:#e6a39b;font-family:\'JetBrains Mono\',monospace;font-size:13px;margin:12px 0">npm run dev</pre>'
      + '<p style="color:#a0a0a0;line-height:1.7">then open <a style="color:#b5302a" href="http://localhost:8080">http://localhost:8080</a>.</p>'
      + '<p style="color:#6b6b6b;font-family:\'JetBrains Mono\',monospace;font-size:12px;margin-top:14px">'+String(err && err.message || err)+'</p></div>';
  }
  // Show the shared popup, always from the top. The body is the scroll container
  // (the header is fixed above it), so without this a popup opened while the
  // previous one was scrolled down would appear part-way through its own text.
  function showOverlay(){
    const body = document.getElementById("ov-body");
    if(body) body.scrollTop = 0;
    const ov = document.getElementById("ov");
    if(ov) ov.classList.add("show");
  }

  function closeModal(){
    MODAL_REOPEN = null;
    const o=document.getElementById("ov"); if(o)o.classList.remove("show");
    // A refresh that arrived while this dialog was open deferred its redraw so
    // as not to pull the content out from under the reader. Apply it now.
    if(PENDING_RENDER){ PENDING_RENDER=false; render(); }
  }

  // Verify popup: shows the operator's BIP47-signed proof of this onion address,
  // as a scannable QR plus the copyable signed message. Source: data/operator.json.
  let OPERATOR = null;
  // Loaded at boot (state read by the footer template at render time); the
  // Verify popup reuses the same state and lazily loads it as a fallback.
  async function loadOperator(){
    try{ OPERATOR = await loadJSON("data/operator.json"); if(DOJOS) render(); }catch(e){ /* no operator.json: footer shows no avatar */ }
  }
  async function openVerify(){
    const titleEl=document.getElementById("ov-title"), body=document.getElementById("ov-body");
    if(!titleEl||!body) return;
    titleEl.textContent = "Verify this directory";
    showOverlay();
    body.innerHTML = '<p class="loading">Loading…</p>';
    try{ if(!OPERATOR) OPERATOR = await loadJSON("data/operator.json"); }
    catch(e){ body.innerHTML='<p class="loading">Operator signature unavailable.</p>'; return; }
    const signed = OPERATOR.verifySigned || "";
    // Error correction H, not the default M. The avatar covers roughly 4% of
    // the symbol area, which only M's 15% budget makes marginal; H's 30% has
    // room to spare. The cost is density, and it is worth stating the numbers
    // because they look alarming out of context: this lands at about 2.7px per
    // module at 300px, where the pairing QR that every visitor already scans
    // sits at 2.2px. Denser than nothing, less dense than what ships.
    const qr = qrSVG(signed, 300, "H");
    // The operator's PayNym, so a reader can put a face and a name to whoever
    // signed this, the same way every listing does. The avatar keys on the
    // payment code, which operator.json always carries and which the updater
    // already syncs alongside the listed nodes.
    const avatar = OPERATOR.paymentCode
      ? `<img class="qr-avatar" alt="" fetchpriority="high" decoding="async" src="data/avatars/${encodeURIComponent(OPERATOR.paymentCode)}.png" onerror="this.remove()">`
      : "";
    // The NAME is a separate problem: operator.json was defined before this was
    // wanted and older instances have no paynym field, so it is read when
    // present and otherwise recovered from the operator's own listing, which is
    // published and carries both the payment code and the PayNym. Either way
    // the link is omitted rather than guessed at if neither source has it.
    const paynym = OPERATOR.paynym
      || ((DOJOS && DOJOS.nodes || []).find((n) => n.paynym && n.paymentCode === OPERATOR.paymentCode) || {}).paynym
      || null;
    const paynymLine = paynym
      ? '<p style="font-size:12.5px;color:var(--muted);text-align:center;margin:0 0 4px">Signed by '
        + `<a class="pn" href="${PAYNYM_WEB}/${esc(paynym)}" target="_blank" rel="noopener">${esc(paynym)}</a>`
        + ' \u00b7 <span style="color:var(--faint)">look the PayNym up yourself before trusting it</span></p>'
      : "";
    body.innerHTML =
      '<p style="font-size:13px;color:var(--muted)">This directory\u2019s operator has signed its onion address with their BIP47 payment code. '+
      'Scan or copy the signed message and verify it against the payment code to confirm you are on the genuine site and not a phishing clone.</p>'+
      '<div style="text-align:center;margin:16px 0"><div class="tile" style="display:inline-block;background:#fff;border-radius:10px;padding:12px">'+qr+avatar+'</div></div>'+
      paynymLine+
      '<div class="lbl"><span class="t">Signed message</span><button class="copybtn" data-act="copyverify">Copy</button></div>'+
      '<pre class="verify-pre">'+esc(signed)+'</pre>';
  }

  // Warm the PayNym avatar as soon as the operator shows intent to open a
  // card's pairing popup, so the image is already in cache by the time the QR
  // renders. Fetching every card's avatar up front would mean one Tor request
  // per listed node on page load, which is far worse than one on hover.
  const warmed = new Set();
  function warmAvatar(card){
    const code = card && card.getAttribute("data-pc");
    if(!code || warmed.has(code)) return;
    warmed.add(code);
    const img = new Image();
    img.src = "data/avatars/" + encodeURIComponent(code) + ".png";
  }
  for(const evt of ["pointerenter","focusin"]){
    document.addEventListener(evt, e=>{
      const t = e.target instanceof Element ? evEl(e)?.closest('[data-act="pair"]') : null;
      if(t) warmAvatar(t.closest(".card"));
    }, true);
  }

  document.addEventListener("click", e=>{
    const netBtn=evEl(e)?.closest("[data-net]");
    if(netBtn){net=netBtn.getAttribute("data-net");render();return;}
    const mBtn=evEl(e)?.closest("[data-modal]");
    if(mBtn){ if(menuOpen){menuOpen=false;render();} openModal(mBtn.getAttribute("data-modal"));return;}
    const act=evEl(e)?.closest("[data-act]");
    if(!act){ if(evEl(e)?.id==="ov") closeModal(); return; }
    const a=act.getAttribute("data-act");
    if(a==="burger"){menuOpen=!menuOpen;render();return;}
    if(a==="torport"){
      TOR_PORT = Number(act.getAttribute("data-v"));
      // Re-render the popup that is open, so the commands on screen and the
      // text behind every copy button move together. Re-opening rather than
      // patching the port in place because the port appears in several blocks
      // and in the connection-refused hint, and a partial update here is the
      // exact failure the control exists to remove.
      if(MODAL_REOPEN) MODAL_REOPEN();
      return;
    }
    if(a==="closemodal"){closeModal();return;}
    if(a==="verify"){ openVerify(); return; }
    if(a==="copyverify"){ if(OPERATOR) copy(OPERATOR.verifySigned).then(()=>flash(act,"Copied ✓")); return; }
    if(a==="copycode"){ copy(act.getAttribute("data-v")).then(()=>flash(act,"Copied ✓")); return; }
    // node resolution that works from a card OR from inside the popup
    const byIdAttr=()=>DOJOS.nodes.find(x=>x.id===act.getAttribute("data-id"));
    if(a==="copypairing"){const n=byIdAttr();copy(JSON.stringify({pairing:n.payload.pairing,explorer:n.payload.explorer},null,2)).then(()=>flash(act,"Copied ✓"));return;}
    if(a==="copysigned"){copy(byIdAttr().signed).then(()=>flash(act,"Copied ✓"));return;}
    const cardEl=evEl(e)?.closest(".card");
    const node=()=>DOJOS.nodes.find(x=>x.id===cardEl.getAttribute("data-id"));
    if(a==="pair"){ openPair(node()); return; }
    if(a==="domproof"){ openDomainProof(node()); return; }
    if(a==="checkself"){ openCheckSelf(node()); return; }
    if(a==="rescan"){ openRescan(node()); return; }
    if(a==="copyurl"){copy(act.getAttribute("data-v")).then(()=>flash(act,"✓"));return;}
  });
  document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeModal(); });

  /* ================= Manage my Dojo (self-service, step 2) =================
     Everything below is inert unless a backend answers /api/me. On the static
     step-1 onion there is no API, so the nav button stays hidden and nothing
     here runs. */
  // e.target is typed EventTarget, which has no DOM methods; every listener here
  // is on a rendered element. One helper narrows it, rather than casting at each
  // call site.
  /** @param {Event} e @returns {Element|null} */
  const evEl = (e) => (e.target instanceof Element ? e.target : null);

  // A gateway error is retried briefly; everything else is returned at once.
  //
  // nginx proxies /api to the backend on localhost and answers 502 when nothing
  // is listening. The one moment that reliably happens is the few seconds after
  // a self-update restarts the service, which is a thing this very page asked
  // for: a moderator clicked update, watched it succeed, and was then shown a
  // bare "502" with no hint that the restart it had requested was still in
  // progress. Nothing was wrong, and there was no way to tell that from the
  // page.
  //
  // Only 502, 503 and 504 are retried, since those are the proxy saying it could
  // not reach anything rather than the backend saying no. A 401 or a 409 is an
  // answer and must not be repeated: retrying a POST that was refused for a
  // real reason would be worse than the error it hides.
  //
  // Five attempts a second apart is a little over the gap a restart leaves and
  // far short of the point where a person would rather be told. A request that
  // is still failing after that is reported normally, which is the honest
  // outcome when the service has genuinely gone.
  const GATEWAY_DOWN = new Set([502, 503, 504]);
  const api = {
    async call(path, method="GET", body, opts){
      const tries = (opts && opts.tries) || 5;
      for(let i=0;i<tries;i++){
        let r;
        try{
          r = await fetch("/api"+path, {method, headers: body?{"Content-Type":"application/json"}:{}, body: body?JSON.stringify(body):undefined, credentials:"same-origin", cache:"no-store"});
        }catch(e){
          // A dropped connection mid-restart looks like this rather than a
          // status. Same treatment: retry, then give up and report it.
          if(i===tries-1) return {status:0, body:null, gatewayDown:true};
          await new Promise((z)=>setTimeout(z,1000)); continue;
        }
        if(GATEWAY_DOWN.has(r.status) && i<tries-1){ await new Promise((z)=>setTimeout(z,1000)); continue; }
        let j=null; try{ j=await r.json(); }catch(e){}
        return {status:r.status, body:j, gatewayDown:GATEWAY_DOWN.has(r.status)};
      }
    }
  };
  let ME = null;
  let BACKEND = false;
  async function detectBackend(){
    try{
      // One attempt only. This runs on every page load to decide whether to show
      // Manage my Dojo, and a directory served as static files must render at
      // once whether or not a backend exists: retrying here would make every
      // visitor to an instance without one wait five seconds for nothing.
      const r = await api.call("/me", "GET", undefined, {tries:1});
      if(r.status===200 && r.body){
        ME = r.body;
        BACKEND = true;
        // render() rebuilds the header, so drive visibility from state and
        // re-render if the page is already up, rather than poking the DOM once.
        if(DOJOS) render();
        else { const el=document.getElementById("manage-link"); if(el) el.hidden=false; }
      }
    }catch(e){ /* no backend: stay hidden */ }
  }

  async function openManage(){
    document.getElementById("ov-title").textContent = "Manage my Dojo";
    showOverlay();
    // One Auth47 session covers both this panel and /admin (same cookie), so
    // re-read /api/me before rendering: a sign-in or sign-out that happened on
    // the admin page (or another tab) is picked up here instead of asking the
    // operator to authenticate twice.
    const body = document.getElementById("ov-body");
    if(body) body.innerHTML = '<p class="loading">Checking session…</p>';
    await refreshMe();
    renderManage();
  }
  async function refreshMe(){ const r=await api.call("/me"); if(r.status===200) ME=r.body; }

  // ---- verified domain -----------------------------------------------------
  // One domain per operator, proven in both directions: a TXT record on the
  // domain names the payment code, and the operator signs a statement naming the
  // domain. DOMAIN holds what the server reported; DOMAIN_PREP holds the exact
  // record and text for a domain being set up, both fetched from the server so
  // the instructions can never drift from what verification checks.
  let DOMAIN = null, DOMAIN_PREP = null, DOMAIN_MSG = "";

  async function refreshDomain(){
    const r = await api.call("/domain","GET");
    // Settle to an object either way, so a failed or unsupported lookup does not
    // make every subsequent render re-request it.
    DOMAIN = r.status===200 && r.body ? r.body : { claim:null, unavailable:true };
  }

  function domainSection(){
    const c = DOMAIN && DOMAIN.claim;
    const msg = DOMAIN_MSG ? `<p class="dmsg">${esc(DOMAIN_MSG)}</p>` : "";
    if(c && !c.verified){
      return `<div class="dbox">
        <p>Saved for <b>${esc(c.domain)}</b> — waiting for the TXT record.</p>
        <p class="dnote">Your signature is verified and stored, so you do not need to sign again.
          We re-check DNS automatically every few minutes${c.last_check?`; last looked ${esc(c.last_check.slice(0,16).replace("T"," "))} UTC`:""}.
          ${c.last_result?`<br>Last result: <span class="dwrap">${esc(c.last_result)}</span>`:""}</p>
        <div class="medit-actions">
          <button class="copybtn" data-mact="domrecheck">Check now</button>
          <button class="copybtn" data-mact="domchange">Change domain</button>
          <button class="copybtn" data-mact="domremove">Remove</button>
        </div>${msg}</div>`;
    }
    if(c && c.verified){
      return `<div class="dbox">
        <p>Verified: <a href="https://${esc(c.domain)}" target="_blank" rel="noopener noreferrer">${esc(c.domain)}</a>
          <span class="ok-tick">✓</span></p>
        <p class="dnote">Shown on your cards, and your card link may point anywhere on this domain.
          ${c.failing_since?`<b>The TXT record is currently missing</b> (since ${esc(c.failing_since.slice(0,10))}); the badge is removed if it stays missing for ${esc(String(c.grace_days))} days.`:""}
          ${c.last_check?`Last checked ${esc(c.last_check.slice(0,10))}.`:""}</p>
        <div class="medit-actions">
          <button class="copybtn" data-mact="domchange">Change domain</button>
          <button class="copybtn" data-mact="domremove">Remove</button>
        </div>${msg}</div>`;
    }
    if(DOMAIN_PREP){
      return `<div class="dbox">
        <p>Two steps for <b>${esc(DOMAIN_PREP.domain)}</b>${DOMAIN_PREP.punycode?' <span class="dnote">(shown in punycode)</span>':""}:</p>
        <p class="dnote">1. Publish this TXT record on your domain:</p>
        <div class="ep"><span class="k">Host</span><span class="u mono">${esc(DOMAIN_PREP.txt_host||"_dojobay")}</span><button class="copybtn" data-act="copyurl" data-v="${esc(DOMAIN_PREP.txt_host||"_dojobay")}">copy</button></div>
        <div class="ep"><span class="k">Value</span><span class="u mono">${esc(DOMAIN_PREP.txt_value)}</span><button class="copybtn" data-act="copyurl" data-v="${esc(DOMAIN_PREP.txt_value)}">copy</button></div>
        <p class="dnote">Most control panels (Namecheap, Cloudflare, Route 53) treat Host as relative to
          your domain, so enter <b>${esc(DOMAIN_PREP.txt_host||"_dojobay")}</b> exactly. Entering the full
          <span class="mono">${esc(DOMAIN_PREP.txt_name)}</span> there creates
          <span class="mono">${esc(DOMAIN_PREP.txt_name)}.${esc(DOMAIN_PREP.domain)}</span> instead, which
          will not be found. A few panels do want the full name; use it only if yours asks for an FQDN.
          Existing records for a website are unaffected: this is a separate TXT record.</p>
        <p class="dnote">2. Sign this EXACT text in your wallet under <b>PayNym → Sign message</b>, then paste the whole signed block below:</p>
        <pre class="dsign mono">${esc(DOMAIN_PREP.sign_text)}</pre>
        <button class="copybtn" data-act="copyurl" data-v="${esc(DOMAIN_PREP.sign_text)}">copy the text to sign</button>
        <label>Signed block <textarea class="d-signed" rows="7" placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----"></textarea></label>
        <div class="medit-actions">
          <button class="copybtn" data-mact="domverify">Verify</button>
          <button class="copybtn" data-mact="domcancel">Cancel</button>
        </div>${msg}</div>`;
    }
    return `<div class="dbox">
      <p class="dnote">Optional. Prove you control a domain and your cards show it, and your card
        title can link to it. Verification is by DNS TXT record plus a wallet signature; nothing
        is published until both check out. This proves control of a domain, not that you are
        trustworthy, and a maintainer can revoke a badge.</p>
      <label>Domain <input class="d-domain" maxlength="253" placeholder="example.com"></label>
      <div class="medit-actions"><button class="copybtn" data-mact="domprep">Continue</button></div>${msg}</div>`;
  }

  async function renderManage(){
    const body = document.getElementById("ov-body");
    if(!ME || !ME.authenticated){ return renderLogin(body); }
    if(DOMAIN===null){ await refreshDomain(); }
    // The API already returns mainnet-then-testnet, alphabetical by name;
    // sort again here so the panel never depends on response ordering.
    const subs = (ME.submissions||[]).slice().sort((a,b)=>
      a.network!==b.network ? (a.network==="mainnet"?-1:1)
      : String(a.name||a.id).localeCompare(String(b.name||b.id),"en",{sensitivity:"base"}));
    body.innerHTML = `
      <p style="margin-bottom:6px">Signed in as <code>${esc(ME.paymentCode.slice(0,12))}…${esc(ME.paymentCode.slice(-4))}</code>
        <button class="copybtn" data-mact="logout" style="margin-left:8px">Sign out</button></p>
      ${ME.admin?'<p style="font-size:12.5px;color:var(--muted)">This payment code moderates the directory: <a href="/admin" style="color:var(--accent)">open the admin console →</a> (same sign-in; signing out here signs you out there too).</p>':""}
      <p style="font-size:13px;color:var(--muted)">Add or edit a Dojo you operate. Every listing must carry a pairing payload you have signed with your PayNym: that signature is the only part of a listing a visitor can check without trusting this site. Submissions are checked for a live Tor connection and for a valid signature, then reviewed by a maintainer before they appear.</p>
      <h3>Verified domain</h3>
      ${domainSection()}
      <h3>Your Dojos</h3>
      ${subs.length? subs.map(manageRow).join("") : '<p style="color:var(--faint)">None yet.</p>'}
      <h3>Add / replace a Dojo</h3>
      ${dojoForm()}
      <div id="manage-msg" style="margin-top:12px"></div>`;
  }
  function statusPill(s){
    const c = s==="approved"?"active":(s==="rejected"?"inactive":"");
    const label = s==="approved"?"Approved":(s==="rejected"?"Rejected":"Pending review");
    return `<span class="cbadge ${c}" style="background:${s==="pending"?"var(--panel2)":""}">${label}</span>`;
  }
  // Inline editing of display fields (name, hardware, Dojo version). One row
  // at a time: EDIT_ID holds the open row; other Edit buttons disable while
  // it is set. Renaming keeps the record id (and history); uniqueness is
  // enforced per network by the API (409).
  let EDIT_ID = null;
  let PAIR_ID = null;
  function editForm(r, actPrefix){
    const ver = r.version || (r.payload && r.payload.pairing && r.payload.pairing.version) || "";
    return `<div class="medit">
      <label>Name <input class="e-name" maxlength="40" value="${esc(r.name||"")}"></label>
      <label>Hardware <input class="e-hw" maxlength="120" value="${esc(r.hardware||"")}"></label>
      <div class="e-ver-note" style="font-size:12px;color:var(--muted)">Dojo version is read live from the node (${esc(ver?("v"+ver):"detected on next probe")}) and can't be edited here.</div>
      <div class="medit-actions">
        <button class="copybtn" data-${actPrefix}="editsave" data-id="${esc(r.id)}">Save</button>
        <button class="copybtn" data-${actPrefix}="editcancel">Cancel</button>
        <span class="edit-msg" style="font-size:12px;color:var(--down)"></span>
      </div>
    </div>`;
  }
  // Updating the pairing payload is a different act from editing display
  // fields: it changes where visitors connect. It keeps the listing's place and
  // history, because approval binds to the payment code that owns the record,
  // not to a particular onion.
  function pairingForm(r){
    const current = JSON.stringify({ pairing: r.payload?.pairing, explorer: r.payload?.explorer }, null, 2);
    return `<div class="medit">
      <p class="dnote">Paste the pairing payload exactly as your Dojo produced it. The new address must be
        answering over Tor right now, or the update is refused and your current listing is left alone.
        Your listing keeps its place, its approval and its uptime history.</p>
      <label>Pairing payload (JSON) <textarea class="p-payload" rows="8">${esc(current)}</textarea></label>
      <label>Signed block (required: sign the payload above, not the one it replaces)
        <textarea class="p-signed" rows="6" placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----"></textarea></label>
      <div class="medit-actions">
        <button class="copybtn" data-mact="pairsave" data-id="${esc(r.id)}">Update pairing</button>
        <button class="copybtn" data-mact="paircancel">Cancel</button>
        <span class="edit-msg" style="font-size:12px;color:var(--down)"></span>
      </div>
    </div>`;
  }

  function manageRow(r){
    const editing = EDIT_ID === r.id;
    const pairing = PAIR_ID === r.id;
    return `<div class="box" style="padding:12px 14px;background:var(--panel2)">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="mono" style="font-size:12.5px"><b>${esc(r.name||r.id)}</b> · ${esc(r.network)} · ${esc(r.jurisdiction||"—")} · ${esc(r.hardware||"—")}</span>
        <span style="display:flex;gap:8px;align-items:center">
          <button class="copybtn" data-mact="edit" data-id="${esc(r.id)}"${EDIT_ID&&!editing?" disabled":""}>${editing?"Editing…":"Edit"}</button>
          <button class="copybtn" data-mact="pairing" data-id="${esc(r.id)}"${PAIR_ID&&!pairing?" disabled":""}>${pairing?"Updating…":"Pairing"}</button>
          ${statusPill(r.status)}
        </span>
      </div>
      ${editing?editForm(r,"mact"):""}
      ${pairing?pairingForm(r):""}
      <div class="mono" style="font-size:11px;color:var(--muted);margin-top:6px;word-break:break-all">${esc(r.payload?.pairing?.url||"")}</div>
      <button class="copybtn" data-mact="delete" data-id="${esc(r.id)}" style="margin-top:8px">Delete</button>
    </div>`;
  }
  function dojoForm(){
    return `<div class="box" style="background:var(--panel2);padding:14px">
      <div class="mform">
        <label>Network
          <select id="m-net"><option value="mainnet">mainnet</option><option value="testnet">testnet</option></select></label>
        <label>Node name (unique per network; shown on the card next to your PayNym) <input id="m-name" maxlength="40" placeholder="e.g. yellow"></label>
        <label>Where is it? (optional \u2014 name a country and your card gets a flag) <input id="m-jur" maxlength="64" placeholder="e.g. Finland, Europe, Ancapistan"></label>
        <label>Hardware <input id="m-hw" maxlength="120" placeholder="e.g. N100 16GB"></label>
        <label>Pairing code (JSON) <textarea id="m-payload" rows="6" placeholder='{"pairing":{"type":"dojo.api",...},"explorer":{...}}'></textarea></label>
        <label>Signed pairing message (required) <textarea id="m-signed" rows="5" placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----&#10;...&#10;-----END BITCOIN SIGNATURE-----"></textarea></label>
        <button class="reveal" data-mact="submit" style="margin-top:4px">Check connection &amp; submit</button>
      </div>
    </div>`;
  }

  function renderLogin(body){
    body.innerHTML = `
      <p>Sign in with your Dojo's <strong>PayNym</strong> using Auth47 to manage its listing. Scan this with <a href="https://web.archive.org/web/20240424023506/https://samouraiwallet.com/" target="_blank" rel="noopener">Samourai</a> or <a href="http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/" target="_blank" rel="noopener">Ashigaru</a> (Tools → Authenticate using PayNym), or tap to open.</p>
      <div id="auth47-box" style="text-align:center;margin:18px 0"><p class="loading">Requesting challenge…</p></div>
      <p style="font-size:12.5px;color:var(--faint)">Auth47 proves you control the payment code without revealing any key. Nothing is stored beyond your payment code and the Dojo details you submit.</p>`;
    startAuth47();
  }
  let pollTimer=null;
  let onAuthSuccess=null;
  async function startAuth47(){
    clearInterval(pollTimer);
    const boxEl = () => document.getElementById("auth47-box");
    const r = await api.call("/auth47/challenge","POST",{});
    if(r.status!==200){ if(boxEl()) boxEl().innerHTML='<p class="loading">Login unavailable.</p>'; return; }
    const {uri,nonce} = r.body;
    // The URI is shown as well as encoded because a QR is unusable when the
    // wallet is on the SAME device as the browser, which is the common case on
    // a phone: nothing can photograph its own screen. Selecting monospace text
    // that wraps mid-token by hand is miserable there, so the challenge gets a
    // copy button like every other opaque string in this interface.
    if(boxEl()) boxEl().innerHTML =
      `<a href="${esc(uri)}"><div class="tile" style="display:inline-block;background:#fff;border-radius:10px;padding:12px">${qrSVG(uri,200)}</div></a>
       <div class="a47-uri">
         <code class="mono">${esc(uri)}</code>
         <button class="copybtn" data-act="copyurl" data-v="${esc(uri)}">copy challenge</button>
       </div>`;
    pollTimer = setInterval(async ()=>{
      // Also one attempt: this is already a poll on its own timer, so a retry
      // inside it would stack requests on top of each other during a restart.
      const p = await api.call("/auth47/poll?nonce="+encodeURIComponent(nonce), "GET", undefined, {tries:1});
      if(p.status===200 && p.body && p.body.authenticated){ clearInterval(pollTimer); await refreshMe(); (onAuthSuccess||renderManage)(); }
    }, 2500);
  }

  document.addEventListener("click", async e=>{
    const manageBtn = evEl(e)?.closest('[data-act="manage"]');
    if(manageBtn){ if(menuOpen){menuOpen=false;render();} openManage(); return; }
    const m = evEl(e)?.closest("[data-mact]");
    if(!m) return;
    const act = m.getAttribute("data-mact");
    const msg = document.getElementById("manage-msg");
    if(act==="logout"){ await api.call("/logout","POST",{}); clearInterval(pollTimer); await refreshMe(); ME={authenticated:false}; EDIT_ID=null; PAIR_ID=null; DOMAIN=null; DOMAIN_PREP=null; renderManage(); return; }

    // ---- verified domain ----
    if(act==="domprep"){
      const v=/** @type {HTMLInputElement} */ (document.querySelector(".d-domain") || {}).value||"";
      DOMAIN_MSG=""; const r=await api.call("/domain/prepare","POST",{domain:v});
      if(r.status!==200){ DOMAIN_MSG=(r.body&&r.body.error)||("HTTP "+r.status); }
      else DOMAIN_PREP=r.body;
      renderManage(); return;
    }
    if(act==="domrecheck"){
      const claim=DOMAIN&&DOMAIN.claim; if(!claim) return;
      /** @type {HTMLButtonElement} */ (m).disabled=true; m.textContent="Checking DNS…";
      const r=await api.call("/domain/recheck","POST",{});
      DOMAIN_MSG = r.status===200 ? "Verified."
        : ((r.body&&(r.body.error||r.body.note))||("HTTP "+r.status));
      await refreshDomain(); renderManage(); return;
    }
    if(act==="domcancel"){ DOMAIN_PREP=null; DOMAIN_MSG=""; renderManage(); return; }
    if(act==="domchange"){ DOMAIN_PREP=null; DOMAIN_MSG=""; DOMAIN={claim:null}; renderManage(); return; }
    if(act==="domremove"){
      await api.call("/domain","DELETE",{}); DOMAIN_PREP=null; DOMAIN_MSG="Removed.";
      await refreshDomain(); await refreshMe(); renderManage(); return;
    }
    if(act==="domverify"){
      const ta=document.querySelector(".d-signed");
      /** @type {HTMLButtonElement} */ (m).disabled=true; m.textContent="Checking DNS…"; DOMAIN_MSG="";
      const r=await api.call("/domain","POST",{domain:DOMAIN_PREP.domain,signed:(ta&&/** @type {HTMLTextAreaElement} */ (ta).value)||""});
      if(r.status===200){ DOMAIN_PREP=null; DOMAIN_MSG="Verified."; await refreshDomain(); }
      else if(r.status===202){ DOMAIN_PREP=null; DOMAIN_MSG=(r.body&&r.body.note)||"Saved; waiting for DNS."; await refreshDomain(); }
      else {
        // 503 means we could not reach enough resolvers: not the operator's fault.
        DOMAIN_MSG=((r.body&&r.body.error)||("HTTP "+r.status))
          + (r.body&&r.body.hint?"  "+r.body.hint:"")
          + (r.status===503?"  This is a lookup problem at our end, not a problem with your record. Try again shortly.":"");
      }
      renderManage(); return;
    }
    if(act==="delete"){ await api.call("/dojo/delete","POST",{id:m.getAttribute("data-id")}); await refreshMe(); EDIT_ID=null; renderManage(); return; }
    if(act==="edit"){ EDIT_ID=m.getAttribute("data-id"); renderManage(); return; }
    if(act==="editcancel"){ EDIT_ID=null; renderManage(); return; }
    if(act==="pairing"){ PAIR_ID=m.getAttribute("data-id"); EDIT_ID=null; renderManage(); return; }
    if(act==="paircancel"){ PAIR_ID=null; renderManage(); return; }
    if(act==="pairsave"){
      const box=m.closest(".medit");
      const msgEl=box.querySelector(".edit-msg");
      let payload;
      try{ payload=JSON.parse(/** @type {HTMLTextAreaElement} */ (box.querySelector(".p-payload")).value); }
      catch(err){ if(msgEl) msgEl.textContent="That is not valid JSON."; return; }
      /** @type {HTMLButtonElement} */ (m).disabled=true; m.textContent="Checking the node…";
      const r=await api.call("/dojo/pairing","POST",{
        id:m.getAttribute("data-id"),
        payload,
        signed:/** @type {HTMLTextAreaElement} */ (box.querySelector(".p-signed")).value,
      });
      if(r.status!==200){
        if(msgEl) msgEl.textContent=(r.body&&r.body.error)||("HTTP "+r.status);
        /** @type {HTMLButtonElement} */ (m).disabled=false; m.textContent="Update pairing";
        return;
      }
      PAIR_ID=null; await refreshMe(); renderManage(); return;
    }
    if(act==="editsave"){
      const box=m.closest(".medit");
      const r=await api.call("/dojo/edit","POST",{
        id:m.getAttribute("data-id"),
        name:/** @type {HTMLInputElement} */ (box.querySelector(".e-name")).value,
        hardware:/** @type {HTMLInputElement} */ (box.querySelector(".e-hw")).value,
      });
      if(r.status!==200){ const em=box.querySelector(".edit-msg"); if(em) em.textContent=(r.body&&r.body.error)||("HTTP "+r.status); return; }
      EDIT_ID=null; await refreshMe(); renderManage(); return;
    }
    if(act==="submit"){
      let payload;
      try{ payload = JSON.parse(/** @type {HTMLInputElement} */ (document.getElementById("m-payload")).value); }
      catch(err){ if(msg) msg.innerHTML='<span style="color:var(--down)">Pairing code is not valid JSON.</span>'; return; }
      // Validate the name (required + unique across approved and pending
      // records) BEFORE the slow Tor connection gate, so a taken name fails in
      // milliseconds. The POST re-checks server-side and answers 409 anyway.
      const name = /** @type {HTMLInputElement} */ (document.getElementById("m-name")).value.trim();
      if(!name){ if(msg) msg.innerHTML='<span style="color:var(--down)">Give your node a name first.</span>'; return; }
      const nc = await api.call("/dojo/name-check?network="+encodeURIComponent(/** @type {HTMLInputElement} */ (document.getElementById("m-net")).value)+"&name="+encodeURIComponent(name));
      if(nc.status!==200 || !nc.body || !nc.body.available){
        if(msg) msg.innerHTML='<span style="color:var(--down)">'+esc((nc.body&&(nc.body.reason||nc.body.error))||"That name is not available.")+'</span>'; return;
      }
      if(msg) msg.innerHTML='<span class="loading">Checking Tor connection… this can take up to 30s.</span>';
      const r = await api.call("/dojo","POST",{
        network: /** @type {HTMLInputElement} */ (document.getElementById("m-net")).value,
        name,
        jurisdiction: /** @type {HTMLInputElement} */ (document.getElementById("m-jur")).value,
        hardware: /** @type {HTMLInputElement} */ (document.getElementById("m-hw")).value,
        payload,
        signed: /** @type {HTMLInputElement} */ (document.getElementById("m-signed")).value.trim() || null,
      });
      if(r.status===200){ if(msg) msg.innerHTML='<span style="color:var(--up)">'+esc(r.body.note||"Submitted.")+'</span>'; await refreshMe(); setTimeout(renderManage,1200); }
      else { if(msg) msg.innerHTML='<span style="color:var(--down)">'+esc((r.body&&r.body.error)||("Error "+r.status))+'</span>'; }
      return;
    }
  });

  detectBackend();


  // Build hash. render() rebuilds the whole footer, so (exactly like the
  // Manage button) the hash must live in state the template reads at render
  // time; a one-shot DOM injection vanished on the first re-render.
  let VERSION = null;
  async function loadVersion(){
    try{
      const v = await loadJSON("data/version.json");
      if(v && v.commit && v.commit !== "dev"){ VERSION = v; if(DOJOS) render(); }
    }catch(e){ /* no version file: show nothing */ }
  }

  // ================= Admin console (/admin) =================================
  // Reuses the Auth47 login flow. A session whose payment code is in the
  // backend's ADMIN_PAYMENT_CODES sees a moderation panel; others are refused.
  function adminShell(inner){
    document.getElementById("root").innerHTML = `
    <header class="no-menu"><div class="wrap">
      <a class="brand" href="./" aria-label="The Dojo Bay">${LOGO}
        <span><div class="name disp">THE DOJO BAY</div><div class="sub mono">operator console</div></span></a>
      <nav><a class="lnk" href="./">\u2190 Directory</a></nav>
    </div></header>
    <main class="wrap"><h2 class="disp" style="margin:18px 0 14px">Moderation</h2>${inner}</main>`;
  }
  let ADM_EDIT_ID = null;
  function adminRow(s){
    const editing = ADM_EDIT_ID === s.id;
    const pr=s.probe;
    const strip = (pr && pr.checks && pr.checks.length) ? relStrip(pr.checks)
      : '<p style="font-size:12px;color:var(--faint);margin:6px 0">No probe data yet (the updater runs every 10 minutes).</p>';
    // "not yet probed" was shown for every approved listing, because the panel
    // read only the pending-probe file, which stops being written once a record
    // is approved. It now prefers the published view, the same data the cards
    // use; a record with neither is genuinely awaiting its first probe.
    const height = (pr && pr.block_height!=null) ? Number(pr.block_height).toLocaleString("en-GB") : "\u2014";
    const st = pr ? pr.status : "not yet probed";
    return `<div class="admin-row" data-id="${esc(s.id)}">
      <div class="admin-head"><b>${esc(s.paynym&&s.name?s.paynym+" · "+s.name:(s.paynym||s.name||s.id))}</b> <span class="abadge ${esc(s.status)}">${esc(s.status)}</span>
        <span class="mono" style="font-size:11px;color:var(--faint)">${esc(s.network)}</span></div>
      <div class="mono" style="font-size:11px;word-break:break-all;color:var(--muted);margin:2px 0">${esc(s.pairingUrl||"")}</div>
      <div style="font-size:12px;color:var(--muted);margin:4px 0">live probe: <b>${esc(st)}</b> \u00b7 block ${height} \u00b7 ${s.signed?"signed \u2713":"no signature"} \u00b7 v${esc(s.version||"?")}${s.hardware?" \u00b7 "+esc(s.hardware):""}</div>
      ${strip}
      <div class="admin-actions">
        ${s.status!=="approved"?`<button class="abtn ok" data-adm="approve" data-id="${esc(s.id)}">Approve</button>`:""}
        ${s.status!=="rejected"?`<button class="abtn" data-adm="reject" data-id="${esc(s.id)}">Reject</button>`:""}
        <button class="abtn" data-adm="edit" data-id="${esc(s.id)}"${ADM_EDIT_ID&&!editing?" disabled":""}>${editing?"Editing…":"Edit"}</button>
        <button class="abtn danger" data-adm="remove" data-id="${esc(s.id)}">Remove</button>
      </div>
      ${editing?editForm(s,"adm"):""}</div>`;
  }
  async function renderAdminPanel(){
    if(!ME || !ME.authenticated){
      adminShell('<p style="font-size:13px;color:var(--muted)">Sign in with your operator PayNym via Auth47 (<a href="https://web.archive.org/web/20240424023506/https://samouraiwallet.com/" target="_blank" rel="noopener">Samourai</a> or <a href="http://ashigaruprvm4u263aoj6wxnipc4jrhb2avjll4nnk255jkdmj2obqqd.onion/" target="_blank" rel="noopener">Ashigaru</a> \u2192 Tools \u2192 Authenticate using PayNym).</p><div id="auth47-box" style="text-align:center;margin:18px 0"><p class="loading">Requesting challenge\u2026</p></div>');
      onAuthSuccess = renderAdminPanel; startAuth47(); return;
    }
    if(!ME.admin){
      adminShell('<p>The payment code <code>'+esc(ME.paymentCode.slice(0,12))+'\u2026</code> is not an administrator of this directory.</p><p style="margin-top:10px"><button class="abtn" data-adm="logout">Sign out</button></p>');
      return;
    }
    if(!ADMIN_UPDATES && !ADMIN_UPDATES_LOADING){
      ADMIN_UPDATES_LOADING = true;
      // Both paths must clear the flag. Neither did, so it stayed true from the
      // first render onward: the re-check control was permanently disabled and
      // permanently described a check that had long finished. It went unnoticed
      // while the two labels were "Checking…" and "Check again", which are
      // similar enough to read as a button either way.
      api.call("/admin/updates")
        .then(r=>{ ADMIN_UPDATES = r.body || {available:false,error:"HTTP "+r.status}; })
        .catch(()=>{ ADMIN_UPDATES={available:false,error:"request failed"}; })
        .finally(()=>{ ADMIN_UPDATES_LOADING = false; renderAdminPanel(); });
      // The outcome of the LAST update, which until now was written to disk and
      // read by nobody: the panel only polled this endpoint while an update was
      // running, so a reload discarded it. An update whose restart failed leaves
      // the new code on disk and the old process serving it, which looks exactly
      // like an update that did nothing, and the note explaining it sat in a
      // file the operator had no reason to open.
      api.call("/admin/update/status").then(r=>{ ADMIN_LAST = (r.body||{}).lastResult||null; renderAdminPanel(); }).catch(()=>{});
    }
    adminShell('<p class="loading">Loading submissions\u2026</p>');
    const r = await api.call("/admin/submissions");
    if(r.status===401){ ME={authenticated:false}; renderAdminPanel(); return; }   // signed out elsewhere (Manage panel / another tab)
    if(r.status!==200){
      // A number tells a moderator nothing. If the proxy could not reach the
      // backend at all, say what that means and what to do about it, because
      // the commonest cause is a restart this page itself set in motion.
      adminShell(r.gatewayDown
        ? '<p>The backend is not answering. If you have just updated, it is restarting: '
          + 'wait a moment and reload. If this persists, the service has stopped and needs '
          + 'starting on the box.</p>'
        : '<p>Could not load submissions ('+esc(String(r.status))+').</p>');
      return;
    }
    const subs=r.body.submissions||[];
    const pending=subs.filter(s=>s.status==="pending");
    const others=subs.filter(s=>s.status!=="pending");
    adminShell(
      '<p style="font-size:13px;color:var(--muted)">Signed in as <code>'+esc(ME.paymentCode.slice(0,12))+'\u2026'+esc(ME.paymentCode.slice(-4))+'</code> '+
      '<button class="abtn" data-adm="logout" style="margin-left:8px">Sign out</button> '+
      '<span style="font-size:12px;color:var(--faint)">(the same Auth47 session as Manage my Dojo; signing out here signs you out there too)</span></p>'+
      updatesLine()+
      importLine()+
      (ADMIN_NOTICE?'<p style="font-size:12.5px;color:var(--down);border:1px solid var(--down);border-radius:8px;padding:8px 12px">'+esc(ADMIN_NOTICE)+'</p>':"")+
      '<h3 style="margin:16px 0 8px">Pending review ('+pending.length+')</h3>'+
      (pending.length? pending.map(adminRow).join("") : '<p style="color:var(--faint)">Nothing awaiting review.</p>')+
      '<h3 style="margin:22px 0 8px">Approved / rejected ('+others.length+')</h3>'+
      (others.length? others.map(adminRow).join("") : '<p style="color:var(--faint)">None.</p>')
    );
  }
  let ADMIN_NOTICE = null;
  let ADMIN_UPDATES = null, ADMIN_UPDATES_LOADING = false, ADMIN_LAST = null;
  // The import job, polled the same way an update is. Declared here, above the
  // functions that read it, because a const or let below its first reader has
  // failed outright in this codebase before.
  let IMPORT_RUN = null;   // {phase, log[], done, ok, error, apply, onion, result}
  let IMPORT_POLL = null;
  // The onion and code of the plan being looked at, so applying does not ask
  // for them again. Held only here: the payment code is public, but which
  // instance this operator is pairing with is not written anywhere.
  let IMPORT_LAST = null;
  let UPDATE_RUN = null;   // {phase, log[], done, ok, error, needsRefresh}
  let UPDATE_POLL = null;
  const UPDATE_PHASES = ["starting","fetching","applying","restarting"];
  function updatesLine(){
    if(UPDATE_RUN) return updateProgress();
    if(!ADMIN_UPDATES) return ADMIN_UPDATES_LOADING ? '<p style="font-size:12px;color:var(--faint)">Checking for updates…</p>' : "";
    const u = ADMIN_UPDATES;
    // A failed check hides what GitHub would have told us. It must not hide the
    // peer update, which never touches GitHub and is the one route still open
    // when GitHub is the thing that is unavailable. This used to return here,
    // so an operator whose exit had been rate-limited was left with no controls
    // at all and no way to update from another instance.
    if(!u.available) return '<p style="font-size:12px;color:var(--faint)">Update check unavailable: '
      + esc(u.error||"unknown") + '</p>'
      + '<div style="margin:10px 0 4px">'
      + '<button class="abtn" data-adm="update-peer">Update from a peer .onion…</button> '
      + '<button class="abtn" data-adm="update-recheck"' + (ADMIN_UPDATES_LOADING ? ' disabled' : '') + '>'
      + (ADMIN_UPDATES_LOADING ? 'Checking GitHub…' : 'Check GitHub') + '</button></div>'
      + '<p style="font-size:12px;color:var(--faint)">A peer update fetches from another Dojo Bay over Tor '
      + 'and verifies that instance\u2019s operator signature, so it works whatever GitHub is doing.</p>';
    const behind = u.commits_behind>0
      ? '<b style="color:var(--warn,#e0a020)">'+u.commits_behind+' commit'+(u.commits_behind===1?"":"s")+' behind main</b>'
      : 'up to date with main';
    // current_release is set when the running commit IS a released tag, so we can
    // say which release this is rather than guessing from timestamps. When it is
    // not set the count is a timestamp approximation, and says so.
    // releases_behind is null when the tag lookup itself failed. Saying nothing
    // is better than a number that is systematically wrong for the commonest
    // case, an instance running the newest release.
    const rel = !u.latest_release ? ""
      : u.releases_behind === null
        ? ' · latest release '+esc(u.latest_release)+' (could not confirm which release this build is'
          +(u.releases_note?': '+esc(u.releases_note):"")+')'
      : u.releases_behind>0
        ? ' · <b>'+u.releases_behind+' release'+(u.releases_behind===1?"":"s")+' behind</b>'
          +(u.releases_behind_approx?' (approximate; latest ':' (latest ')+esc(u.latest_release)+')'
      : u.current_release
        ? ' · running release <b>'+esc(u.current_release)+'</b>'
        : ' · latest release '+esc(u.latest_release);
    const behindAny = u.commits_behind>0 || (u.releases_behind||0)>0;
    // Disabled when there is nothing to fetch. Reinstalling the code you are
    // already running is not a useful thing to offer as the primary green
    // button, and on a path this consequential an idle click that restarts the
    // service for no gain is a real cost. The peer button stays live, because
    // pulling from a peer is a different question from being behind GitHub: a
    // federated instance may want another operator's build at the same commit.
    const controls = '<div class="upd-controls">'
      + '<button class="abtn ok" data-adm="update-github"' + (behindAny ? '' : ' disabled')
        + ' title="' + (behindAny ? 'Fetch and apply the newer code from GitHub'
            : 'Already on the latest commit; nothing to fetch') + '">Update from GitHub</button>'
      + '<button class="abtn" data-adm="update-peer">Update from a peer .onion…</button>'
      // The answer is cached for six hours, which is right for an unattended
      // check over Tor and wrong for an operator who has just pushed while
      // already signed in. Signing in discards the cache, so this is for the
      // case that does not involve signing in again.
      + '<button class="abtn" data-adm="update-recheck"' + (ADMIN_UPDATES_LOADING ? ' disabled' : '')
        + ' title="Ask GitHub again rather than answering from the cached check">'
        + (ADMIN_UPDATES_LOADING ? 'Checking GitHub…' : 'Check GitHub') + '</button>'
      + '</div>';
    // How old the answer is, in the operator's terms rather than a timestamp
    // they have to subtract from now. Shown always, because "up to date" means
    // nothing without it: the panel would say the same thing six hours after
    // the state stopped being true.
    const age = (() => {
      const t = Date.parse(u.checked_at || "");
      if (!isFinite(t)) return "";
      const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
      const when = mins < 1 ? "just now" : mins < 60 ? mins + " min ago"
        : Math.round(mins / 60) + (Math.round(mins / 60) === 1 ? " hour ago" : " hours ago");
      return '<p style="font-size:12px;color:var(--faint)">Checked ' + when
        + (u.refresh_wait_s
            ? '. GitHub was asked less than a minute ago, so this is the same answer; try again in '
              + u.refresh_wait_s + 's.'
            : '')
        + '</p>';
    })();
    // Marked experimental in the panel itself rather than only in the docs,
    // because the person about to click is not reading the docs. This stays
    // until a self-update has completed on real hardware; when it goes, the
    // note in README goes with it.
    // Surfaced whenever the last attempt did not finish cleanly, and only then:
    // a banner after every successful update would be noise, and noise is what
    // this one needs to stand out from.
    const stale = ADMIN_LAST && (ADMIN_LAST.ok === false || ADMIN_LAST.restarting === false)
      ? '<p class="upd-warn"><b>The last update did not finish.</b> '
        + esc(ADMIN_LAST.error || ADMIN_LAST.note || "no reason recorded")
        + ' Until the service restarts, this page is being served by the old code, '
        + 'so it will keep reporting whatever it knew before the update.</p>'
      : "";
    // Said before the click, not after the failure. Without the privilege an
    // update applies and then stops on its last line, leaving new code on disk
    // and the old process serving it, which is indistinguishable from nothing
    // having happened.
    // Three answers, and "unknown" is not "yes". The remedy is a polkit rule
    // because nothing calls sudo: apply-update.mjs runs systemctl directly, so
    // a sudoers line, which this used to print, grants a privilege on a path no
    // code takes.
    const svc = esc(u.serviceUser || "<your service user>");
    // Nothing is claimed about the restart permission. The instance cannot
    // find out: polkit refuses a details-bearing authorisation query from any
    // caller that is not uid 0, and the rules directory is not readable by the
    // service account. Two versions of this warning have now been wrong, one
    // saying yes when it had asked nobody and one saying unknown on a machine
    // where the rule was installed and working, and a warning that is wrong in
    // both directions is worse than no warning.
    //
    // The evidence-based version of this already exists a few lines up: an
    // update that installed and did not restart is recorded in lastResult and
    // reported, and that is precisely what a missing permission looks like.
    const note = '<p class="upd-exp-note">This fetches over Tor, verifies what it fetched, keeps a full copy '
      + 'of the current code under <code>data/backups/</code>, and restarts the service. If the restart does '
      + 'not come back you will need shell access to the box to recover, so do not run it where you cannot '
      + 'reach a terminal. Updating by deploy or by hand remains the supported path.</p>';
    return '<div class="upd-line"><p style="font-size:12px;color:var(--muted)">Codebase <code>'+esc(u.commit)+'</code> — '+behind+rel
      + '<span class="upd-exp" title="Replaces running code in place: recoverable, but only from a terminal">experimental</span></p>'
      + stale
      + controls
      + age
      + (behindAny ? '' : '<p class="upd-none">Up to date. There is nothing to fetch from GitHub.</p>')
      + note
      + '</div>';
  }
  function updateProgress(){
    const j = UPDATE_RUN;
    const idx = Math.max(0, UPDATE_PHASES.indexOf(j.phase));
    const pct = j.done ? 100 : Math.round(((idx+0.5)/UPDATE_PHASES.length)*100);
    const barColor = j.error ? 'var(--down)' : (j.done? 'var(--up)' : 'var(--accent)');
    const tail = (j.log||[]).slice(-6).map(l=>esc(l)).join('<br>');
    let head;
    if(j.error) head = '<b style="color:var(--down)">Update failed:</b> '+esc(j.error);
    else if(j.done && j.needsRefresh) head = '<b style="color:var(--up)">Update applied.</b> Waiting for the service to come back, then reloading…';
    else head = '<b>Updating from '+esc(j.sourceLabel||j.source||"source")+'…</b> '+esc(j.phase);
    return '<div class="upd-line">'
      + '<p style="font-size:12.5px">'+head+'</p>'
      + '<div class="upd-bar"><div class="upd-bar-fill" style="width:'+pct+'%;background:'+barColor+'"></div></div>'
      + '<pre class="upd-log">'+tail+'</pre>'
      + (j.error? '<button class="abtn" data-adm="update-dismiss">Dismiss</button>':'')
      + '</div>';
  }
  // Importing listings from another Dojo Bay.
  //
  // Two steps, always. The premise of importing from another directory is that
  // you do not trust it, so the operator sees the plan before anything is
  // written: what would be imported, what this instance already lists under a
  // different id, and what is refused and why. Apply only appears once a plan
  // has come back, so the button that writes cannot be the first one clicked.
  function importLine(){
    const j = IMPORT_RUN;
    if(!j){
      return '<div style="margin:14px 0 4px">'
        + '<button class="abtn" data-adm="import-plan">Import Dojos from another Dojo Bay\u2026</button>'
        + '<p style="font-size:12px;color:var(--faint);margin:6px 0 0">'
        + 'Fetches another instance\u2019s published list over Tor and shows what it would add. '
        + 'Nothing is written until you say so, every listing\u2019s own signature is checked here, '
        + 'and anything imported arrives in Pending review rather than on the site.</p></div>';
    }
    const res = j.result || null;
    const rows = (res && res.plan) || [];
    const counts = res
      ? [res.planned + ' to import', res.merged + ' already listed here', res.refused + ' refused']
      : [];
    // The refused rows are the ones worth reading, so they are not collapsed
    // away: a directory publishing listings this instance will not accept is
    // something an operator should see rather than a number.
    const table = rows.length
      ? '<table class="imp"><thead><tr><th>Node</th><th>Network</th><th>Pairing</th><th></th></tr></thead><tbody>'
        + rows.map(r => '<tr class="imp-' + esc(r.action) + '"><td>' + esc(r.name)
            + (r.paynym ? ' <span style="color:var(--faint)">' + esc(r.paynym) + '</span>' : '')
            + '</td><td>' + esc(r.network || "") + '</td><td><code style="font-size:11px">'
            + esc(String(r.url || "").replace(/^https?:\/\//, "").slice(0, 22)) + '\u2026</code></td><td>'
            + (r.action === "import" ? 'import'
               : r.action === "merge" ? 'already listed as ' + esc(r.dupOf || "")
               : 'refused: ' + esc(r.why || "")) + '</td></tr>').join("")
        + '</tbody></table>'
      : "";
    const apply = (j.done && j.ok && !j.apply && res && res.planned > 0)
      ? '<button class="abtn" data-adm="import-apply">Import ' + res.planned + ' listing'
        + (res.planned === 1 ? '' : 's') + ' as pending</button> '
      : "";
    // The phase, while it is running. Importing is quick and the probe cycle
    // afterwards takes about a minute, so a panel that said only "Importing…"
    // for that minute would look stuck at the point it is doing the slowest
    // and least obvious part of the work.
    const phase = j.done ? "" : ({ planning: "reading their list",
      importing: "importing", rebuilding: "rebuilding the public list",
      probing: "probing the imported nodes over Tor, about a minute" }[j.phase] || j.phase || "");
    return '<div class="upd-run"><p><b>' + (j.apply ? 'Importing from ' : 'Planning an import from ')
      + '</b><code style="font-size:11px">' + esc(j.onion || "") + '</code>'
      + (j.done ? "" : ' \u2026 ' + esc(phase)) + '</p>'
      + (j.error ? '<p class="upd-warn">' + esc(j.error) + '</p>' : "")
      + (counts.length ? '<p style="font-size:12px;color:var(--muted)">' + counts.join(' \u00b7 ') + '</p>' : "")
      + table
      + (j.done && j.apply && j.ok
          ? '<p style="font-size:12px;color:var(--up)">Imported. They are in Pending review below, '
            + 'unpublished until you approve them.</p>' : "")
      + '<p style="margin-top:8px">' + apply
      + '<button class="abtn" data-adm="import-dismiss">' + (j.done ? 'Close' : 'Hide') + '</button></p></div>';
  }

  async function startImport(onion, code, apply){
    IMPORT_RUN = { phase:"starting", log:[], done:false, ok:false, apply, onion, result:null,
      error:null };
    renderAdminPanel();
    const r = await api.call("/admin/import","POST",{ onion, code, apply });
    if(r.status===409){ IMPORT_RUN=null; ADMIN_NOTICE="An import is already in progress."; renderAdminPanel(); return; }
    if(r.status!==202){ IMPORT_RUN.error=(r.body&&r.body.error)||("HTTP "+r.status); IMPORT_RUN.done=true; renderAdminPanel(); return; }
    // The onion and code are kept only in this closure, for the apply step, so
    // that applying does not ask for them a second time. They are not written
    // anywhere: the payment code is public, but the pairing is between this
    // operator and that instance and does not belong in storage.
    IMPORT_LAST = { onion, code };
    pollImport();
  }
  function pollImport(){
    clearInterval(IMPORT_POLL);
    IMPORT_POLL = setInterval(async ()=>{
      let r; try{ r = await api.call("/admin/import/status"); } catch(e){ return; }
      if(r.status!==200 || !r.body || !r.body.job) return;
      IMPORT_RUN = r.body.job;
      if(IMPORT_RUN.done){ clearInterval(IMPORT_POLL); IMPORT_POLL=null; }
      renderAdminPanel();
    }, 1200);
  }

  async function startUpdate(source, extra){
    UPDATE_RUN = /** @type {{ phase: string, log: string[], done: boolean, source: any, error?: string }} */
      ({ phase:"starting", log:["requesting update…"], done:false, source });
    renderAdminPanel();
    const r = await api.call("/admin/update","POST",{ source, ...(extra||{}) });
    if(r.status===409){ UPDATE_RUN=null; ADMIN_NOTICE="An update is already in progress."; renderAdminPanel(); return; }
    if(r.status!==202){ UPDATE_RUN.error=(r.body&&r.body.error)||("HTTP "+r.status); UPDATE_RUN.done=true; renderAdminPanel(); return; }
    pollUpdate();
  }
  function pollUpdate(){
    clearInterval(UPDATE_POLL);
    let restartWaits = 0;
    UPDATE_POLL = setInterval(async ()=>{
      let r;
      try{ r = await api.call("/admin/update/status"); }
      catch(e){ r = null; }
      // Once the service restarts, /api calls fail transiently; treat a run
      // that reached needsRefresh as success and hard-reload when it returns.
      if(UPDATE_RUN && UPDATE_RUN.needsRefresh){
        if(!r || r.status!==200){ restartWaits++; return; }   // backend still down
        // backend answered again -> new code is live -> hard reload
        clearInterval(UPDATE_POLL);
        location.reload();
        return;
      }
      if(!r || r.status!==200) return;
      const j = r.body && r.body.job;
      if(j){ UPDATE_RUN = { ...UPDATE_RUN, ...j }; renderAdminPanel(); }
      if(j && j.done){
        if(j.ok && j.needsRefresh){
          UPDATE_RUN.needsRefresh = true;   // next successful poll after restart triggers reload
        } else {
          clearInterval(UPDATE_POLL);
        }
      }
    }, 1200);
  }
  document.addEventListener("click", async e=>{
    const b=evEl(e)?.closest("[data-adm]"); if(!b) return;
    const act=b.getAttribute("data-adm"), id=b.getAttribute("data-id");
    if(act==="logout"){ await api.call("/logout","POST",{}); ME={authenticated:false}; ADM_EDIT_ID=null; renderAdminPanel(); return; }
    if(act==="update-github"){
      // The button is disabled when there is nothing to fetch, but a disabled
      // attribute is a hint to a person rather than a guarantee: check the state
      // that matters rather than trusting the markup.
      if(!(ADMIN_UPDATES && (ADMIN_UPDATES.commits_behind>0 || (ADMIN_UPDATES.releases_behind||0)>0))){
        alert("This instance is already on the latest commit. There is nothing to fetch."); return;
      }
      if(confirm("Update this instance from GitHub over Tor?\n\nSELF-UPDATE IS EXPERIMENTAL. The service will restart; if it does not come back you will need shell access to the box. A full copy of the current code is kept under data/backups/.")) startUpdate("github"); return; }
    if(act==="import-plan"){
      const onion=prompt("The .onion of the Dojo Bay to import from:"); if(!onion) return;
      const code=prompt("That instance operator's BIP47 payment code (verifies whose list this is):")||"";
      startImport(String(onion).replace(/^https?:\/\//,"").replace(/\/.*$/,""), code, false);
      return;
    }
    if(act==="import-apply"){
      // The plan on screen was produced from these details, so applying re-uses
      // them rather than asking again: retyping an onion between seeing a plan
      // and accepting it is a chance to accept a plan from somewhere else.
      if(!IMPORT_LAST) return;
      const n = (IMPORT_RUN && IMPORT_RUN.result && IMPORT_RUN.result.planned) || 0;
      if(!confirm("Import "+n+" listing"+(n===1?"":"s")+" from "+IMPORT_LAST.onion+"?\n\nThey arrive as Pending review and are not published until you approve them. Their signatures have already been verified here.")) return;
      startImport(IMPORT_LAST.onion, IMPORT_LAST.code, true);
      return;
    }
    if(act==="import-dismiss"){ clearInterval(IMPORT_POLL); IMPORT_POLL=null; IMPORT_RUN=null; renderAdminPanel(); return; }
    if(act==="update-peer"){
      const onion=prompt("Trusted peer .onion to update from:"); if(!onion) return;
      const code=prompt("That operator's BIP47 payment code (verifies who you're trusting):")||"";
      if(confirm("Update this instance from "+onion+" over Tor?\n\nSELF-UPDATE IS EXPERIMENTAL. You are also trusting that peer's copy of the code. The service will restart; if it does not come back you will need shell access to the box.")) startUpdate("peer",{onion,code});
      return;
    }
    if(act==="update-dismiss"){ UPDATE_RUN=null; clearInterval(UPDATE_POLL); ADMIN_UPDATES=null; renderAdminPanel(); return; }
    if(act==="update-recheck"){
      // Keep the current answer on screen while the new one is fetched. Clearing
      // it first would replace a panel that says something with one that says
      // nothing, and over Tor that gap is seconds rather than instant.
      if(ADMIN_UPDATES_LOADING) return;
      ADMIN_UPDATES_LOADING = true; renderAdminPanel();
      const r = await api.call("/admin/updates?refresh=1");
      ADMIN_UPDATES = r.body || {available:false,error:"HTTP "+r.status};
      ADMIN_UPDATES_LOADING = false; renderAdminPanel();
      return;
    }
    if(act==="edit"){ ADM_EDIT_ID=b.getAttribute("data-id"); renderAdminPanel(); return; }
    if(act==="editcancel"){ ADM_EDIT_ID=null; renderAdminPanel(); return; }
    if(act==="editsave"){
      const box=b.closest(".medit");
      const r=await api.call("/admin/edit","POST",{
        id:b.getAttribute("data-id"),
        name:/** @type {HTMLInputElement} */ (box.querySelector(".e-name")).value,
        hardware:/** @type {HTMLInputElement} */ (box.querySelector(".e-hw")).value,
      });
      if(r.status!==200){ const em=box.querySelector(".edit-msg"); if(em) em.textContent=(r.body&&r.body.error)||("HTTP "+r.status); return; }
      ADM_EDIT_ID=null; renderAdminPanel(); return;
    }
    if(act==="remove" && !confirm("Remove this submission permanently?")) return;
    /** @type {HTMLButtonElement} */ (b).disabled=true; const o=b.textContent; b.textContent="\u2026";
    let r=null;
    if(act==="approve") r=await api.call("/admin/approve","POST",{id});
    else if(act==="reject") r=await api.call("/admin/reject","POST",{id});
    else if(act==="remove") r=await api.call("/admin/remove","POST",{id});
    // The moderation change and the publish (rebuild of data/dojos.json) are
    // two steps; report a failure of either, rather than silently showing a
    // node as approved that never reached the public list.
    ADMIN_NOTICE = null;
    if(r && r.status!==200) ADMIN_NOTICE = act+" failed: "+((r.body&&r.body.error)||("HTTP "+r.status));
    else if(r && r.body && r.body.rebuild && r.body.rebuild.error) ADMIN_NOTICE = act+" saved, but publishing failed: "+r.body.rebuild.error;
    await refreshMe(); renderAdminPanel();
  });

  const IS_ADMIN_PAGE = location.pathname.replace(/\/+$/,"") === "/admin";

  // Keep the open page current.
  //
  // The staleness banner reads DOJOS.generated_at, which is when the INSTANCE
  // last rebuilt the file. A tab left open all day would therefore raise it even
  // on a perfectly healthy directory, because the page's copy had aged while the
  // server's had not. So the page refetches on the same cadence the instance
  // publishes, and the banner then means what it says: the directory itself has
  // stopped refreshing.
  //
  // Three restraints, because every request here is a Tor round trip:
  //   - only while the tab is actually visible; a backgrounded tab polls nothing
  //   - an immediate refetch when a hidden tab is brought back, rather than
  //     waiting out the remainder of an interval with stale data on screen
  //   - never re-render underneath an open dialog; the data is taken, and the
  //     redraw waits until the dialog is closed.
  let REFRESH_TIMER = null, PENDING_RENDER = false;

  function modalOpen(){
    const ov = document.getElementById("ov");
    return !!(ov && ov.classList.contains("show"));
  }

  async function refreshData(){
    // Never on /admin. render() paints the directory into #root, so refreshing
    // there replaced the admin panel with the main page — which looked like the
    // console spontaneously redirecting.
    if(IS_ADMIN_PAGE) return;
    if(document.visibilityState !== "visible") return;
    try{
      const [d,h] = await Promise.all([loadJSON("data/dojos.json"), loadJSON("data/history.json")]);
      if(!d || !Array.isArray(d.nodes)) return;               // ignore a malformed reply
      DOJOS = d; HIST = h || HIST;
      HIST90 = null; DAILY = {nodes:{}};                      // let the 90-day strips reload lazily
      if(modalOpen()){ PENDING_RENDER = true; return; }
      render();
    }catch(e){ /* a failed poll keeps the last good data; staleness will show if it persists */ }
  }

  function scheduleRefresh(){
    if(REFRESH_TIMER) clearInterval(REFRESH_TIMER);
    const mins = Number(DOJOS && DOJOS.interval_minutes) > 0 ? Number(DOJOS.interval_minutes) : 10;
    REFRESH_TIMER = setInterval(refreshData, Math.max(60, mins*60) * 1000);
  }

  document.addEventListener("visibilitychange", ()=>{
    if(!IS_ADMIN_PAGE && document.visibilityState === "visible") refreshData();
  });

  (async function(){
    if(IS_ADMIN_PAGE){ document.title="Admin \u2014 The Dojo Bay"; await refreshMe(); renderAdminPanel(); return; }
    try{
      [DOJOS,HIST]=await Promise.all([loadJSON("data/dojos.json"),loadJSON("data/history.json"),loadHist90()]);
      render();
      scheduleRefresh();
      loadVersion();
      loadOperator();
    }catch(e){ showLoadError(e); }
  })();
})();
