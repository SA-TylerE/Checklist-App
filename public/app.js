// \u2500\u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const SESSION_ID='sess-'+Math.random().toString(36).slice(2);
let config=null,clients={},guides={},stepsData={},activeClientId=null;
let syncroCustomer=null,syncroDeviceType='Workstation',syncroAgentUrl=null;
let addDeviceTargetClient=null;
let activeRefPhaseId=null;
let activeChecklistTab='org';
let sseSource=null;
let appSettings={
  staleDays:30,
  dueDays:3,
  defaultDueOffset:90,
  urlTemplates:{
    Workstation:'https://rmm.syncromsp.com/dl/rs/',
    Server:'https://rmm.syncromsp.com/dl/rs/',
    Mac:'https://production.kabutoservices.com/desktop/macos/setup?token=',
    Linux:'https://systemalternatives.syncromsp.com/download_linux_agent_installers?token='
  }
};
let currentTheme=localStorage.getItem('theme')||'system';
const isMobile=()=>window.innerWidth<=900;
const unseenChanges=new Map();
const unseenToastTimers=new Map();
const notifyStore=new Map();          // notifyId -> {techName,ts} — single source of truth
const qrCache=new Map();              // url -> img element src (avoid re-fetching)
// Two-phase notification: changes accumulate here from SSE events, then transfer into notifyStore when the client is opened.
const pendingClientChanges=new Map(); // clientId -> {changes:Array, techName:string}

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme){
  currentTheme=theme;
  localStorage.setItem('theme',theme);
  const dark=theme==='dark'||(theme==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches);
  document.body.classList.toggle('light',!dark);
  ['light','system','dark'].forEach(t=>{
    const btn=document.getElementById('theme-'+t);
    if(btn) btn.classList.toggle('active',t===theme);
  });
}
window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{
  if(currentTheme==='system') applyTheme('system');
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg,type='success',duration=2800){
  const prefix={error:'✗ ',warn:'⚠ ',info:'ℹ ',success:'✓ '}[type]||'';
  showRichToast({body:prefix+msg,type,duration,simple:true});
}
function showRichToastFull({title,body,footer,type='info',duration=5000,clientId=null}){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className='toast '+type+(clientId?' toast-clickable':'');
  t.innerHTML=`<div class="toast-title">${title}<button class="toast-close" onclick="event.stopPropagation();this.closest('.toast').classList.add('removing');setTimeout(()=>this.closest('.toast')?.remove(),350)">×</button></div><div class="toast-body">${body}</div><div class="toast-footer">${footer}</div>`;
  if(clientId) t.addEventListener('click',()=>{
    t.classList.add('removing');setTimeout(()=>t.remove(),350);
    if(clients[clientId]) selectClient(clientId);
  });
  c.appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('show')));
  t._expTimer=setTimeout(()=>{t.classList.add('removing');setTimeout(()=>t.remove(),350);},duration);
  return t;
}
function showRichToast({title,body,type='info',duration=4500,simple=false}){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className='toast '+(simple?'simple ':'')+type;
  if(title&&!simple){
    t.innerHTML=`<div class="toast-title">${title}</div><div class="toast-body">${body||''}</div>`;
  }else{
    t.innerHTML=`<div class="toast-body">${body||''}</div>`;
  }
  c.appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>t.classList.add('show')));
  t._expTimer=setTimeout(()=>{t.classList.add('removing');setTimeout(()=>t.remove(),350);},duration);
  return t;
}

async function logAction(action,details={}){
  const myName=localStorage.getItem('myName')||'';
  const clientId=details.clientId||activeClientId||null;
  const client=clientId?clients[clientId]:null;
  try{
    await fetch('/api/logs',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ts:new Date().toISOString(),tech:myName,action,clientId,clientName:client?.name||null,...details})
    });
  }catch(_){}
}

function clearAllUpdateDots(){
  notifyStore.clear();
  if(activeClientId) pendingClientChanges.delete(activeClientId);
  renderAllDots();
}

async function showClientLog(clientId){
  const modal=document.getElementById('log-modal');
  const client=clients[clientId];
  document.getElementById('log-modal-title').textContent=(client?.name||'')+'  — Activity Log';
  document.getElementById('log-modal-body').innerHTML='<div style="color:var(--text3);font-size:11px;">Loading…</div>';
  modal.style.display='flex';
  try{
    const r=await fetch(`/api/logs?clientId=${clientId}&limit=200`);
    const logs=await r.json();
    renderLogTimeline(document.getElementById('log-modal-body'),logs);
  }catch(e){document.getElementById('log-modal-body').innerHTML=`<div style="color:#fca5a5;font-size:11px;">Failed to load logs: ${e.message}</div>`;}
}
function closeLogModal(){document.getElementById('log-modal').style.display='none';}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('log-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeLogModal();});
});

function actionLabel(action){
  const map={
    checklist_created:'Created checklist',checklist_deleted:'Deleted checklist',checklist_edited:'Edited checklist',
    step_complete:'Completed step',step_incomplete:'Unchecked step',substep_complete:'Completed substep',substep_incomplete:'Unchecked substep',
    device_step_complete:'Completed device step',device_step_incomplete:'Unchecked device step',
    device_added:'Added device',device_removed:'Removed device',notes_updated:'Updated notes',
    customer_linked:'Linked Syncro customer',customer_unlinked:'Unlinked Syncro customer',
    step_note:'Step note updated',
    procedures_saved:'Saved procedures',guides_saved:'Saved guides',
    config_saved:'Saved configuration',products_saved:'Saved products',
    quote_created:'Created quote',quote_edited:'Edited quote',quote_deleted:'Deleted quote',
    line_enabled:'Enabled line item',line_disabled:'Disabled line item',
    custom_item_added:'Added custom item',custom_item_removed:'Removed custom item',
    bk_client_added:'Added backup client',bk_client_removed:'Removed backup client',
    bk_client_updated:'Updated backup client',bk_fetch_error:'Backup fetch error',
  };
  return map[action]||action;
}
function relTime(ts){
  const d=new Date(ts),now=Date.now(),diff=now-d.getTime();
  if(diff<60000)return 'just now';
  if(diff<3600000)return Math.floor(diff/60000)+'m ago';
  if(diff<86400000)return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString([],{month:'short',day:'numeric'})+'  '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function logDotColor(action){
  if(['checklist_created','device_added','customer_linked','quote_created','line_enabled','custom_item_added'].includes(action)) return 'var(--success)';
  if(['checklist_deleted','device_removed','customer_unlinked','quote_deleted','custom_item_removed','bk_client_removed','bk_fetch_error'].includes(action)) return 'var(--danger)';
  if(['checklist_edited','notes_updated','step_note','quote_edited','line_disabled'].includes(action)) return 'var(--warn)';
  if(['procedures_saved','guides_saved','config_saved','products_saved'].includes(action)) return 'var(--text2)';
  return 'var(--accent)';
}
function renderLogTimeline(container,logs){
  if(!logs.length){container.innerHTML='<div style="color:var(--text3);font-size:11px;padding:8px 0;">No activity recorded yet.</div>';return;}
  container.innerHTML=`<div class="log-timeline">${logs.map(l=>`
    <div class="log-entry">
      <div class="log-time">${relTime(l.ts)}</div>
      <div class="log-dot-col"><div class="log-dot-mark" style="background:${logDotColor(l.action)}"></div><div class="log-dot-line"></div></div>
      <div class="log-content">
        <span class="log-tech">${escHtml(l.tech||'Unknown')}</span>
        <span class="log-action-text"> — ${actionLabel(l.action)}</span>
        ${l.stepTitle?`<div style="font-size:10px;color:var(--text2);margin-top:1px;">"${escHtml(l.stepTitle)}"${l.phase?' · '+escHtml(l.phase):''}</div>`:''}
        ${(!l.stepTitle&&l.details)?`<div style="font-size:10px;color:var(--text2);margin-top:1px;">${escHtml(l.details)}</div>`:''}
        ${l.clientName&&!l.clientId_is_context?`<div class="log-client-tag">${escHtml(l.clientName)}</div>`:''}
      </div>
    </div>`).join('')}</div>`;
}

// ─── Styled confirm ───────────────────────────────────────────────────────────
function styledConfirm(msg,onOk){
  document.getElementById('confirm-msg').textContent=msg;
  const overlay=document.getElementById('confirm-overlay');
  const btns=document.getElementById('confirm-btns');
  btns.innerHTML=`<button class="btn-secondary" id="confirm-cancel">Cancel</button><button class="btn-danger" id="confirm-ok">Confirm</button>`;
  overlay.classList.add('show');
  const cleanup=()=>overlay.classList.remove('show');
  document.getElementById('confirm-ok').onclick=()=>{cleanup();onOk();};
  document.getElementById('confirm-cancel').onclick=cleanup;
}
function styledConfirm3(msg,...buttons){
  document.getElementById('confirm-msg').textContent=msg;
  const overlay=document.getElementById('confirm-overlay');
  const btns=document.getElementById('confirm-btns');
  const cleanup=()=>overlay.classList.remove('show');
  btns.innerHTML=buttons.map((b,i)=>`<button class="${i===0?'btn-primary':i===buttons.length-1?'btn-secondary':'btn-secondary'}" data-ci="${i}">${b.label}</button>`).join('');
  btns.querySelectorAll('button').forEach((btn,i)=>btn.onclick=()=>{cleanup();buttons[i].action();});
  overlay.classList.add('show');
}

const DEFAULT_PRODUCTS=[
  {id:'syncro',label:'Syncro RMM',desc:'RMM agent & ticketing'},
  {id:'threatlocker',label:'Threatlocker',desc:'Application control'},
  {id:'huntress',label:'Huntress',desc:'EDR / ITDR / SIEM'},
  {id:'mailprotect',label:'Mail Protect',desc:'emailservice.io filtering'},
  {id:'controlone',label:'ControlOne',desc:'Remote access & VPN'},
  {id:'keeper',label:'Keeper',desc:'Password manager'},
  {id:'duo',label:'Duo',desc:'MFA / 2FA'},
  {id:'easydmarc',label:'EasyDMARC',desc:'Email authentication'},
  {id:'syncrify',label:'Syncrify Backup',desc:'Endpoint backup'},
];
function getProducts(){return appSettings.products||DEFAULT_PRODUCTS;}

const VPN_OPTIONS=[
  {id:'syncrify-vpn-unifi',label:'Unifi'},
  {id:'syncrify-vpn-controlone',label:'ControlOne'},
  {id:'syncrify-vpn-zywall',label:'Zywall'},
];

// \u2500\u2500\u2500 Steps from JSON \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function buildPhases(client){
  if(!stepsData.phases) return [];
  return stepsData.phases.filter(p=>{
    if(!p.product||p.product==='final') return true;
    return client.products.includes(p.product);
  });
}

function buildDeviceSteps(client){
  if(!stepsData.device_steps) return [];
  return stepsData.device_steps.filter(s=>{
    if(!s.product_filter) return true;
    return client.products.includes(s.product_filter);
  });
}

// \u2500\u2500\u2500 Guide panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function renderInline(s){return s.replace(/`([^`]+)`/g,'<code>$1</code>');}

function renderGuideBody(guide){
  return guide.sections.map((sec,si)=>{
    const noteHtml=sec.note?`<div class="guide-note">${escHtml(sec.note)}</div>`:'';
    const warnHtml=sec.warn?`<div class="guide-warn">${escHtml(sec.warn)}</div>`:'';
    const stepsHtml=sec.steps.map(s=>`
      <div class="guide-step">
        <div class="guide-step-num">${s.n}</div>
        <div class="guide-step-body">
          <h5>${escHtml(s.h)}</h5>
          <p>${renderInline(escHtml(s.b))}</p>
          ${s.code?`<div class="guide-codeblock">${escHtml(s.code)}</div>`:''}
          ${s.link?`<a class="guide-link" href="${escHtml(s.link.url)}" target="_blank">&#x2197; ${escHtml(s.link.text)}</a>`:''}
        </div>
      </div>`).join('');
    const sid=`gsec-${si}`;
    return `<div class="guide-section open" id="${sid}">
      <div class="guide-section-header" onclick="toggleGuideSection('${sid}')">
        <h4>${escHtml(sec.title)}</h4><span class="guide-section-icon">&#9654;</span>
      </div>
      <div class="guide-section-body">${noteHtml}${warnHtml}${stepsHtml}</div>
    </div>`;
  }).join('');
}

let activeGuideId=null;
function openGuide(guideId){
  const panel=document.getElementById('guide-panel');
  if(activeGuideId===guideId&&panel.classList.contains('open')){
    closeGuide();return;
  }
  const guide=guides[guideId];if(!guide)return;
  activeGuideId=guideId;
  document.getElementById('guide-title').textContent=guide.title;
  document.getElementById('guide-content').innerHTML=renderGuideBody(guide);
  panel.classList.add('open');
  // Show backdrop on all screen sizes — guide now overlays content everywhere
  document.getElementById('overlay-bg').classList.add('show');
}
function closeGuide(){
  activeGuideId=null;
  document.getElementById('guide-panel').classList.remove('open');
  document.getElementById('overlay-bg').classList.remove('show');
}
function toggleGuideSection(id){document.getElementById(id)?.classList.toggle('open');}

// Mobile drag (drags bottom edge from handle position)
(function(){
  let startY=0,startH=0,dragging=false;
  const handle=document.getElementById('guide-drag-handle');
  if(!handle)return;
  handle.addEventListener('touchstart',e=>{
    const panel=document.getElementById('guide-panel');
    startY=e.touches[0].clientY;startH=panel.offsetHeight;dragging=true;
    e.stopPropagation();
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!dragging)return;
    const panel=document.getElementById('guide-panel');
    const dy=startY-e.touches[0].clientY;
    panel.style.height=Math.min(window.innerHeight*0.92,Math.max(80,startH+dy))+'px';
  },{passive:true});
  document.addEventListener('touchend',()=>{ dragging=false; });
})();

// \u2500\u2500\u2500 Sidebar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function toggleSidebar(){
  if(window.innerWidth>=1280) return;
  document.getElementById('sidebar').classList.toggle('collapsed');
}
function toggleMobileSidebar(){
  const sb=document.getElementById('sidebar');
  const ob=document.getElementById('overlay-bg');
  const opening=sb.style.display!=='flex'&&!sb.classList.contains('mobile-overlay');
  if(opening){sb.classList.add('mobile-overlay');ob.classList.add('show');}
  else{sb.classList.remove('mobile-overlay');ob.classList.remove('show');}
}
function closeOverlays(){
  closeGuide();
  const sb=document.getElementById('sidebar');
  sb.classList.remove('mobile-overlay');
  document.getElementById('overlay-bg').classList.remove('show');
}
window.addEventListener('resize',()=>{
  if(window.innerWidth>=1280) document.getElementById('sidebar').classList.remove('collapsed');
});
function newClientFromSidebar(){
  if(isMobile()) closeOverlays();
  showView('new-client');
}

// ─── Section navigation (replaces sidebar nav tabs) ──────────────────────────
let activeSection=null;

function switchSection(name){
  if(!confirmLeaveSettings())return;
  if(isMobile()) closeOverlays();
  activeSection=name;
  document.getElementById('sidebar').classList.remove('hidden','collapsed');
  document.getElementById('settings-btn')?.classList.remove('active');
  ['onboarding','sales','quotes','reference','backups'].forEach(s=>{
    document.getElementById('ah-btn-'+s)?.classList.toggle('active',s===name);
    document.getElementById('ss-'+s)?.classList.toggle('active',s===name);
  });
  if(name==='onboarding'){
    activeSalesQuoteId=null;
    renderSidebar();
    showView('empty');
  } else if(name==='sales'){
    activeClientId=null;
    renderSidebar();
    renderSalesSidebar();
    showView('sales');
  } else if(name==='quotes'){
    activeClientId=null;
    activeSalesQuoteId=null;
    renderQuotesSidebar();
    showView('quotes');
    renderQuotesDashboard();
  } else if(name==='reference'){
    activeClientId=null;
    activeSalesQuoteId=null;
    renderSidebar();
    renderSalesSidebar();
    renderRefProductChips();
    renderReferenceView(null,null);
  } else if(name==='backups'){
    activeClientId=null;
    activeSalesQuoteId=null;
    showView('backups');
    renderBackupsView();
  }
}

function ahToggleSidebar(){
  if(isMobile()) toggleMobileSidebar(); else toggleSidebar();
}

// Legacy alias — some callers may still use the old name
function switchSidebarNav(tab){
  if(tab==='clients') switchSection('onboarding');
  else switchSection(tab);
}

let _preSettingsClientId=null;
let settingsDirty=false;

function markSettingsDirty(){
  settingsDirty=true;
  const el=document.getElementById('settings-save-status');
  if(el){el.textContent='Unsaved changes';el.style.color='var(--warn)';}
}

// Returns true if it's OK to navigate away from Settings (not dirty, or user confirmed).
function confirmLeaveSettings(){
  if(!settingsDirty) return true;
  if(confirm('You have unsaved settings changes. Leave without saving?')){
    settingsDirty=false;
    return true;
  }
  return false;
}

document.addEventListener('DOMContentLoaded',()=>{
  const settingsEl=document.getElementById('view-settings');
  settingsEl?.addEventListener('input',e=>{if(e.target.matches('input,select,textarea'))markSettingsDirty();});
  settingsEl?.addEventListener('change',e=>{if(e.target.matches('input,select,textarea'))markSettingsDirty();});
  window.addEventListener('beforeunload',e=>{
    if(settingsDirty){e.preventDefault();e.returnValue='';}
  });
});

function openSettings(){
  if(isMobile()) closeOverlays();
  _preSettingsClientId=activeClientId;
  activeClientId=null;
  activeSalesQuoteId=null;
  ['onboarding','sales','reference','backups'].forEach(s=>document.getElementById('ah-btn-'+s)?.classList.remove('active'));
  document.getElementById('settings-btn')?.classList.add('active');
  document.getElementById('sidebar').classList.add('hidden');
  showView('settings');
  renderSettingsView();
  renderSidebar();
  renderSalesSidebar();
}
function goToDashboard(){
  if(!confirmLeaveSettings())return;
  document.getElementById('settings-btn')?.classList.remove('active');
  activeClientId=null;
  activeSalesQuoteId=null;
  _preSettingsClientId=null;
  activeSection=null;
  ['onboarding','sales','reference','backups'].forEach(s=>{
    document.getElementById('ah-btn-'+s)?.classList.remove('active');
    document.getElementById('ss-'+s)?.classList.remove('active');
  });
  document.getElementById('sidebar').classList.add('hidden');
  showView('home');
}
function toggleSettings(){
  const btn=document.getElementById('settings-btn');
  if(btn?.classList.contains('active')){
    if(!confirmLeaveSettings())return;
    btn.classList.remove('active');
    _preSettingsClientId=null;
    if(!activeSection){
      goToDashboard();
    } else {
      document.getElementById('ah-btn-'+activeSection)?.classList.add('active');
      document.getElementById('sidebar').classList.remove('hidden','collapsed');
      if(activeSection==='sales'){
        renderSalesSidebar();
        showView('sales');
      } else if(activeSection==='reference'){
        renderRefProductChips();
        renderReferenceView(null,null);
      } else if(activeSection==='backups'){
        showView('backups');
        renderBackupsView();
      } else {
        showView('empty');
      }
    }
  } else {
    openSettings();
  }
}

// ─── Reference list ───────────────────────────────────────────────────────────
function renderRefList(filter){
  const container=document.getElementById('ref-list');
  if(!stepsData.phases) return;
  const phases=stepsData.phases;
  const q=(filter||'').toLowerCase();
  container.innerHTML=phases.map(phase=>{
    const matches=!q||phase.title.toLowerCase().includes(q)||
      phase.steps.some(s=>s.title.toLowerCase().includes(q));
    if(!matches) return '';
    return `<div class="ref-item ${activeRefPhaseId===phase.id?'active':''}"
      onclick="openRefPhase('${phase.id}')">${phase.title}</div>`;
  }).join('');
}

function filterRefList(q){ renderRefList(q); }

function openRefPhase(phaseId){
  if(isMobile()) closeOverlays();
  activeRefPhaseId=phaseId;
  renderRefList(document.getElementById('ref-search-input')?.value||'');
  // Scroll to the phase card in the grid
  setTimeout(()=>document.getElementById('ref-phase-'+phaseId)?.scrollIntoView({behavior:'smooth',block:'start'}),80);
}

let activeRefProduct='';

function setRefProduct(productId){
  activeRefProduct=productId;
  document.querySelectorAll('.ref-chip').forEach(c=>c.classList.toggle('active',c.dataset.product===productId));
  renderReferenceView(null,null);
}

function renderRefProductChips(){
  const bar=document.getElementById('ref-product-filter');
  if(!bar) return;
  const usedProducts=new Set((stepsData.phases||[]).map(p=>p.product||'').filter(Boolean));
  const prods=getProducts().filter(p=>usedProducts.has(p.id));
  bar.innerHTML=`<button class="ref-chip ${activeRefProduct===''?'active':''}" data-product="" onclick="setRefProduct('')">All</button>`+
    prods.map(p=>`<button class="ref-chip ${activeRefProduct===p.id?'active':''}" data-product="${p.id}" onclick="setRefProduct('${p.id}')">${escHtml(p.label)}</button>`).join('');
}

function buildRefPhaseCard(phase){
  const steps=phase.steps||[];
  const prodLabel=phase.product?getProducts().find(p=>p.id===phase.product)?.label:'';
  return `<div class="phase-block" id="ref-phase-${phase.id}">
    <div class="phase-header" onclick="this.closest('.phase-block').classList.toggle('collapsed')">
      <div class="phase-num">${steps.length}</div>
      <div class="phase-title">${escHtml(phase.title)}</div>
      ${phase.badge?`<span class="phase-badge">${escHtml(phase.badge)}</span>`:''}
      ${prodLabel?`<span class="phase-badge" style="background:rgba(59,130,246,0.12);color:var(--accent);">${escHtml(prodLabel)}</span>`:''}
      <div class="phase-toggle-icon">▼</div>
    </div>
    <div class="phase-body">
      ${steps.map((s,i)=>`
        <div class="step-item" style="cursor:default;">
          <div class="step-row" style="cursor:default;">
            <div class="step-check" style="cursor:default;background:var(--bg3);border-color:var(--border2);">
              <span style="width:10px;height:10px;border-radius:50%;background:var(--bg4);display:block;margin:auto;"></span>
            </div>
            <div class="step-body">
              <div class="step-title">${escHtml(s.title)}</div>
              ${s.detail?`<div class="step-detail">${escHtml(s.detail)}</div>`:''}
              ${s.tags?.length?`<div class="step-tags">${s.tags.map(t=>`<span class="step-tag ${t}">${t}</span>`).join('')}</div>`:''}
            </div>
            <div class="step-actions">
              ${s.guide?`<button class="btn-guide" onclick="event.stopPropagation();openGuide('${s.guide}')">Guide &#x2197;</button>`:''}
            </div>
          </div>
          ${s.substeps?.length?`<div class="substeps">${s.substeps.map(sub=>`
            <div class="substep-item" style="cursor:default;">
              <div class="substep-check" style="cursor:default;"></div>
              <div class="substep-body">
                <div class="substep-title">${escHtml(sub.title)}</div>
                ${sub.detail?`<div class="step-detail">${escHtml(sub.detail)}</div>`:''}
              </div>
            </div>`).join('')}</div>`:''}
        </div>`).join('')}
    </div>
  </div>`;
}

function buildReferenceHTML(phase,highlightStepId){ return buildRefPhaseCard(phase); }

function renderReferenceView(phase,highlightStepId){
  const phases=(stepsData.phases||[]).filter(p=>!activeRefProduct||(p.product||'')===activeRefProduct);
  const content=document.getElementById('reference-content');
  if(content) content.innerHTML=phases.length?phases.map(p=>buildRefPhaseCard(p)).join(''):
    `<div style="color:var(--text3);text-align:center;padding:40px;font-size:13px;">No procedures for this product.</div>`;
  showView('reference');
}

// ─── Content editor (split-pane) ─────────────────────────────────────────────
let editorTab='procedures';
let editorSelected=null;
let editorTreeFilter='';
let editorExpandedNodes=new Set();
let editorDrag=null;
let editorDirty=false;
let editorProductFilter='';
let _editorSnapshot=null; // deep copy taken on editor open; restored on discard to prevent in-memory mutations persisting
let editorDirtyNodes=new Set();

function markDirty(){
  if(!_editorSnapshot) return;
  const src =editorTab==='procedures'?stepsData:guides;
  const snap=editorTab==='procedures'?_editorSnapshot.stepsData:_editorSnapshot.guides;
  const actuallyDirty=JSON.stringify(src)!==JSON.stringify(snap);
  editorDirty=actuallyDirty;
  const btn=document.getElementById('editor-save-btn');
  if(btn) btn.style.display=actuallyDirty?'':'none';
  const sel=editorSelected;
  if(actuallyDirty&&sel){
    editorDirtyNodes.add(etNodeKey(sel));
    if(sel.type==='step') editorDirtyNodes.add('phase:'+sel.pi);
    if(sel.type==='substep'){editorDirtyNodes.add('phase:'+sel.pi);editorDirtyNodes.add(`step:${sel.pi}:${sel.si}`);}
    if(sel.type==='section') editorDirtyNodes.add('guide:'+sel.gid);
    if(sel.type==='guide-step'){editorDirtyNodes.add('guide:'+sel.gid);editorDirtyNodes.add(`sec:${sel.gid}:${sel.secI}`);}
  } else if(!actuallyDirty){
    editorDirtyNodes.clear();
  }
  document.querySelectorAll('#editor-tree-body .et-row').forEach(r=>{
    try{r.classList.toggle('et-dirty',editorDirtyNodes.has(etNodeKey(JSON.parse(r.dataset.node))));}catch(_){}
  });
}
async function editorSave(){
  const btn=document.getElementById('editor-save-btn');
  if(btn) btn.disabled=true;
  try{
    if(editorTab==='procedures') await saveStepsJson();
    else await saveGuidesJson();
    editorDirty=false;
    // Refresh snapshot to current saved state so further edits can be detected
    _editorSnapshot={stepsData:JSON.parse(JSON.stringify(stepsData)),guides:JSON.parse(JSON.stringify(guides))};
    editorDirtyNodes.clear();
    if(btn){
      btn.style.display='none';
      btn.textContent='Saved ✓';
      btn.style.cssText='padding:5px 14px;font-size:12px;color:var(--success);';
      setTimeout(()=>{
        btn.textContent='Save Changes';
        btn.style.cssText='padding:5px 14px;font-size:12px;display:none;';
      },1500);
    }
    // Re-render tree to clear all amber labels
    renderEditorTree();
  }finally{if(btn) btn.disabled=false;}
}
function _doCloseEditor(){
  editorDirty=false;
  _editorSnapshot=null;
  editorDirtyNodes.clear();
  document.getElementById('editor-modal').classList.remove('show');
}
function settingsToggle(id){
  const el=document.getElementById(id);
  if(el) el.classList.toggle('open');
}

// ─── Procedure editor ─────────────────────────────────────────────────────────
function openEditorModal(tab){
  _editorSnapshot={stepsData:JSON.parse(JSON.stringify(stepsData)),guides:JSON.parse(JSON.stringify(guides))};
  editorSelected=null;editorExpandedNodes=new Set();editorTreeFilter='';editorDirty=false;editorDirtyNodes=new Set();
  const btn=document.getElementById('editor-save-btn');
  if(btn){btn.style.display='none';btn.textContent='Save Changes';btn.style.cssText='padding:5px 14px;font-size:12px;display:none;';}
  document.getElementById('editor-modal').classList.add('show');
  switchEditorTab(tab||'procedures');
}
function closeEditorModal(){
  if(!editorDirty){_doCloseEditor();return;}
  styledConfirm3('You have unsaved changes.',
    {label:'Save & Close',action:async()=>{await editorSave();_doCloseEditor();}},
    {label:'Discard',action:()=>{
      if(_editorSnapshot){stepsData=_editorSnapshot.stepsData;guides=_editorSnapshot.guides;}
      editorDirty=false;editorDirtyNodes.clear();_doCloseEditor();
    }},
    {label:'Cancel',action:()=>{}}
  );
}
function switchEditorTab(tab){
  editorTab=tab;editorSelected=null;editorProductFilter='';
  ['procedures','guides'].forEach(t=>document.getElementById('editor-tab-'+t)?.classList.toggle('active',t===tab));
  const s=document.getElementById('editor-tree-search');
  if(s){s.value='';editorTreeFilter='';}
  renderEditorView();
}
function filterEditorTree(val){editorTreeFilter=(val||'').toLowerCase();renderEditorView();}
function renderEditorView(){
  const filterWrap=document.getElementById('editor-product-filter-wrap');
  const filterSel=document.getElementById('editor-product-filter');
  if(filterSel&&editorTab==='procedures'){
    if(filterWrap) filterWrap.style.display='';
    filterSel.innerHTML=`<option value="">All products</option>`+
      getProducts().map(p=>`<option value="${p.id}"${editorProductFilter===p.id?' selected':''}>${escHtml(p.label)}</option>`).join('');
  } else {
    if(filterWrap) filterWrap.style.display='none';
  }
  renderEditorTree();
  renderEditorForm();
}

function etToggle(key){
  editorExpandedNodes.has(key)?editorExpandedNodes.delete(key):editorExpandedNodes.add(key);
  const b=document.getElementById('editor-tree-body'),sc=b?.scrollTop||0;
  renderEditorTree();if(b)b.scrollTop=sc;
}
function etSelect(node){
  editorSelected=node;
  if(node.type==='step') editorExpandedNodes.add('phase:'+node.pi);
  if(node.type==='substep'){editorExpandedNodes.add('phase:'+node.pi);editorExpandedNodes.add(`step:${node.pi}:${node.si}`);}
  if(node.type==='section') editorExpandedNodes.add('guide:'+node.gid);
  if(node.type==='guide-step'){editorExpandedNodes.add('guide:'+node.gid);editorExpandedNodes.add(`section:${node.gid}:${node.secI}`);}
  const b=document.getElementById('editor-tree-body'),sc=b?.scrollTop||0;
  renderEditorTree();if(b)b.scrollTop=sc;
  renderEditorForm();
}
function etNodeKey(n){
  if(n.type==='phase') return 'phase:'+n.pi;
  if(n.type==='step') return `step:${n.pi}:${n.si}`;
  if(n.type==='substep') return `substep:${n.pi}:${n.si}:${n.subi}`;
  if(n.type==='device-step') return 'ds:'+n.di;
  if(n.type==='guide') return 'guide:'+n.gid;
  if(n.type==='section') return `sec:${n.gid}:${n.secI}`;
  if(n.type==='guide-step') return `gs:${n.gid}:${n.secI}:${n.gsI}`;
  return '';
}
function etSelMatch(s,n){
  if(!s||s.type!==n.type) return false;
  if(n.type==='phase') return s.pi===n.pi;
  if(n.type==='step') return s.pi===n.pi&&s.si===n.si;
  if(n.type==='substep') return s.pi===n.pi&&s.si===n.si&&s.subi===n.subi;
  if(n.type==='device-step') return s.di===n.di;
  if(n.type==='guide') return s.gid===n.gid;
  if(n.type==='section') return s.gid===n.gid&&s.secI===n.secI;
  if(n.type==='guide-step') return s.gid===n.gid&&s.secI===n.secI&&s.gsI===n.gsI;
  return false;
}

function renderEditorTree(){
  const body=document.getElementById('editor-tree-body');
  const footer=document.getElementById('editor-tree-footer');
  if(!body||!footer) return;
  const f=editorTreeFilter,sel=editorSelected;
  function match(t){return !f||t.toLowerCase().includes(f);}
  function row(node,label,depth,hasChildren){
    const key=etNodeKey(node);
    const isOpen=editorExpandedNodes.has(key);
    const isSel=etSelMatch(sel,node);
    const nd=JSON.stringify(node).replace(/'/g,'&#39;');
    return `<div class="et-row${isSel?' active':''}${editorDirtyNodes.has(key)?' et-dirty':''}" style="padding-left:${depth*14+8}px"
      data-node='${nd}' draggable="true"
      onclick="etSelect(JSON.parse(this.dataset.node))"
      ondragstart="etDragStart(event,this)" ondragover="etDragOver(event,this)"
      ondragleave="etDragLeave(event)" ondrop="etDrop(event,this)" ondragend="etDragEnd(this)">
      <span class="et-drag" onclick="event.stopPropagation()">⠿</span>
      <span class="et-label">${escHtml(label)}</span>
      <span class="et-arrow${isOpen?' open':''}${hasChildren?'':' et-no-child'}" onclick="event.stopPropagation();etToggle('${key}')">▶</span>
    </div>`;
  }
  let html='';
  if(editorTab==='procedures'){
    const phases=stepsData.phases||[],devs=stepsData.device_steps||[];
    phases.forEach((ph,pi)=>{
      if(editorProductFilter&&(ph.product||'')!==editorProductFilter) return;
      const phShow=match(ph.title)||ph.steps.some(s=>match(s.title)||((s.substeps||[]).some(sub=>match(sub.title))));
      if(!phShow) return;
      const open=editorExpandedNodes.has('phase:'+pi);
      html+=row({type:'phase',pi},ph.title,0,ph.steps.length>0);
      if(open) ph.steps.forEach((s,si)=>{
        if(f&&!match(s.title)&&!((s.substeps||[]).some(sub=>match(sub.title)))) return;
        const sOpen=editorExpandedNodes.has(`step:${pi}:${si}`);
        html+=row({type:'step',pi,si},s.title,1,(s.substeps||[]).length>0);
        if(sOpen)(s.substeps||[]).forEach((sub,subi)=>{
          if(f&&!match(sub.title)) return;
          html+=row({type:'substep',pi,si,subi},sub.title,2,false);
        });
      });
    });
    if(!f||devs.some(s=>match(s.title))){
      html+=`<div class="et-section-hdr">Device Steps</div>`;
      devs.forEach((s,di)=>{if(!f||match(s.title)) html+=row({type:'device-step',di},s.title,0,false);});
    }
    footer.innerHTML=`<button class="et-add-btn" onclick="etAddPhase()">+ Add Phase</button>
      <button class="et-add-btn" onclick="etAddDevStep()">+ Add Device Step</button>`;
  } else {
    Object.entries(guides).forEach(([gid,g],gi)=>{
      const gShow=match(g.title)||(g.sections||[]).some(s=>match(s.title)||((s.steps||[]).some(gs=>match(gs.h||''))));
      if(!gShow) return;
      const open=editorExpandedNodes.has('guide:'+gid);
      html+=row({type:'guide',gid,gi},g.title,0,(g.sections||[]).length>0);
      if(open)(g.sections||[]).forEach((sec,secI)=>{
        if(f&&!match(sec.title)&&!((sec.steps||[]).some(gs=>match(gs.h||'')))) return;
        const sOpen=editorExpandedNodes.has(`sec:${gid}:${secI}`);
        html+=row({type:'section',gid,secI},sec.title,1,(sec.steps||[]).length>0);
        if(sOpen)(sec.steps||[]).forEach((gs,gsI)=>{
          if(f&&!match(gs.h||'')) return;
          html+=row({type:'guide-step',gid,secI,gsI},gs.h||('Step '+(gsI+1)),2,false);
        });
      });
    });
    footer.innerHTML=`<button class="et-add-btn" onclick="etAddGuide()">+ Add Guide</button>`;
  }
  body.innerHTML=html;
}

function renderEditorForm(){
  const pane=document.getElementById('editor-form-pane');
  if(!pane) return;
  const sel=editorSelected;
  if(!sel){pane.innerHTML='<div class="ef-empty">Select an item from the tree to edit</div>';return;}
  const H=t=>`<div class="ef-header">${t}</div>`;
  const fld=(lbl,inp,hint='')=>`<div class="ef-field">${lbl?`<label>${lbl}</label>`:''}${inp}${hint?`<div class="ef-hint">${hint}</div>`:''}</div>`;
  const inp=(v,h,ph='')=>`<input value="${escHtml(v||'')}" placeholder="${ph}" oninput="${h};etLiveLabel(this.value)">`;
  const inp2=(v,h,ph='')=>`<input value="${escHtml(v||'')}" placeholder="${ph}" oninput="${h}">`;
  const ta=(v,h,ph='',mono=false)=>`<textarea placeholder="${ph}" oninput="${h}"${mono?' class="ef-mono"':''}>${escHtml(v||'')}</textarea>`;
  let html='';
  if(sel.type==='phase'){
    const p=stepsData.phases[sel.pi];if(!p){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    html+=H('Phase');
    html+=`<div class="ef-grid full">${fld('Title',inp(p.title,`stepsData.phases[${sel.pi}].title=this.value;markDirty()`))}</div>`;
    const prodOpts=`<option value="">Always shown</option>${getProducts().map(pr=>`<option value="${pr.id}"${(p.product||'')===pr.id?' selected':''}>${escHtml(pr.label)}</option>`).join('')}`;
    html+=`<div class="ef-grid">${fld('Badge',inp2(p.badge,`stepsData.phases[${sel.pi}].badge=this.value;markDirty()`,'e.g. ORG SETUP'))}${fld('Product',`<select oninput="stepsData.phases[${sel.pi}].product=this.value||undefined;markDirty()" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:6px 9px;color:var(--text);font-size:12px;outline:none;">${prodOpts}</select>`)}</div>`;
    html+=`<hr class="ef-divider"><div style="font-size:12px;color:var(--text2);margin-bottom:12px;">${p.steps.length} step${p.steps.length!==1?'s':''} — select a step in the tree to edit it.</div>`;
    html+=`<div class="ef-actions"><button class="ef-add-btn" onclick="etAddStep(${sel.pi})">+ Add Step</button><button class="ef-add-btn" onclick="openEditorPreview()">Preview</button><button class="ef-del-btn" onclick="etDeletePhase(${sel.pi})">Delete Phase</button></div>`;
  } else if(sel.type==='step'){
    const s=stepsData.phases[sel.pi]?.steps[sel.si];if(!s){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    const tgs=['required','verify','optional'];
    html+=H(`Step — ${escHtml(stepsData.phases[sel.pi].title)}`);
    html+=`<div class="ef-grid full">${fld('Title',inp(s.title,`stepsData.phases[${sel.pi}].steps[${sel.si}].title=this.value;markDirty()`))}</div>`;
    html+=`<div class="ef-grid full">${fld('Detail',ta(s.detail,`stepsData.phases[${sel.pi}].steps[${sel.si}].detail=this.value;markDirty()`,'Supporting detail shown below the step title'))}</div>`;
    html+=`<div class="ef-grid">${fld('Guide ID',inp2(s.guide,`stepsData.phases[${sel.pi}].steps[${sel.si}].guide=this.value||undefined;markDirty()`,'e.g. duo-eam'),'References a guide from guides.json')}</div>`;
    html+=`<hr class="ef-divider"><div class="ef-field"><label>Tags</label><div class="ef-tags">${tgs.map(t=>`<label class="ef-tag"><input type="checkbox" ${(s.tags||[]).includes(t)?'checked':''} onchange="etToggleTag(${sel.pi},${sel.si},-1,'${t}',this.checked)"> ${t}</label>`).join('')}</div></div>`;
    html+=`<div class="ef-actions"><button class="ef-add-btn" onclick="etAddSubstep(${sel.pi},${sel.si})">+ Add Substep</button><button class="ef-del-btn" onclick="etDeleteStep(${sel.pi},${sel.si})">Delete Step</button></div>`;
  } else if(sel.type==='substep'){
    const sub=stepsData.phases[sel.pi]?.steps[sel.si]?.substeps?.[sel.subi];if(!sub){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    const tgs=['required','verify','optional'];
    html+=H(`Substep — ${escHtml(stepsData.phases[sel.pi].steps[sel.si].title)}`);
    html+=`<div class="ef-grid full">${fld('Title',inp(sub.title,`stepsData.phases[${sel.pi}].steps[${sel.si}].substeps[${sel.subi}].title=this.value;markDirty()`))}</div>`;
    html+=`<div class="ef-grid full">${fld('Detail',ta(sub.detail,`stepsData.phases[${sel.pi}].steps[${sel.si}].substeps[${sel.subi}].detail=this.value;markDirty()`))}</div>`;
    html+=`<hr class="ef-divider"><div class="ef-field"><label>Tags</label><div class="ef-tags">${tgs.map(t=>`<label class="ef-tag"><input type="checkbox" ${(sub.tags||[]).includes(t)?'checked':''} onchange="etToggleTag(${sel.pi},${sel.si},${sel.subi},'${t}',this.checked)"> ${t}</label>`).join('')}</div></div>`;
    html+=`<div class="ef-actions"><button class="ef-del-btn" onclick="etDeleteSubstep(${sel.pi},${sel.si},${sel.subi})">Delete Substep</button></div>`;
  } else if(sel.type==='device-step'){
    const s=stepsData.device_steps?.[sel.di];if(!s){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    html+=H('Device Step');
    html+=`<div class="ef-grid full">${fld('Title',inp(s.title,`stepsData.device_steps[${sel.di}].title=this.value;markDirty()`))}</div>`;
    html+=`<div class="ef-grid full">${fld('Detail',ta(s.detail,`stepsData.device_steps[${sel.di}].detail=this.value;markDirty()`))}</div>`;
    html+=`<hr class="ef-divider"><div class="ef-field"><label>Options</label><div class="ef-tags">
      <label class="ef-tag"><input type="checkbox" ${s.installer_url?'checked':''} onchange="stepsData.device_steps[${sel.di}].installer_url=this.checked||undefined;markDirty()"> Show installer URL</label>
      <label class="ef-tag"><input type="checkbox" ${s.vpn_selector?'checked':''} onchange="stepsData.device_steps[${sel.di}].vpn_selector=this.checked||undefined;markDirty()"> VPN selector</label>
    </div></div>`;
    html+=`<div class="ef-actions"><button class="ef-del-btn" onclick="etDeleteDevStep(${sel.di})">Delete Device Step</button></div>`;
  } else if(sel.type==='guide'){
    const g=guides[sel.gid];if(!g){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    html+=H('Guide');
    html+=`<div class="ef-grid full">${fld('Guide ID (read-only)',`<input value="${escHtml(sel.gid)}" disabled style="opacity:0.5;cursor:not-allowed;">`)}</div>`;
    html+=`<div class="ef-grid full">${fld('Title',inp(g.title,`guides['${sel.gid}'].title=this.value;markDirty()`))}</div>`;
    html+=`<hr class="ef-divider"><div style="font-size:12px;color:var(--text2);margin-bottom:12px;">${(g.sections||[]).length} section${(g.sections||[]).length!==1?'s':''} — select a section in the tree to edit it.</div>`;
    html+=`<div class="ef-actions"><button class="ef-add-btn" onclick="etAddSection('${sel.gid}')">+ Add Section</button><button class="ef-add-btn" onclick="openEditorPreview()">Preview</button><button class="ef-del-btn" onclick="etDeleteGuide('${sel.gid}')">Delete Guide</button></div>`;
  } else if(sel.type==='section'){
    const sec=guides[sel.gid]?.sections?.[sel.secI];if(!sec){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    html+=H(`Section — ${escHtml(guides[sel.gid].title)}`);
    html+=`<div class="ef-grid full">${fld('Title',inp(sec.title,`guides['${sel.gid}'].sections[${sel.secI}].title=this.value;markDirty()`))}</div>`;
    html+=`<div class="ef-grid full">${fld('Info Note',ta(sec.note,`guides['${sel.gid}'].sections[${sel.secI}].note=this.value||undefined;markDirty()`,'Blue info box shown above steps (optional)'))}</div>`;
    html+=`<div class="ef-grid full">${fld('Warning',ta(sec.warn,`guides['${sel.gid}'].sections[${sel.secI}].warn=this.value||undefined;markDirty()`,'Red warning box shown above steps (optional)'))}</div>`;
    html+=`<div class="ef-actions"><button class="ef-add-btn" onclick="etAddGuideStep('${sel.gid}',${sel.secI})">+ Add Guide Step</button><button class="ef-del-btn" onclick="etDeleteSection('${sel.gid}',${sel.secI})">Delete Section</button></div>`;
  } else if(sel.type==='guide-step'){
    const gs=guides[sel.gid]?.sections?.[sel.secI]?.steps?.[sel.gsI];if(!gs){pane.innerHTML='<div class="ef-empty">Not found</div>';return;}
    const lnk=gs.link||{};
    html+=H(`Guide Step — ${escHtml(guides[sel.gid].sections[sel.secI].title)}`);
    html+=`<div class="ef-grid full">${fld('Heading',inp(gs.h,`guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].h=this.value;markDirty()`))}</div>`;
    html+=`<div class="ef-grid full">${fld('Body',ta(gs.b,`guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].b=this.value;markDirty()`,'Main description text'))}</div>`;
    html+=`<div class="ef-grid full">${fld('Code Block',ta(gs.code,`guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].code=this.value||undefined;markDirty()`,'Optional — displayed as a formatted code block',true),'Displayed as monospace code in the guide')}</div>`;
    html+=`<div class="ef-grid">${fld('Link Label',inp2(lnk.text,`(guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].link=guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].link||{}).text=this.value||undefined;markDirty()`,'Button label'))}${fld('Link URL',inp2(lnk.url,`(guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].link=guides['${sel.gid}'].sections[${sel.secI}].steps[${sel.gsI}].link||{}).url=this.value||undefined;markDirty()`,'https://...'))}</div>`;
    html+=`<div class="ef-actions"><button class="ef-del-btn" onclick="etDeleteGuideStep('${sel.gid}',${sel.secI},${sel.gsI})">Delete Guide Step</button></div>`;
  }
  pane.innerHTML=html;
}
function openEditorPreview(){
  const sel=editorSelected;
  if(!sel) return;
  const body=document.getElementById('editor-preview-body');
  let html='';
  if(['phase','step','substep'].includes(sel.type)){
    const phase=stepsData.phases[sel.pi];
    if(phase) html=buildReferenceHTML(phase, sel.type==='step'?stepsData.phases[sel.pi].steps[sel.si]?.id:null);
  } else if(sel.type==='device-step'){
    html=buildReferenceHTML({title:'Device Steps',steps:stepsData.device_steps},stepsData.device_steps[sel.di]?.id);
  } else if(['guide','section','guide-step'].includes(sel.type)){
    const g=guides[sel.gid];
    if(g) html=`<div><h3 style="font-size:16px;font-weight:700;margin-bottom:14px;">${escHtml(g.title)}</h3>${renderGuideBody(g)}</div>`;
  }
  body.innerHTML=html||'<div style="color:var(--text3);padding:20px;">Nothing to preview</div>';
  document.getElementById('editor-preview-modal').classList.add('show');
}
function etLiveLabel(val){
  const el=document.querySelector('#editor-tree-body .et-row.active .et-label');
  if(el) el.textContent=val;
}

// ─── Drag-to-reorder ─────────────────────────────────────────────────────────
function etDragStart(e,el){
  editorDrag=JSON.parse(el.dataset.node);
  e.dataTransfer.effectAllowed='move';
  setTimeout(()=>el.style.opacity='0.4',0);
}
function etDragOver(e,el){
  e.preventDefault();
  const tgt=JSON.parse(el.dataset.node);
  if(!etDragCompat(editorDrag,tgt)) return;
  const upper=e.clientY<el.getBoundingClientRect().top+el.getBoundingClientRect().height/2;
  el.classList.toggle('drag-over-before',upper);
  el.classList.toggle('drag-over-after',!upper);
}
function etDragLeave(e){
  if(e.currentTarget.contains(e.relatedTarget)) return;
  e.currentTarget.classList.remove('drag-over-before','drag-over-after');
}
function etDragEnd(el){
  el.style.opacity='';
  document.querySelectorAll('.et-row').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  editorDrag=null;
}
function etDrop(e,el){
  e.preventDefault();
  el.classList.remove('drag-over-before','drag-over-after');el.style.opacity='';
  const tgt=JSON.parse(el.dataset.node);
  const src=editorDrag;editorDrag=null;
  if(!src||!etDragCompat(src,tgt)) return;
  const upper=e.clientY<el.getBoundingClientRect().top+el.getBoundingClientRect().height/2;
  const si=etIdx(src),ti=etIdx(tgt);
  if(si===ti) return;
  if(src.type==='guide'){
    const ids=Object.keys(guides);
    const [id]=ids.splice(si,1);
    let ins=si<ti?(upper?ti-1:ti):(upper?ti:ti+1);
    ins=Math.max(0,Math.min(ins,ids.length));
    ids.splice(ins,0,id);
    const ng={};ids.forEach(k=>ng[k]=guides[k]);
    Object.keys(guides).forEach(k=>delete guides[k]);Object.assign(guides,ng);
    if(editorSelected?.type==='guide') editorSelected.gi=ins;
    const b=document.getElementById('editor-tree-body'),sc=b?.scrollTop||0;
    saveGuidesJson();renderEditorTree();if(b)b.scrollTop=sc;
    return;
  }
  const arr=etArr(src);if(!arr) return;
  const [item]=arr.splice(si,1);
  let ins=si<ti?(upper?ti-1:ti):(upper?ti:ti+1);
  ins=Math.max(0,Math.min(ins,arr.length));
  arr.splice(ins,0,item);
  if(editorSelected&&etDragCompat(editorSelected,src)){
    const oi=etIdx(editorSelected);
    if(oi===si) etSetIdx(editorSelected,ins);
    else if(si<ti&&oi>si&&oi<=ins) etSetIdx(editorSelected,oi-1);
    else if(si>ti&&oi>=ins&&oi<si) etSetIdx(editorSelected,oi+1);
  }
  const b=document.getElementById('editor-tree-body'),sc=b?.scrollTop||0;
  if(['guide','section','guide-step'].includes(src.type)) saveGuidesJson(); else saveStepsJson();
  renderEditorTree();if(b)b.scrollTop=sc;
}
function etDragCompat(s,t){
  if(!s||!t||s.type!==t.type) return false;
  if(s.type==='phase'||s.type==='device-step'||s.type==='guide') return true;
  if(s.type==='step') return s.pi===t.pi;
  if(s.type==='substep') return s.pi===t.pi&&s.si===t.si;
  if(s.type==='section') return s.gid===t.gid;
  if(s.type==='guide-step') return s.gid===t.gid&&s.secI===t.secI;
  return false;
}
function etArr(n){
  if(n.type==='phase') return stepsData.phases;
  if(n.type==='step') return stepsData.phases[n.pi].steps;
  if(n.type==='substep') return stepsData.phases[n.pi].steps[n.si].substeps;
  if(n.type==='device-step') return stepsData.device_steps;
  if(n.type==='section') return guides[n.gid].sections;
  if(n.type==='guide-step') return guides[n.gid].sections[n.secI].steps;
  return null;
}
function etIdx(n){
  if(n.type==='phase') return n.pi;if(n.type==='step') return n.si;
  if(n.type==='substep') return n.subi;if(n.type==='device-step') return n.di;
  if(n.type==='guide') return n.gi;if(n.type==='section') return n.secI;
  if(n.type==='guide-step') return n.gsI;return 0;
}
function etSetIdx(n,v){
  if(n.type==='phase') n.pi=v;else if(n.type==='step') n.si=v;
  else if(n.type==='substep') n.subi=v;else if(n.type==='device-step') n.di=v;
  else if(n.type==='guide') n.gi=v;else if(n.type==='section') n.secI=v;
  else if(n.type==='guide-step') n.gsI=v;
}

// ─── Editor mutations ─────────────────────────────────────────────────────────
async function saveStepsJson(){
  const r=await fetch('/api/steps',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(stepsData)});
  if(r.ok){logAction('procedures_saved',{clientId:null,clientName:null,details:`${stepsData.phases?.length||0} phases`});}
  else{let msg='Failed to save procedures';try{const d=await r.json();if(d.error)msg=d.error;}catch(_){}showToast(msg,'error');}
}
function etAddPhase(){
  stepsData.phases.push({id:'phase-'+Date.now(),title:'New Phase',badge:'',steps:[]});
  saveStepsJson();etSelect({type:'phase',pi:stepsData.phases.length-1});
}
function etDeletePhase(pi){
  styledConfirm(`Delete phase "${stepsData.phases[pi].title}"?`,()=>{
    stepsData.phases.splice(pi,1);editorSelected=null;saveStepsJson();renderEditorView();
  });
}
function etAddStep(pi){
  stepsData.phases[pi].steps.push({id:'s-'+Date.now(),title:'New Step',detail:'',tags:[]});
  editorExpandedNodes.add('phase:'+pi);saveStepsJson();
  etSelect({type:'step',pi,si:stepsData.phases[pi].steps.length-1});
}
function etDeleteStep(pi,si){
  styledConfirm(`Delete step "${stepsData.phases[pi].steps[si].title}"?`,()=>{
    stepsData.phases[pi].steps.splice(si,1);editorSelected={type:'phase',pi};saveStepsJson();renderEditorView();
  });
}
function etAddSubstep(pi,si){
  if(!stepsData.phases[pi].steps[si].substeps) stepsData.phases[pi].steps[si].substeps=[];
  stepsData.phases[pi].steps[si].substeps.push({id:'sub-'+Date.now(),title:'New Substep',detail:''});
  editorExpandedNodes.add('phase:'+pi);editorExpandedNodes.add(`step:${pi}:${si}`);saveStepsJson();
  etSelect({type:'substep',pi,si,subi:stepsData.phases[pi].steps[si].substeps.length-1});
}
function etDeleteSubstep(pi,si,subi){
  stepsData.phases[pi].steps[si].substeps.splice(subi,1);
  editorSelected={type:'step',pi,si};saveStepsJson();renderEditorView();
}
function etToggleTag(pi,si,subi,tag,checked){
  const obj=subi>=0?stepsData.phases[pi].steps[si].substeps[subi]:stepsData.phases[pi].steps[si];
  if(!obj.tags) obj.tags=[];
  if(checked&&!obj.tags.includes(tag)) obj.tags.push(tag);
  else if(!checked){const i=obj.tags.indexOf(tag);if(i>=0)obj.tags.splice(i,1);}
  markDirty();
}
function etAddDevStep(){
  stepsData.device_steps.push({id:'dv-'+Date.now(),title:'New Device Step',detail:''});
  saveStepsJson();etSelect({type:'device-step',di:stepsData.device_steps.length-1});
}
function etDeleteDevStep(di){
  styledConfirm(`Delete device step "${stepsData.device_steps[di].title}"?`,()=>{
    stepsData.device_steps.splice(di,1);editorSelected=null;saveStepsJson();renderEditorView();
  });
}
async function saveGuidesJson(){
  const r=await fetch('/api/guides',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(guides)});
  if(r.ok){logAction('guides_saved',{clientId:null,clientName:null,details:`${Object.keys(guides).length} guides`});}
  else{let msg='Failed to save guides';try{const d=await r.json();if(d.error)msg=d.error;}catch(_){}showToast(msg,'error');}
}
function etAddGuide(){
  const gid='guide-'+Date.now();
  guides[gid]={title:'New Guide',sections:[]};
  const gi=Object.keys(guides).length-1;
  saveGuidesJson();etSelect({type:'guide',gid,gi});
}
function etDeleteGuide(gid){
  styledConfirm(`Delete guide "${guides[gid].title}"?`,()=>{
    delete guides[gid];editorSelected=null;saveGuidesJson();renderEditorView();
  });
}
function etAddSection(gid){
  if(!guides[gid].sections) guides[gid].sections=[];
  guides[gid].sections.push({title:'New Section',steps:[]});
  editorExpandedNodes.add('guide:'+gid);saveGuidesJson();
  etSelect({type:'section',gid,secI:guides[gid].sections.length-1});
}
function etDeleteSection(gid,secI){
  guides[gid].sections.splice(secI,1);
  editorSelected={type:'guide',gid,gi:Object.keys(guides).indexOf(gid)};
  saveGuidesJson();renderEditorView();
}
function etAddGuideStep(gid,secI){
  if(!guides[gid].sections[secI].steps) guides[gid].sections[secI].steps=[];
  const n=guides[gid].sections[secI].steps.length+1;
  guides[gid].sections[secI].steps.push({n,h:'New Step',b:''});
  editorExpandedNodes.add('guide:'+gid);editorExpandedNodes.add(`sec:${gid}:${secI}`);saveGuidesJson();
  etSelect({type:'guide-step',gid,secI,gsI:guides[gid].sections[secI].steps.length-1});
}
function etDeleteGuideStep(gid,secI,gsI){
  guides[gid].sections[secI].steps.splice(gsI,1);
  editorSelected={type:'section',gid,secI};saveGuidesJson();renderEditorView();
}


// ─── Name management ─────────────────────────────────────────────────────────
function openNameModal(){
  const existing=localStorage.getItem('myName')||'';
  const title=document.getElementById('name-modal-title');
  const input=document.getElementById('name-input');
  const skipBtn=document.getElementById('name-skip-btn');
  if(title) title.textContent=existing?'Edit Your Name':'Welcome';
  if(input){input.value=existing;}
  if(skipBtn) skipBtn.textContent=existing?'Cancel':'Skip';
  const m=document.getElementById('name-modal');
  if(m){m.style.display='flex';setTimeout(()=>{input?.focus();input?.select();},80);}
}
function checkFirstVisit(){
  if(!localStorage.getItem('myName')) openNameModal();
  updateNameDisplay();
}
function setMyName(save){
  if(save){
    const name=(document.getElementById('name-input')?.value||'').trim();
    if(name) localStorage.setItem('myName',name);
  }
  const m=document.getElementById('name-modal');
  if(m) m.style.display='none';
  updateNameDisplay();
}
function updateNameDisplay(){
  const btn=document.getElementById('ah-name-display');
  if(!btn) return;
  const name=localStorage.getItem('myName')||'';
  if(name){btn.textContent=name.split(' ')[0];btn.style.display='';}
  else{btn.style.display='none';}
}

// ─── Sales helper ─────────────────────────────────────────────────────────────

const DEFAULT_SALES_PRODUCTS=[
  // User Products
  {id:'duo',label:'Duo',desc:'MFA / 2FA',salesCategory:'user',saCost:2.50,defaultPrice:12.50,billing:'monthly',qtySource:'licensedUsers'},
  {id:'keeper',label:'Keeper',desc:'Password manager',salesCategory:'user',saCost:5.00,defaultPrice:25.00,billing:'monthly',qtySource:'licensedUsers'},
  {id:'cloud-backup',label:'365 Cloud Backup',desc:'Cloud backup for M365',salesCategory:'user',saCost:1.90,defaultPrice:9.50,billing:'monthly',qtySource:'licensedUsers'},
  {id:'mail-filter',label:'Mail Filter',desc:'Email filtering',salesCategory:'user',saCost:1.50,defaultPrice:7.50,billing:'monthly',qtySource:'licensedUsers'},
  {id:'mail-protector',label:'Mail Protector',desc:'Advanced email protection',salesCategory:'user',saCost:1.25,defaultPrice:6.25,billing:'monthly',qtySource:'licensedUsers'},
  {id:'mail-prot-enc',label:'Mail Protector (Encrypted)',desc:'Encrypted email protection',salesCategory:'user',saCost:4.00,defaultPrice:20.00,billing:'monthly',qtySource:'licensedUsers'},
  {id:'huntress-itdr',label:'Huntress ITDR',desc:'Identity threat detection',salesCategory:'user',saCost:1.50,defaultPrice:7.50,billing:'monthly',qtySource:'licensedUsers'},
  {id:'huntress-sat',label:'Huntress SAT',desc:'Security awareness training',salesCategory:'user',saCost:1.40,defaultPrice:7.00,billing:'monthly',qtySource:'licensedUsers'},
  {id:'labor',label:'Labor (½hr/employee)',desc:'Onboarding labor',salesCategory:'user',saCost:0,defaultPrice:87.50,billing:'monthly',qtySource:'employees'},
  {id:'co-standard',label:'Control One Standard',desc:'Standard VPN/remote access',salesCategory:'user',saCost:10.00,defaultPrice:50.00,billing:'monthly',qtySource:'licensedUsers'},
  {id:'co-limited',label:'Control One Limited',desc:'Limited VPN/remote access',salesCategory:'user',saCost:6.00,defaultPrice:30.00,billing:'monthly',qtySource:'licensedUsers'},
  // Machine Products
  {id:'syncro',label:'Syncro + Splashtop',desc:'RMM + remote control',salesCategory:'machine',saCost:2.00,defaultPrice:10.00,billing:'monthly',qtySource:'machines'},
  {id:'threatlocker',label:'Threatlocker',desc:'Application control',salesCategory:'machine',saCost:5.00,defaultPrice:25.00,billing:'monthly',qtySource:'machines'},
  {id:'edr-ngav',label:'EDR & NGAV',desc:'Endpoint detection & antivirus',salesCategory:'machine',saCost:2.50,defaultPrice:12.50,billing:'monthly',qtySource:'machines'},
  {id:'siem',label:'SIEM & Threat Detection',desc:'Log monitoring & SIEM',salesCategory:'machine',saCost:1.50,defaultPrice:7.50,billing:'monthly',qtySource:'machines'},
  {id:'mxdr',label:'MXDR & SOC',desc:'Managed detection & response',salesCategory:'machine',saCost:5.00,defaultPrice:25.00,billing:'monthly',qtySource:'machines'},
  {id:'backup-mach',label:'Backups (Machines)',desc:'Machine backup service',salesCategory:'machine',saCost:0,defaultPrice:25.00,billing:'monthly',qtySource:'backedUpMachines'},
  // Site Products
  {id:'easydmarc',label:'Easy Dmarc',desc:'Email authentication / DMARC',salesCategory:'site',saCost:10,defaultPrice:50.00,billing:'monthly',qtySource:'sites'},
  {id:'co-cloud',label:'Control One Cloud',desc:'Cloud network appliance',salesCategory:'site',saCost:49,defaultPrice:245.00,billing:'monthly',qtySource:'sites'},
  {id:'co-bridge-lic',label:'Control One Bridge License',desc:'Bridge license (one-time)',salesCategory:'site',saCost:100,defaultPrice:500.00,billing:'onetime',qtySource:''},
  {id:'co-bridge-std',label:'Control One Bridge (Standard)',desc:'Standard bridge hardware',salesCategory:'site',saCost:199,defaultPrice:995.00,billing:'onetime',qtySource:''},
  {id:'co-bridge-ltd',label:'Control One Bridge (Limited)',desc:'Limited bridge hardware',salesCategory:'site',saCost:150,defaultPrice:750.00,billing:'onetime',qtySource:''},
  {id:'co-ipsec',label:'Control One IPSec Connector',desc:'IPSec site connector',salesCategory:'site',saCost:20,defaultPrice:100.00,billing:'monthly',qtySource:'sites'},
  {id:'backup-data',label:'Backups (Data)',desc:'Data backup per site',salesCategory:'site',saCost:0,defaultPrice:40.00,billing:'monthly',qtySource:'sites'},
];

let salesQuotes={};
let activeSalesQuoteId=null;

function getSalesProducts(){
  const src=(appSettings.products||DEFAULT_PRODUCTS||[]).filter(p=>p.salesCategory||p.subItems?.length);
  const source=src.length?src:DEFAULT_SALES_PRODUCTS;
  const result=[];
  source.forEach(p=>{
    if(p.subItems?.length){
      p.subItems.forEach(sub=>result.push({...sub,billing:sub.billing||'monthly',salesCategory:sub.salesCategory||p.salesCategory,qtySource:sub.qtySource||p.qtySource||'',parentLabel:p.label,parentId:p.id}));
    }else{
      result.push({...p,billing:p.billing||'monthly'});
    }
  });
  return result;
}

async function loadSalesQuotes(){
  try{const r=await fetch('/api/sales-quotes');if(r.ok)salesQuotes=await r.json();}
  catch(_){salesQuotes={};}
}
async function saveSalesQuotes(){
  try{await fetch('/api/sales-quotes',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(salesQuotes)});}
  catch(e){console.error(e);}
}

// ── Quotes page: Purchase Requests + Invoices ──────────────────────────────────
let purchaseRequests={};
let invoices={};
let activeQuotesTab='pr'; // 'pr' | 'invoice'
let activePurchaseRequestId=null;
let activeInvoiceId=null;

function newRecordId(prefix){ return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; }

// Wraps a line-item input with a small uppercase label above it — placeholder
// text alone disappears once filled in, so every column needs a real label.
function liField(label,inputHtml){
  return `<div style="min-width:0;"><label style="display:block;font-size:9px;font-weight:600;color:var(--text2);letter-spacing:0.03em;text-transform:uppercase;margin-bottom:2px;">${escHtml(label)}</label>${inputHtml}</div>`;
}
// A number input with a "$" prefix rendered inside the field.
function liCurrencyInput(value,oninput,onchange){
  return `<div style="position:relative;"><span style="position:absolute;left:7px;top:50%;transform:translateY(-50%);color:var(--text3);font-size:11px;pointer-events:none;">$</span>
    <input class="li-input" type="number" min="0" step="0.01" style="padding-left:16px;" value="${value||0}" oninput="${oninput}" onchange="${onchange}"></div>`;
}

async function loadPurchaseRequests(){
  try{const r=await fetch('/api/purchase-requests');if(r.ok)purchaseRequests=await r.json();}
  catch(_){purchaseRequests={};}
}
async function savePurchaseRequests(){
  try{await fetch('/api/purchase-requests',{method:'PUT',headers:{'Content-Type':'application/json','X-Session-Id':SESSION_ID},body:JSON.stringify(purchaseRequests)});}
  catch(e){console.error(e);}
}
async function loadInvoices(){
  try{const r=await fetch('/api/invoices');if(r.ok)invoices=await r.json();}
  catch(_){invoices={};}
}
async function saveInvoices(){
  try{await fetch('/api/invoices',{method:'PUT',headers:{'Content-Type':'application/json','X-Session-Id':SESSION_ID},body:JSON.stringify(invoices)});}
  catch(e){console.error(e);}
}

function purchaseRequestStatusLabel(s){return{not_sent:'Not Sent',pending:'Pending',approved:'Approved',denied:'Denied',modified:'Modified'}[s]||'Not Sent';}

// Only edits a client would actually see on the estimate PDF invalidate an
// existing Approved/Denied decision — internal-only fields (internal notes,
// vendor/purchase link/received, workflow status) don't, since they never
// reach the client.
const CLIENT_VISIBLE_PR_FIELDS=new Set(['notes','clientEmail','clientName']);
const CLIENT_VISIBLE_PR_ITEM_FIELDS=new Set(['description','qty','estUnitCost','sku']);
async function markPrModifiedIfResolved(id){
  const pr=purchaseRequests[id]; if(!pr) return;
  if(pr.approvalStatus!=='approved'&&pr.approvalStatus!=='denied') return;
  try{
    const r=await fetch(`/api/purchase-requests/${id}/mark-modified`,{method:'POST',headers:{'X-Session-Id':SESSION_ID}});
    if(r.ok){
      pr.approvalStatus='modified';
      renderQuotesSidebar();
      if(activePurchaseRequestId===id) renderPurchaseRequestDetail(id);
    }
  }catch(e){console.error(e);}
}
function invoiceStatusLabel(s){return{draft:'Draft',sent:'Sent',paid:'Paid',overdue:'Overdue',void:'Void'}[s]||'Draft';}
function prSidebarSummary(pr){
  const n=(pr.items||[]).length;
  const total=(pr.items||[]).reduce((s,it)=>s+(it.qty||0)*(it.estUnitCost||0),0);
  return `${n} item${n===1?'':'s'} · $${total.toFixed(2)}`;
}

// ── Reusable: searchable Syncro client picker ──────────────────────────────────
// Replaces a plain client <select> with a text search against the locally
// cached syncro_customers table (kept fresh by the server's poll loop), so
// any Syncro customer can be picked, not just ones with an onboarding checklist.
let syncroSearchDebounceTimer=null;
let syncroSearchResults={};
let syncroClientSelectHandlers={};

function renderSyncroClientField(prefix,currentName,onSelect){
  syncroClientSelectHandlers[prefix]=onSelect;
  return `<div class="field-group" style="margin:0;position:relative;"><label>Client</label>
    <input type="text" id="${prefix}-search" value="${escHtml(currentName||'')}" placeholder="Search Syncro customers..." autocomplete="off"
      oninput="searchSyncroClients('${prefix}',this.value)" onfocus="searchSyncroClients('${prefix}',this.value)">
    <div id="${prefix}-suggestions" class="syncro-suggestions" style="display:none;"></div>
  </div>`;
}
function searchSyncroClients(prefix,query){
  clearTimeout(syncroSearchDebounceTimer);
  syncroSearchDebounceTimer=setTimeout(async ()=>{
    try{
      const r=await fetch(`/api/syncro-customers?q=${encodeURIComponent(query||'')}`);
      syncroSearchResults[prefix]=r.ok?await r.json():[];
    }catch(_){ syncroSearchResults[prefix]=[]; }
    renderSyncroSuggestions(prefix);
  },250);
}
function renderSyncroSuggestions(prefix){
  const el=document.getElementById(`${prefix}-suggestions`);
  if(!el) return;
  const results=syncroSearchResults[prefix]||[];
  if(!results.length){ el.style.display='none'; el.innerHTML=''; return; }
  el.innerHTML=results.map((c,i)=>`
    <div class="syncro-suggestion-item" onmousedown="selectSyncroClient('${prefix}',${i})">
      <div style="font-weight:600;">${escHtml(c.businessName||'')}</div>
      ${c.email?`<div style="font-size:11px;color:var(--text3);">${escHtml(c.email)}</div>`:''}
    </div>`).join('');
  el.style.display='block';
}
function selectSyncroClient(prefix,index){
  const c=(syncroSearchResults[prefix]||[])[index];
  if(!c) return;
  const el=document.getElementById(`${prefix}-suggestions`);
  if(el){ el.style.display='none'; el.innerHTML=''; }
  const input=document.getElementById(`${prefix}-search`);
  if(input) input.value=c.businessName||'';
  syncroClientSelectHandlers[prefix]?.(c);
}
document.addEventListener('click',e=>{
  document.querySelectorAll('.syncro-suggestions').forEach(el=>{
    const inputId=el.id.replace('-suggestions','-search');
    if(el.style.display!=='none'&&e.target.id!==inputId&&!el.contains(e.target)) el.style.display='none';
  });
});

// ── Reusable: right-click context menu ─────────────────────────────────────────
function showContextMenu(x,y,items){
  closeContextMenu();
  const menu=document.createElement('div');
  menu.className='context-menu';
  menu.id='active-context-menu';
  menu.style.left=x+'px';
  menu.style.top=y+'px';
  menu.innerHTML=items.map((it,i)=>it.separator
    ?'<div class="context-menu-sep"></div>'
    :`<div class="context-menu-item${it.danger?' danger':''}" data-idx="${i}">${escHtml(it.label)}</div>`).join('');
  document.body.appendChild(menu);
  menu.querySelectorAll('.context-menu-item').forEach(el=>{
    el.addEventListener('click',()=>{ const it=items[parseInt(el.dataset.idx)]; closeContextMenu(); it.onClick(); });
  });
  requestAnimationFrame(()=>{
    const rect=menu.getBoundingClientRect();
    if(rect.right>window.innerWidth) menu.style.left=Math.max(0,window.innerWidth-rect.width-8)+'px';
    if(rect.bottom>window.innerHeight) menu.style.top=Math.max(0,window.innerHeight-rect.height-8)+'px';
  });
}
function closeContextMenu(){ document.getElementById('active-context-menu')?.remove(); }
document.addEventListener('click',closeContextMenu);
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeContextMenu(); });

function switchQuotesTab(tab){
  activeQuotesTab=tab;
  document.getElementById('quotes-tab-pr')?.classList.toggle('active',tab==='pr');
  document.getElementById('quotes-tab-invoice')?.classList.toggle('active',tab==='invoice');
  renderQuotesSidebar();
}

function renderQuotesSidebar(){
  const list=document.getElementById('quotes-list');
  if(!list) return;
  if(activeQuotesTab==='pr'){
    const items=Object.values(purchaseRequests).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    list.innerHTML=items.map(pr=>`
      <div class="client-item ${pr.id===activePurchaseRequestId?'active':''}" title="${escHtml(pr.clientName||'')}"
        oncontextmenu="event.preventDefault();showPrContextMenu(event,'${pr.id}')">
        <div style="padding:7px 14px;cursor:pointer;" onclick="selectPurchaseRequest('${pr.id}')">
          <div class="cn"><span>${escHtml(pr.clientName||'(no client)')}</span><span class="quote-status ${pr.approvalStatus||'not_sent'}">${purchaseRequestStatusLabel(pr.approvalStatus)}</span></div>
          <div class="cm">${prSidebarSummary(pr)}</div>
        </div>
      </div>`).join('') || `<div style="padding:20px 12px;text-align:center;font-size:12px;color:var(--text3);">No purchase requests yet.</div>`;
  } else {
    const items=Object.values(invoices).sort((a,b)=>(b.number||0)-(a.number||0));
    list.innerHTML=items.map(inv=>`
      <div class="client-item ${inv.id===activeInvoiceId?'active':''}" title="${escHtml(inv.clientName||'')}"
        oncontextmenu="event.preventDefault();showInvoiceContextMenu(event,'${inv.id}')">
        <div style="padding:7px 14px;cursor:pointer;" onclick="selectInvoice('${inv.id}')">
          <div class="cn"><span>#${inv.number} · ${escHtml(inv.clientName||'(no client)')}</span><span class="quote-status ${inv.status||'draft'}">${invoiceStatusLabel(inv.status)}</span></div>
        </div>
      </div>`).join('') || `<div style="padding:20px 12px;text-align:center;font-size:12px;color:var(--text3);">No invoices yet.</div>`;
  }
}

function showPrContextMenu(e,id){
  const pr=purchaseRequests[id]; if(!pr) return;
  showContextMenu(e.clientX,e.clientY,[
    {label:'Open', onClick:()=>selectPurchaseRequest(id)},
    {label:'Duplicate', onClick:()=>duplicatePurchaseRequest(id)},
    {label:pr.priority?'Unmark Priority':'Mark Priority', onClick:()=>togglePrPriority(id)},
    {separator:true},
    {label:'Delete', danger:true, onClick:()=>deletePurchaseRequest(id)},
  ]);
}
function showInvoiceContextMenu(e,id){
  showContextMenu(e.clientX,e.clientY,[
    {label:'Open', onClick:()=>selectInvoice(id)},
    {label:'Duplicate', onClick:()=>duplicateInvoice(id)},
    {separator:true},
    {label:'Delete', danger:true, onClick:()=>deleteInvoice(id)},
  ]);
}
function togglePrPriority(id){
  const pr=purchaseRequests[id]; if(!pr) return;
  pr.priority=!pr.priority;
  savePurchaseRequests();
  renderQuotesSidebar();
}
async function duplicatePurchaseRequest(id){
  const pr=purchaseRequests[id]; if(!pr) return;
  const newId=newRecordId('pr');
  purchaseRequests[newId]={
    ...pr, id:newId, status:'draft', invoiceId:null,
    approvalStatus:'not_sent', approvalId:null, approvalSentAt:null, approvalResolvedAt:null,
    createdAt:Date.now(), updatedAt:Date.now(),
    items:(pr.items||[]).map(it=>({...it})),
  };
  await savePurchaseRequests();
  renderQuotesSidebar();
  selectPurchaseRequest(newId);
}
function deletePurchaseRequest(id){
  const pr=purchaseRequests[id]; if(!pr) return;
  styledConfirm(`Delete purchase request for "${pr.clientName||'this client'}"?`,async()=>{
    await fetch(`/api/purchase-requests/${id}`,{method:'DELETE',headers:{'X-Session-Id':SESSION_ID}});
    delete purchaseRequests[id];
    if(activePurchaseRequestId===id){ activePurchaseRequestId=null; renderQuotesDashboard(); }
    renderQuotesSidebar();
  });
}
async function duplicateInvoice(id){
  const inv=invoices[id]; if(!inv) return;
  const r=await fetch('/api/invoices',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':SESSION_ID},body:JSON.stringify({
    clientId:inv.clientId, clientName:inv.clientName, notes:inv.notes, taxRate:inv.taxRate,
    lineItems:(inv.lineItems||[]).map(it=>({description:it.description,qty:it.qty,unitPrice:it.unitPrice})),
  })});
  const body=await r.json();
  await loadInvoices();
  renderQuotesSidebar();
  selectInvoice(body.id);
}
function deleteInvoice(id){
  const inv=invoices[id]; if(!inv) return;
  styledConfirm(`Delete invoice #${inv.number}?`,async()=>{
    await fetch(`/api/invoices/${id}`,{method:'DELETE',headers:{'X-Session-Id':SESSION_ID}});
    delete invoices[id];
    if(activeInvoiceId===id){ activeInvoiceId=null; renderQuotesDashboard(); }
    renderQuotesSidebar();
  });
}

function renderQuotesDashboard(){
  if(activePurchaseRequestId&&purchaseRequests[activePurchaseRequestId]){ renderPurchaseRequestDetail(activePurchaseRequestId); return; }
  if(activeInvoiceId&&invoices[activeInvoiceId]){ renderInvoiceDetail(activeInvoiceId); return; }
  const el=document.getElementById('quotes-content');
  if(el) el.innerHTML=`<div style="padding:30px;color:var(--text3);">Select a purchase request or invoice from the sidebar, or create a new one.</div>`;
}

function newQuotesItemFromSidebar(){
  if(activeQuotesTab==='pr') createPurchaseRequest();
  else createInvoiceFromSidebar();
}

async function createPurchaseRequest(){
  const id=newRecordId('pr');
  purchaseRequests[id]={
    id, clientId:'', clientName:'', requestedBy:localStorage.getItem('myName')||'',
    notes:'', priority:false, status:'draft', clientEmail:'',
    approvalStatus:'not_sent', invoiceId:null, items:[], createdAt:Date.now(), updatedAt:Date.now(),
  };
  await savePurchaseRequests();
  renderQuotesSidebar();
  selectPurchaseRequest(id);
}

function selectPurchaseRequest(id){
  activePurchaseRequestId=id;
  activeInvoiceId=null;
  activeQuotesTab='pr';
  renderQuotesSidebar();
  showView('quotes');
  renderPurchaseRequestDetail(id);
}

function renderPurchaseRequestDetail(id){
  const pr=purchaseRequests[id];
  const el=document.getElementById('quotes-content');
  if(!pr||!el) return;
  const itemsRows=(pr.items||[]).map((it,i)=>`
    <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;min-width:0;">
      <div class="li-row" style="display:grid;grid-template-columns:100px minmax(0,2fr) 60px 100px 70px auto;gap:8px;margin-bottom:8px;">
        ${liField('Item',`<input class="li-input" value="${escHtml(it.sku||'')}" onchange="savePrItem('${id}',${i},'sku',this.value)">`)}
        ${liField('Description',`<input class="li-input" value="${escHtml(it.description||'')}" onchange="savePrItem('${id}',${i},'description',this.value)">`)}
        ${liField('Qty',`<input class="li-input" type="number" min="0" step="1" value="${it.qty||0}" oninput="livePrItem('${id}',${i},'qty',this.value)" onchange="savePrItem('${id}',${i},'qty',this.value)">`)}
        ${liField('Unit Cost',liCurrencyInput(it.estUnitCost, `livePrItem('${id}',${i},'estUnitCost',this.value)`, `savePrItem('${id}',${i},'estUnitCost',this.value)`))}
        ${liField('Total',`<div style="text-align:right;font-weight:600;padding-top:6px;" id="pr-item-total-${id}-${i}">$${((it.qty||0)*(it.estUnitCost||0)).toFixed(2)}</div>`)}
        <div style="display:flex;align-items:flex-end;"><button class="btn-secondary" style="padding:5px 8px;font-size:11px;" onclick="removePrItem('${id}',${i})">✕</button></div>
      </div>
      <div class="li-row" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:8px;">
        ${liField('Vendor',`<input class="li-input" placeholder="e.g. CDW" value="${escHtml(it.vendor||'')}" onchange="savePrItem('${id}',${i},'vendor',this.value)">`)}
        ${liField('Purchase Link',`<div style="display:flex;gap:4px;align-items:center;min-width:0;">
          <input class="li-input" type="url" style="flex:1;min-width:0;" value="${escHtml(it.url||'')}" onchange="savePrItem('${id}',${i},'url',this.value)">
          ${it.url?`<a href="${escHtml(it.url)}" target="_blank" rel="noopener" title="Open purchase link">🔗</a>`:''}
        </div>`)}
        <label style="display:flex;align-items:flex-end;gap:4px;font-size:11px;white-space:nowrap;padding-bottom:7px;">
          <input type="checkbox" ${it.received?'checked':''} onchange="savePrItem('${id}',${i},'received',this.checked)"> Received
        </label>
      </div>
    </div>`).join('');
  const total=(pr.items||[]).reduce((s,it)=>s+(it.qty||0)*(it.estUnitCost||0),0);
  const canSend=pr.approvalStatus==='not_sent'||pr.approvalStatus==='modified';
  const canGenerateInvoice=pr.status==='received'&&!pr.invoiceId;
  el.innerHTML=`
    <div class="wizard-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h2 style="margin:0;">Purchase Request</h2>
        <span class="quote-status ${pr.approvalStatus||'not_sent'}">${purchaseRequestStatusLabel(pr.approvalStatus)}</span>
      </div>
      <div id="pr-alert-${id}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        ${renderSyncroClientField('pr-client-'+id,pr.clientName,c=>updatePrClientFromSyncro(id,c))}
        <div class="field-group" style="margin:0;"><label>Client Email</label>
          <input value="${escHtml(pr.clientEmail||'')}" onchange="updatePrField('${id}','clientEmail',this.value)" placeholder="client@example.com">
        </div>
        <div class="field-group" style="margin:0;"><label>Status</label>
          <select onchange="updatePrField('${id}','status',this.value)">
            ${['draft','ordered','received','invoiced','cancelled'].map(s=>`<option value="${s}" ${s===pr.status?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="field-group" style="grid-column:1/-1;margin:0;"><label>Notes <span style="font-weight:400;color:var(--text3);">(visible to client)</span></label>
          <textarea rows="2" onchange="updatePrField('${id}','notes',this.value)">${escHtml(pr.notes||'')}</textarea>
        </div>
        <div class="field-group" style="grid-column:1/-1;margin:0;"><label>Internal Notes <span style="font-weight:400;color:var(--text3);">(tech only — never sent to client)</span></label>
          <textarea rows="2" onchange="updatePrField('${id}','internalNotes',this.value)">${escHtml(pr.internalNotes||'')}</textarea>
        </div>
      </div>
      <div style="font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:7px;">Line Items</div>
      ${itemsRows}
      <button class="btn-secondary" style="font-size:11px;margin-bottom:14px;" onclick="addPrItem('${id}')">+ Add Item</button>
      <div style="text-align:right;font-weight:700;margin-bottom:16px;" id="pr-grand-total-${id}">Estimated Total: $${total.toFixed(2)}</div>
      <div class="wizard-actions">
        <button class="btn-secondary" onclick="switchSection('quotes')">Back</button>
        <button class="btn-secondary" style="color:var(--danger);" onclick="deletePurchaseRequest('${id}')">Delete</button>
        <button class="btn-secondary" onclick="window.open('/api/purchase-requests/${id}/pdf','_blank')">Preview PDF</button>
        ${pr.invoiceId?`<button class="btn-secondary" onclick="selectInvoice('${pr.invoiceId}')">View Invoice</button>`
          :canGenerateInvoice?`<button class="btn-secondary" onclick="generateInvoiceFromPr('${id}')">Generate Invoice</button>`:''}
        <button class="btn-primary" ${canSend?'':'disabled'} onclick="sendPurchaseRequestForApproval('${id}')">${canSend?(pr.approvalStatus==='modified'?'Resend for Approval':'Send for Approval'):'Sent — '+purchaseRequestStatusLabel(pr.approvalStatus)}</button>
      </div>
    </div>`;
}

function updatePrField(id,field,value){
  const pr=purchaseRequests[id]; if(!pr) return;
  pr[field]=value;
  pr.updatedAt=Date.now();
  savePurchaseRequests();
  renderQuotesSidebar();
  if(CLIENT_VISIBLE_PR_FIELDS.has(field)) markPrModifiedIfResolved(id);
}
function updatePrClientFromSyncro(id,customer){
  const pr=purchaseRequests[id]; if(!pr) return;
  pr.clientId=String(customer.id);
  pr.clientName=customer.businessName||'';
  if(customer.email&&!pr.clientEmail) pr.clientEmail=customer.email;
  pr.updatedAt=Date.now();
  savePurchaseRequests();
  renderQuotesSidebar();
  renderPurchaseRequestDetail(id);
  markPrModifiedIfResolved(id);
}
function addPrItem(id){
  const pr=purchaseRequests[id]; if(!pr) return;
  pr.items=pr.items||[];
  pr.items.push({description:'',qty:1,estUnitCost:0,notes:'',vendor:'',url:'',sku:'',received:false});
  savePurchaseRequests();
  renderPurchaseRequestDetail(id);
  markPrModifiedIfResolved(id);
}
function removePrItem(id,idx){
  const pr=purchaseRequests[id]; if(!pr) return;
  pr.items.splice(idx,1);
  savePurchaseRequests();
  renderPurchaseRequestDetail(id);
  markPrModifiedIfResolved(id);
}
// Live (oninput): updates in-memory value + patches just this row's total and
// the grand total in place — never rebuilds the form, so typing never loses focus.
function livePrItem(id,idx,field,value){
  const pr=purchaseRequests[id]; if(!pr) return;
  const it=pr.items[idx]; if(!it) return;
  it[field]=parseFloat(value)||0;
  const rowTotalEl=document.getElementById(`pr-item-total-${id}-${idx}`);
  if(rowTotalEl) rowTotalEl.textContent='$'+((it.qty||0)*(it.estUnitCost||0)).toFixed(2);
  const grandTotalEl=document.getElementById(`pr-grand-total-${id}`);
  if(grandTotalEl){
    const total=(pr.items||[]).reduce((s,x)=>s+(x.qty||0)*(x.estUnitCost||0),0);
    grandTotalEl.textContent='Estimated Total: $'+total.toFixed(2);
  }
}
// Persisted (onchange/blur): safe to save + refresh the sidebar here since the
// field has already lost focus by the time this fires.
function savePrItem(id,idx,field,value){
  const pr=purchaseRequests[id]; if(!pr) return;
  const it=pr.items[idx]; if(!it) return;
  it[field]=(field==='qty'||field==='estUnitCost')?parseFloat(value)||0:value;
  savePurchaseRequests();
  renderQuotesSidebar();
  if(CLIENT_VISIBLE_PR_ITEM_FIELDS.has(field)) markPrModifiedIfResolved(id);
}

async function sendPurchaseRequestForApproval(id){
  const pr=purchaseRequests[id]; if(!pr) return;
  if(!pr.clientEmail){ showAlert(`pr-alert-${id}`,'error','Set a client email before sending.'); return; }
  try{
    const r=await fetch(`/api/purchase-requests/${id}/send-approval`,{method:'POST',headers:{'X-Tech-Name':localStorage.getItem('myName')||'','X-Session-Id':SESSION_ID}});
    const body=await r.json();
    if(!r.ok) throw new Error(body.error||'Failed to send');
    await loadPurchaseRequests();
    renderQuotesSidebar();
    renderPurchaseRequestDetail(id);
  }catch(e){ showAlert(`pr-alert-${id}`,'error',e.message); }
}

async function generateInvoiceFromPr(id){
  try{
    const r=await fetch(`/api/purchase-requests/${id}/generate-invoice`,{method:'POST',headers:{'X-Session-Id':SESSION_ID}});
    const body=await r.json();
    if(!r.ok) throw new Error(body.error||'Failed to generate invoice');
    await loadPurchaseRequests();
    await loadInvoices();
    renderQuotesSidebar();
    selectInvoice(body.invoiceId);
  }catch(e){ showAlert(`pr-alert-${id}`,'error',e.message); }
}

async function createInvoiceFromSidebar(){
  const r=await fetch('/api/invoices',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Id':SESSION_ID},body:JSON.stringify({lineItems:[]})});
  const body=await r.json();
  await loadInvoices();
  renderQuotesSidebar();
  selectInvoice(body.id);
}

function selectInvoice(id){
  activeInvoiceId=id;
  activePurchaseRequestId=null;
  activeQuotesTab='invoice';
  renderQuotesSidebar();
  showView('quotes');
  renderInvoiceDetail(id);
}

function calcInvoiceTotal(inv){
  const subtotal=(inv.lineItems||[]).reduce((s,it)=>s+(it.qty||0)*(it.unitPrice||0),0);
  const tax=subtotal*((inv.taxRate||0)/100);
  return {subtotal,tax,total:subtotal+tax};
}

function renderInvoiceDetail(id){
  const inv=invoices[id];
  const el=document.getElementById('quotes-content');
  if(!inv||!el) return;
  const itemsRows=(inv.lineItems||[]).map((it,i)=>`
    <tr>
      <td><input class="li-input" value="${escHtml(it.description||'')}" onchange="saveInvoiceItem('${id}',${i},'description',this.value)"></td>
      <td><input class="li-input" type="number" min="0" step="1" value="${it.qty||0}" style="width:70px;" oninput="liveInvoiceItem('${id}',${i},'qty',this.value)" onchange="saveInvoiceItem('${id}',${i},'qty',this.value)"></td>
      <td style="width:90px;">${liCurrencyInput(it.unitPrice, `liveInvoiceItem('${id}',${i},'unitPrice',this.value)`, `saveInvoiceItem('${id}',${i},'unitPrice',this.value)`)}</td>
      <td style="text-align:right;" id="inv-item-total-${id}-${i}">$${((it.qty||0)*(it.unitPrice||0)).toFixed(2)}</td>
      <td><button class="btn-secondary" style="padding:2px 8px;font-size:11px;" onclick="removeInvoiceItem('${id}',${i})">✕</button></td>
    </tr>`).join('');
  const totals=calcInvoiceTotal(inv);
  el.innerHTML=`
    <div class="wizard-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h2 style="margin:0;">Invoice #${inv.number}</h2>
        <span class="quote-status ${inv.status||'draft'}">${invoiceStatusLabel(inv.status)}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        ${renderSyncroClientField('inv-client-'+id,inv.clientName,c=>updateInvoiceClientFromSyncro(id,c))}
        <div class="field-group" style="margin:0;"><label>Status</label>
          <select onchange="updateInvoiceField('${id}','status',this.value)">
            ${['draft','sent','paid','overdue','void'].map(s=>`<option value="${s}" ${s===inv.status?'selected':''}>${invoiceStatusLabel(s)}</option>`).join('')}
          </select>
        </div>
        <div class="field-group" style="margin:0;"><label>Tax Rate (%)</label>
          <input type="number" min="0" step="0.01" value="${inv.taxRate||0}" oninput="liveInvoiceField('${id}','taxRate',this.value)" onchange="updateInvoiceField('${id}','taxRate',this.value)">
        </div>
        <div class="field-group" style="margin:0;"><label>Due Date</label>
          <input type="date" value="${inv.dueDate?new Date(inv.dueDate).toISOString().slice(0,10):''}" onchange="updateInvoiceField('${id}','dueDate',this.value?new Date(this.value).getTime():null)">
        </div>
        <div class="field-group" style="grid-column:1/-1;margin:0;"><label>Notes</label>
          <textarea rows="2" onchange="updateInvoiceField('${id}','notes',this.value)">${escHtml(inv.notes||'')}</textarea>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px;">
        <thead><tr><th style="text-align:left;">Description</th><th>Qty</th><th>Unit Price</th><th style="text-align:right;">Total</th><th></th></tr></thead>
        <tbody>${itemsRows}</tbody>
      </table>
      <button class="btn-secondary" style="font-size:11px;margin-bottom:14px;" onclick="addInvoiceItem('${id}')">+ Add Line Item</button>
      <div style="text-align:right;margin-bottom:16px;" id="inv-totals-${id}">
        <div>Subtotal: $${totals.subtotal.toFixed(2)}</div>
        <div>Tax: $${totals.tax.toFixed(2)}</div>
        <div style="font-weight:700;">Total: $${totals.total.toFixed(2)}</div>
      </div>
      <div class="wizard-actions">
        <button class="btn-secondary" onclick="switchSection('quotes')">Back</button>
        <button class="btn-secondary" style="color:var(--danger);" onclick="deleteInvoice('${id}')">Delete</button>
        <button class="btn-secondary" onclick="printInvoice('${id}')">Print</button>
      </div>
    </div>`;
}

function refreshInvoiceTotalsDisplay(id){
  const inv=invoices[id]; if(!inv) return;
  const el=document.getElementById(`inv-totals-${id}`); if(!el) return;
  const totals=calcInvoiceTotal(inv);
  el.innerHTML=`
    <div>Subtotal: $${totals.subtotal.toFixed(2)}</div>
    <div>Tax: $${totals.tax.toFixed(2)}</div>
    <div style="font-weight:700;">Total: $${totals.total.toFixed(2)}</div>`;
}

function updateInvoiceField(id,field,value){
  const inv=invoices[id]; if(!inv) return;
  if(field==='taxRate') inv.taxRate=parseFloat(value)||0;
  else inv[field]=value;
  inv.updatedAt=Date.now();
  saveInvoices();
  renderQuotesSidebar();
}
function updateInvoiceClientFromSyncro(id,customer){
  const inv=invoices[id]; if(!inv) return;
  inv.clientId=String(customer.id);
  inv.clientName=customer.businessName||'';
  inv.updatedAt=Date.now();
  saveInvoices();
  renderQuotesSidebar();
  renderInvoiceDetail(id);
}
// Live (oninput, tax rate only — the one non-item field with a visible total impact).
function liveInvoiceField(id,field,value){
  const inv=invoices[id]; if(!inv) return;
  if(field==='taxRate') inv.taxRate=parseFloat(value)||0;
  refreshInvoiceTotalsDisplay(id);
}
function addInvoiceItem(id){
  const inv=invoices[id]; if(!inv) return;
  inv.lineItems=inv.lineItems||[];
  inv.lineItems.push({description:'',qty:1,unitPrice:0});
  saveInvoices();
  renderInvoiceDetail(id);
}
function removeInvoiceItem(id,idx){
  const inv=invoices[id]; if(!inv) return;
  inv.lineItems.splice(idx,1);
  saveInvoices();
  renderInvoiceDetail(id);
}
// Live (oninput): updates in-memory value + patches this row's total and the
// overall totals block in place — never rebuilds the form.
function liveInvoiceItem(id,idx,field,value){
  const inv=invoices[id]; if(!inv) return;
  const it=inv.lineItems[idx]; if(!it) return;
  it[field]=parseFloat(value)||0;
  const rowTotalEl=document.getElementById(`inv-item-total-${id}-${idx}`);
  if(rowTotalEl) rowTotalEl.textContent='$'+((it.qty||0)*(it.unitPrice||0)).toFixed(2);
  refreshInvoiceTotalsDisplay(id);
}
// Persisted (onchange/blur).
function saveInvoiceItem(id,idx,field,value){
  const inv=invoices[id]; if(!inv) return;
  const it=inv.lineItems[idx]; if(!it) return;
  it[field]=(field==='qty'||field==='unitPrice')?parseFloat(value)||0:value;
  saveInvoices();
  renderQuotesSidebar();
}

function printInvoice(id){
  const inv=invoices[id]; if(!inv) return;
  // Browsers render PDFs natively in a new tab (with their own print button),
  // so this just opens the server-rendered branded PDF — no HTML template to
  // keep in sync with pdf.js's layout.
  window.open(`/api/invoices/${id}/pdf`, '_blank');
}

function newQuoteFromSidebar(){
  if(isMobile()) closeOverlays();
  showView('new-quote');
}
function filterQuotes(val){renderSalesSidebar(val);}

function renderSalesSidebar(filter){
  const list=document.getElementById('sales-list');
  if(!list) return;
  const entries=Object.values(salesQuotes).filter(q=>!filter||q.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b)=>(b.priority?1:0)-(a.priority?1:0)||new Date(b.lastModified||b.createdAt)-new Date(a.lastModified||a.createdAt));
  if(!entries.length){
    list.innerHTML=`<div style="padding:20px 12px;text-align:center;"><div style="font-size:24px;height:30px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;opacity:0.4;">💼</div><div style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:4px;">${filter?'No matches':'No quotes yet'}</div>${filter?'':`<div style="font-size:11px;color:var(--text3);">Use the button below to get started</div>`}</div>`;
    return;
  }
  list.innerHTML=entries.map(q=>{
    const t=calcQuoteTotals(q);
    return `<div class="client-item ${q.id===activeSalesQuoteId?'active':''}" title="${q.name}">
      <div style="padding:7px 32px 7px 14px;" onclick="selectQuote('${q.id}')">
        <div class="cn"><span>${escHtml(q.name)}</span>${quoteStatusBadge(q.status)}</div>
        <div class="cm">${escHtml(q.tech)} · $${t.monthlyClient.toFixed(0)}/mo${t.onetimeClient>0?' + $'+t.onetimeClient.toFixed(0)+' OT':''}</div>
      </div>
      <button class="sidebar-star${q.priority?' on':''}" onclick="toggleQuotePriority('${q.id}')" title="${q.priority?'Unmark priority':'Mark priority'}"><svg width="16" height="16" viewBox="0 0 24 24" fill="${q.priority?'currentColor':'none'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
    </div>`;
  }).join('');
}

function selectQuote(id){
  if(isMobile()) closeOverlays();
  activeSalesQuoteId=id;
  renderSalesSidebar(document.getElementById('sales-search')?.value||'');
  loadSalesQuote(id);
}

function resolveQtySource(src,nums){
  if(src==='employees') return nums.employees;
  if(src==='licensedUsers') return nums.licensedUsers;
  if(src==='workstations') return nums.workstations;
  if(src==='servers') return nums.servers;
  if(src==='machines') return nums.workstations+nums.servers;
  if(src==='backedUpMachines') return nums.backedUpMachines;
  if(src==='sites') return nums.sites;
  return 0;
}

async function createQuote(){
  const name=document.getElementById('qwiz-name').value.trim();
  if(!name){showAlert('quote-wizard-alert','error','Company name is required.');return;}
  const nums={
    employees:parseInt(document.getElementById('qwiz-emp').value)||0,
    licensedUsers:parseInt(document.getElementById('qwiz-users').value)||0,
    workstations:parseInt(document.getElementById('qwiz-ws').value)||0,
    servers:parseInt(document.getElementById('qwiz-srv').value)||0,
    sites:parseInt(document.getElementById('qwiz-sites').value)||1,
    backedUpMachines:parseInt(document.getElementById('qwiz-backup').value)||0,
  };
  const id='quote-'+Date.now();
  const lineItems={};
  getSalesProducts().forEach(p=>{
    const qty=resolveQtySource(p.qtySource||'',nums);
    lineItems[p.id]={enabled:qty>0,qty,unitPrice:p.defaultPrice,note:''};
  });
  salesQuotes[id]={
    id,name,contact:document.getElementById('qwiz-contact').value.trim(),
    tech:document.getElementById('qwiz-tech').value.trim()||localStorage.getItem('myName')||'Unassigned',
    createdAt:new Date().toISOString(),lastModified:new Date().toISOString(),
    ...nums,nonManagedMachines:0,localBackupTB:0,cloudBackupTB:0,notes:'',lineItems,customItems:[],status:'draft',priority:false
  };
  await saveSalesQuotes();
  logQuote(id,'quote_created',{clientName:name});
  renderSalesSidebar();
  selectQuote(id);
}

function calcQuoteTotals(q){
  const prods=getSalesProducts();
  let monthlyClient=0,onetimeClient=0,monthlySA=0;
  prods.forEach(p=>{
    const li=q.lineItems?.[p.id];
    if(!li||!li.enabled)return;
    if(p.billing==='monthly'){monthlyClient+=li.qty*li.unitPrice;monthlySA+=li.qty*(p.saCost||0);}
    else{onetimeClient+=li.qty*li.unitPrice;}
  });
  (q.customItems||[]).forEach(c=>{
    if(c.enabled===false)return;
    if(c.billing==='monthly')monthlyClient+=c.qty*c.unitPrice;
    else onetimeClient+=c.qty*c.unitPrice;
  });
  return{monthlyClient,onetimeClient,monthlySA,profit:monthlyClient-monthlySA};
}

function loadSalesQuote(id){
  activeSalesQuoteId=id;
  const q=salesQuotes[id];
  if(!q){showView('sales');return;}
  const prods=getSalesProducts();
  const totals=calcQuoteTotals(q);
  const sections=[{key:'user',label:'User Products'},{key:'machine',label:'Machine Products'},{key:'site',label:'Site Products'}];
  const isCustomerView=document.getElementById('quote-content')?.dataset?.customer==='1';
  let html=`<div class="checklist-header" style="margin-bottom:0;">
    <div>
      <h2 style="font-size:18px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${escHtml(q.name)}
        <span class="status-badge-wrap">
          <span class="quote-status ${q.status||'draft'}" onclick="toggleStatusDropdown('${id}')" style="cursor:pointer;" title="Change status">${quoteStatusLabel(q.status)}</span>
          <div class="status-dropdown" id="status-dd-${id}">
            <button onclick="closeStatusDropdown('${id}');saveQuoteStatus('${id}','draft')">Draft</button>
            <button onclick="closeStatusDropdown('${id}');saveQuoteStatus('${id}','sent')">Sent</button>
            <button onclick="closeStatusDropdown('${id}');saveQuoteStatus('${id}','accepted')">Accepted</button>
            <button onclick="closeStatusDropdown('${id}');saveQuoteStatus('${id}','rejected')">Rejected</button>
          </div>
        </span>
        <button class="quote-status${isCustomerView?' customer-active':''}" onclick="toggleCustomerView('${id}')" title="Toggle customer view">${isCustomerView?'Exit Customer View':'Show Customer View'}</button>
      </h2>
      <div style="font-size:11px;color:var(--text3);">${escHtml(q.tech)}${q.contact?' · '+escHtml(q.contact):''} · Created ${relTime(q.createdAt)}</div>
    </div>
    <div class="header-actions">
      <button class="step-note-btn${q.notes?' has-note':''}" id="qnotes-btn-${id}" onclick="toggleHeaderNote('${id}','quote')" title="Quote notes">Notes</button>
      <div class="client-menu-wrap" id="qmenu-wrap-${id}">
        <button class="client-menu-btn" onclick="toggleQuoteMenu('${id}')">&#8230;</button>
        <div class="client-menu-dropdown" id="qmenu-${id}">
          <button class="client-menu-item" onclick="closeQuoteMenu('${id}');showQuoteSummary('${id}')">Summary</button>
          <button class="client-menu-item" onclick="closeQuoteMenu('${id}');showQuoteLog('${id}')">View Log</button>
          <button class="client-menu-item warn" onclick="closeQuoteMenu('${id}');editQuoteInfo('${id}')">Edit</button>
          <button class="client-menu-item danger" onclick="closeQuoteMenu('${id}');deleteQuote('${id}')">Delete</button>
        </div>
      </div>
    </div>
  </div>
  <div class="header-note-area${q.notes?' open':''}" id="qnotes-${id}" style="margin-bottom:16px;">
    <textarea class="inline-notes-ta" placeholder="Add notes about this quote..." onblur="saveInlineQuoteNotes('${id}',this.value)">${escHtml(q.notes||'')}</textarea>
  </div>
  <div class="quote-sticky-totals">
    <div class="qst-item"><span class="qst-label">Monthly</span><span class="qst-value" id="qstv-mo-${id}">$${totals.monthlyClient.toFixed(2)}</span></div>
    <div class="qst-item"><span class="qst-label">One Time</span><span class="qst-value" id="qstv-ot-${id}">$${totals.onetimeClient.toFixed(2)}</span></div>
    <div class="qst-item qst-sa"><span class="qst-label">SA Cost</span><span class="qst-value" id="qstv-sa-${id}" style="color:var(--text3);">$${totals.monthlySA.toFixed(2)}</span></div>
    <div class="qst-item qst-profit"><span class="qst-label">Profit</span><span class="qst-value ${totals.profit>=0?'profit-pos':'profit-neg'}" id="qstv-pr-${id}">$${totals.profit.toFixed(2)}</span></div>
  </div>
  <div class="quote-col-hdr">
    <div style="flex:1;"></div>
    <div style="width:52px;text-align:right;">Qty</div>
    <div style="width:64px;text-align:right;">List</div>
    <div style="width:72px;text-align:right;">$/Unit</div>
    <div class="quote-disc-hdr" style="width:40px;text-align:center;">Disc</div>
    <div style="width:78px;text-align:right;">Cost</div>
    <div style="width:72px;text-align:right;">Freq</div>
    <div style="width:28px;flex-shrink:0;"></div>
  </div>`;
  sections.forEach(sec=>{
    const sp=prods.filter(p=>p.salesCategory===sec.key);
    const secCustom=(q.customItems||[]).filter(c=>c.category===sec.key);
    if(!sp.length&&!secCustom.length)return;
    const secTotals={mo:0,ot:0};
    sp.forEach(p=>{const li=q.lineItems?.[p.id];if(li?.enabled){if(p.billing==='monthly')secTotals.mo+=li.qty*li.unitPrice;else secTotals.ot+=li.qty*li.unitPrice;}});
    secCustom.forEach(c=>{if(c.enabled!==false){if(c.billing==='monthly')secTotals.mo+=c.qty*c.unitPrice;else secTotals.ot+=c.qty*c.unitPrice;}});
    html+=`<div class="quote-section">
      <div class="quote-section-header" onclick="this.closest('.quote-section').classList.toggle('collapsed')">
        <span>${sec.label}</span>
        <span class="quote-section-subtotal" id="qsub-${id}-${sec.key}">${secTotals.mo>0||secTotals.ot>0?'$'+secTotals.mo.toFixed(0)+'/mo'+(secTotals.ot>0?' + $'+secTotals.ot.toFixed(0)+' OT':''):'—'}</span>
        <span class="quote-section-toggle">▼</span>
      </div>
      <div class="quote-section-body">`;
    // Group items: standalone vs grouped by parentId
    const groups=[];const seenParents=new Set();
    sp.forEach(p=>{
      if(p.parentId){
        if(!seenParents.has(p.parentId)){seenParents.add(p.parentId);groups.push({parentLabel:p.parentLabel,items:sp.filter(pp=>pp.parentId===p.parentId)});}
      }else{groups.push({parentLabel:p.label,items:[p]});}
    });
    // Helper for rendering a standard product line
    const renderProductLine=(p,li,nid,indent)=>{
      const on=li.enabled;
      const cost=on?li.qty*li.unitPrice:0;
      const listStr=p.defaultPrice!=null?'$'+p.defaultPrice.toFixed(2):'—';
      const discPct=p.defaultPrice?Math.round((li.unitPrice-p.defaultPrice)/p.defaultPrice*100):null;
      const discStr=discPct===null||discPct===0?'—':(discPct>0?'+':'')+discPct+'%';
      const discCls='quote-disc'+(discPct>0?' inc':discPct<0?' dec':'');
      return`<div class="qline-wrap${li.note?' note-open':''}" id="${nid}"${indent?' style="padding-left:12px;"':''}>
        <div class="quote-line${on?'':' disabled'}">
          <div class="quote-check${on?' on':''}" onclick="toggleSalesLine('${id}','${p.id}')">${on?'✓':''}</div>
          <div class="quote-label" style="display:flex;flex-direction:column;justify-content:center;min-width:0;gap:1px;">
            <div style="display:flex;align-items:center;gap:5px;min-width:0;">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(p.label)}</span>
              <button class="quote-note-btn${li.note?' has-note':''}" onclick="toggleQuoteNote('${nid}')" title="Notes">&#9998;</button>
            </div>
            ${p.desc?`<span style="font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2;">${escHtml(p.desc)}</span>`:''}
          </div>
          <input class="quote-input" style="width:52px;" type="number" min="0" value="${li.qty}" oninput="onQuoteInputChange('${id}','${p.id}','qty',this.valueAsNumber||0)" onblur="saveQuoteInput('${id}','${p.id}','qty',this.valueAsNumber||0)" title="Quantity">
          <div class="quote-list">${listStr}</div>
          <input class="quote-input" style="width:72px;" type="number" min="0" step="0.05" value="${(li.unitPrice||0).toFixed(2)}" oninput="onQuoteInputChange('${id}','${p.id}','unitPrice',this.valueAsNumber||0)" onblur="saveQuoteInput('${id}','${p.id}','unitPrice',this.valueAsNumber||0)" title="Price per unit">
          <div class="${discCls}" id="qdisc-${id}-${p.id}">${discStr}</div>
          <div class="quote-col${cost>0?' active':''}" id="qcost-${id}-${p.id}">${cost>0?'$'+cost.toFixed(2):'-'}</div>
          <span class="quote-billing-tag" style="width:64px;text-align:center;">${p.billing==='onetime'?'One Time':'Monthly'}</span>
          <div class="quote-del"></div>
        </div>
        <div class="quote-note-area"><textarea placeholder="Item note..." oninput="onQuoteNoteInput('${nid}',this.value)" onblur="onSaleNoteBlur('${nid}','${id}','${p.id}',this.value)">${escHtml(li.note||'')}</textarea></div>
      </div>`;
    };
    groups.forEach(g=>{
      html+=`<div class="quote-group-header">${escHtml(g.parentLabel)}</div>`;
      const indent=g.items.length>1;
      g.items.forEach(p=>{
        const li=q.lineItems?.[p.id]||{enabled:false,qty:0,unitPrice:p.defaultPrice||0,note:''};
        html+=renderProductLine(p,li,`qln-${id}-${p.id}`,indent);
      });
    });
    // Custom items
    secCustom.forEach(c=>{
      const enabled=c.enabled!==false;
      const cost=enabled?c.qty*c.unitPrice:0;
      const cnid=`qln-${id}-${c.id}`;
      html+=`<div class="qline-wrap${c.note?' note-open':''}" id="${cnid}">
        <div class="quote-line${enabled?'':' disabled'}">
          <div class="quote-check${enabled?' on':''}" onclick="toggleCustomLine('${id}','${c.id}')">${enabled?'✓':''}</div>
          <div class="quote-label" style="display:flex;align-items:center;gap:5px;min-width:0;">
            <input class="quote-custom-label" style="flex:1;" placeholder="Custom item..." value="${escHtml(c.label)}" onblur="updateCustomLabel('${id}','${c.id}',this.value)">
            <button class="quote-note-btn${c.note?' has-note':''}" onclick="toggleQuoteNote('${cnid}')" title="Notes">&#9998;</button>
          </div>
          <input class="quote-input" style="width:52px;" type="number" min="0" value="${c.qty}" oninput="onCustomInputChange('${id}','${c.id}','qty',this.valueAsNumber||0)" onblur="saveCustomInput('${id}','${c.id}','qty',this.valueAsNumber||0)" title="Quantity">
          <div class="quote-list" style="color:transparent;">—</div>
          <input class="quote-input" style="width:72px;" type="number" min="0" step="0.05" value="${(c.unitPrice||0).toFixed(2)}" oninput="onCustomInputChange('${id}','${c.id}','unitPrice',this.valueAsNumber||0)" onblur="saveCustomInput('${id}','${c.id}','unitPrice',this.valueAsNumber||0)" title="Price per unit">
          <div class="quote-disc">—</div>
          <div class="quote-col${cost>0?' active':''}" id="qcost-${id}-${c.id}">${cost>0?'$'+cost.toFixed(2):'-'}</div>
          <select class="quote-billing-sel" style="width:64px;" onchange="updateCustomBilling('${id}','${c.id}',this.value)">
            <option value="monthly" ${c.billing==='monthly'?'selected':''}>Monthly</option>
            <option value="onetime" ${c.billing==='onetime'?'selected':''}>One Time</option>
          </select>
          <button class="quote-del-btn" onclick="styledConfirm('Remove this item?',()=>deleteCustomQuoteLine('${id}','${c.id}'))" title="Remove">&#215;</button>
        </div>
        <div class="quote-note-area"><textarea placeholder="Item note..." oninput="onQuoteNoteInput('${cnid}',this.value)" onblur="onCustomNoteBlur('${cnid}','${id}','${c.id}',this.value)">${escHtml(c.note||'')}</textarea></div>
      </div>`;
    });
    html+=`<div style="padding:6px 14px 8px;">
      <button class="quote-add-item-btn" onclick="addCustomQuoteLine('${id}','${sec.key}')">+ Add Item</button>
    </div>`;
    html+=`</div></div>`;
  });
  document.getElementById('quote-content').innerHTML=html;
  showView('quote');
}

async function toggleSalesLine(quoteId,productId){
  const q=salesQuotes[quoteId];if(!q)return;
  if(!q.lineItems[productId])q.lineItems[productId]={enabled:false,qty:0,unitPrice:getSalesProducts().find(p=>p.id===productId)?.defaultPrice||0,note:''};
  const wantEnable=!q.lineItems[productId].enabled;
  const p=getSalesProducts().find(pp=>pp.id===productId);
  // Dependency check: all required items must be enabled first
  if(wantEnable){
    const reqIds=Array.isArray(p?.requires)?p.requires:p?.requires?[p.requires]:[];
    for(const rid of reqIds){
      if(!q.lineItems[rid]?.enabled){
        const rp=getSalesProducts().find(pp=>pp.id===rid);
        showToast(`"${p.label}" requires "${rp?.label||rid}" to be enabled first`,'warn');
        return;
      }
    }
  }
  // When disabling, auto-disable any dependents
  if(!wantEnable){
    const allProds=getSalesProducts();
    const dependents=allProds.filter(pp=>{
      const reqs=Array.isArray(pp.requires)?pp.requires:pp.requires?[pp.requires]:[];
      return reqs.includes(productId)&&q.lineItems[pp.id]?.enabled;
    });
    if(dependents.length){
      dependents.forEach(pp=>{q.lineItems[pp.id].enabled=false;});
      showToast(`Also disabled ${dependents.length} dependent item${dependents.length>1?'s':''}`,'warn');
    }
  }
  // Exclusion group: auto-deselect conflicting items
  if(wantEnable&&p?.exclusionGroup){
    const conflicts=getSalesProducts().filter(pp=>pp.exclusionGroup===p.exclusionGroup&&pp.id!==productId&&q.lineItems[pp.id]?.enabled);
    if(conflicts.length){
      conflicts.forEach(pp=>{q.lineItems[pp.id].enabled=false;});
      showToast(`Switched to ${p.label} — deselected ${conflicts.map(pp=>pp.label).join(', ')}`, 'info');
    }
  }
  q.lineItems[productId].enabled=wantEnable;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  logQuote(quoteId,wantEnable?'line_enabled':'line_disabled',{details:p?.label||productId});
  renderSalesSidebar(document.getElementById('sales-search')?.value||'');
  loadSalesQuote(quoteId);
}
// Live update: updates in-memory + column cells + totals without re-rendering
function onQuoteInputChange(quoteId,productId,field,val){
  const q=salesQuotes[quoteId];if(!q)return;
  if(!q.lineItems[productId]){const p=getSalesProducts().find(pp=>pp.id===productId);q.lineItems[productId]={enabled:false,qty:0,unitPrice:p?.defaultPrice||0,note:''};}
  q.lineItems[productId][field]=isNaN(val)?0:+val;
  const li=q.lineItems[productId];
  const p=getSalesProducts().find(pp=>pp.id===productId);
  if(p){
    const cost=li.enabled?li.qty*li.unitPrice:0;
    const costEl=document.getElementById(`qcost-${quoteId}-${productId}`);
    if(costEl){costEl.textContent=cost>0?'$'+cost.toFixed(2):'-';costEl.classList.toggle('active',cost>0);}
    // Update discount %
    const discEl=document.getElementById(`qdisc-${quoteId}-${productId}`);
    if(discEl&&p.defaultPrice){
      const pct=Math.round((li.unitPrice-p.defaultPrice)/p.defaultPrice*100);
      discEl.textContent=pct===0?'—':(pct>0?'+':'')+pct+'%';
      discEl.className='quote-disc'+(pct>0?' inc':pct<0?' dec':'');
    }
  }
  refreshQuoteUI(quoteId);
}
// Save to server on blur without re-rendering
async function saveQuoteInput(quoteId,productId,field,val){
  const q=salesQuotes[quoteId];if(!q)return;
  if(!q.lineItems[productId]){const p=getSalesProducts().find(pp=>pp.id===productId);q.lineItems[productId]={enabled:false,qty:0,unitPrice:p?.defaultPrice||0,note:''};}
  q.lineItems[productId][field]=isNaN(val)?0:+val;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  renderSalesSidebar(document.getElementById('sales-search')?.value||'');
}
function onCustomInputChange(quoteId,customId,field,val){
  const q=salesQuotes[quoteId];if(!q)return;
  const c=(q.customItems||[]).find(c=>c.id===customId);if(!c)return;
  c[field]=isNaN(val)?0:+val;
  const cost=c.enabled!==false?c.qty*c.unitPrice:0;
  const costEl=document.getElementById(`qcost-${quoteId}-${customId}`);
  if(costEl){costEl.textContent=cost>0?'$'+cost.toFixed(2):'-';costEl.classList.toggle('active',cost>0);}
  refreshQuoteUI(quoteId);
}
async function saveCustomInput(quoteId,customId,field,val){
  const q=salesQuotes[quoteId];if(!q)return;
  const c=(q.customItems||[]).find(c=>c.id===customId);if(!c)return;
  c[field]=isNaN(val)?0:+val;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  renderSalesSidebar(document.getElementById('sales-search')?.value||'');
}
function onQuoteNoteInput(wrapperId,val){
  document.querySelector(`#${wrapperId} .quote-note-btn`)?.classList.toggle('has-note',!!val.trim());
}
function onSaleNoteBlur(wrapperId,quoteId,productId,val){
  updateSalesNote(quoteId,productId,val);
  if(!val.trim())document.getElementById(wrapperId)?.classList.remove('note-open');
}
function onCustomNoteBlur(wrapperId,quoteId,customId,val){
  updateCustomNote(quoteId,customId,val);
  if(!val.trim())document.getElementById(wrapperId)?.classList.remove('note-open');
}
function refreshQuoteUI(quoteId){
  const q=salesQuotes[quoteId];if(!q)return;
  const t=calcQuoteTotals(q);
  const prods=getSalesProducts();
  // Sticky totals via IDs
  const moEl=document.getElementById(`qstv-mo-${quoteId}`);if(moEl)moEl.textContent='$'+t.monthlyClient.toFixed(2);
  const otEl=document.getElementById(`qstv-ot-${quoteId}`);if(otEl)otEl.textContent='$'+t.onetimeClient.toFixed(2);
  const saEl=document.getElementById(`qstv-sa-${quoteId}`);if(saEl)saEl.textContent='$'+t.monthlySA.toFixed(2);
  const prEl=document.getElementById(`qstv-pr-${quoteId}`);
  if(prEl){prEl.textContent='$'+t.profit.toFixed(2);prEl.className='qst-value '+(t.profit>=0?'profit-pos':'profit-neg');}
  // Section subtotals via IDs
  ['user','machine','site'].forEach(key=>{
    const sp=prods.filter(p=>p.salesCategory===key);
    const sc=(q.customItems||[]).filter(c=>c.category===key&&c.enabled!==false);
    const mo=sp.reduce((s,p)=>{const li=q.lineItems?.[p.id];return s+(li?.enabled&&p.billing==='monthly'?li.qty*li.unitPrice:0);},0)+sc.reduce((s,c)=>s+(c.billing==='monthly'?c.qty*c.unitPrice:0),0);
    const ot=sp.reduce((s,p)=>{const li=q.lineItems?.[p.id];return s+(li?.enabled&&p.billing==='onetime'?li.qty*li.unitPrice:0);},0)+sc.reduce((s,c)=>s+(c.billing==='onetime'?c.qty*c.unitPrice:0),0);
    const subEl=document.getElementById(`qsub-${quoteId}-${key}`);
    if(subEl)subEl.textContent=mo>0||ot>0?'$'+mo.toFixed(0)+'/mo'+(ot>0?' + $'+ot.toFixed(0)+' OT':''):'—';
  });
}
// Legacy wrappers kept for wheel-handler compatibility (no re-render)
async function updateSalesQty(quoteId,productId,val){await saveQuoteInput(quoteId,productId,'qty',val);}
async function updateSalesPrice(quoteId,productId,val){await saveQuoteInput(quoteId,productId,'unitPrice',val);}
async function updateSalesNote(quoteId,productId,val){
  const q=salesQuotes[quoteId];if(!q||!q.lineItems?.[productId])return;
  q.lineItems[productId].note=val;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
}

function toggleQuoteNote(wrapperId){
  document.getElementById(wrapperId)?.classList.toggle('note-open');
}
async function toggleCustomLine(quoteId,customId){
  const q=salesQuotes[quoteId];if(!q)return;
  const c=(q.customItems||[]).find(c=>c.id===customId);if(!c)return;
  const wasEnabled=c.enabled===false?true:false;
  c.enabled=wasEnabled;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  logQuote(quoteId,wasEnabled?'line_enabled':'line_disabled',{details:c.label||'Custom item'});
  loadSalesQuote(quoteId);
}
async function toggleQuotePriority(id){
  const q=salesQuotes[id];if(!q)return;
  q.priority=!q.priority;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  renderSalesSidebar();
  if(activeSalesQuoteId===id) loadSalesQuote(id);
}
function quoteStatusLabel(s){return{draft:'Draft',sent:'Sent',accepted:'Accepted',rejected:'Rejected'}[s]||'Draft';}
function quoteStatusBadge(status){
  return`<span class="quote-status ${status||'draft'}">${quoteStatusLabel(status)}</span>`;
}
async function saveQuoteStatus(id,status){
  const q=salesQuotes[id];if(!q)return;
  q.status=status;q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  renderSalesSidebar();
  loadSalesQuote(id);
}
function logQuote(quoteId,action,details={}){
  const myName=localStorage.getItem('myName')||'';
  const q=salesQuotes[quoteId];
  fetch('/api/logs',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ts:new Date().toISOString(),tech:myName,action,clientId:quoteId,clientName:q?.name||null,...details})
  }).catch(_=>{});
}
async function showQuoteLog(quoteId){
  const q=salesQuotes[quoteId];
  const modal=document.getElementById('log-modal');
  document.getElementById('log-modal-title').textContent=(q?.name||'Quote')+' — Activity Log';
  document.getElementById('log-modal-body').innerHTML='<div style="color:var(--text3);font-size:11px;">Loading…</div>';
  modal.style.display='flex';
  try{
    const r=await fetch(`/api/logs?clientId=${quoteId}&limit=200`);
    const logs=await r.json();
    renderLogTimeline(document.getElementById('log-modal-body'),logs);
  }catch(e){document.getElementById('log-modal-body').innerHTML=`<div style="color:#fca5a5;font-size:11px;">Failed to load logs: ${e.message}</div>`;}
}
async function saveInlineQuoteNotes(quoteId,val){
  const q=salesQuotes[quoteId];if(!q)return;
  q.notes=val;
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  const btn=document.getElementById(`qnotes-btn-${quoteId}`);
  if(btn)btn.classList.toggle('has-note',!!val);
}
function toggleCustomerView(id){
  const el=document.getElementById('quote-content');if(!el)return;
  const isOn=el.dataset.customer==='1';
  if(isOn) el.removeAttribute('data-customer');
  else el.dataset.customer='1';
  loadSalesQuote(id);
}
function printQuoteCustomer(id){
  const q=salesQuotes[id];if(!q)return;
  const prods=getSalesProducts();
  const t=calcQuoteTotals(q);
  const orgName=config?.orgName||'System Alternatives';
  const date=new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const sections=[{key:'user',label:'User Products'},{key:'machine',label:'Machine Products'},{key:'site',label:'Site Products'}];
  let rows='';let rowIdx=0;
  sections.forEach(sec=>{
    const sp=prods.filter(p=>p.salesCategory===sec.key&&q.lineItems?.[p.id]?.enabled);
    const sc=(q.customItems||[]).filter(c=>c.category===sec.key&&c.enabled!==false&&(c.qty>0||c.unitPrice>0));
    if(!sp.length&&!sc.length)return;
    rows+=`<tr class="sec-hdr"><td colspan="4">${sec.label}</td></tr>`;
    sp.forEach(p=>{
      const li=q.lineItems[p.id];
      const cost=li.qty*li.unitPrice;
      const note=li.note||'';
      rows+=`<tr class="${rowIdx++%2?'even':''}"><td>${p.label}${note?`<div class="note">${note}</div>`:''}</td><td class="r">${li.qty}</td><td class="r">$${li.unitPrice.toFixed(2)}</td><td class="r">${p.billing==='onetime'?'One Time':'Monthly'}</td></tr>`;
    });
    sc.forEach(c=>{
      const note=c.note||'';
      rows+=`<tr class="${rowIdx++%2?'even':''} custom"><td>${c.label||'(Custom item)'}${note?`<div class="note">${note}</div>`:''}</td><td class="r">${c.qty}</td><td class="r">$${c.unitPrice.toFixed(2)}</td><td class="r">${c.billing==='onetime'?'One Time':'Monthly'}</td></tr>`;
    });
  });
  const css=`*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1a1d23;background:#fff;font-size:13px;line-height:1.5;}.accent-bar{height:4px;background:linear-gradient(90deg,#3b82f6,#6366f1);}.header{padding:28px 32px 20px;border-bottom:1px solid #e5e7eb;}.org{font-size:22px;font-weight:800;color:#1a1d23;letter-spacing:-0.3px;}.quote-label-hdr{font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;}.meta-row{display:flex;gap:24px;flex-wrap:wrap;padding:14px 32px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;}.meta-item{display:flex;flex-direction:column;gap:2px;}.meta-label{font-size:10px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;}.meta-val{font-weight:600;color:#111827;}.body{padding:20px 32px 32px;}table{width:100%;border-collapse:collapse;margin-top:0;}thead tr{background:#f0f4ff;}th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#1e3a8a;padding:10px 12px;text-align:left;border-bottom:2px solid #bfdbfe;}td{padding:8px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;}tr.even td{background:#f9fafb;}tr.sec-hdr td{background:#eff6ff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#1e40af;padding:8px 12px;border-top:8px solid #fff;border-bottom:1px solid #bfdbfe;}tr.custom td:first-child{font-style:italic;}.note{font-size:11px;color:#6b7280;margin-top:2px;font-style:italic;}.r{text-align:right;}.totals-wrap{display:flex;justify-content:flex-end;margin-top:20px;}.totals-card{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;min-width:260px;}.totals-card table{margin-top:0;}.totals-card th{background:#f8fafc;color:#6b7280;}.totals-card td{padding:9px 14px;}.tot-label{font-weight:500;color:#374151;}.tot-val{text-align:right;font-weight:700;}.notes-block{margin-top:24px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;}.notes-block strong{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#92400e;}.notes-text{margin-top:6px;font-size:12px;color:#78350f;line-height:1.6;white-space:pre-wrap;}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}`;
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quote — ${escHtml(q.name)}</title><style>${css}</style></head><body>
<div class="accent-bar"></div>
<div class="header"><div class="org">${escHtml(orgName)}</div><div class="quote-label-hdr">Sales Quote</div></div>
<div class="meta-row">
  <div class="meta-item"><span class="meta-label">Company</span><span class="meta-val">${escHtml(q.name)}</span></div>
  ${q.contact?`<div class="meta-item"><span class="meta-label">Contact</span><span class="meta-val">${escHtml(q.contact)}</span></div>`:''}
  <div class="meta-item"><span class="meta-label">Prepared by</span><span class="meta-val">${escHtml(q.tech)}</span></div>
  <div class="meta-item"><span class="meta-label">Date</span><span class="meta-val">${date}</span></div>
</div>
<div class="body">
<table><thead><tr><th>Product / Service</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Billing</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="totals-wrap"><div class="totals-card"><table>
  <tr><td class="tot-label">Monthly Total</td><td class="tot-val">$${t.monthlyClient.toFixed(2)}</td></tr>
  <tr><td class="tot-label">One-Time Total</td><td class="tot-val">$${t.onetimeClient.toFixed(2)}</td></tr>
</table></div></div>
${q.notes?`<div class="notes-block"><strong>Notes</strong><div class="notes-text">${escHtml(q.notes)}</div></div>`:''}
</div></body></html>`;
  const w=window.open('','_blank');
  w.document.write(html);w.document.close();w.print();w.close();
}
function toggleQuoteMenu(id){
  const menu=document.getElementById(`qmenu-${id}`);
  const isOpen=menu?.classList.contains('open');
  document.querySelectorAll('.client-menu-dropdown.open').forEach(m=>m.classList.remove('open'));
  if(!isOpen)menu?.classList.add('open');
}
function closeQuoteMenu(id){document.getElementById(`qmenu-${id}`)?.classList.remove('open');}

async function addCustomQuoteLine(quoteId,category){
  const q=salesQuotes[quoteId];if(!q)return;
  if(!q.customItems)q.customItems=[];
  q.customItems.push({id:'custom-'+Date.now(),label:'',category,qty:1,unitPrice:0,billing:'monthly',note:'',enabled:true});
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  logQuote(quoteId,'custom_item_added',{details:`Added custom item to ${category} section`});
  loadSalesQuote(quoteId);
}
async function deleteCustomQuoteLine(quoteId,customId){
  const q=salesQuotes[quoteId];if(!q)return;
  const label=(q.customItems||[]).find(c=>c.id===customId)?.label||'';
  q.customItems=(q.customItems||[]).filter(c=>c.id!==customId);
  q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
  logQuote(quoteId,'custom_item_removed',{details:label?`"${label}"`:'unnamed custom item'});
  loadSalesQuote(quoteId);
}
async function updateCustomLabel(quoteId,customId,val){
  const q=salesQuotes[quoteId];if(!q)return;
  const c=(q.customItems||[]).find(c=>c.id===customId);if(!c)return;
  c.label=val;q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
}
async function updateCustomQty(quoteId,customId,val){await saveCustomInput(quoteId,customId,'qty',val);}
async function updateCustomPrice(quoteId,customId,val){await saveCustomInput(quoteId,customId,'unitPrice',val);
}
async function updateCustomBilling(quoteId,customId,val){
  const q=salesQuotes[quoteId];if(!q)return;
  const c=(q.customItems||[]).find(c=>c.id===customId);if(!c)return;
  c.billing=val;q.lastModified=new Date().toISOString();
  await saveSalesQuotes();loadSalesQuote(quoteId);
}
async function updateCustomNote(quoteId,customId,val){
  const q=salesQuotes[quoteId];if(!q)return;
  const c=(q.customItems||[]).find(c=>c.id===customId);if(!c)return;
  c.note=val;q.lastModified=new Date().toISOString();
  await saveSalesQuotes();
}

async function deleteQuote(id){
  const name=salesQuotes[id]?.name;
  styledConfirm(`Delete quote "${name}"?`,async()=>{
    logQuote(id,'quote_deleted',{clientName:name});
    delete salesQuotes[id];
    activeSalesQuoteId=null;
    await saveSalesQuotes();
    renderSalesSidebar();
    showView('sales');
  });
}

function editQuoteInfo(id){
  const q=salesQuotes[id];if(!q)return;
  const m=document.getElementById('edit-quote-modal');
  document.getElementById('eq-name').value=q.name||'';
  document.getElementById('eq-contact').value=q.contact||'';
  document.getElementById('eq-tech').value=q.tech||'';
  document.getElementById('eq-emp').value=q.employees||0;
  document.getElementById('eq-users').value=q.licensedUsers||0;
  document.getElementById('eq-ws').value=q.workstations||0;
  document.getElementById('eq-srv').value=q.servers||0;
  document.getElementById('eq-sites').value=q.sites||1;
  document.getElementById('eq-backup').value=q.backedUpMachines||0;
  document.getElementById('eq-status').value=q.status||'draft';
  m._quoteId=id;
  m.style.display='flex';
}
function closeEditQuoteModal(){document.getElementById('edit-quote-modal').style.display='none';}
async function saveEditQuote(){
  const m=document.getElementById('edit-quote-modal');
  const id=m._quoteId;const q=salesQuotes[id];if(!q)return;
  q.name=document.getElementById('eq-name').value.trim()||q.name;
  q.contact=document.getElementById('eq-contact').value.trim();
  q.tech=document.getElementById('eq-tech').value.trim()||q.tech;
  q.employees=parseInt(document.getElementById('eq-emp').value)||0;
  q.licensedUsers=parseInt(document.getElementById('eq-users').value)||0;
  q.workstations=parseInt(document.getElementById('eq-ws').value)||0;
  q.servers=parseInt(document.getElementById('eq-srv').value)||0;
  q.sites=parseInt(document.getElementById('eq-sites').value)||1;
  q.backedUpMachines=parseInt(document.getElementById('eq-backup').value)||0;
  q.status=document.getElementById('eq-status').value||'draft';
  q.lastModified=new Date().toISOString();
  closeEditQuoteModal();
  await saveSalesQuotes();
  logQuote(id,'quote_edited',{details:'Updated quote info'});
  renderSalesSidebar();
  loadSalesQuote(id);
}

function printQuote(id){
  const q=salesQuotes[id];if(!q)return;
  const prods=getSalesProducts();
  const t=calcQuoteTotals(q);
  const orgName=config?.orgName||'System Alternatives';
  const date=new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const sections=[{key:'user',label:'User Products'},{key:'machine',label:'Machine Products'},{key:'site',label:'Site Products'}];
  let rows='';let rowIdx=0;
  sections.forEach(sec=>{
    const sp=prods.filter(p=>p.salesCategory===sec.key&&q.lineItems?.[p.id]?.enabled);
    const sc=(q.customItems||[]).filter(c=>c.category===sec.key&&c.enabled!==false&&(c.qty>0||c.unitPrice>0));
    if(!sp.length&&!sc.length)return;
    rows+=`<tr class="sec-hdr"><td colspan="7">${sec.label}</td></tr>`;
    sp.forEach(p=>{
      const li=q.lineItems[p.id];
      const cost=li.qty*li.unitPrice;
      const note=li.note||'';
      const discPct=p.defaultPrice?Math.round((li.unitPrice-p.defaultPrice)/p.defaultPrice*100):null;
      const discStr=discPct===null||discPct===0?'—':(discPct>0?'+':'')+discPct+'%';
      const discColor=discPct>0?'#dc2626':discPct<0?'#16a34a':'#9ca3af';
      rows+=`<tr class="${rowIdx++%2?'even':''}"><td>${p.label}${note?`<div class="note">${note}</div>`:''}</td><td class="r">${li.qty}</td><td class="r">${p.defaultPrice?'$'+p.defaultPrice.toFixed(2):'—'}</td><td class="r">$${li.unitPrice.toFixed(2)}</td><td class="r" style="color:${discColor};font-weight:600;">${discStr}</td><td class="r">$${cost.toFixed(2)}</td><td class="r">${p.billing==='onetime'?'One Time':'Monthly'}</td></tr>`;
    });
    sc.forEach(c=>{
      const cost=c.qty*c.unitPrice;
      const note=c.note||'';
      rows+=`<tr class="${rowIdx++%2?'even':''} custom"><td>${c.label||'(Custom item)'}${note?`<div class="note">${note}</div>`:''}</td><td class="r">${c.qty}</td><td class="r">—</td><td class="r">$${c.unitPrice.toFixed(2)}</td><td class="r">—</td><td class="r">$${cost.toFixed(2)}</td><td class="r">${c.billing==='onetime'?'One Time':'Monthly'}</td></tr>`;
    });
  });
  const profitColor=t.profit>=0?'#16a34a':'#dc2626';
  const css=`*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1a1d23;background:#fff;font-size:13px;line-height:1.5;}
.accent-bar{height:4px;background:linear-gradient(90deg,#3b82f6,#6366f1);}
.header{padding:28px 32px 20px;border-bottom:1px solid #e5e7eb;}
.org{font-size:22px;font-weight:800;color:#1a1d23;letter-spacing:-0.3px;}
.quote-label-hdr{font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;}
.meta-row{display:flex;gap:24px;flex-wrap:wrap;padding:14px 32px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;}
.meta-item{display:flex;flex-direction:column;gap:2px;}
.meta-label{font-size:10px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;}
.meta-val{font-weight:600;color:#111827;}
.body{padding:20px 32px 32px;}
table{width:100%;border-collapse:collapse;margin-top:0;}
thead tr{background:#f0f4ff;}
th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#1e3a8a;padding:10px 12px;text-align:left;border-bottom:2px solid #bfdbfe;}
td{padding:8px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;}
tr.even td{background:#f9fafb;}
tr.sec-hdr td{background:#eff6ff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#1e40af;padding:8px 12px;border-top:8px solid #fff;border-bottom:1px solid #bfdbfe;}
tr.custom td:first-child{font-style:italic;}
.tag{display:inline-block;margin-left:6px;font-size:9px;font-weight:600;color:#6b7280;background:#f3f4f6;border-radius:3px;padding:1px 5px;vertical-align:middle;font-style:normal;}
.note{font-size:11px;color:#6b7280;margin-top:2px;font-style:italic;}
.r{text-align:right;font-variant-numeric:tabular-nums;}
.totals-wrap{display:flex;justify-content:flex-end;margin-top:20px;}
.totals-card{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;min-width:280px;}
.totals-card table{margin-top:0;}
.totals-card th{background:#f8fafc;color:#6b7280;}
.totals-card td{padding:9px 14px;}
.tot-label{font-weight:500;color:#374151;}
.tot-val{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;}
.profit-val{color:${profitColor};font-size:15px;}
.notes-block{margin-top:24px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;}
.notes-block strong{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#92400e;}
.notes-text{margin-top:6px;font-size:12px;color:#78350f;line-height:1.6;white-space:pre-wrap;}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}.accent-bar{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}`;
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Quote — ${escHtml(q.name)}</title><style>${css}</style></head><body>
<div class="accent-bar"></div>
<div class="header">
  <div class="org">${escHtml(orgName)}</div>
  <div class="quote-label-hdr">Sales Quote</div>
</div>
<div class="meta-row">
  <div class="meta-item"><span class="meta-label">Company</span><span class="meta-val">${escHtml(q.name)}</span></div>
  ${q.contact?`<div class="meta-item"><span class="meta-label">Contact</span><span class="meta-val">${escHtml(q.contact)}</span></div>`:''}
  <div class="meta-item"><span class="meta-label">Prepared by</span><span class="meta-val">${escHtml(q.tech)}</span></div>
  <div class="meta-item"><span class="meta-label">Date</span><span class="meta-val">${date}</span></div>
</div>
<div class="body">
<table><thead><tr><th>Product / Service</th><th class="r">Qty</th><th class="r">List Price</th><th class="r">$/Unit</th><th class="r">Disc</th><th class="r">Cost</th><th class="r">Freq</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="totals-wrap"><div class="totals-card"><table>
  <tr><td class="tot-label">Monthly Total</td><td class="tot-val">$${t.monthlyClient.toFixed(2)}</td></tr>
  <tr><td class="tot-label">One-Time Total</td><td class="tot-val">$${t.onetimeClient.toFixed(2)}</td></tr>
  <tr><td class="tot-label" style="color:#6b7280;font-weight:400;">SA Cost (monthly)</td><td class="tot-val" style="color:#9ca3af;">$${t.monthlySA.toFixed(2)}</td></tr>
  <tr style="border-top:2px solid #e5e7eb;"><td class="tot-label">Monthly Profit</td><td class="tot-val profit-val">$${t.profit.toFixed(2)}</td></tr>
</table></div></div>
${q.notes?`<div class="notes-block"><strong>Notes</strong><div class="notes-text">${escHtml(q.notes)}</div></div>`:''}
</div></body></html>`;
  const w=window.open('','_blank');
  w.document.write(html);w.document.close();w.print();w.close();
}

function renderSalesView(){
  const el=document.getElementById('sales-content');
  if(!el) return;
  const myName=localStorage.getItem('myName')||'';
  const quotes=Object.values(salesQuotes).sort((a,b)=>new Date(b.lastModified||b.createdAt)-new Date(a.lastModified||a.createdAt));
  const totalMRR=quotes.reduce((s,q)=>s+calcQuoteTotals(q).monthlyClient,0);
  const totalProfit=quotes.reduce((s,q)=>s+calcQuoteTotals(q).profit,0);
  const byStatus={draft:0,sent:0,accepted:0,rejected:0};
  quotes.forEach(q=>{const s=q.status||'draft';byStatus[s]=(byStatus[s]||0)+1;});
  const stats=[
    {label:'Total',value:quotes.length,color:'var(--accent)'},
    {label:'Sent',value:byStatus.sent,color:'var(--warn)'},
    {label:'Accepted',value:byStatus.accepted,color:'var(--success)'},
    {label:'MRR',value:'$'+totalMRR.toFixed(0),color:'var(--success)'},
  ];
  el.innerHTML=`<div style="max-width:760px;width:100%;">
    <div style="margin-bottom:22px;text-align:center;">
      <h2 style="font-size:20px;font-weight:700;margin-bottom:3px;">${myName?'Hey, '+myName:'Sales'}</h2>
      <p style="color:var(--text2);font-size:12px;">${config?.orgName||'System Alternatives'} — Quote Builder</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:22px;">
      ${stats.map(s=>`<div class="dash-stat">
        <div class="dash-stat-value" style="color:${s.color};">${s.value}</div>
        <div class="dash-stat-label">${s.label}</div>
      </div>`).join('')}
    </div>
    ${quotes.length?`<div>
      <div class="dash-section-label">Recent Quotes</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;">
        ${quotes.slice(0,8).map(q=>{const t=calcQuoteTotals(q);const otStr=t.onetimeClient>0?' + $'+t.onetimeClient.toFixed(0)+' OT':'';const profitColor=t.profit>=0?'var(--success)':'var(--danger)';return`<div class="dash-row" onclick="selectQuote('${q.id}')">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;display:flex;align-items:center;gap:4px;overflow:hidden;"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(q.name)}</span>${quoteStatusBadge(q.status)}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px;">$${t.monthlyClient.toFixed(0)}/mo${otStr}<span style="color:${profitColor};margin-left:4px;">· $${t.profit.toFixed(0)} profit</span></div>
          </div>
        </div>`;}).join('')}
      </div>
    </div>`:`<div style="text-align:center;padding:48px 20px;">
      <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:6px;">No quotes yet</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:18px;">Create your first quote to get started.</div>
      <button class="btn-primary" onclick="newQuoteFromSidebar()">+ New Quote</button>
    </div>`}
  </div>`;
}

// ─── Backup tracker ───────────────────────────────────────────────────────────

const DEFAULT_BACKUP_CLIENTS=[
  {id:'nwuav',name:'Northwest UAV',syncrifyId:'NWUAV',allottedGB:13000,contractDevices:5,charged:1165,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'toptier',name:'TopTier',syncrifyId:'TopTier',allottedGB:10000,contractDevices:4,charged:580,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'dccpa',name:'Dougall Conradie',syncrifyId:'DCCPA',allottedGB:4000,contractDevices:3,charged:395,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'petersonassoc',name:'Peterson & Associates',syncrifyId:'PetersonAssociates',allottedGB:1500,contractDevices:2,charged:170,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Unifi',notes:''},
  {id:'cug',name:'Composites Universal Group',syncrifyId:'CUG',allottedGB:2000,contractDevices:2,charged:210,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'oai',name:'Oregon Aero',syncrifyId:'OAI',allottedGB:3000,contractDevices:4,charged:340,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'nwrapid',name:'NW Rapid',syncrifyId:'NWrapid',allottedGB:2500,contractDevices:3,charged:275,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:'No backup on invoice'},
  {id:'heller',name:'Heller',syncrifyId:'Heller',allottedGB:2000,contractDevices:2,charged:210,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'kandf',name:"K&F Coffee Roasters",syncrifyId:'KandF',allottedGB:500,contractDevices:1,charged:65,syncrify:'Inactive',wasabi:'Inactive',frequency:'Weekly',vpnHost:'Zywall',notes:''},
  {id:'cascadeconcrete',name:'Cascade Concrete',syncrifyId:'CascadeConcrete',allottedGB:500,contractDevices:1,charged:65,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Unifi',notes:''},
  {id:'scaptax',name:'Scappoose Business & Tax',syncrifyId:'ScapTax',allottedGB:500,contractDevices:2,charged:90,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'petersenlaw',name:'Petersen Law',syncrifyId:'PetersenLaw',allottedGB:500,contractDevices:1,charged:65,syncrify:'Active',wasabi:'Active',frequency:'Weekly',vpnHost:'Zywall',notes:''},
  {id:'lindalamp',name:'Linda Lamprecht',syncrifyId:'LindaLamp',allottedGB:500,contractDevices:1,charged:65,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'gilbertson',name:'Gilbertson Transport',syncrifyId:'Gilbertson Transport',allottedGB:500,contractDevices:1,charged:65,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'remax',name:'ReMax Power Pros',syncrifyId:'Remax',allottedGB:500,contractDevices:1,charged:65,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'cascadetax',name:'Cascade Tax',syncrifyId:'CascadeTax',allottedGB:0,contractDevices:0,charged:0,syncrify:'Inactive',wasabi:'Inactive',frequency:'Daily',vpnHost:'???',notes:''},
  {id:'nwtax',name:'NW Tax',syncrifyId:'NWTax',allottedGB:500,contractDevices:2,charged:90,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'willametteglass',name:'Willamette Glass',syncrifyId:'WillametteGlass',allottedGB:2000,contractDevices:2,charged:210,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Unifi',notes:''},
  {id:'spl',name:'Scappoose Public Library',syncrifyId:'SPL',allottedGB:500,contractDevices:1,charged:65,syncrify:'Active',wasabi:'Inactive',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'etburner',name:'Tom Stevens / ET Burner',syncrifyId:'ETBurner',allottedGB:500,contractDevices:1,charged:0,syncrify:'Active',wasabi:'Inactive',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'rexmurray',name:'Rex Murray',syncrifyId:'RexMurray',allottedGB:0,contractDevices:0,charged:0,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'Zywall',notes:''},
  {id:'ats',name:'ATS',syncrifyId:'ATS',allottedGB:0,contractDevices:0,charged:0,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'',notes:''},
  {id:'sap',name:'SAP',syncrifyId:'SAP',allottedGB:0,contractDevices:0,charged:0,syncrify:'Inactive',wasabi:'Inactive',frequency:'Daily',vpnHost:'',notes:''},
];

const BK_ROLES=[
  {id:'win-img-local',   label:'Win Image · Local',    bg:'#1e3a5f',fg:'#93c5fd'},
  {id:'win-img-offsite', label:'Win Image · Off-site', bg:'#0f2240',fg:'#60a5fa'},
  {id:'win-data-local',  label:'Win Data · Local',     bg:'#14291a',fg:'#86efac'},
  {id:'win-data-offsite',label:'Win Data · Off-site',  bg:'#0c1a0c',fg:'#4ade80'},
  {id:'prx-img-local',   label:'Prx Image · Local',    bg:'#2d1a00',fg:'#fbbf24'},
  {id:'prx-img-offsite', label:'Prx Image · Off-site', bg:'#1f1200',fg:'#f59e0b'},
  {id:'prx-data-local',  label:'Prx Data · Local',     bg:'#1a1a2e',fg:'#818cf8'},
  {id:'prx-data-offsite',label:'Prx Data · Off-site',  bg:'#12122a',fg:'#6366f1'},
];
let _backupLiveData=null; // null=not fetched; obj keyed by syncrifyId → {usedBytes, profiles:[]}
let _backupActivityData=null; // null=not fetched; array of currently-active sessions {profile,bytes,status,clientIp,user}
let _bkActivityLastUpdated=null; // mtimeMs from server
let _bkActivitySource=null; // 'direct' | 'direct-pending' | 'none'
let _backupDriveData=null; // null=not fetched; {totalBytes,freeBytes} for the backup storage volume
let _bkDriveSource=null; // 'direct' | 'direct-pending' | 'none'
let _bkLastUpdated=null; // mtimeMs from server
let _bkDataSource=null; // 'direct' | 'direct-pending' | 'none'
let _bkActiveClient='all';
let _bkTab='overview';
let _bkFetching=false;
let _bkDataFetchTesting=false; // true while Test Data Fetch is running — blocks refreshSyncrifyStatus from overwriting the spinner
let _bkExpanded=new Set();
let _bkNoteOpen=new Set();
let _bkHideInactive=localStorage.getItem('bkHideInactive')==='1';
let _bkShowCosts=false; // costs columns disabled for now — toggle removed from the menu
let _bkFilterNonCompliant=false;
let _bkProfileNoteOpen=new Set(); // keys: "clientId:profileName"
let _bkSort={col:null,dir:1}; // col: 'name'|'used'|'oldest'|'compliant'|'allotted'
let _bkCardSort=localStorage.getItem('bkCardSort')||'status'; // 'status'|'name'|'used'|'oldest'|'compliant' — dashboard/monitor card order
let _bkMonitorMode=false;
let _bkMonitorClockInterval=null;

function bkGetClients(){return appSettings.backupClients||DEFAULT_BACKUP_CLIENTS;}

// Shared "● Live polling" indicator for the dashboard subtitle and Monitor Mode —
// color reflects whether the activity feed has updated recently, not just whether
// direct polling is configured.
function bkLivePollingBadge(){
  if(_bkActivitySource==='direct-pending')return`<span style="color:var(--warn);" title="Direct Syncrify polling is configured but hasn't connected yet — check Settings">● Polling pending</span>`;
  if(_bkActivitySource!=='direct')return'';
  const pollMs=Math.max(5,parseInt(appSettings.syncrifyActivityPollSec)||30)*1000;
  const ageMs=_bkActivityLastUpdated?Date.now()-_bkActivityLastUpdated:Infinity;
  const fresh=ageMs<pollMs*3;
  return fresh
    ?`<span style="color:var(--success);" title="Live activity is polled directly from Syncrify">● Live polling</span>`
    :`<span style="color:var(--warn);" title="Live activity hasn't updated recently — check Settings">● Live polling (stale)</span>`;
}

function bkEnterMonitor(){
  _bkMonitorMode=true;
  const el=document.createElement('div');
  el.id='bk-monitor-overlay';
  el.className='bk-monitor-overlay';
  document.body.appendChild(el);
  bkDrawMonitor();
  document.addEventListener('keydown',bkMonitorKey);
  _bkMonitorClockInterval=setInterval(bkMonitorTick,1000);
}
function bkExitMonitor(){
  _bkMonitorMode=false;
  clearInterval(_bkMonitorClockInterval);
  _bkMonitorClockInterval=null;
  document.removeEventListener('keydown',bkMonitorKey);
  const el=document.getElementById('bk-monitor-overlay');
  if(el)el.remove();
}
function bkMonitorKey(e){if(e.key==='Escape')bkExitMonitor();}
function bkMonitorTick(){
  const clk=document.getElementById('bk-monitor-clk');
  if(clk)clk.textContent=new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  const live=document.getElementById('bk-monitor-live');
  if(live)live.innerHTML=bkLivePollingBadge();
}
function bkDrawMonitor(){
  const overlay=document.getElementById('bk-monitor-overlay');
  if(!overlay)return;
  const allClients=bkGetClients();
  const clients=_bkHideInactive?allClients.filter(c=>c.syncrify==='Active'||c.wasabi==='Active'):allClients;
  const issues=clients.filter(c=>['error','warn'].includes(bkRowStatus(c,_backupLiveData?.[c.syncrifyId])));
  const clearCnt=clients.filter(c=>bkRowStatus(c,_backupLiveData?.[c.syncrifyId])==='good').length;
  const dataFrom=_bkLastUpdated?'Data from '+new Date(_bkLastUpdated).toLocaleString('en-US',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}):'No data yet';
  // Most stale: find the oldest non-disabled profile across all active clients
  const stalest=_backupLiveData?clients.reduce((worst,c)=>{
    const live=_backupLiveData[c.syncrifyId];
    if(!live||(c.syncrify!=='Active'&&c.wasabi!=='Active'))return worst;
    for(const p of live.profiles){
      if(bkEffectiveFreq(c,p.profile)==='Disabled'||!p.lastAccess)continue;
      if(!worst||p.lastAccess<worst.lastAccess)worst={...p,clientName:c.name};
    }
    return worst;
  },null):null;
  const stalestFreq=stalest?bkGetClients().reduce((freq,c)=>{const live=_backupLiveData?.[c.syncrifyId];if(live&&live.profiles.find(p=>p.profile===stalest.profile&&c.name===stalest.clientName))return bkEffectiveFreq(c,stalest.profile);return freq;},'Daily'):'Daily';
  const stalestComp=stalest?bkIsCompliant(stalest.lastAccess,stalestFreq):null;
  const stalestAge=stalest?bkFmtAge(stalest.lastAccess,stalestFreq==='Monthly'?32:stalestFreq==='Weekly'?8:2,stalestComp==='grace'):null;

  overlay.innerHTML=`
    <div class="bk-monitor-header">
      <div class="bk-mh-left">
        <span style="font-size:16px;font-weight:700;color:var(--text);flex-shrink:0;">Backup Monitor</span>
        <span id="bk-monitor-clk" style="font-size:22px;font-weight:300;color:var(--text);font-variant-numeric:tabular-nums;flex-shrink:0;">${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span>
        <span id="bk-monitor-df" style="color:var(--text3);font-size:12px;white-space:nowrap;">${dataFrom}</span>
        ${stalest?`<div style="display:flex;flex-direction:column;gap:1px;padding:4px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;min-width:0;flex-shrink:1;overflow:hidden;"><span style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;">Most Stale</span><span style="font-size:12px;font-weight:600;color:${stalestAge.color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escHtml(stalest.profile)} — ${escHtml(stalest.clientName)}">${stalestAge.text} · ${escHtml(stalest.clientName)}</span></div>`:''}
      </div>
      <div class="bk-mh-right">
        ${bkDriveUsageHtml(true)}
        ${issues.length?`<span style="background:rgba(239,68,68,0.15);color:#f87171;font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;border:1px solid rgba(239,68,68,0.3);white-space:nowrap;">⚠ ${issues.length} issue${issues.length!==1?'s':''}</span>`:''}
        <span style="background:rgba(34,197,94,0.1);color:#4ade80;font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;border:1px solid rgba(34,197,94,0.2);white-space:nowrap;">${clearCnt} clear</span>
        <span id="bk-monitor-live" style="font-size:11px;white-space:nowrap;">${bkLivePollingBadge()}</span>
        <select class="bk-cell-select" style="border:1px solid var(--border);" title="Sort cards by" onchange="bkSetCardSort(this.value)">${bkCardSortOptionsHtml(_bkCardSort)}</select>
        <button onclick="bkExitMonitor()" style="background:var(--bg3);border:1px solid var(--border);color:var(--text2);font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;flex-shrink:0;">✕ Exit</button>
      </div>
    </div>
    ${bkBuildMonitorRunningBar()}
    <div class="bk-monitor-grid" id="bk-monitor-grid">${bkBuildMonitorCards()}</div>`;
}
function bkBuildMonitorRunningBar(){
  const jobs=bkGetActiveJobs();
  if(!jobs.length)return'';
  const chips=jobs.map(j=>{
    const c=bkFindClientByProfile(j.profile);
    const name=c?c.name:j.profile;
    const pct=j.percentDone!=null?`${j.percentDone}%`:'';
    const started=bkParseSyncrifyDate(j.startedOn);
    const elapsedMs=started?Date.now()-started.getTime():null;
    const elapsed=bkFormatElapsed(elapsedMs);
    const stuck=elapsedMs!=null&&elapsedMs>3*3600000;
    return`<span style="display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:14px;padding:4px 12px;font-size:12px;white-space:nowrap;flex-shrink:0;">
      <span class="bk-live-dot"></span>
      <span style="font-weight:700;color:var(--text);">${escHtml(name)}</span>
      <span style="color:var(--text3);">${escHtml(j.profile)}</span>
      ${pct?`<span style="color:#4ade80;font-weight:700;">${pct}</span>`:''}
      ${elapsed?`<span title="Started ${escHtml(j.startedOn)}"${stuck?' style="color:var(--warn);font-weight:700;"':' style="color:var(--text3);"'}>${stuck?'⚠ ':''}${elapsed}</span>`:''}
    </span>`;
  }).join('');
  return`<div style="display:flex;gap:8px;padding:8px 16px;overflow-x:auto;flex-shrink:0;background:var(--bg2);border-bottom:1px solid var(--border);">${chips}</div>`;
}

function bkBuildMonitorCards(){
  const allClients=bkGetClients();
  const clients=_bkHideInactive?allClients.filter(c=>c.syncrify==='Active'||c.wasabi==='Active'):allClients;
  const stColor={error:'#ef4444',warn:'#f59e0b',good:'#22c55e',inactive:'#4b5563'};
  let cats=clients.map(c=>{const live=_backupLiveData?.[c.syncrifyId];return{c,live,st:bkRowStatus(c,live)};});
  cats=bkSortClientCats(cats,_bkCardSort);
  return cats.map(({c,live,st})=>{
    const active=c.syncrify==='Active'||c.wasabi==='Active';
    const borderColor=live||st==='inactive'?stColor[st]||'#6b7280':'#6b7280';
    const monP=live?live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled'):[];
    const totalP=live?monP.length:null;
    const compP=live&&active?monP.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))).length:null;
    const compColor=compP===null?'var(--text3)':compP===totalP?'#22c55e':compP===0?'#ef4444':'#f59e0b';
    let segBar='';
    if(monP.length){
      const gap=monP.length>15?1:2;
      const segs=monP.map(p=>{
        const freq=bkEffectiveFreq(c,p.profile);
        const comp=bkIsCompliant(p.lastAccess,freq);
        const col=!active?'#4b5563':comp===false?'#ef4444':comp==='grace'?'#f59e0b':'#22c55e';
        const tip=p.lastAccess?`${p.profile} · ${freq} · ${bkFmtDate(p.lastAccess)}${comp==='grace'?' · weekend grace':''}`:p.profile;
        return`<div title="${escHtml(tip)}" style="flex:1;background:${col};border-radius:2px;min-width:3px;"></div>`;
      }).join('');
      segBar=`<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span class="bk-monitor-lbl">Profiles</span><span style="font-size:11px;color:${compColor};font-weight:700;">${compP!==null?`${compP}/${totalP}`:totalP??'—'}</span></div><div style="display:flex;gap:${gap}px;height:10px;">${segs}</div></div>`;
    }
    let oldestHtml='';
    if(monP.length){
      const op=monP.reduce((a,b)=>a.lastAccess<b.lastAccess?a:b);
      const freq=bkEffectiveFreq(c,op.profile);
      const opComp=bkIsCompliant(op.lastAccess,freq);
      const thresh=freq==='Monthly'?32:freq==='Weekly'?8:2;
      const age=bkFmtAge(op.lastAccess,thresh,opComp==='grace');
      oldestHtml=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span class="bk-monitor-lbl">Oldest backup</span><span style="font-size:13px;font-weight:700;color:${age.color};" title="${age.date}">${age.text}${opComp==='grace'?' ~':''}</span></div>`;
    }
    let storBar='';
    const usedGB=live?live.usedBytes/1e9:null;
    if(usedGB!==null){
      if(c.allottedGB===-1){
        storBar=`<div><div style="display:flex;justify-content:space-between;align-items:center;"><span class="bk-monitor-lbl">Storage</span><span style="font-size:11px;color:var(--text3);font-weight:700;">${bkFmt(usedGB)} · ∞</span></div></div>`;
      } else if(c.allottedGB===0){
        storBar=`<div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span class="bk-monitor-lbl">Storage</span><span style="font-size:11px;color:#ef4444;font-weight:700;">${bkFmt(usedGB)} / —</span></div><div style="height:10px;background:var(--bg4);border-radius:2px;overflow:hidden;"><div style="height:100%;width:100%;background:#ef4444;border-radius:2px;"></div></div></div>`;
      } else {
        const pct=Math.min(100,usedGB/c.allottedGB*100);
        const bc=pct>=90?'#ef4444':pct>=70?'#f59e0b':'#22c55e';
        storBar=`<div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span class="bk-monitor-lbl">Storage</span><span style="font-size:11px;color:${bc};font-weight:700;">${bkFmt(usedGB)} / ${bkFmt(c.allottedGB)}</span></div><div style="height:10px;background:var(--bg4);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${pct.toFixed(1)}%;background:${bc};border-radius:2px;"></div></div></div>`;
      }
    }
    const dimmed=st==='inactive'?'opacity:0.5;':'';
    const running=live&&live.profiles.some(p=>bkGetActiveJobs().some(j=>j.profile===p.profile));
    const liveBadge=running?`<span class="bk-live-dot" title="Backup currently running" style="margin-left:6px;"></span>`:'';
    return`<div class="bk-monitor-card" style="border-left-color:${borderColor};${dimmed}"><div class="bk-monitor-card-name">${escHtml(c.name)}${liveBadge}</div>${segBar}${oldestHtml}${storBar}</div>`;
  }).join('');
}

function bkCalcCost(usedGB,devices){
  if(!usedGB&&!devices)return 0;
  const bs=appSettings.bkBlockSizeGB||500,cb=appSettings.bkCostPerBlock||40,cd=appSettings.bkCostPerDevice||25;
  return Math.ceil(usedGB/bs)*cb+devices*cd;
}
function bkEstCost(allottedGB,contractDevices){
  if(allottedGB<=0)return 0;
  const bs=appSettings.bkBlockSizeGB||500,cb=appSettings.bkCostPerBlock||40,cd=appSettings.bkCostPerDevice||25;
  return Math.ceil(allottedGB/bs)*cb+contractDevices*cd;
}
function bkUpdateNavBadge(){
  const badge=document.getElementById('bk-nav-badge');
  if(!badge)return;
  const errCount=bkGetClients().filter(c=>bkRowStatus(c,_backupLiveData?.[c.syncrifyId])==='error').length;
  badge.textContent=errCount;
  badge.style.display=errCount>0?'':'none';
}
function bkScrollToClient(id){
  const scroll=document.querySelector('.bk-scroll');
  const row=scroll&&scroll.querySelector(`tr[data-client-id="${id}"]`);
  if(row)row.scrollIntoView({block:'center',behavior:'smooth'});
}
function bkExportCsv(){
  const clients=bkGetClients();
  const rows=[['Client','Syncrify ID','Allotted GB','Contract Devices','Est Cost','Charged','Used GB','Live Devices','Calc Cost','Diff','Syncrify','Wasabi','Frequency','VPN','Notes']];
  clients.forEach(c=>{
    const live=_backupLiveData?.[c.syncrifyId];
    const usedGB=live?live.usedBytes/1e9:null;
    const tp=live?live.profiles.length:null;
    const calc=usedGB!==null?bkCalcCost(usedGB,tp):null;
    const diff=calc!==null&&c.charged!==undefined?c.charged-calc:null;
    const est=c.allottedGB>0?bkEstCost(c.allottedGB,c.contractDevices):null;
    rows.push([c.name,c.syncrifyId||'',c.allottedGB||0,c.contractDevices||0,est??'',c.charged||0,usedGB!=null?usedGB.toFixed(1):'',tp??'',calc??'',diff??'',c.syncrify,c.wasabi,c.frequency,c.vpnHost||'',c.notes||'']);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='backup-clients-'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}
function bkLogAction(action,details={}){
  const myName=localStorage.getItem('myName')||'';
  fetch('/api/logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ts:new Date().toISOString(),tech:myName,action,clientId:'_backups',clientName:'Backups',...details})}).catch(_=>{});
}
async function bkShowLog(){
  closeBkMenu();
  const modal=document.getElementById('log-modal');
  document.getElementById('log-modal-title').textContent='Backups — Activity Log';
  document.getElementById('log-modal-body').innerHTML='<div style="color:var(--text3);font-size:11px;">Loading…</div>';
  modal.style.display='flex';
  try{
    const r=await fetch('/api/logs?clientId=_backups&limit=200');
    const logs=await r.json();
    renderLogTimeline(document.getElementById('log-modal-body'),logs);
  }catch(e){document.getElementById('log-modal-body').innerHTML=`<div style="color:#fca5a5;font-size:11px;">Failed to load logs: ${e.message}</div>`;}
}
function bkOpenProfiles(){
  closeBkMenu();
  const c=_bkActiveClient!=='all'?bkGetClients().find(x=>x.id===_bkActiveClient):null;
  document.getElementById('bk-profiles-modal-title').textContent=(c?escHtml(c.name)+' — ':'')+'Backup Profiles';
  document.getElementById('bk-profiles-modal-body').innerHTML=bkRenderProfiles();
  document.getElementById('bk-profiles-modal').style.display='flex';
}
function closeBkProfilesModal(){document.getElementById('bk-profiles-modal').style.display='none';}
function bkToggleMenu(){
  const m=document.getElementById('bk-main-menu');
  if(!m)return;
  const isOpen=m.classList.contains('open');
  document.querySelectorAll('.client-menu-dropdown.open').forEach(x=>x.classList.remove('open'));
  if(isOpen){m.classList.remove('open');}else{m.classList.add('open');}
}
function closeBkMenu(){document.getElementById('bk-main-menu')?.classList.remove('open');}
function bkToggleIssues(){
  document.getElementById('bk-issues-detail')?.classList.toggle('open');
}
function bkIsCompliant(lastAccessMs,frequency){
  if(frequency==='Disabled')return null;
  if(!lastAccessMs)return null;
  const ageDays=(Date.now()-lastAccessMs)/86400000;
  if(frequency==='Monthly')return ageDays<=32;
  if(frequency==='Weekly')return ageDays<=8;
  // Daily: within normal 2-day window
  if(ageDays<=2)return true;
  // Grace: last backup was on a weekend day (Fri/Sat/Sun) and is < 4 days old
  // No nowDow check needed — ageDays<4 bounds it to early-week naturally
  const lastDow=new Date(lastAccessMs).getDay();
  if((lastDow===5||lastDow===6||lastDow===0)&&ageDays<4)return'grace';
  return false;
}
function bkEffectiveFreq(c,profileName){
  return(c.profileSettings&&c.profileSettings[profileName]?.frequency)||'Daily';
}
function bkRowStatus(c,live){
  const inactive=c.syncrify==='Inactive'&&c.wasabi==='Inactive';
  if(inactive)return'inactive';
  if(live&&live.profiles.length){
    const anyNonCompliant=live.profiles.some(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))===false);
    if(anyNonCompliant)return'error';
  }
  const usedGB=live?live.usedBytes/1e9:0;
  if(c.allottedGB!==-1){if(c.allottedGB===0?usedGB>0:usedGB>c.allottedGB)return'warn';}
  const calc=bkCalcCost(usedGB,live?live.profiles.length:0);
  if(c.charged>0&&calc>c.charged+5)return'warn';
  return'good';
}

// Clients with at least one non-compliant (stale) backup profile, for dashboard alerting.
function bkGetIssueClients(){
  if(!_backupLiveData)return[];
  return bkGetClients().map(c=>{
    const live=_backupLiveData[c.syncrifyId];
    if(bkRowStatus(c,live)!=='error')return null;
    const monP=live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled');
    const nonCompliant=monP.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))===false).length;
    return{c,nonCompliant};
  }).filter(Boolean);
}

// Oldest monitored-profile timestamp for a client, or Infinity if unknown (sorts last).
function bkOldestProfileMs({c,live}){
  if(!live)return Infinity;
  const monP=live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled'&&p.lastAccess);
  return monP.length?Math.min(...monP.map(p=>p.lastAccess)):Infinity;
}
// Fraction of monitored profiles that are compliant, or 2 if unknown/inactive (sorts last).
function bkComplianceRatio({c,live,st}){
  if(!live||st==='inactive')return 2;
  const monP=live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled');
  if(!monP.length)return 2;
  const comp=monP.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))).length;
  return comp/monP.length;
}
// Reorders {c,live,st} entries for the dashboard/monitor cards per _bkCardSort.
// 'status' is handled by the caller (dashboard groups into sections; monitor sorts by severity).
function bkSortClientCats(cats,mode){
  const arr=[...cats];
  if(mode==='name')return arr.sort((a,b)=>a.c.name.toLowerCase()<b.c.name.toLowerCase()?-1:a.c.name.toLowerCase()>b.c.name.toLowerCase()?1:0);
  if(mode==='used')return arr.sort((a,b)=>(b.live?b.live.usedBytes:-1)-(a.live?a.live.usedBytes:-1));
  if(mode==='oldest')return arr.sort((a,b)=>bkOldestProfileMs(a)-bkOldestProfileMs(b));
  if(mode==='compliant')return arr.sort((a,b)=>bkComplianceRatio(a)-bkComplianceRatio(b));
  if(mode==='status'){const o={error:0,warn:1,good:2,inactive:3};return arr.sort((a,b)=>(o[a.st]??2)-(o[b.st]??2));}
  return arr;
}
function bkSetCardSort(mode){
  _bkCardSort=mode;
  localStorage.setItem('bkCardSort',mode);
  bkRenderMain();
  if(_bkMonitorMode)bkDrawMonitor();
}
const BK_CARD_SORT_LABELS={status:'Status',name:'Name (A–Z)',used:'Storage Used',oldest:'Oldest Backup',compliant:'Least Compliant'};
function bkCardSortOptionsHtml(selected){
  return Object.entries(BK_CARD_SORT_LABELS).map(([v,label])=>`<option value="${v}"${selected===v?' selected':''}>${label}</option>`).join('');
}

let _bkFetchError=null;
async function bkFetchLive(){
  if(_bkFetching)return;
  _bkFetching=true;
  _bkFetchError=null;
  try{
    const r=await fetch('/api/backup-data');
    const d=await r.json();
    if(d.error){_bkFetchError=d.error;_backupLiveData={};return;}
    if(!Array.isArray(d.data)){_bkFetchError='Unexpected response from server';_backupLiveData={};return;}
    _bkLastUpdated=d.lastUpdated||null;
    _bkDataSource=d.source||null;
    _backupLiveData={};
    for(const e of d.data){
      if(!_backupLiveData[e.client])_backupLiveData[e.client]={usedBytes:0,profiles:[]};
      _backupLiveData[e.client].usedBytes+=e.diskSize;
      _backupLiveData[e.client].profiles.push(e);
    }
  }catch(err){_bkFetchError=err.message;_backupLiveData={};bkLogAction('bk_fetch_error',{note:err.message});}finally{_bkFetching=false;bkUpdateNavBadge();}
  await Promise.all([bkFetchActivity(),bkFetchDrive()]);
}
async function bkFetchActivity(){
  try{
    const r=await fetch('/api/backup-activity');
    const d=await r.json();
    _backupActivityData=(!d.error&&Array.isArray(d.data))?d.data:[];
    _bkActivityLastUpdated=d.lastUpdated||null;
    _bkActivitySource=d.source||null;
  }catch(err){_backupActivityData=[];}
}
async function bkFetchDrive(){
  try{
    const r=await fetch('/api/backup-drive');
    const d=await r.json();
    _backupDriveData=(!d.error&&d.data)?d.data:null;
    _bkDriveSource=d.source||null;
  }catch(err){_backupDriveData=null;}
}
function bkGetActiveJobs(){
  return _backupActivityData||[];
}
// Parses Syncrify's "Started On" format (e.g. "6/11/26 1:00 AM") into a Date.
function bkParseSyncrifyDate(str){
  if(!str)return null;
  const m=str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if(!m)return null;
  let[,mo,da,yr,hh,mi,ap]=m;
  yr=parseInt(yr);if(yr<100)yr+=2000;
  hh=parseInt(hh);
  if(ap){ap=ap.toUpperCase();if(ap==='PM'&&hh!==12)hh+=12;if(ap==='AM'&&hh===12)hh=0;}
  return new Date(yr,parseInt(mo)-1,parseInt(da),hh,parseInt(mi));
}
// Formats a duration in ms as e.g. "1h 23m" or "45m".
function bkFormatElapsed(ms){
  if(ms==null||ms<0)return null;
  const mins=Math.floor(ms/60000);
  if(mins<60)return`${mins}m`;
  return`${Math.floor(mins/60)}h ${mins%60}m`;
}
function bkFindClientByProfile(profileName){
  if(!_backupLiveData)return null;
  for(const c of bkGetClients()){
    const live=_backupLiveData[c.syncrifyId];
    if(live&&live.profiles.some(p=>p.profile===profileName))return c;
  }
  return null;
}

function bkSwitchClient(id){
  _bkActiveClient=id;
  if(id==='all'){
    _bkExpanded.clear();
    _bkNoteOpen.clear();
  } else {
    _bkExpanded.add(id);
  }
  document.querySelectorAll('.bk-client-item').forEach(el=>el.classList.toggle('active',el.dataset.bkid===id));
  bkRenderMain();
}
function bkSwitchTab(tab){_bkTab=tab;bkRenderMain();}

function renderBackupsSidebar(){
  const el=document.getElementById('bk-client-list');
  if(!el)return;
  const clients=bkGetClients();
  el.innerHTML=`<div class="bk-client-item${_bkActiveClient==='all'?' active':''}" data-bkid="all" onclick="bkSwitchClient('all')" style="font-weight:600;border-bottom:1px solid var(--border);margin-bottom:4px;padding-bottom:8px;">All Clients</div>`
    +clients.map(c=>{
      const live=_backupLiveData?.[c.syncrifyId];
      const st=bkRowStatus(c,live);
      const active=c.syncrify==='Active'||c.wasabi==='Active';
      const monP=live?live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled'):[];
      const totalP=live?monP.length:null;
      const compP=active&&live?monP.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))).length:null;
      const badgeColor=compP===null?'var(--text3)':compP===totalP?'#22c55e':compP===0?'#ef4444':'#f59e0b';
      const badgeText=compP!==null?`${compP}/${totalP}`:st==='inactive'?'inactive':'—';
      const badge=totalP!==null?`<span style="font-size:9px;color:${badgeColor};font-weight:600;flex-shrink:0;margin-right:2px;">${badgeText}</span>`:'';
      const running=live&&live.profiles.some(p=>bkGetActiveJobs().some(j=>j.profile===p.profile));
      const liveBadge=running?`<span class="bk-live-dot" title="Backup currently running" style="margin-right:2px;"></span>`:'';
      return`<div class="bk-client-item${_bkActiveClient===c.id?' active':''}" data-bkid="${c.id}" onclick="bkSwitchClient('${c.id}')"><span class="bk-dot bk-dot-${st}"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(c.name)}</span>${liveBadge}${badge}</div>`;
    }).join('');
}

async function renderBackupsView(){
  if(_backupLiveData===null&&!_bkFetching){
    bkFetchLive().then(()=>{renderBackupsSidebar();bkRenderMain();});
  }
  renderBackupsSidebar();
  bkRenderMain();
}

function bkRenderMain(){
  const el=document.getElementById('backups-content');
  if(!el)return;
  const isAll=_bkActiveClient==='all';
  const hasHost=!!(appSettings.syncrifyHost||'').trim();
  const isStale=_bkLastUpdated&&(Date.now()-new Date(_bkLastUpdated).getTime())>86400000;
  // Subtitle line
  let subtitle='';
  if(_backupLiveData===null){subtitle=hasHost?'Loading live data…':'<a style="color:var(--accent);cursor:pointer;" onclick="openSettings()">Configure Syncrify connection in Settings ↗</a>';}
  else if(_bkFetchError){subtitle=`<span style="color:var(--danger);">⚠ Fetch error — use ⋯ menu to retry</span>`;}
  else{
    const np=Object.values(_backupLiveData).reduce((s,v)=>s+v.profiles.length,0);
    const upd=_bkLastUpdated?'data from '+new Date(_bkLastUpdated).toLocaleString('en-US',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
    subtitle=`${np} profiles${upd?' · '+upd:''}${isStale?` <span style="color:var(--warn);">⚠ stale</span>`:''}`;
  }
  const liveBadge=bkLivePollingBadge();
  if(liveBadge)subtitle+=` · ${liveBadge}`;
  if(_bkDataSource==='direct')subtitle+=` · <span style="color:var(--success);" title="Backup data (usage, last-run status) is polled directly from Syncrify">● Direct data</span>`;
  else if(_bkDataSource==='direct-pending')subtitle+=` · <span style="color:var(--warn);" title="Direct Syncrify data polling is configured but hasn't connected yet — check Settings">● Data polling pending</span>`;
  // Title
  let titleHtml='';
  if(isAll){
    titleHtml=`<span>Backup Monitoring</span>`;
  } else {
    const c=bkGetClients().find(x=>x.id===_bkActiveClient);
    const st=c?bkRowStatus(c,_backupLiveData?.[c.syncrifyId]):'good';
    titleHtml=`<button class="bk-back-btn" onclick="bkSwitchClient('all')">← All</button><span class="bk-dot bk-dot-${st}"></span><span>${c?escHtml(c.name):'Client'}</span>`;
  }
  // ... menu (shared between dashboard and client view)
  const menuHtml=`<div class="client-menu-wrap">
    <button class="client-menu-btn" onclick="bkToggleMenu()">&#8230;</button>
    <div class="client-menu-dropdown" id="bk-main-menu">
      <button class="client-menu-item" onclick="closeBkMenu();_backupLiveData=null;_bkFetchError=null;_bkFetching=false;renderBackupsView()">↻ Refresh</button>
      <div class="client-menu-sep"></div>
      <button class="client-menu-item${_bkHideInactive?' checked':''}" onclick="_bkHideInactive=!_bkHideInactive;localStorage.setItem('bkHideInactive',_bkHideInactive?'1':'0');bkRenderMain()">Hide Inactive</button>
      ${isAll?`<div class="client-menu-item" style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:default;">
        <span>Sort by</span>
        <select class="bk-cell-select" onchange="bkSetCardSort(this.value)">${bkCardSortOptionsHtml(_bkCardSort)}</select>
      </div>`:''}
      <div class="client-menu-sep"></div>
      <button class="client-menu-item" onclick="bkOpenProfiles()">View Profiles</button>
      <button class="client-menu-item" onclick="bkExportCsv()">Export CSV</button>
      <button class="client-menu-item" onclick="bkShowLog()">View Log</button>
      <button class="client-menu-item" onclick="closeBkMenu();bkEnterMonitor()">Monitor Mode</button>
      ${!isAll?`<div class="client-menu-sep"></div><button class="client-menu-item" style="color:var(--danger);" onclick="closeBkMenu();bkRemoveClient('${_bkActiveClient}')">Remove Client…</button>`:''}
    </div>
  </div>`;
  const errBanner=_bkFetchError?`<div style="background:#3b0f0f;border:1px solid rgba(239,68,68,0.3);border-radius:7px;padding:12px 16px;margin-bottom:14px;"><div style="font-size:12px;font-weight:600;color:#f87171;margin-bottom:6px;">Backup Data Fetch Error</div><div style="font-size:12px;color:#fca5a5;line-height:1.5;word-break:break-word;">${escHtml(_bkFetchError)}</div></div>`:'';
  if(isAll){
    // Dashboard: no page header bar, menu lives inline on the page
    el.innerHTML=`<div class="bk-scroll">${errBanner}${bkRenderDashboard(menuHtml,subtitle)}</div>`;
  } else {
    // Client detail: show the page header with title + back button
    const pageHeader=`<div class="bk-page-header">
      <div><div class="bk-page-title">${titleHtml}</div><div class="bk-page-subtitle">${subtitle}</div></div>
      <div class="header-actions">${menuHtml}</div>
    </div>`;
    el.innerHTML=pageHeader+`<div class="bk-scroll">${errBanner}${bkRenderOverview()}</div>`;
  }
}

function bkRenderDashboard(menuHtml='',subtitle=''){
  const allClients=bkGetClients();
  if(!allClients.length)return`<div class="bk-dash"><div style="text-align:center;padding:60px 20px;"><div style="font-size:14px;font-weight:500;color:var(--text2);margin-bottom:6px;">No clients configured</div><div style="font-size:12px;color:var(--text3);margin-bottom:18px;">Add your first backup client using the sidebar.</div><button class="btn-primary" onclick="bkAddClient()">+ Add Client</button></div></div>`;
  const visible=_bkHideInactive?allClients.filter(c=>c.syncrify==='Active'||c.wasabi==='Active'):allClients;
  const cats=visible.map(c=>{const live=_backupLiveData?.[c.syncrifyId];return{c,live,st:bkRowStatus(c,live)};});
  const errors=cats.filter(x=>x.st==='error');
  const warns=cats.filter(x=>x.st==='warn');
  const noData=cats.filter(x=>x.st!=='inactive'&&!x.live&&x.c.syncrifyId);
  const inactive=cats.filter(x=>x.st==='inactive');
  const good=cats.filter(x=>x.st==='good'&&x.live);
  let sumUsed=0,sumAllotted=0;
  visible.forEach(c=>{const live=_backupLiveData?.[c.syncrifyId];if(live)sumUsed+=live.usedBytes/1e9;if(c.allottedGB>0)sumAllotted+=c.allottedGB;});
  const loading=_backupLiveData===null;
  const statVal=(n,color)=>`<div class="dash-stat-value" style="color:${color};">${loading?'…':n}</div>`;
  const issueList=[...errors,...warns];
  const stColor={error:'#ef4444',warn:'#f59e0b',good:'#22c55e',inactive:'#4b5563'};
  const clientCard=({c,live,st})=>{
    const usedGB=live?live.usedBytes/1e9:null;
    const monP=live?live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled'):[];
    const totalP=live?monP.length:null;
    const compP=live&&(c.syncrify==='Active'||c.wasabi==='Active')?monP.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))).length:null;
    const oldest=live&&monP.length?Math.min(...monP.map(p=>p.lastAccess)):null;
    const compColor=compP===null?'var(--text3)':compP===totalP?'#22c55e':compP===0?'#ef4444':'#f59e0b';
    const running=live&&live.profiles.some(p=>bkGetActiveJobs().some(j=>j.profile===p.profile));
    return`<div class="bk-client-card" style="border-left-color:${live||st==='inactive'?stColor[st]||'#4b5563':'#6b7280'};" onclick="bkSwitchClient('${c.id}')">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;">
        <span class="bk-card-name">${escHtml(c.name)}</span>
        ${running?`<span class="bk-live-dot" title="Backup currently running"></span>`:''}
      </div>
      <div class="bk-card-meta">
        ${!live?'<span>No profile data</span>':''}
        ${!live&&!c.syncrifyId?`<span style="color:var(--danger);">No Syncrify ID</span>`:''}
      </div>
      ${(()=>{if(!live||!monP.length)return'';const active=c.syncrify==='Active'||c.wasabi==='Active';const gap=monP.length>15?1:2;const segHtml=monP.map(p=>{const freq=bkEffectiveFreq(c,p.profile);const comp=bkIsCompliant(p.lastAccess,freq);const col=!active?'#4b5563':comp===false?'#ef4444':comp==='grace'?'#f59e0b':'#22c55e';const tip=p.lastAccess?`${escHtml(p.profile)} · ${freq} · ${bkFmtDate(p.lastAccess)}${comp==='grace'?' · weekend grace':''}`:escHtml(p.profile);return`<div title="${tip}" style="flex:1;background:${col};border-radius:2px;min-width:3px;"></div>`;}).join('');const rightLabel=active?`${compP}/${totalP}`:`${totalP}`;const rightColor=active?compColor:'var(--text3)';return`<div style="margin-top:7px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;"><span style="font-size:8px;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;">Profiles</span><span style="font-size:9px;color:${rightColor};font-weight:600;">${rightLabel}</span></div><div style="display:flex;gap:${gap}px;height:7px;">${segHtml}</div></div>`;})()}
      ${(()=>{
        if(usedGB===null)return'';
        if(c.allottedGB===-1)return`<div style="margin-top:7px;"><div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-size:8px;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;">Storage</span><span style="font-size:9px;color:var(--text3);font-weight:600;">${bkFmt(usedGB)} · ∞</span></div></div>`;
        if(c.allottedGB===0)return`<div style="margin-top:7px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;"><span style="font-size:8px;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;">Storage</span><span style="font-size:9px;color:#ef4444;font-weight:600;">${bkFmt(usedGB)} / —</span></div><div class="bk-storage-bar"><div class="bk-storage-fill" style="width:100%;background:#ef4444;"></div></div></div>`;
        const pct=Math.min(100,usedGB/c.allottedGB*100);const barColor=pct>=90?'#ef4444':pct>=70?'#f59e0b':'#22c55e';
        return`<div style="margin-top:7px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;"><span style="font-size:8px;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;">Storage</span><span style="font-size:9px;color:${barColor};font-weight:600;">${bkFmt(usedGB)} / ${bkFmt(c.allottedGB)}</span></div><div class="bk-storage-bar"><div class="bk-storage-fill" style="width:${pct.toFixed(1)}%;background:${barColor};"></div></div></div>`;
      })()}
      ${(()=>{const coveredRoles=new Set();if(c.profileSettings)Object.values(c.profileSettings).forEach(ps=>{if(Array.isArray(ps.roles))ps.roles.forEach(r=>coveredRoles.add(r));});if(!coveredRoles.size)return'';return`<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:6px;">${BK_ROLES.map(r=>coveredRoles.has(r.id)?`<span style="font-size:8px;padding:1px 5px;border-radius:8px;background:${r.fg}25;color:${r.fg};border:1px solid ${r.fg}55;font-weight:600;">${r.label}</span>`:'').filter(Boolean).join('')}</div>`;})()}
    </div>`;
  };
  const cardGrid=arr=>`<div class="bk-card-grid">${arr.map(clientCard).join('')}</div>`;
  return`<div class="bk-dash">
    <div class="checklist-header" style="margin-bottom:18px;">
      <div>
        <h2 style="font-size:18px;font-weight:700;margin-bottom:2px;">Backup Monitoring</h2>
        <div class="meta">${visible.length} client${visible.length!==1?'s':''} monitored${sumAllotted>0?' · '+bkFmt(sumUsed)+' used of '+bkFmt(sumAllotted)+' allotted':sumUsed>0?' · '+bkFmt(sumUsed)+' used':''}${subtitle?' · '+subtitle:''}</div>
      </div>
      <div class="header-actions">${menuHtml}</div>
    </div>
    ${bkDriveUsageHtml()}
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:24px;">
      <div class="dash-stat">${statVal(issueList.length,'var(--danger)')}<div class="dash-stat-label">${issueList.length===1?'Issue':'Issues'}</div></div>
      <div class="dash-stat">${statVal(good.length,'var(--success)')}<div class="dash-stat-label">All Clear</div></div>
      <div class="dash-stat">${statVal(noData.length,'var(--text2)')}<div class="dash-stat-label">No Data</div></div>
      <div class="dash-stat">${statVal(inactive.length,'var(--text3)')}<div class="dash-stat-label">Inactive</div></div>
      <div class="dash-stat">${statVal(visible.length,'var(--accent)')}<div class="dash-stat-label">Total</div></div>
    </div>
    ${(()=>{const oi=bkGetOrphanIds();if(!oi.length||loading)return'';return`<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:7px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><span style="color:#f59e0b;font-size:12px;font-weight:600;flex-shrink:0;">⚠ ${oi.length} unrecognized Syncrify ID${oi.length!==1?'s':''}</span><span style="color:var(--text3);font-size:11px;flex:1;min-width:80px;">${oi.map(id=>`<code style="background:var(--bg3);padding:1px 5px;border-radius:3px;font-family:var(--mono);font-size:10px;">${escHtml(id)}</code>`).join(' ')}</span><button onclick="bkOpenProfiles()" style="font-size:11px;color:var(--accent);background:none;border:1px solid var(--border2);border-radius:4px;cursor:pointer;padding:3px 9px;white-space:nowrap;flex-shrink:0;">View Profiles →</button></div>`;})()}
    ${(()=>{
      const jobs=bkGetActiveJobs();
      if(!jobs.length||loading)return'';
      const rows=jobs.map(j=>{
        const c=bkFindClientByProfile(j.profile);
        const name=c?c.name:j.profile;
        const progress=(j.filesCompleted!=null&&j.filesQueue!=null)?`${j.filesCompleted}/${j.filesCompleted+j.filesQueue} files`:'';
        const started=bkParseSyncrifyDate(j.startedOn);
        const elapsedMs=started?Date.now()-started.getTime():null;
        const elapsed=bkFormatElapsed(elapsedMs);
        const stuck=elapsedMs!=null&&elapsedMs>3*3600000;
        const startedHtml=started?`<span title="Started ${escHtml(j.startedOn)}"${stuck?' style="color:var(--warn);font-weight:600;"':''}>${stuck?'⚠ ':''}running ${elapsed}</span>`:'';
        const detail=[j.bytes,j.status,progress].filter(Boolean).map(escHtml).concat(startedHtml?[startedHtml]:[]).join(' · ');
        return`<div style="padding:3px 0;font-size:11px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="bk-live-dot"></span>
            <span style="font-weight:600;color:var(--text);">${escHtml(name)}</span>
            <span style="color:var(--text3);">${escHtml(j.profile)}</span>
            ${detail?`<span style="margin-left:auto;color:var(--text3);">${detail}</span>`:''}
          </div>
          ${j.message?`<div style="padding-left:15px;color:var(--text3);font-size:10px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escHtml(j.message)}">${escHtml(j.message)}</div>`:''}
        </div>`;
      }).join('');
      return`<div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.25);border-radius:7px;padding:10px 14px;margin-bottom:16px;">
        <div style="color:#22c55e;font-size:12px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px;"><span class="bk-live-dot"></span>${jobs.length} backup${jobs.length!==1?'s':''} currently running</div>
        ${rows}
      </div>`;
    })()}
    ${_bkCardSort==='status'?`
    ${issueList.length?`<div style="margin-bottom:20px;"><div class="dash-section-label" style="color:var(--danger);">Issues (${issueList.length})</div>${cardGrid(issueList)}</div>`:''}
    ${noData.length?`<div style="margin-bottom:20px;"><div class="dash-section-label" style="color:var(--warn);">No Live Data (${noData.length})</div>${cardGrid(noData)}</div>`:''}
    ${good.length?`<div style="margin-bottom:20px;"><div class="dash-section-label" style="color:var(--success);">All Clear (${good.length})</div>${cardGrid(good)}</div>`:''}
    ${!_bkHideInactive&&inactive.length?`<div style="margin-bottom:20px;"><div class="dash-section-label">Inactive (${inactive.length})</div>${cardGrid(inactive)}</div>`:''}
    `:cardGrid(bkSortClientCats(cats,_bkCardSort))}
    ${loading?`<div style="text-align:center;padding:20px;color:var(--text3);font-size:12px;">Loading live data…</div>`:''}
  </div>`;
}
function bkFmt(usedGB){return usedGB>=1000?(usedGB/1000).toFixed(1)+' TB':usedGB.toFixed(0)+' GB';}
function bkFmtBytes(bytes){if(bytes==null)return'—';const tb=bytes/1024**4,gb=bytes/1024**3;return tb>=1?tb.toFixed(1)+' TB':gb.toFixed(0)+' GB';}
function bkDriveUsageHtml(compact){
  if(!_backupDriveData)return'';
  const{totalBytes,freeBytes}=_backupDriveData;
  const usedBytes=totalBytes-freeBytes;
  const pct=Math.min(100,usedBytes/totalBytes*100);
  const barColor=pct>=90?'#ef4444':pct>=75?'#f59e0b':'#22c55e';
  return`<div style="${compact?'min-width:230px;':'width:100%;margin-bottom:14px;'}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
      <span style="font-size:${compact?9:10}px;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;">Drive Usage</span>
      <span style="font-size:${compact?11:12}px;color:${barColor};font-weight:600;">${bkFmtBytes(usedBytes)} / ${bkFmtBytes(totalBytes)} (${pct.toFixed(0)}%)</span>
    </div>
    <div class="bk-storage-bar"><div class="bk-storage-fill" style="width:${pct.toFixed(1)}%;background:${barColor};"></div></div>
  </div>`;
}
function bkFmtDate(ms){if(!ms)return'—';return new Date(ms).toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'2-digit'});}
function bkFmtAge(ms,threshDays,grace=false){if(!ms)return{text:'—',color:'var(--text3)',date:''};const d=Math.floor((Date.now()-ms)/86400000);let text;if(d===0)text='today';else if(d===1)text='1d ago';else if(d<30)text=`${d}d ago`;else if(d<365)text=`${Math.floor(d/30)}mo ago`;else{const yrs=Math.floor(d/365);const mos=Math.floor((d%365)/30);text=mos>0?`${yrs}yr, ${mos}mo ago`:`${yrs}yr ago`;}const color=grace?'#f59e0b':d>threshDays?'#ef4444':d>threshDays*0.75?'#f59e0b':'#22c55e';return{text,color,date:bkFmtDate(ms)};}
function bkFmtCur(n){return'$'+(n||0).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});}

function bkSaveProfileFreq(clientId,profileName,freq){
  const clients=bkGetClients().slice();
  const c=clients.find(x=>x.id===clientId);
  if(!c)return;
  if(!c.profileSettings)c.profileSettings={};
  if(!c.profileSettings[profileName])c.profileSettings[profileName]={};
  c.profileSettings[profileName].frequency=freq;
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  const scroll=document.querySelector('.bk-scroll');
  const scrollTop=scroll?scroll.scrollTop:0;
  renderBackupsSidebar();
  bkRenderMain();
  if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkSaveProfileNote(clientId,profileName,note){
  const clients=bkGetClients().slice();
  const c=clients.find(x=>x.id===clientId);
  if(!c)return;
  if(!c.profileSettings)c.profileSettings={};
  if(!c.profileSettings[profileName])c.profileSettings[profileName]={};
  const ps=c.profileSettings[profileName];
  if(note.trim())ps.note=note.trim();else delete ps.note;
  if(!Object.keys(ps).length)delete c.profileSettings[profileName];
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
}
function bkSortBy(col){
  if(_bkSort.col===col)_bkSort.dir*=-1;else{_bkSort.col=col;_bkSort.dir=1;}
  const scroll=document.querySelector('.bk-scroll');const scrollTop=scroll?scroll.scrollTop:0;
  bkRenderMain();if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkAutoTagProfiles(clientId){
  const clients=bkGetClients().slice();
  const c=clients.find(x=>x.id===clientId);
  if(!c)return;
  const live=_backupLiveData?.[c.syncrifyId];
  if(!live||!live.profiles.length){showToast('No live profile data available','error');return;}
  if(!c.profileSettings)c.profileSettings={};
  let changed=0;
  live.profiles.forEach(p=>{
    const n=p.profile.toLowerCase();
    const isWin=/win(dows)?/.test(n);
    const isPrx=/prox(mox)?|pve/.test(n);
    const isImg=/image|img|snapshot|snap/.test(n);
    const isDat=/data|files?/.test(n)&&!isImg;
    const isLoc=/local|nas\b/.test(n);
    const isOff=/off.?site|offsite|remote|cloud/.test(n);
    const suggestions=[];
    if(isWin&&isImg&&isLoc)suggestions.push('win-img-local');
    if(isWin&&isImg&&isOff)suggestions.push('win-img-offsite');
    if(isWin&&isDat&&isLoc)suggestions.push('win-data-local');
    if(isWin&&isDat&&isOff)suggestions.push('win-data-offsite');
    if(isPrx&&isImg&&isLoc)suggestions.push('prx-img-local');
    if(isPrx&&isImg&&isOff)suggestions.push('prx-img-offsite');
    if(isPrx&&isDat&&isLoc)suggestions.push('prx-data-local');
    if(isPrx&&isDat&&isOff)suggestions.push('prx-data-offsite');
    if(!suggestions.length)return;
    if(!c.profileSettings[p.profile])c.profileSettings[p.profile]={};
    const ps=c.profileSettings[p.profile];
    const roles=new Set(Array.isArray(ps.roles)?ps.roles:[]);
    const before=roles.size;
    suggestions.forEach(r=>roles.add(r));
    if(roles.size>before){ps.roles=[...roles];changed++;}
  });
  if(!changed){showToast('No new tags detected from profile names');return;}
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  showToast(`Auto-tagged ${changed} profile${changed!==1?'s':''}`);
  const scroll=document.querySelector('.bk-scroll');const scrollTop=scroll?scroll.scrollTop:0;
  bkRenderMain();if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkToggleProfileNote(clientId,profileName){
  const key=clientId+':'+profileName;
  if(_bkProfileNoteOpen.has(key))_bkProfileNoteOpen.delete(key);else _bkProfileNoteOpen.add(key);
  const scroll=document.querySelector('.bk-scroll');
  const scrollTop=scroll?scroll.scrollTop:0;
  bkRenderMain();
  if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkToggleProfileRole(clientId,profileName,roleId){
  const clients=bkGetClients().slice();
  const c=clients.find(x=>x.id===clientId);
  if(!c)return;
  if(!c.profileSettings)c.profileSettings={};
  if(!c.profileSettings[profileName])c.profileSettings[profileName]={};
  const ps=c.profileSettings[profileName];
  const roles=Array.isArray(ps.roles)?[...ps.roles]:[];
  const idx=roles.indexOf(roleId);
  if(idx>=0)roles.splice(idx,1);else roles.push(roleId);
  if(roles.length)ps.roles=roles;else delete ps.roles;
  if(!Object.keys(ps).length)delete c.profileSettings[profileName];
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  const modal=document.getElementById('bk-profiles-modal');
  if(modal&&modal.style.display!=='none'){
    const body=document.getElementById('bk-profiles-modal-body');
    if(body)body.innerHTML=bkRenderProfiles();
  } else {
    const scroll=document.querySelector('.bk-scroll');
    const scrollTop=scroll?scroll.scrollTop:0;
    bkRenderMain();
    if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
  }
}
function bkToggleNote(id){
  if(_bkNoteOpen.has(id))_bkNoteOpen.delete(id);else _bkNoteOpen.add(id);
  const scroll=document.querySelector('.bk-scroll');
  const scrollTop=scroll?scroll.scrollTop:0;
  bkRenderMain();
  if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkToggleExpand(id){
  if(_bkExpanded.has(id))_bkExpanded.delete(id);else _bkExpanded.add(id);
  const scroll=document.querySelector('.bk-scroll');
  const scrollTop=scroll?scroll.scrollTop:0;
  bkRenderMain();
  if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkSaveClient(id,field,val){
  const clients=bkGetClients().slice();
  const c=clients.find(x=>x.id===id);
  if(!c)return;
  if(['allottedGB','contractDevices','charged'].includes(field))val=parseFloat(val)||0;
  c[field]=val;
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  if(['syncrify','wasabi','frequency','charged','notes'].includes(field))bkLogAction('bk_client_updated',{note:`${c.name}: ${field}=${val}`});
  const scroll=document.querySelector('.bk-scroll');
  const scrollTop=scroll?scroll.scrollTop:0;
  renderBackupsSidebar();
  bkRenderMain();
  bkUpdateNavBadge();
  if(scrollTop)requestAnimationFrame(()=>{const s=document.querySelector('.bk-scroll');if(s)s.scrollTop=scrollTop;});
}
function bkAddClient(){
  const clients=bkGetClients().slice();
  clients.push({id:'bk'+Date.now(),name:'New Client',syncrifyId:'',allottedGB:0,contractDevices:0,charged:0,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'',notes:''});
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  bkLogAction('bk_client_added');
  renderBackupsSidebar();
  bkRenderMain();
}
function bkGetOrphanIds(){
  if(!_backupLiveData)return[];
  const known=new Set(bkGetClients().map(c=>c.syncrifyId).filter(Boolean));
  return Object.keys(_backupLiveData).filter(id=>!known.has(id));
}
function bkAddClientFromId(syncrifyId){
  const clients=bkGetClients().slice();
  clients.push({id:'bk'+Date.now(),name:syncrifyId,syncrifyId,allottedGB:0,contractDevices:0,charged:0,syncrify:'Active',wasabi:'Active',frequency:'Daily',vpnHost:'',notes:''});
  appSettings.backupClients=clients;
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  bkLogAction('bk_client_added',{note:`from unrecognized ID: ${syncrifyId}`});
  closeBkProfilesModal();
  renderBackupsSidebar();
  bkRenderMain();
  showToast(`Added client for "${syncrifyId}" — fill in name and details in the overview`);
}
function bkRemoveClient(id){
  if(!confirm('Remove this client? This cannot be undone.'))return;
  const c=bkGetClients().find(x=>x.id===id);
  appSettings.backupClients=bkGetClients().filter(c=>c.id!==id);
  if(_bkActiveClient===id)_bkActiveClient='all';
  fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  bkLogAction('bk_client_removed',{note:c?.name||id});
  renderBackupsSidebar();
  bkRenderMain();
}

function bkRenderOverview(){
  let clients=bkGetClients();
  if(_bkActiveClient!=='all')clients=clients.filter(c=>c.id===_bkActiveClient);
  if(_bkHideInactive)clients=clients.filter(c=>c.syncrify==='Active'||c.wasabi==='Active');
  if(_bkFilterNonCompliant)clients=clients.filter(c=>bkRowStatus(c,_backupLiveData?.[c.syncrifyId])==='error');

  // Apply column sort
  if(_bkSort.col){
    clients=[...clients].sort((a,b)=>{
      const la=_backupLiveData?.[a.syncrifyId],lb=_backupLiveData?.[b.syncrifyId];
      let av,bv;
      if(_bkSort.col==='name'){av=a.name.toLowerCase();bv=b.name.toLowerCase();return av<bv?-_bkSort.dir:av>bv?_bkSort.dir:0;}
      if(_bkSort.col==='used'){av=la?la.usedBytes:0;bv=lb?lb.usedBytes:0;}
      if(_bkSort.col==='allotted'){av=a.allottedGB||0;bv=b.allottedGB||0;}
      if(_bkSort.col==='oldest'){av=la&&la.profiles.length?Math.min(...la.profiles.map(p=>p.lastAccess)):0;bv=lb&&lb.profiles.length?Math.min(...lb.profiles.map(p=>p.lastAccess)):0;}
      if(_bkSort.col==='compliant'){
        const ap=la?la.profiles.length:0,bp=lb?lb.profiles.length:0;
        const ac=la?la.profiles.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(a,p.profile))).length:0;
        const bc=lb?lb.profiles.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(b,p.profile))).length:0;
        av=ap>0?ac/ap:-1;bv=bp>0?bc/bp:-1;
      }
      if(_bkSort.col==='status'){const o={error:0,warn:1,good:2,inactive:3};av=o[bkRowStatus(a,la)]??2;bv=o[bkRowStatus(b,lb)]??2;}
      return(av-bv)*_bkSort.dir;
    });
  }

  let sumAllotted=0,sumCharged=0,sumUsed=0,sumCalc=0,issueCount=0;
  const issueClients=[];
  clients.forEach(c=>{
    if(c.allottedGB>0)sumAllotted+=c.allottedGB;
    sumCharged+=c.charged||0;
    const live=_backupLiveData?.[c.syncrifyId];
    if(live){const g=live.usedBytes/1e9;sumUsed+=g;sumCalc+=bkCalcCost(g,live.profiles.length);}
    const st=bkRowStatus(c,live);
    if(st==='error'||st==='warn'){issueCount++;issueClients.push({c,live,st});}
  });

  let unmatchedHtml='';
  if(_backupLiveData&&_bkActiveClient==='all'){
    const clientIds=new Set(bkGetClients().map(c=>c.syncrifyId).filter(Boolean));
    const unmatched=Object.keys(_backupLiveData).filter(k=>!clientIds.has(k));
    if(unmatched.length)unmatchedHtml=`<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;padding:8px 14px;margin-bottom:12px;font-size:11px;"><span style="color:var(--warn);font-weight:600;">⚠ ${unmatched.length} unmatched Syncrify ID${unmatched.length>1?'s':''} in live data:</span><span style="color:var(--text3);margin-left:6px;">${unmatched.map(k=>`<code style="background:var(--bg3);padding:1px 4px;border-radius:3px;">${escHtml(k)}</code>`).join(' ')}</span></div>`;
  }

  const sel=(id,field,opts,val)=>`<select class="bk-cell-select" onchange="bkSaveClient('${id}','${field}',this.value)">${opts.map(o=>`<option value="${o}"${val===o?' selected':''}>${o}</option>`).join('')}</select>`;

  // Coverage checklist — only shown when a single client is selected
  let coverageHtml='';
  if(_bkActiveClient!=='all'&&clients.length===1){
    const c=clients[0];
    const coveredRoles=new Set();
    if(c.profileSettings)Object.values(c.profileSettings).forEach(ps=>{if(Array.isArray(ps.roles))ps.roles.forEach(r=>coveredRoles.add(r));});
    const hasCoverage=coveredRoles.size>0||Object.values(c.profileSettings||{}).some(ps=>ps.roles?.length);
    const autoBtn=`<button class="btn-secondary" style="font-size:10px;padding:3px 8px;" onclick="bkAutoTagProfiles('${c.id}')">Auto-tag</button>`;
    coverageHtml=`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;">Coverage</span>
        ${autoBtn}
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;">
        ${BK_ROLES.map(r=>{
          const on=coveredRoles.has(r.id);
          return`<div style="display:flex;align-items:center;gap:5px;padding:5px 8px;border-radius:5px;border:1px solid ${on?r.fg+'55':'var(--border)'};background:${on?r.fg+'18':'transparent'};">
            <span style="font-size:11px;${on?`color:${r.fg};`:'color:var(--text3);'}font-weight:600;">${on?'✓':'○'}</span>
            <span style="font-size:10px;${on?`color:${r.fg};font-weight:500;`:'color:var(--text3);'}">${r.label}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  return unmatchedHtml+coverageHtml+(_bkActiveClient==='all'?`<div class="bk-summary-bar">
    <div class="bk-sum-card"><div class="bk-sum-lbl">Total Used</div><div class="bk-sum-val">${bkFmt(sumUsed)}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl">Total Allotted</div><div class="bk-sum-val">${bkFmt(sumAllotted)}</div></div>
    ${_bkShowCosts?`<div class="bk-sum-card"><div class="bk-sum-lbl">Total Charged</div><div class="bk-sum-val">${bkFmtCur(sumCharged)}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl">Calculated</div><div class="bk-sum-val">${bkFmtCur(sumCalc)}</div></div>
    <div class="bk-sum-card"><div class="bk-sum-lbl">Difference</div><div class="bk-sum-val ${sumCharged-sumCalc<0?'bk-neg':''}">${bkFmtCur(sumCharged-sumCalc)}</div></div>`:''}
    ${issueCount>0?`<div class="bk-sum-card bk-issues-card" style="border-color:rgba(239,68,68,0.35);" onclick="bkToggleIssues()">
      <div style="display:flex;align-items:center;justify-content:space-between;"><div class="bk-sum-lbl" style="color:var(--danger);">Issues</div><span style="font-size:9px;color:var(--text3);">▾ tap to expand</span></div>
      <div class="bk-sum-val" style="color:var(--danger);">${issueCount}</div>
      <div class="bk-issues-detail" id="bk-issues-detail">
        ${issueClients.map(({c,live,st})=>{
          let reason='';
          if(st==='error'){const nc=live?.profiles.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))===false)||[];reason=nc.length+' profile'+(nc.length!==1?'s':'')+' non-compliant';}
          else{const usedGB=live?live.usedBytes/1e9:0;const calc=bkCalcCost(usedGB,live?.profiles.length||0);reason=`cost +${bkFmtCur(calc-(c.charged||0))} over`;}
          return`<div class="bk-issue-row"><span class="bk-dot bk-dot-${st}"></span><span style="flex:1;">${escHtml(c.name)}</span><span style="color:var(--text3);font-size:10px;">${reason}</span><button style="background:none;border:none;color:var(--accent);font-size:10px;cursor:pointer;padding:2px 4px;" onclick="event.stopPropagation();bkSwitchClient('${c.id}')">→</button></div>`;
        }).join('')}
      </div>
    </div>`:''}
  </div>`:'')
  +(_bkActiveClient==='all'?`<div style="display:flex;justify-content:flex-end;margin-bottom:6px;"><button class="btn-secondary" style="font-size:11px;padding:3px 10px;${_bkFilterNonCompliant?'border-color:var(--danger);color:var(--danger);background:rgba(239,68,68,0.08);':''}" onclick="_bkFilterNonCompliant=!_bkFilterNonCompliant;bkRenderMain()">${_bkFilterNonCompliant?'✕ Clear filter':'⚠ Non-compliant only'}</button></div>`:'')
  +`<div class="bk-table-wrap"><table class="bk-table">
    <thead>
      <tr>
        <th class="bk-th-name" rowspan="2" onclick="bkSortBy('name')" style="cursor:pointer;" title="Sort by name">Client${_bkSort.col==='name'?(_bkSort.dir>0?' ↑':' ↓'):''}</th>
        <th colspan="${_bkShowCosts?4:2}" style="text-align:center;padding-bottom:3px;color:#60a5fa;border-bottom:2px solid rgba(96,165,250,0.25);">Contract</th>
        <th colspan="${_bkShowCosts?4:2}" style="text-align:center;padding-bottom:3px;color:#34d399;border-bottom:2px solid rgba(52,211,153,0.25);">Live</th>
        <th colspan="4" style="text-align:center;padding-bottom:3px;color:#fbbf24;border-bottom:2px solid rgba(251,191,36,0.25);">Backup Status</th>
        <th rowspan="2">VPN</th>
        <th rowspan="2" style="text-align:center;width:36px;">Notes</th>
      </tr><tr>
        <th onclick="bkSortBy('allotted')" style="cursor:pointer;color:#60a5fa99;" title="Sort by allotted">Allotted (GB)${_bkSort.col==='allotted'?(_bkSort.dir>0?' ↑':' ↓'):''}</th><th style="color:#60a5fa99;">Devices</th>${_bkShowCosts?'<th style="color:#60a5fa99;">Est. ($)</th><th style="color:#60a5fa99;">Charged ($)</th>':''}
        <th onclick="bkSortBy('used')" style="cursor:pointer;color:#34d39999;" title="Sort by usage">Used${_bkSort.col==='used'?(_bkSort.dir>0?' ↑':' ↓'):''}</th><th style="color:#34d39999;">Devices</th>${_bkShowCosts?'<th style="color:#34d39999;">Calc.</th><th style="color:#34d39999;">Diff.</th>':''}
        <th onclick="bkSortBy('status')" style="cursor:pointer;color:#fbbf2499;" title="Sort by status">Syncrify${_bkSort.col==='status'?(_bkSort.dir>0?' ↑':' ↓'):''}</th><th style="color:#fbbf2499;">Wasabi</th><th onclick="bkSortBy('oldest')" style="cursor:pointer;color:#fbbf2499;" title="Sort by oldest backup">Oldest Backup${_bkSort.col==='oldest'?(_bkSort.dir>0?' ↑':' ↓'):''}</th><th onclick="bkSortBy('compliant')" style="cursor:pointer;color:#fbbf2499;" title="Sort by compliance">Profiles${_bkSort.col==='compliant'?(_bkSort.dir>0?' ↑':' ↓'):''}</th>
      </tr>
    </thead>
    <tbody>
      ${clients.map(c=>{
        const live=_backupLiveData?.[c.syncrifyId];
        const hasProfiles=live&&live.profiles.length>0;
        const expanded=true;
        const usedGB=live?live.usedBytes/1e9:null;
        const devCnt=live?live.profiles.filter(p=>p.diskSize>0).length:null;
        const monProfiles=live?live.profiles.filter(p=>bkEffectiveFreq(c,p.profile)!=='Disabled'):[];
        const totalProfiles=live?monProfiles.length:null;
        const calc=usedGB!==null?bkCalcCost(usedGB,live?live.profiles.length:0):null;
        const diff=(calc!==null&&c.charged!==undefined)?c.charged-calc:null;
        const oldestAccess=monProfiles.length?Math.min(...monProfiles.map(p=>p.lastAccess)):null;
        const active=c.syncrify==='Active'||c.wasabi==='Active';
        const compliantCount=active&&live?monProfiles.filter(p=>bkIsCompliant(p.lastAccess,bkEffectiveFreq(c,p.profile))).length:null;
        const ageDays=oldestAccess?(Date.now()-oldestAccess)/86400000:null;
        const st=bkRowStatus(c,live);
        const estCost=c.allottedGB>0?bkEstCost(c.allottedGB,c.contractDevices):null;
        const inp=(field,val,style='')=>`<input type="text" class="bk-cell-input" value="${escHtml(String(val??''))}" onblur="bkSaveClient('${c.id}','${field}',this.value)" onkeydown="if(event.key==='Enter')this.blur()"${style?` style="${style}"`:''}>`
        const num=(field,val,step=1,min=0)=>`<input type="number" class="bk-cell-input bk-cell-num" min="${min}" step="${step}" value="${val??0}" onblur="bkSaveClient('${c.id}','${field}',this.value)" onkeydown="if(event.key==='Enter')this.blur()">`;
        const chevron=`<span class="bk-expand-toggle" style="opacity:0;pointer-events:none;">▸</span>`;
        const profilesCell=totalProfiles===null?'—'
          :compliantCount===null?`<span class="bk-dim">${totalProfiles}</span>`
          :`<span class="${compliantCount===totalProfiles?'bk-pos':compliantCount===0?'bk-neg':'bk-warn'}">${compliantCount}/${totalProfiles}</span>`;
        const vpnSel=['Zywall','Unifi','Other'].includes(c.vpnHost)?c.vpnHost:(c.vpnHost?'Other':'');
        const ncols=_bkShowCosts?15:11;
        const noteRow=_bkNoteOpen.has(c.id)?`<tr class="bk-note-row">
          <td colspan="${ncols}" style="padding:4px 12px 8px 44px;background:rgba(245,158,11,0.04);border-bottom:1px solid var(--border);">
            <textarea style="width:100%;max-width:600px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:6px 8px;color:var(--text);font-size:11px;font-family:var(--sans);resize:vertical;min-height:44px;outline:none;box-sizing:border-box;display:block;" placeholder="Add notes…" onblur="bkSaveClient('${c.id}','notes',this.value)" onkeydown="if(event.key==='Escape')bkToggleNote('${c.id}')">${escHtml(c.notes||'')}</textarea>
          </td>
        </tr>`:'';
        const expandRow=hasProfiles&&expanded?`<tr class="bk-expand-row">
          <td colspan="${ncols}" style="padding:4px 8px 8px 44px;border-bottom:1px solid var(--border);">
            <table class="bk-expand-table">
              <thead><tr>
                <th style="text-align:left;">Profile · Roles</th>
                <th style="text-align:right;">Used</th>
                <th style="text-align:right;">Last Backup</th>
                <th class="bk-exp-freq">Freq.</th>
                <th style="text-align:center;" title="Encrypted">Enc</th>
                <th style="text-align:center;" title="Last run status">Run</th>
                <th style="text-align:center;padding-right:0;">&#9998;</th>
              </tr></thead>
              <tbody>${live.profiles.map((p,pi)=>{
                const pEffectiveFreq=bkEffectiveFreq(c,p.profile);
                const pThresh=pEffectiveFreq==='Monthly'?32:pEffectiveFreq==='Weekly'?8:2;
                const pAge=(Date.now()-p.lastAccess)/86400000;
                const pOk=bkIsCompliant(p.lastAccess,pEffectiveFreq);
                const ps=c.profileSettings&&c.profileSettings[p.profile]||{};
                const pRoles=Array.isArray(ps.roles)?ps.roles:[];
                const noteKey=c.id+':'+p.profile;
                const noteOpen=_bkProfileNoteOpen.has(noteKey);
                const hasNote=!!(ps.note);
                const roleToggleChips=BK_ROLES.map(r=>{
                  const on=pRoles.includes(r.id);
                  return`<button data-cid="${c.id}" data-pname="${escHtml(p.profile)}" data-rid="${r.id}" onclick="bkToggleProfileRole(this.dataset.cid,this.dataset.pname,this.dataset.rid)" style="font-size:8px;padding:1px 5px;border-radius:8px;cursor:pointer;transition:all 0.1s;${on?`background:${r.fg}25;color:${r.fg};border:1px solid ${r.fg}66;font-weight:600;`:'background:transparent;color:var(--text3);border:1px solid var(--border2);'}">${r.label}</button>`;
                }).join('');
                const pAgeInfo=bkFmtAge(p.lastAccess,pThresh,pOk==='grace');
                const isDisabled=pEffectiveFreq==='Disabled';
                const pRunning=bkGetActiveJobs().some(j=>j.profile===p.profile);
                const profileRow=`<tr${isDisabled?' style="opacity:0.45;"':''}>
                  <td style="text-align:left;min-width:220px;">
                    <div style="font-size:11px;font-weight:500;margin-bottom:4px;display:flex;align-items:center;gap:5px;">${escHtml(p.profile)}${pRunning?`<span class="bk-live-dot" title="Backup currently running"></span>`:''}</div>
                    <div style="display:flex;flex-wrap:wrap;gap:3px;">${roleToggleChips}</div>
                  </td>
                  <td style="text-align:right;color:var(--text3);vertical-align:top;padding-top:8px;">${p.diskSize>0?bkFmt(p.diskSize/1e9):'<span class="bk-dim">—</span>'}</td>
                  <td style="text-align:right;vertical-align:top;padding-top:8px;" title="${pAgeInfo.date}"><span style="color:${pAgeInfo.color};font-weight:500;">${pAgeInfo.text}</span></td>
                  <td class="bk-exp-freq" style="vertical-align:top;padding-top:6px;">
                    <select class="bk-cell-select" style="font-size:10px;" data-cid="${c.id}" data-pname="${escHtml(p.profile)}" onchange="bkSaveProfileFreq(this.dataset.cid,this.dataset.pname,this.value)">
                      <option value="Daily"${pEffectiveFreq==='Daily'?' selected':''}>Daily</option>
                      <option value="Weekly"${pEffectiveFreq==='Weekly'?' selected':''}>Weekly</option>
                      <option value="Monthly"${pEffectiveFreq==='Monthly'?' selected':''}>Monthly</option>
                      <option value="Disabled"${pEffectiveFreq==='Disabled'?' selected':''}>Disabled</option>
                    </select>
                  </td>
                  <td style="text-align:center;vertical-align:top;padding-top:8px;" title="${p.encrypted?'Encrypted':'Not encrypted'}">${p.encrypted?'<span class="bk-pos">🔒</span>':'<span class="bk-dim">—</span>'}</td>
                  <td style="text-align:center;vertical-align:top;padding-top:8px;" title="${escHtml(p.lastRunOk===1?'Last run completed without errors':p.lastRunOk===0?(p.errFiles&&p.errFiles.length?'Failed files:\n'+p.errFiles.join('\n'):'Last run reported errors, but Syncrify did not disclose a reason.'):'No run history')}">${p.lastRunOk===1?'<span class="bk-pos">✓</span>':p.lastRunOk===0?'<span class="bk-neg" style="cursor:help;border-bottom:1px dotted currentColor;">✗</span>':'<span class="bk-dim">—</span>'}</td>
                  <td style="text-align:center;padding-right:0;vertical-align:top;padding-top:6px;">
                    <button class="quote-note-btn${hasNote?' has-note':''}" onclick="bkToggleProfileNote('${c.id}','${escHtml(p.profile)}')" title="${hasNote?escHtml(ps.note||''):'Add note'}">&#9998;</button>
                  </td>
                </tr>`;
                const noteRow=noteOpen?`<tr>
                  <td colspan="7" style="padding:2px 0 8px 0;border-top:none;">
                    <textarea style="width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:5px 8px;color:var(--text);font-size:11px;font-family:var(--sans);resize:vertical;min-height:36px;outline:none;box-sizing:border-box;display:block;" placeholder="Profile note…" onblur="bkSaveProfileNote('${c.id}','${escHtml(p.profile)}',this.value)" onkeydown="if(event.key==='Escape')bkToggleProfileNote('${c.id}','${escHtml(p.profile)}')">${escHtml(ps.note||'')}</textarea>
                  </td>
                </tr>`:'';
                const sep=pi>0?'<tr class="bk-expand-sep"><td colspan="7"></td></tr>':'';
                return sep+profileRow+noteRow;
              }).join('')}</tbody>
            </table>
          </td>
        </tr>`:'';
        return`<tr class="bk-row-${st}" data-client-id="${c.id}">
          <td class="bk-td-name">
            <div style="display:flex;align-items:center;gap:4px;">
              ${chevron}
              <span class="bk-dot bk-dot-${st}" style="flex-shrink:0;"></span>
              <div style="flex:1;min-width:0;">
                <input type="text" class="bk-cell-input" style="font-weight:500;" value="${escHtml(c.name)}" onblur="bkSaveClient('${c.id}','name',this.value)" onkeydown="if(event.key==='Enter')this.blur()">
                <div style="display:flex;align-items:center;gap:3px;margin-top:1px;"><span style="font-size:9px;color:var(--text3);flex-shrink:0;">ID:</span><input type="text" class="bk-cell-input" style="font-size:9px;color:var(--text3);width:80px;" value="${escHtml(c.syncrifyId||'')}" onblur="bkSaveClient('${c.id}','syncrifyId',this.value)" onkeydown="if(event.key==='Enter')this.blur()"></div>
              </div>
            </div>
          </td>
          <td data-label="Allotted"><div style="display:flex;align-items:center;justify-content:flex-end;gap:3px;">${num('allottedGB',c.allottedGB,500,-1)}<span style="font-size:9px;color:var(--text3);flex-shrink:0;">${c.allottedGB===-1?'∞':'GB'}</span></div></td>
          <td data-label="Devices">${num('contractDevices',c.contractDevices,1,-1)}</td>
          ${_bkShowCosts?`<td data-label="Est." style="color:var(--text3);">${estCost!==null?bkFmtCur(estCost):'—'}</td>
          <td data-label="Charged"><div style="display:flex;align-items:center;justify-content:flex-end;gap:1px;"><span style="font-size:9px;color:var(--text3);flex-shrink:0;">$</span>${num('charged',c.charged,5)}</div></td>`:''}
          <td data-label="Used">${usedGB!==null?(()=>{const over=c.allottedGB!==-1&&(c.allottedGB===0?usedGB>0:usedGB>c.allottedGB);return`<span style="${over?'color:#ef4444;font-weight:600;':''}" title="${over?'⚠ Exceeds allotted storage':''}">${bkFmt(usedGB)}${over?' ⚠':''}</span>`;})():'<span class="bk-dim">—</span>'}</td>
          <td data-label="Live">${devCnt!==null?devCnt:'<span class="bk-dim">—</span>'}</td>
          ${_bkShowCosts?`<td data-label="Calc.">${calc!==null?bkFmtCur(calc):'<span class="bk-dim">—</span>'}</td>
          <td data-label="Diff" class="${diff!==null?(diff>=0?'bk-pos':'bk-neg'):''}">${diff!==null?bkFmtCur(diff):'<span class="bk-dim">—</span>'}</td>`:''}
          <td data-label="Syncrify">${sel(c.id,'syncrify',['Active','Inactive'],c.syncrify)}</td>
          <td data-label="Wasabi">${sel(c.id,'wasabi',['Active','Inactive'],c.wasabi)}</td>
          <td data-label="Oldest" class="${oldestAccess!==null?(st==='error'?'bk-neg':'bk-pos'):''}">${bkFmtDate(oldestAccess)}</td>
          <td data-label="Profiles">${profilesCell}</td>
          <td data-label="VPN"><select class="bk-cell-select" onchange="bkSaveClient('${c.id}','vpnHost',this.value)"><option value=""${vpnSel===''?' selected':''}>—</option><option value="Zywall"${vpnSel==='Zywall'?' selected':''}>Zywall</option><option value="Unifi"${vpnSel==='Unifi'?' selected':''}>Unifi</option><option value="Other"${vpnSel==='Other'?' selected':''}>Other</option></select></td>
          <td style="text-align:center;padding:4px 8px;"><button class="quote-note-btn${c.notes?' has-note':''}" onclick="bkToggleNote('${c.id}')" title="${c.notes?escHtml(c.notes):'Add note'}">&#9998;</button></td>
        </tr>${noteRow}${expandRow}`;
      }).join('')}
    </tbody>
    <tfoot>
      <tr style="background:var(--bg3);font-size:10px;color:var(--text3);font-weight:600;">
        <td class="bk-td-name" style="padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;">Totals</td>
        <td style="text-align:right;padding:5px 8px;">${sumAllotted>0?bkFmt(sumAllotted):'—'}</td>
        <td style="padding:5px 8px;"></td>
        ${_bkShowCosts?`<td style="padding:5px 8px;"></td><td style="text-align:right;padding:5px 8px;">${bkFmtCur(sumCharged)}</td>`:''}
        <td style="text-align:right;padding:5px 8px;">${sumUsed>0?bkFmt(sumUsed):'—'}</td>
        <td style="padding:5px 8px;"></td>
        ${_bkShowCosts?`<td style="text-align:right;padding:5px 8px;">${bkFmtCur(sumCalc)}</td><td style="text-align:right;padding:5px 8px;${sumCharged-sumCalc<0?'color:#ef4444;':''}">${bkFmtCur(sumCharged-sumCalc)}</td>`:''}
        <td style="padding:5px 8px;"></td><td style="padding:5px 8px;"></td>
        <td style="padding:5px 8px;"></td>
        <td style="padding:5px 8px;"></td>
        <td style="padding:5px 8px;"></td><td style="padding:5px 8px;"></td>
      </tr>
    </tfoot>
  </table></div>`;
}

function bkRenderProfiles(){
  let clients=bkGetClients();
  if(_bkActiveClient!=='all')clients=clients.filter(c=>c.id===_bkActiveClient);
  if(!_backupLiveData)return`<div style="color:var(--text3);font-size:12px;padding:20px 0;">${_backupLiveData===null?'Loading backup data…':'Syncrify connection not configured — add one in Settings.'}</div>`;
  const pad=(s,n)=>String(s??'').substring(0,n).padEnd(n);
  const lines=[
    `# backup_profiles.txt${_bkLastUpdated?' | data from '+new Date(_bkLastUpdated).toLocaleString('en-US',{month:'numeric',day:'numeric',year:'2-digit',hour:'numeric',minute:'2-digit'}):''}`,
    `# ${clients.length} client(s)`,
    '',
    pad('CLIENT',22)+pad('PROFILE',38)+pad('SIZE',10)+pad('LAST ACCESS',14)+pad('FREQ',10)+pad('ENC',5)+'RUN',
    '─'.repeat(106),
  ];
  clients.forEach(c=>{
    const live=_backupLiveData[c.syncrifyId];
    if(!live||!live.profiles.length){lines.push(pad(c.syncrifyId||c.name,22)+'(no data)');return;}
    live.profiles.forEach(p=>{
      const freq=bkEffectiveFreq(c,p.profile);
      const comp=bkIsCompliant(p.lastAccess,freq);
      const flag=comp===null?'  ':comp===false?' ✗':comp==='grace'?' ~':' ✓';
      const size=p.diskSize>0?bkFmt(p.diskSize/1e9):'—';
      const date=p.lastAccess?new Date(p.lastAccess).toLocaleDateString('en-US',{year:'2-digit',month:'numeric',day:'numeric'}):'—';
      const enc=p.encrypted?'Yes':'No';
      const run=p.lastRunOk===1?'OK':p.lastRunOk===0?'ERR':'—';
      lines.push(flag+' '+pad(c.syncrifyId||c.name,20)+pad(p.profile,38)+pad(size,10)+pad(date,14)+pad(freq,10)+pad(enc,5)+run);
    });
  });
  const preBlock=`<pre style="font-family:var(--mono);font-size:11px;color:var(--text2);line-height:1.65;white-space:pre;overflow:auto;margin:0;padding:2px 0;">${escHtml(lines.join('\n'))}</pre>`;
  // Orphan section — only shown on the "all clients" view
  const orphanIds=_bkActiveClient==='all'?bkGetOrphanIds():[];
  if(!orphanIds.length)return preBlock;
  const orphanSection=`<div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px;">
    <div style="font-size:10px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">⚠ Unrecognized Syncrify IDs (${orphanIds.length})</div>
    ${orphanIds.map(id=>{
      const live=_backupLiveData[id];
      const usedGB=live.usedBytes/1e9;
      const profileLines=live.profiles.map(p=>{
        const comp=bkIsCompliant(p.lastAccess,'Daily');
        const flag=comp===null?'  ':comp===false?' ✗':comp==='grace'?' ~':' ✓';
        const size=p.diskSize>0?bkFmt(p.diskSize/1e9):'—';
        const date=p.lastAccess?new Date(p.lastAccess).toLocaleDateString('en-US',{year:'2-digit',month:'numeric',day:'numeric'}):'—';
        return`${flag} ${pad(p.profile,38)}${pad(size,10)}${date}`;
      }).join('\n');
      return`<div style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.25);border-radius:7px;padding:10px 14px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <span style="font-size:13px;font-weight:700;color:var(--text);font-family:var(--mono);">${escHtml(id)}</span>
          <span style="font-size:10px;color:var(--text3);">${live.profiles.length} profile${live.profiles.length!==1?'s':''} · ${bkFmt(usedGB)}</span>
          <button onclick="bkAddClientFromId('${escHtml(id)}')" style="margin-left:auto;font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.1);color:#f59e0b;cursor:pointer;white-space:nowrap;font-weight:600;">+ Add as Client</button>
        </div>
        <pre style="font-family:var(--mono);font-size:10px;color:var(--text3);line-height:1.55;white-space:pre;margin:0;">${escHtml(profileLines)}</pre>
      </div>`;
    }).join('')}
  </div>`;
  return preBlock+orphanSection;
}

async function saveAllSettings(){
  const statusEl=document.getElementById('settings-save-status');
  const setStatus=(msg,color)=>{if(statusEl){statusEl.textContent=msg;statusEl.style.color=color||'var(--text3)';}};

  const orgName=(document.getElementById('cfg-org')?.value||'').trim();

  const subdomain=(document.getElementById('cfg-subdomain')?.value||'').trim();
  const token=(document.getElementById('cfg-token')?.value||'').trim();
  if(!subdomain){showToast('Syncro subdomain is required','error');setStatus('');return false;}
  if(!token&&!config?.syncroTokenSet){showToast('Syncro API token is required','error');setStatus('');return false;}
  const staleDays=parseInt(document.getElementById('cfg-stale')?.value)||0;
  const dueDays=parseInt(document.getElementById('cfg-due')?.value)||3;
  const defaultDueOffset=parseInt(document.getElementById('cfg-offset')?.value)||90;
  const urlTemplates={
    Workstation:(document.getElementById('cfg-url-workstation')?.value||'').trim(),
    Server:(document.getElementById('cfg-url-server')?.value||'').trim(),
    Mac:(document.getElementById('cfg-url-mac')?.value||'').trim(),
    Linux:(document.getElementById('cfg-url-linux')?.value||'').trim()
  };

  const marginRaw=document.getElementById('setting-margin')?.value;
  let productMargin=appSettings.productMargin;
  if(marginRaw){
    const v=parseFloat(marginRaw);
    if(isNaN(v)||v<=0||v>=100){showToast('Product margin must be 1–99%','error');setStatus('');return false;}
    productMargin=v;
  }

  const bs=parseFloat(document.getElementById('setting-bk-block-size')?.value||'')||500;
  const cb=parseFloat(document.getElementById('setting-bk-cost-per-block')?.value||'')||40;
  const cd=parseFloat(document.getElementById('setting-bk-cost-per-device')?.value||'')||25;
  const saWebsiteApiBase=(document.getElementById('setting-sa-website-base')?.value||'').trim()||undefined;
  const saWebsiteApiKey=(document.getElementById('setting-sa-website-key')?.value||'').trim()||undefined;
  const syncrifyHost=(document.getElementById('setting-syncrify-host')?.value||'').trim()||undefined;
  const syncrifyUser=(document.getElementById('setting-syncrify-user')?.value||'').trim()||undefined;
  const syncrifyPass=(document.getElementById('setting-syncrify-pass')?.value||'').trim()||undefined;
  const pollSel=document.getElementById('setting-syncrify-poll')?.value;
  const pollCustom=parseInt(document.getElementById('setting-syncrify-poll-custom')?.value||'');
  const syncrifyActivityPollSec=Math.max(5,(pollSel==='custom'?pollCustom:parseInt(pollSel))||30);
  const dataPollSel=document.getElementById('setting-syncrify-data-poll')?.value;
  const dataPollCustom=parseInt(document.getElementById('setting-syncrify-data-poll-custom')?.value||'');
  const syncrifyDataPollSec=Math.max(300,(dataPollSel==='custom'?dataPollCustom:parseInt(dataPollSel))||1800);

  appSettings.staleDays=staleDays;
  appSettings.dueDays=dueDays;
  appSettings.defaultDueOffset=defaultDueOffset;
  appSettings.urlTemplates=urlTemplates;
  appSettings.productMargin=productMargin;
  appSettings.bkBlockSizeGB=bs;
  appSettings.bkCostPerBlock=cb;
  appSettings.bkCostPerDevice=cd;
  appSettings.saWebsiteApiBase=saWebsiteApiBase;
  appSettings.saWebsiteApiKey=saWebsiteApiKey;
  appSettings.syncrifyHost=syncrifyHost;
  appSettings.syncrifyUser=syncrifyUser;
  appSettings.syncrifyPass=syncrifyPass;
  appSettings.syncrifyActivityPollSec=syncrifyActivityPollSec;
  appSettings.syncrifyDataPollSec=syncrifyDataPollSec;

  setStatus('Saving…');
  const [cfgR,setR]=await Promise.all([
    fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({orgName,syncroSubdomain:subdomain,syncroToken:token})}),
    fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)})
  ]);
  if(cfgR.ok&&setR.ok){
    config={...config,orgName,syncroTokenSet:!!(token||config?.syncroTokenSet),syncroTokenHint:token?(token.slice(0,5)+'•••••••••••'):config?.syncroTokenHint||'',syncroSubdomain:subdomain};
    document.querySelectorAll('.ah-brand').forEach(el=>el.textContent=orgName||'System Alternatives');
    renderSidebar();
    logAction('config_saved',{clientId:null,clientName:null,details:`org: ${orgName}, subdomain: ${subdomain}`});
    _backupLiveData=null;_backupActivityData=null;_backupDriveData=null;_bkFetching=false;
    showToast('Settings saved');
    settingsDirty=false;
    setStatus(`Saved at ${new Date().toLocaleTimeString()}`,'var(--success)');
    refreshSyncrifyStatus();
    return true;
  }else{
    showToast('Save failed','error');
    setStatus('Save failed','var(--danger)');
    return false;
  }
}
// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderHomeView(){
  const el=document.getElementById('view-home');
  if(!el) return;
  const myName=localStorage.getItem('myName')||'';
  const orgName=config?.orgName||'System Alternatives';
  const hasHost=!!(appSettings.syncrifyHost||'').trim();
  if(hasHost&&_backupLiveData===null&&!_bkFetching){
    bkFetchLive().then(()=>renderHomeView());
  }
  const issues=bkGetIssueClients();
  el.innerHTML=`<div style="max-width:580px;width:100%;">
    <div style="margin-bottom:32px;text-align:center;">
      <h2 style="font-size:22px;font-weight:700;margin-bottom:4px;">${myName?'Hey, '+escHtml(myName):'Welcome'}</h2>
      <p style="color:var(--text2);font-size:13px;">${escHtml(orgName)}</p>
    </div>
    ${issues.length?`<div style="margin-bottom:20px;">
      <div class="dash-section-label">Backup issues</div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        ${issues.map(({c,nonCompliant})=>`<div class="dash-row" onclick="switchSection('backups');bkSwitchClient('${c.id}')">
          <span style="flex:1;font-size:12px;font-weight:500;">${escHtml(c.name)}</span>
          <span class="due-badge overdue">${nonCompliant} non-compliant</span>
        </div>`).join('')}
      </div>
    </div>`:''}
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div class="dash-row" style="padding:16px 20px;cursor:pointer;gap:16px;" onclick="switchSection('onboarding')">
        <span style="font-size:22px;width:28px;text-align:center;flex-shrink:0;">📋</span>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:600;">Onboarding</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;">Client checklists and setup tracking</div>
        </div>
        <span style="color:var(--text3);font-size:14px;">›</span>
      </div>
      <div class="dash-row" style="padding:16px 20px;cursor:pointer;gap:16px;" onclick="switchSection('sales')">
        <span style="font-size:22px;width:28px;text-align:center;flex-shrink:0;">💼</span>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:600;">Sales Quotes</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;">Build and export pricing proposals</div>
        </div>
        <span style="color:var(--text3);font-size:14px;">›</span>
      </div>
      <div class="dash-row" style="padding:16px 20px;cursor:pointer;gap:16px;" onclick="switchSection('backups')">
        <span style="font-size:22px;width:28px;text-align:center;flex-shrink:0;">🗄️</span>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:600;">Backups</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;">Monitor client backup compliance</div>
        </div>
        <span style="color:var(--text3);font-size:14px;">›</span>
      </div>
      <div class="dash-row" style="padding:16px 20px;cursor:pointer;gap:16px;" onclick="switchSection('reference')">
        <span style="font-size:22px;width:28px;text-align:center;flex-shrink:0;">📖</span>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:600;">References</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;">Browse procedures and guides</div>
        </div>
        <span style="color:var(--text3);font-size:14px;">›</span>
      </div>
    </div>
  </div>`;
}

function renderDashboard(){
  const el=document.getElementById('view-empty');
  if(!el) return;
  const myName=localStorage.getItem('myName')||'';
  const clientList=Object.values(clients);
  const now=Date.now();
  const staleDays=appSettings.staleDays||0;
  const total=clientList.length;
  const inProgress=clientList.filter(c=>{const p=overallProgress(c);return p.done>0&&p.done<p.total;}).length;
  const complete=clientList.filter(c=>{const p=overallProgress(c);return p.total>0&&p.done===p.total;}).length;
  const stale=staleDays?clientList.filter(c=>{const lm=c.lastModified||c.createdAt||0;return((now-new Date(lm).getTime())/(864e5))>staleDays;}).length:0;
  const dueSoon=clientList.filter(c=>{
    if(!c.dueDate)return false;
    const diff=Math.ceil((new Date(c.dueDate+' 12:00')-new Date())/(864e5));
    return diff>=0&&diff<=7;
  }).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  const recent=clientList.filter(c=>c.lastModified||c.createdAt)
    .sort((a,b)=>new Date(b.lastModified||b.createdAt)-new Date(a.lastModified||a.createdAt)).slice(0,6);
  const stats=[
    {label:'Total',value:total,color:'var(--accent)'},
    {label:'In Progress',value:inProgress,color:'var(--warn)'},
    {label:'Completed',value:complete,color:'var(--success)'},
    {label:staleDays?'Stale':'On Hold',value:staleDays?stale:clientList.filter(c=>c.clientStatus==='on-hold').length,color:'var(--danger)'},
  ];
  el.innerHTML=`<div style="max-width:760px;width:100%;">
    <div style="margin-bottom:22px;text-align:center;">
      <h2 style="font-size:20px;font-weight:700;margin-bottom:3px;">${myName?'Welcome back, '+myName:'Onboarding'}</h2>
      <p style="color:var(--text2);font-size:12px;">Client checklists &amp; setup tracking</p>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:22px;">
      ${stats.map(s=>`<div class="dash-stat">
        <div class="dash-stat-value" style="color:${s.color};">${s.value}</div>
        <div class="dash-stat-label">${s.label}</div>
      </div>`).join('')}
    </div>
    ${dueSoon.length?`<div style="margin-bottom:20px;">
      <div class="dash-section-label">Due within 7 days</div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        ${dueSoon.map(c=>{const diff=Math.ceil((new Date(c.dueDate+' 12:00')-new Date())/(864e5));const cls=diff===0?'overdue':diff<=2?'warn':'ok';return`<div class="dash-row" onclick="selectClient('${c.id}')">
          <span style="flex:1;font-size:12px;font-weight:500;">${c.name}</span>
          <span class="due-badge ${cls}">${diff===0?'Today':diff+'d left'}</span>
        </div>`;}).join('')}
      </div></div>`:''}
    ${recent.length?`<div>
      <div class="dash-section-label">Recent checklists</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;">
        ${recent.map(c=>{const p=overallProgress(c);const pct=p.total?Math.round(p.done/p.total*100):0;const cs=c.clientStatus&&c.clientStatus!=='active'?`<span class="quote-status ${c.clientStatus}">${clientStatusLabel(c.clientStatus)}</span>`:'';return`<div class="dash-row" onclick="selectClient('${c.id}')">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;display:flex;align-items:center;gap:4px;overflow:hidden;"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.name}</span>${cs}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:1px;">${c.tech}</div>
          </div>
          <span style="font-size:11px;color:var(--text3);flex-shrink:0;">${pct}%</span>
        </div>`;}).join('')}
      </div></div>`:''}
    ${!total?`<div style="text-align:center;padding:48px 20px;">
      <div style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:6px;">No checklists yet</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:18px;">Create your first client onboarding checklist to get started.</div>
      <button class="btn-primary" onclick="newClientFromSidebar()">+ New Checklist</button>
    </div>`:''}
  </div>`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function renderSettingsView(){
  settingsDirty=false;
  document.getElementById('settings-content').innerHTML=`
    <div style="max-width:760px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;">
        <h2 style="font-size:18px;font-weight:700;margin:0;">Settings</h2>
        <div style="display:flex;align-items:center;gap:10px;">
          <span id="settings-save-status" style="font-size:12px;color:var(--text3);"></span>
          <button class="btn-primary" onclick="saveAllSettings()">Save Settings</button>
        </div>
      </div>
      <div class="settings-section-label">General</div>
      <div class="settings-block">
        <div class="settings-block-header">Appearance</div>
        <div class="settings-block-body">
          <div style="font-size:12px;color:var(--text2);margin-bottom:10px;">Display theme</div>
          <div class="theme-pill" style="width:fit-content;">
            <button class="theme-btn${currentTheme==='light'?' active':''}" id="theme-light" onclick="applyTheme('light')" title="Light">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/></svg> Light
            </button>
            <button class="theme-btn${currentTheme==='system'?' active':''}" id="theme-system" onclick="applyTheme('system')" title="System">
              <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> System
            </button>
            <button class="theme-btn${currentTheme==='dark'?' active':''}" id="theme-dark" onclick="applyTheme('dark')" title="Dark">
              <svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg> Dark
            </button>
          </div>
        </div>
      </div>
      <div class="settings-block">
        <div class="settings-block-header">Organisation</div>
        <div class="settings-block-body">
          <div class="field-group" style="margin:0;">
            <label>Organisation Name</label>
            <input id="cfg-org" value="${(config?.orgName||'System Alternatives').replace(/"/g,'&quot;')}" placeholder="e.g. System Alternatives">
            <div class="field-hint">Displayed in the sidebar and mobile header.</div>
          </div>
        </div>
      </div>
      <div class="settings-block">
        <div class="settings-block-header">Updates <span id="update-section-badge" style="display:${updateAvailable?'inline-block':'none'};margin-left:8px;font-size:10px;font-weight:600;background:var(--warn);color:#000;padding:1px 7px;border-radius:10px;vertical-align:middle;">Available</span></div>
        <div class="settings-block-body" id="update-section-body">
          <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">Check for and apply updates from GitHub. The server will restart automatically when an update is applied.</p>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <button class="btn-secondary" onclick="checkForUpdates()">Check Now</button>
            <button class="btn-primary" id="apply-update-btn" onclick="applyUpdate()" style="display:${updateAvailable?'':'none'};">Apply Update &amp; Restart</button>
          </div>
          <div id="update-status" style="margin-top:12px;font-size:12px;color:var(--text2);">${updateAvailable?'<span style="color:var(--warn);">&#9679; Update available</span>':''}</div>
        </div>
      </div>
      <div class="settings-block">
        <div class="settings-block-header">Activity Log</div>
        <div class="settings-block-body">
          <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">View a full history of checklist activity across all clients.</p>
          <button class="btn-secondary" onclick="openGlobalLogModal()">View Activity Log</button>
        </div>
      </div>
      <div class="settings-section-label">Onboarding</div>
      <div class="settings-block">
        <div class="settings-block-header">Onboarding</div>
        <div class="settings-block-body" id="cfg-section-body"></div>
      </div>
      <div class="settings-section-label">Sales</div>
      <div class="settings-block">
        <div class="settings-block-header">Products</div>
        <div class="settings-block-body">
          <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">Manage products for the onboarding checklist and sales quoting tool.</p>
          <div style="margin-bottom:14px;">
            <label style="font-size:12px;font-weight:500;display:block;margin-bottom:4px;">Default Product Margin</label>
            <div style="display:flex;align-items:center;gap:6px;">
              <input type="number" id="setting-margin" min="1" max="99" step="1" value="${appSettings.productMargin||''}" placeholder="e.g. 80" style="width:70px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
              <span style="font-size:12px;color:var(--text2);">%</span>
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:4px;">Sets the recommended client price in the product manager. Formula: Client Cost = SA Cost ÷ (1 − Margin%)</div>
          </div>
          <button class="btn-secondary" onclick="openProductsModal()">Manage Products</button>
        </div>
      </div>
      <div class="settings-section-label">Quotes</div>
      <div class="settings-block">
        <div class="settings-block-header">Client Approval Emails</div>
        <div class="settings-block-body">
          <p style="font-size:12px;color:var(--text2);margin-bottom:14px;">Sends purchase-request approval links to clients through systemalternatives.net. Requires a matching API key configured on that site (<span style="font-family:var(--mono);">CHECKLIST_APP_API_KEY</span>).</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div class="field-group" style="margin:0;grid-column:1/-1;">
              <label>SA Website API Base URL</label>
              <input id="setting-sa-website-base" value="${escHtml(appSettings.saWebsiteApiBase||'')}" placeholder="https://systemalternatives.net/api" style="font-size:11px;">
            </div>
            <div class="field-group" style="margin:0;grid-column:1/-1;">
              <label>SA Website API Key</label>
              <input id="setting-sa-website-key" type="password" value="${escHtml(appSettings.saWebsiteApiKey||'')}" placeholder="••••••••" style="font-size:11px;">
              <div class="field-hint">Must match CHECKLIST_APP_API_KEY on systemalternatives.net.</div>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-section-label">Backups</div>
      <div class="settings-block">
        <div class="settings-block-header">Backups</div>
        <div class="settings-block-body">
          <p style="font-size:12px;color:var(--text2);margin-bottom:14px;">This server connects directly to Syncrify (e.g. over Tailscale) to poll currently-running backups, per-client disk usage/last-run status, and overall storage capacity.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
            <div class="field-group" style="margin:0;grid-column:1/-1;">
              <label>Syncrify Host</label>
              <input id="setting-syncrify-host" value="${escHtml(appSettings.syncrifyHost||'')}" placeholder="http://100.x.y.z" style="font-size:11px;">
              <div class="field-hint">Base URL of Syncrify's web UI, reachable from this server.</div>
            </div>
            <div class="field-group" style="margin:0;">
              <label>Username</label>
              <input id="setting-syncrify-user" value="${escHtml(appSettings.syncrifyUser||'')}" placeholder="webapp" style="font-size:11px;">
            </div>
            <div class="field-group" style="margin:0;">
              <label>Password</label>
              <input id="setting-syncrify-pass" type="password" value="${escHtml(appSettings.syncrifyPass||'')}" placeholder="••••••••" style="font-size:11px;">
            </div>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
            <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:4px;">Live Activity Polling</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:10px;">How often this server checks Syncrify for currently-running backups.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              ${(()=>{
                const pollSec=appSettings.syncrifyActivityPollSec||30;
                const presets=[10,30,60,300];
                const isCustom=!presets.includes(pollSec);
                return`<div class="field-group" style="margin:0;grid-column:1/-1;">
                  <label>Activity Poll Interval</label>
                  <div style="display:flex;gap:6px;align-items:center;">
                    <select id="setting-syncrify-poll" onchange="document.getElementById('setting-syncrify-poll-custom').style.display=this.value==='custom'?'':'none';" style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
                      <option value="10"${pollSec===10?' selected':''}>Realtime (10s)</option>
                      <option value="30"${pollSec===30?' selected':''}>30 seconds</option>
                      <option value="60"${pollSec===60?' selected':''}>1 minute</option>
                      <option value="300"${pollSec===300?' selected':''}>5 minutes</option>
                      <option value="custom"${isCustom?' selected':''}>Custom…</option>
                    </select>
                    <input id="setting-syncrify-poll-custom" type="number" min="5" step="1" value="${isCustom?pollSec:''}" placeholder="seconds" style="display:${isCustom?'':'none'};width:90px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
                  </div>
                  <div class="field-hint">How often this server polls Syncrify for the live activity feed. Minimum 5 seconds.</div>
                </div>`;
              })()}
              <div class="field-group" style="margin:0;grid-column:1/-1;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <button class="btn-secondary" onclick="testSyncrifyConnection()">Test Connection</button>
                  <span id="syncrify-status" style="font-size:12px;color:var(--text3);"></span>
                </div>
              </div>
            </div>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
            <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:4px;">Backup Data Polling</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:10px;">How often this server pulls per-client disk usage, last-run status, and overall storage capacity from Syncrify. This is a heavier scrape (one request per client/profile) so it polls less often.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              ${(()=>{
                const pollSec=appSettings.syncrifyDataPollSec||1800;
                const presets=[300,900,1800,3600];
                const isCustom=!presets.includes(pollSec);
                return`<div class="field-group" style="margin:0;grid-column:1/-1;">
                  <label>Data Poll Interval</label>
                  <div style="display:flex;gap:6px;align-items:center;">
                    <select id="setting-syncrify-data-poll" onchange="document.getElementById('setting-syncrify-data-poll-custom').style.display=this.value==='custom'?'':'none';" style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
                      <option value="300"${pollSec===300?' selected':''}>5 minutes</option>
                      <option value="900"${pollSec===900?' selected':''}>15 minutes</option>
                      <option value="1800"${pollSec===1800?' selected':''}>30 minutes</option>
                      <option value="3600"${pollSec===3600?' selected':''}>1 hour</option>
                      <option value="custom"${isCustom?' selected':''}>Custom…</option>
                    </select>
                    <input id="setting-syncrify-data-poll-custom" type="number" min="300" step="1" value="${isCustom?pollSec:''}" placeholder="seconds" style="display:${isCustom?'':'none'};width:90px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
                  </div>
                  <div class="field-hint">How often this server scrapes Syncrify for per-client disk usage and last-run status. Minimum 5 minutes.</div>
                </div>`;
              })()}
              <div class="field-group" style="margin:0;grid-column:1/-1;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <button class="btn-secondary" onclick="testSyncrifyDataFetch()">Test Data Fetch</button>
                  <span id="syncrify-data-status" style="font-size:12px;color:var(--text3);"></span>
                </div>
                <div class="field-hint">May take a while — fetches a profile and report history page per client.</div>
              </div>
            </div>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
            <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:8px;">Cost Formula</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:10px;">Cost = ⌈ Used GB ÷ Block Size ⌉ × $/Block + Devices × $/Device</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
              <div class="field-group" style="margin:0;">
                <label style="font-size:10px;">Block Size (GB)</label>
                <input id="setting-bk-block-size" type="number" min="1" step="1" value="${appSettings.bkBlockSizeGB||500}" style="width:80px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
              </div>
              <div class="field-group" style="margin:0;">
                <label style="font-size:10px;">$ per Block</label>
                <input id="setting-bk-cost-per-block" type="number" min="0" step="1" value="${appSettings.bkCostPerBlock||40}" style="width:70px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
              </div>
              <div class="field-group" style="margin:0;">
                <label style="font-size:10px;">$ per Device</label>
                <input id="setting-bk-cost-per-device" type="number" min="0" step="1" value="${appSettings.bkCostPerDevice||25}" style="width:70px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text);font-size:12px;outline:none;font-family:var(--sans);">
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-section-label">Reference</div>
      <div class="settings-block">
        <div class="settings-block-header">Content Editors</div>
        <div class="settings-block-body">
          <p style="font-size:12px;color:var(--text2);margin-bottom:12px;">Edit the procedure steps and in-app guide content shown in checklists.</p>
          <button class="btn-secondary" onclick="openEditorModal('procedures')">Open Editor</button>
        </div>
      </div>
    </div>`;
  renderOnboardingSection();
  refreshSyncrifyStatus();
}

function fmtAge(ms){
  const s=Math.round(ms/1000);
  if(s<60)return`${s}s ago`;
  const m=Math.floor(s/60),rs=s%60;
  if(m<60)return rs>0?`${m}m ${rs}s ago`:`${m}m ago`;
  const h=Math.floor(m/60),rm=m%60;
  return rm>0?`${h}h ${rm}m ago`:`${h}h ago`;
}

async function refreshSyncrifyStatus(){
  const el=document.getElementById('syncrify-status');
  const dataEl=document.getElementById('syncrify-data-status');
  const host=(appSettings.syncrifyHost||'').trim();
  if(el){
    if(!host){el.textContent='Not configured — using Active Jobs URL fallback.';el.style.color='var(--text3)';}
    else{
      el.textContent='Checking…';el.style.color='var(--text3)';
      try{
        const r=await fetch('/api/backup-activity');
        const d=await r.json();
        if(d.source==='direct'){
          const age=d.lastUpdated?Math.round((Date.now()-d.lastUpdated)/1000):null;
          el.textContent=`✓ Connected — last poll ${age!=null?age+'s ago':'just now'}${d.error?` (last attempt: ${d.error})`:''}`;
          el.style.color=d.error?'var(--warn)':'var(--success)';
        }else if(d.source==='direct-pending'){
          el.textContent=`⚠ Configured but not yet connected${d.error?`: ${d.error}`:' — waiting for first poll'}`;
          el.style.color='var(--warn)';
        }else{
          el.textContent='Not connected.';
          el.style.color='var(--text3)';
        }
      }catch(err){el.textContent=`Status check failed: ${err.message}`;el.style.color='var(--warn)';}
    }
  }
  if(dataEl&&!_bkDataFetchTesting){
    if(!host){dataEl.textContent='Not configured — using Backup Data URL fallback.';dataEl.style.color='var(--text3)';dataEl.title='';}
    else{
      dataEl.textContent='Checking…';dataEl.style.color='var(--text3)';dataEl.title='';
      try{
        const r=await fetch('/api/backup-data');
        const d=await r.json();
        if(d.source==='direct'){
          const ageMs=d.lastUpdated?Date.now()-d.lastUpdated:null;
          const pollMs=(appSettings.syncrifyDataPollSec||1800)*1000;
          const isStale=ageMs!=null&&ageMs>pollMs*1.5;
          const ageStr=ageMs!=null?fmtAge(ageMs):'just now';
          const pollMin=Math.round((appSettings.syncrifyDataPollSec||1800)/60);
          const staleSpan=isStale?` <span style="color:var(--warn);"> ⚠ stale (poll every ${pollMin}m)</span>`:'';
          const errSpan=d.error?` <span style="color:var(--warn);">(last error: ${escHtml(d.error)})</span>`:'';
          dataEl.innerHTML=`✓ Connected — last polled ${ageStr}${staleSpan}${errSpan}`;
          dataEl.title=d.lastUpdated?`Last refreshed: ${new Date(d.lastUpdated).toLocaleString()}`:'';
          dataEl.style.color=isStale||d.error?'var(--warn)':'var(--success)';
        }else if(d.source==='direct-pending'){
          dataEl.textContent=`⚠ Configured but not yet connected${d.error?`: ${d.error}`:' — waiting for first poll'}`;
          dataEl.style.color='var(--warn)';dataEl.title='';
        }else{
          dataEl.textContent='Not connected.';
          dataEl.style.color='var(--text3)';dataEl.title='';
        }
      }catch(err){dataEl.textContent=`Status check failed: ${err.message}`;dataEl.style.color='var(--warn)';dataEl.title='';}
    }
  }
}

async function testSyncrifyConnection(){
  const el=document.getElementById('syncrify-status');
  if(el){el.textContent='Testing…';el.style.color='var(--text3)';}
  if(!await saveAllSettings())return;
  try{
    const r=await fetch('/api/syncrify-test',{method:'POST'});
    const d=await r.json();
    if(d.ok){
      if(el){el.textContent=`✓ Connected — found ${d.jobCount} active session${d.jobCount===1?'':'s'}`;el.style.color='var(--success)';}
      _backupActivityData=null;_bkActivityLastUpdated=null;
    }else{
      if(el){el.textContent=`✗ ${d.error}`;el.style.color='var(--danger)';}
    }
  }catch(err){
    if(el){el.textContent=`✗ ${err.message}`;el.style.color='var(--danger)';}
  }
}

async function testSyncrifyDataFetch(){
  const el=document.getElementById('syncrify-data-status');
  _bkDataFetchTesting=true;
  let elapsed=0;
  let ticker=null;
  const setSpinner=()=>{
    if(el){el.innerHTML=`<span class="spinner" style="width:10px;height:10px;border-width:2px;"></span> Fetching… ${elapsed}s elapsed`;el.style.color='var(--text3)';}
  };
  setSpinner();
  ticker=setInterval(()=>{elapsed++;setSpinner();},1000);
  const finish=(html,color)=>{
    clearInterval(ticker);
    _bkDataFetchTesting=false;
    if(el){el.innerHTML=html;el.style.color=color;el.title='';}
  };
  if(!await saveAllSettings()){
    clearInterval(ticker);
    _bkDataFetchTesting=false;
    refreshSyncrifyStatus();
    return;
  }
  try{
    const r=await fetch('/api/syncrify-test?type=data',{method:'POST'});
    const d=await r.json();
    if(d.ok){
      finish(`✓ Fetched ${d.rowCount} profile${d.rowCount===1?'':'s'} in ${elapsed}s`,'var(--success)');
      _backupLiveData=null;_bkLastUpdated=null;_bkDataSource=null;
    }else{
      finish(`✗ ${d.error||'No data returned'}`,'var(--danger)');
    }
  }catch(err){
    finish(`✗ ${err.message}`,'var(--danger)');
  }
}

function renderOnboardingSection(){
  const body=document.getElementById('cfg-section-body');
  if(!body) return;
  const t=appSettings.urlTemplates||{};
  body.innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
      <div class="field-group" style="margin:0;"><label>Syncro Subdomain</label>
        <input id="cfg-subdomain" value="${(config?.syncroSubdomain||'').replace(/"/g,'&quot;')}" placeholder="yourcompany">
      </div>
      <div class="field-group" style="margin:0;"><label>Syncro API Token</label>
        <input id="cfg-token" type="password" placeholder="${config?.syncroTokenSet?'Leave blank to keep current token':'Paste API token'}">
        ${config?.syncroTokenSet?`<div class="field-hint" style="color:var(--success);">&#10003; Token configured &mdash; <span style="font-family:var(--mono);letter-spacing:0.04em;">${escHtml(config.syncroTokenHint||'')}</span></div>`:'<div class="field-hint" style="color:var(--warn);">No token set</div>'}
      </div>
    </div>
    <div style="border-top:1px solid var(--border);margin:0 -16px;padding:14px 16px 0;">
      <div style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Checklist Behaviour</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">
        <div class="field-group" style="margin:0;"><label>Stale Threshold (days)</label>
          <input type="number" id="cfg-stale" value="${appSettings.staleDays||30}" min="0">
          <div class="field-hint">Flag inactive clients. 0 = disabled.</div>
        </div>
        <div class="field-group" style="margin:0;"><label>Due Warning (days before)</label>
          <input type="number" id="cfg-due" value="${appSettings.dueDays||3}" min="1">
          <div class="field-hint">Show amber badge this many days before due.</div>
        </div>
        <div class="field-group" style="margin:0;"><label>Default Due Offset (days)</label>
          <input type="number" id="cfg-offset" value="${appSettings.defaultDueOffset||90}" min="1">
          <div class="field-hint">Pre-fill due date on new checklists.</div>
        </div>
      </div>
    </div>
    <div style="border-top:1px solid var(--border);margin:0 -16px;padding:14px 16px 0;">
      <div style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">RMM Installer URL Prefixes</div>
      <div style="font-size:10px;color:var(--text3);margin-bottom:12px;">The agent token from Syncro is appended to each prefix to build the full download URL.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        ${['Workstation','Server','Mac','Linux'].map(type=>`
          <div class="field-group" style="margin:0;"><label>${type}</label>
            <input id="cfg-url-${type.toLowerCase()}" value="${(t[type]||'').replace(/"/g,'&quot;')}" placeholder="URL prefix...">
          </div>`).join('')}
      </div>
    </div>`;
}

async function renderSettingsLog(){
  const body=document.getElementById('settings-log-body');if(!body)return;
  body.innerHTML=`<div class="log-filter-row">
    <input id="log-client-filter" placeholder="Filter by client…" oninput="applyLogFilter()" style="flex:1;">
    <select id="log-action-filter" onchange="applyLogFilter()">
      <option value="">All actions</option>
      <option value="step_complete">Step completed</option>
      <option value="step_incomplete">Step unchecked</option>
      <option value="checklist_created">Checklist created</option>
      <option value="checklist_deleted">Checklist deleted</option>
      <option value="checklist_edited">Checklist edited</option>
      <option value="device_added">Device added</option>
      <option value="device_removed">Device removed</option>
    </select>
    <button class="btn-secondary btn-sm" onclick="renderSettingsLog()">Refresh</button>
  </div>
  <div id="settings-log-timeline" style="max-height:480px;overflow-y:auto;padding-right:4px;"><div style="color:var(--text3);font-size:11px;">Loading…</div></div>`;
  try{
    const r=await fetch('/api/logs?limit=500');
    window._settingsLogs=await r.json();
    applyLogFilter();
  }catch(e){document.getElementById('settings-log-timeline').innerHTML=`<div style="color:#fca5a5;font-size:11px;">Failed: ${e.message}</div>`;}
}
function filterLogEntries(logs,cf,af){
  return logs.filter(l=>{
    if(af&&l.action!==af)return false;
    if(cf){
      const s=[(l.clientName||''),(l.tech||''),(l.details||'')].join(' ').toLowerCase();
      if(!s.includes(cf))return false;
    }
    return true;
  });
}
function applyLogFilter(){
  const logs=window._settingsLogs||[];
  const cf=(document.getElementById('log-client-filter')?.value||'').toLowerCase();
  const af=document.getElementById('log-action-filter')?.value||'';
  renderLogTimeline(document.getElementById('settings-log-timeline'),filterLogEntries(logs,cf,af).slice(0,200));
}

// ─── Update polling ───────────────────────────────────────────────────────────
let updateAvailable=false;
function setUpdateAvailable(avail){
  updateAvailable=avail;
  document.getElementById('settings-btn')?.classList.toggle('update-dot',avail);
  const badge=document.getElementById('update-section-badge');
  if(badge) badge.style.display=avail?'inline-block':'none';
  const applyBtn=document.getElementById('apply-update-btn');
  if(applyBtn) applyBtn.style.display=avail?'':'none';
  const statusEl=document.getElementById('update-status');
  if(statusEl&&avail&&!statusEl.innerHTML.trim())
    statusEl.innerHTML=`<span style="color:var(--warn);">&#9679; Update available</span>`;
}
async function pollForUpdates(){
  try{
    const r=await fetch('/api/update/status');
    const d=await r.json();
    if(!d.error&&!d.upToDate&&!updateAvailable){
      setUpdateAvailable(true);
      showToast('A new update is available — open Settings to apply','info');
    } else if(d.upToDate){
      setUpdateAvailable(false);
    }
  }catch(_){}
}
function startUpdatePolling(){
  pollForUpdates();
  setInterval(pollForUpdates,30*60*1000);
}

// ─── Server restart detection ─────────────────────────────────────────────────
let _serverStartedAt=null; // estimated server boot time based on uptime
const _sessionStartedAt=Date.now(); // when this browser session loaded

async function checkServerRestart(){
  try{
    const r=await fetch('/api/health',{cache:'no-store'});
    if(!r.ok) return;
    const h=await r.json();
    const bootedAt=Date.now()-h.uptime*1000;
    if(_serverStartedAt===null){
      _serverStartedAt=bootedAt; // baseline on first check
    } else if(bootedAt>_serverStartedAt+15000){
      // Server booted significantly later than our stored baseline — it restarted
      _serverStartedAt=bootedAt; // update so we don't keep re-showing
      const banner=document.getElementById('update-banner');
      if(banner){
        banner.textContent='↺ Server was restarted — click to reload';
        banner.style.display='block';
      }
    }
  }catch(_){}
}
function startServerRestartPolling(){
  checkServerRestart(); // baseline reading
  setInterval(checkServerRestart,5*60*1000); // re-check every 5 min
}

// ─── Products modal ───────────────────────────────────────────────────────────
let _pmProducts=[];
let _pmDrag=null;
let _pmTouch=null;
let _pmSubDrag=null;
let _pmDirty=false;
let _pmOpenIdx=null;
function pmMarkDirty(){
  _pmDirty=true;
  const ind=document.getElementById('pm-dirty-indicator');
  if(ind) ind.style.display='inline';
}
function openProductsModal(){
  _pmDirty=false;
  _pmProducts=JSON.parse(JSON.stringify(getProducts()));
  const ind=document.getElementById('pm-dirty-indicator');
  if(ind) ind.style.display='none';
  document.getElementById('products-modal').classList.add('show');
  pmRender();
}
function closeProductsModal(){
  if(!_pmDirty){_doCloseProducts();return;}
  styledConfirm3('Products have unsaved changes.',
    {label:'Save & Close',action:async()=>{const ok=await pmSave();if(ok)_doCloseProducts();}},
    {label:'Discard',action:()=>{_pmDirty=false;_doCloseProducts();}},
    {label:'Cancel',action:()=>{}}
  );
}
function _doCloseProducts(){
  _pmDirty=false;
  const ind=document.getElementById('pm-dirty-indicator');
  if(ind) ind.style.display='none';
  document.getElementById('products-modal').classList.remove('show');
}
function pmRender(){
  const qtyOpts=['','employees','licensedUsers','workstations','servers','machines','backedUpMachines','sites'];
document.getElementById('pm-list').innerHTML=_pmProducts.map((p,i)=>{
    const hasSubItems=p.subItems?.length>0;
    const _subInp=`background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 5px;color:var(--text);font-size:11px;outline:none;flex:1;min-width:0;box-sizing:border-box;`;
    const _subCost=`background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 4px;color:var(--text);font-size:11px;outline:none;flex:1;min-width:0;text-align:right;box-sizing:border-box;`;
    const _subSel=`background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 3px;color:var(--text);font-size:11px;outline:none;flex:1;min-width:70px;box-sizing:border-box;text-align-last:center;`;
    const _dlbl=`font-size:9px;color:var(--text3);flex-shrink:0;`;
    const _dp=`font-size:10px;color:var(--text3);flex-shrink:0;`;
    const subItemsHtml=hasSubItems?p.subItems.map((sub,si)=>{
      const rec=(()=>{const m=appSettings.productMargin;const r=(m>0&&m<100)?(sub.saCost||0)/(1-m/100):0;return r>0?'$'+r.toFixed(2):'—';})();
      return`<div class="pm-sub-item" data-si="${si}" style="border:1px solid var(--border);border-radius:6px;background:var(--bg3);display:flex;">
        <span class="pm-drag" onmousedown="pmMouseDown(event,${i},'sub',${si})" ontouchstart="pmSubTouchStart(event,${i},${si})" style="border-right:1px solid var(--border);padding:0 5px;display:flex;align-items:center;">⠿</span>
        <div style="flex:1;padding:7px 10px;display:flex;flex-direction:column;gap:5px;">
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            <input style="${_subInp}min-width:130px;" value="${escHtml(sub.label)}" placeholder="Name" oninput="_pmProducts[${i}].subItems[${si}].label=this.value;pmMarkDirty()">
            <input style="${_subInp}flex:2;min-width:160px;" value="${escHtml(sub.desc||'')}" placeholder="Description" oninput="_pmProducts[${i}].subItems[${si}].desc=this.value;pmMarkDirty()">
            <input type="text" style="${_subInp}min-width:80px;flex:0.8;" placeholder="Excl. Group" value="${escHtml(sub.exclusionGroup||'')}" oninput="_pmProducts[${i}].subItems[${si}].exclusionGroup=this.value.trim()||undefined;pmMarkDirty();" title="Sub-items sharing the same group name are mutually exclusive — selecting one auto-deselects the others">
          </div>
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex:1;min-width:80px;">
              <span style="font-size:9px;color:var(--text3);flex:1;pointer-events:none;user-select:none;">Cost</span>
              <input type="number" step="0.05" min="0" style="width:56px;background:transparent;border:none;padding:2px 0;color:var(--text);font-size:11px;outline:none;text-align:right;" value="${(sub.saCost||0).toFixed(2)}" oninput="const v=parseFloat(this.value)||0;_pmProducts[${i}].subItems[${si}].saCost=v;const m=appSettings.productMargin;const r=(m>0&&m<100)?v/(1-m/100):0;const el=document.getElementById('pmrec-${i}-${si}');if(el)el.value=r>0?r.toFixed(2):'—';pmMarkDirty();" onblur="this.value=(parseFloat(this.value)||0).toFixed(2);">
            </div>
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex:1;min-width:80px;cursor:default;">
              <span style="font-size:9px;color:var(--text3);flex:1;user-select:none;">Margin${appSettings.productMargin?` (${appSettings.productMargin}%)`:''}</span>
              <input type="text" readonly tabindex="-1" id="pmrec-${i}-${si}" style="width:56px;background:transparent;border:none;padding:2px 0;color:var(--text3);font-size:11px;outline:none;text-align:right;cursor:default;" value="${(()=>{const m=appSettings.productMargin;const r=(m>0&&m<100)?(sub.saCost||0)/(1-m/100):0;return r>0?r.toFixed(2):'—';})()}">
            </div>
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex:1;min-width:80px;">
              <span style="font-size:9px;color:var(--text3);flex:1;pointer-events:none;user-select:none;">Price</span>
              <input type="number" step="0.05" min="0" style="width:56px;background:transparent;border:none;padding:2px 0;color:var(--text);font-size:11px;outline:none;text-align:right;" value="${(sub.defaultPrice||0).toFixed(2)}" oninput="_pmProducts[${i}].subItems[${si}].defaultPrice=parseFloat(this.value)||0;pmMarkDirty();" onblur="this.value=(parseFloat(this.value)||0).toFixed(2);">
            </div>
          </div>
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
            <div class="pm-req-dd" id="pmreqdd-${i}-${si}" tabindex="-1" onfocusout="if(!this.contains(event.relatedTarget))this.classList.remove('open')">
              <button type="button" class="pm-req-trigger" onclick="this.closest('.pm-req-dd').classList.toggle('open')">
                <span class="pm-req-sum">${(()=>{const c=_normReqs(sub.requires).length;return c?c+' req.':'None';})()}</span>
                <span style="font-size:9px;opacity:0.5;">▼</span>
              </button>
              <div class="pm-req-panel">
                ${_pmProducts.flatMap((pp,j)=>{
                  if(pp.subItems?.length){return pp.subItems.filter((s,sk)=>s.id&&!(j===i&&sk===si)).map(s=>{const chk=_normReqs(sub.requires).includes(s.id);return`<label class="pm-req-opt${chk?' checked':''}" data-rid="${s.id}"><input type="checkbox" ${chk?'checked':''} onchange="pmToggleReq(${i},${si},this.checked,'${s.id}')">${escHtml((pp.label||pp.id)+' — '+(s.label||s.id))}</label>`;});}
                  if(!pp.id||j===i)return[];
                  const chk=_normReqs(sub.requires).includes(pp.id);
                  return[`<label class="pm-req-opt${chk?' checked':''}" data-rid="${pp.id}"><input type="checkbox" ${chk?'checked':''} onchange="pmToggleReq(${i},${si},this.checked,'${pp.id}')">${escHtml(pp.label||pp.id)}</label>`];
                }).join('')}
              </div>
            </div>
            <select style="${_subSel}" title="Monthly = recurring charge each period. One-Time = charged once at sale" oninput="_pmProducts[${i}].subItems[${si}].billing=this.value;pmMarkDirty()">
              <option value="monthly" ${(sub.billing||'monthly')==='monthly'?'selected':''}>Monthly</option>
              <option value="onetime" ${sub.billing==='onetime'?'selected':''}>One-Time</option>
            </select>
            <select style="${_subSel}" title="Which pricing section this item appears in on the quote (User, Machine, or Site)" oninput="_pmProducts[${i}].subItems[${si}].salesCategory=this.value||undefined;pmMarkDirty()">
              <option value="" ${!sub.salesCategory?'selected':''}>— Category —</option>
              <option value="user" ${sub.salesCategory==='user'?'selected':''}>User</option>
              <option value="machine" ${sub.salesCategory==='machine'?'selected':''}>Machine</option>
              <option value="site" ${sub.salesCategory==='site'?'selected':''}>Site</option>
            </select>
            <select style="${_subSel}" title="Auto-populates quantity from the client's headcount data. Leave blank to enter manually" oninput="_pmProducts[${i}].subItems[${si}].qtySource=this.value;pmMarkDirty()">
              <option value="" ${!sub.qtySource?'selected':''}>— Qty Source —</option>
              <option value="employees" ${sub.qtySource==='employees'?'selected':''}>Employees</option>
              <option value="licensedUsers" ${sub.qtySource==='licensedUsers'?'selected':''}>Lic. Users</option>
              <option value="workstations" ${sub.qtySource==='workstations'?'selected':''}>Workstations</option>
              <option value="servers" ${sub.qtySource==='servers'?'selected':''}>Servers</option>
              <option value="machines" ${sub.qtySource==='machines'?'selected':''}>Machines</option>
              <option value="backedUpMachines" ${sub.qtySource==='backedUpMachines'?'selected':''}>Backed Up</option>
              <option value="sites" ${sub.qtySource==='sites'?'selected':''}>Sites</option>
            </select>
          </div>
        </div>
        <div onclick="styledConfirm('Remove this sub-item?',()=>pmDeleteSubItem(${i},${si}))" title="Remove sub-item" style="width:28px;flex-shrink:0;border-left:1px solid var(--border);background:rgba(239,68,68,0.06);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background 0.15s;" onmouseenter="this.style.background='rgba(239,68,68,0.18)'" onmouseleave="this.style.background='rgba(239,68,68,0.06)'">
          <span style="color:var(--danger);font-size:16px;line-height:1;">&#215;</span>
        </div>
      </div>`;
    }).join(''):'';
    return`
    <div class="pm-row" data-pi="${i}">
      <span class="pm-drag" onmousedown="pmMouseDown(event,${i},'row')" ontouchstart="pmTouchStart(event,${i})">⠿</span>
      <div class="pm-fields">
        <div class="pm-row-top">
          <input class="pm-label-input pm-id-input" value="${escHtml(p.id)}" placeholder="product-id"
            oninput="_pmProducts[${i}].id=this.value.toLowerCase().replace(/[^a-z0-9-_]/g,'');pmMarkDirty()"
            onfocus="this.setSelectionRange(this.value.length,this.value.length)">
          <input class="pm-label-input" data-lbl="${i}" value="${escHtml(p.label)}" placeholder="Product name"
            oninput="_pmProducts[${i}].label=this.value;pmMarkDirty()"
            onfocus="this.setSelectionRange(this.value.length,this.value.length)">
        </div>
        <input class="pm-label-input pm-desc-input" value="${escHtml(p.desc||'')}" placeholder="Description (optional)"
          oninput="_pmProducts[${i}].desc=this.value;pmMarkDirty()"
          onfocus="this.setSelectionRange(this.value.length,this.value.length)">
        <div class="pm-sales-expand"${hasSubItems?' style="border-top:none;"':''}>
          ${!hasSubItems?`
          <div style="width:100%;font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">Sales Pricing</div>
          <div style="display:flex;gap:5px;align-items:center;width:100%;margin-bottom:5px;">
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex:1;min-width:0;" title="Your internal cost for this service">
              <span style="font-size:9px;color:var(--text3);flex:1;pointer-events:none;user-select:none;">Cost</span>
              <input type="number" step="0.05" min="0" style="width:56px;background:transparent;border:none;padding:2px 0;color:var(--text);font-size:11px;outline:none;text-align:right;" value="${(p.saCost||0).toFixed(2)}" oninput="const v=parseFloat(this.value)||0;_pmProducts[${i}].saCost=v;const m=appSettings.productMargin;const rec=(m>0&&m<100)?v/(1-m/100):0;const el=document.getElementById('pmrec-${i}');if(el)el.value=rec>0?rec.toFixed(2):'—';pmMarkDirty();" onblur="this.value=(parseFloat(this.value)||0).toFixed(2);">
            </div>
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex:1;min-width:0;cursor:default;" title="Recommended client price calculated from your configured margin %">
              <span style="font-size:9px;color:var(--text3);flex:1;user-select:none;">Margin${appSettings.productMargin?' ('+appSettings.productMargin+'%)':''}</span>
              <input type="text" readonly tabindex="-1" id="pmrec-${i}" style="width:56px;background:transparent;border:none;padding:2px 0;color:var(--text3);font-size:11px;outline:none;text-align:right;cursor:default;" value="${(()=>{const m=appSettings.productMargin;const r=(m>0&&m<100)?(p.saCost||0)/(1-m/100):0;return r>0?r.toFixed(2):'—';})()}">
            </div>
            <div style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex:1;min-width:0;" title="The price the client is billed for this service">
              <span style="font-size:9px;color:var(--text3);flex:1;pointer-events:none;user-select:none;">Price</span>
              <input type="number" step="0.05" min="0" style="width:56px;background:transparent;border:none;padding:2px 0;color:var(--text);font-size:11px;outline:none;text-align:right;" value="${(p.defaultPrice||0).toFixed(2)}" oninput="_pmProducts[${i}].defaultPrice=parseFloat(this.value)||0;pmMarkDirty();" onblur="this.value=(parseFloat(this.value)||0).toFixed(2);">
            </div>
          </div>
          <div style="display:flex;gap:5px;align-items:center;width:100%;flex-wrap:wrap;margin-bottom:6px;">
            <div class="pm-req-dd" id="pmreqdd-${i}-p" tabindex="-1" onfocusout="if(!this.contains(event.relatedTarget))this.classList.remove('open')" style="flex:1;min-width:130px;">
              <button type="button" class="pm-req-trigger" onclick="this.closest('.pm-req-dd').classList.toggle('open')">
                <span class="pm-req-sum">${(()=>{const c=_normReqs(p.requires).length;return c?c+' req.':'Requires…';})()}</span>
                <span style="font-size:9px;opacity:0.5;">▼</span>
              </button>
              <div class="pm-req-panel">
                ${_pmProducts.flatMap((pp,j)=>{
                  if(j===i)return[];
                  if(pp.subItems?.length){return pp.subItems.filter(s=>s.id).map(s=>{const chk=_normReqs(p.requires).includes(s.id);return`<label class="pm-req-opt${chk?' checked':''}" data-rid="${s.id}"><input type="checkbox" ${chk?'checked':''} onchange="pmToggleReq(${i},null,this.checked,'${s.id}')">${escHtml((pp.label||pp.id)+' — '+(s.label||s.id))}</label>`;});}
                  if(!pp.id)return[];
                  const chk=_normReqs(p.requires).includes(pp.id);
                  return[`<label class="pm-req-opt${chk?' checked':''}" data-rid="${pp.id}"><input type="checkbox" ${chk?'checked':''} onchange="pmToggleReq(${i},null,this.checked,'${pp.id}')">${escHtml(pp.label||pp.id)}</label>`];
                }).join('')}
              </div>
            </div>
            <select style="${_subSel}" title="Monthly = recurring charge each period. One-Time = charged once at sale" oninput="_pmProducts[${i}].billing=this.value;pmMarkDirty()">
              <option value="monthly" ${(p.billing||'monthly')==='monthly'?'selected':''}>Monthly</option>
              <option value="onetime" ${p.billing==='onetime'?'selected':''}>One-Time</option>
            </select>
            <select style="${_subSel}" title="Which pricing section this product appears in on the quote (User, Machine, or Site)" oninput="_pmProducts[${i}].salesCategory=this.value||undefined;pmMarkDirty()">
              <option value="">— Not in sales —</option>
              <option value="user" ${(p.salesCategory||'')==='user'?'selected':''}>User</option>
              <option value="machine" ${(p.salesCategory||'')==='machine'?'selected':''}>Machine</option>
              <option value="site" ${(p.salesCategory||'')==='site'?'selected':''}>Site</option>
            </select>
            <select style="${_subSel}" title="Auto-populates quantity from the client's headcount data. Leave blank to enter manually" oninput="_pmProducts[${i}].qtySource=this.value;pmMarkDirty()">
              ${qtyOpts.map(o=>`<option value="${o}" ${(p.qtySource||'')===(o)?'selected':''}>${o||'— Manual —'}</option>`).join('')}
            </select>
            <input type="text" style="${_subInp}min-width:80px;flex:0.8;" placeholder="Excl. Group" value="${escHtml(p.exclusionGroup||'')}" oninput="_pmProducts[${i}].exclusionGroup=this.value.trim()||undefined;pmMarkDirty();" title="Products sharing the same group name are mutually exclusive — selecting one auto-deselects the others in a quote">
          </div>`:''}
          ${hasSubItems?`<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:4px;width:100%;">${subItemsHtml}</div>`:''}
          <button onclick="pmAddSubItem(${i})" style="background:none;border:1px dashed var(--border);border-radius:3px;color:var(--text3);cursor:pointer;font-size:10px;padding:2px 8px;margin-top:4px;transition:all 0.15s;" title="Add sub-item" onmouseenter="this.style.borderColor='var(--accent)';this.style.color='var(--accent)';this.style.background='rgba(59,130,246,0.08)';" onmouseleave="this.style.borderColor='';this.style.color='';this.style.background='';">+ Sub-item</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;align-items:center;flex-shrink:0;">
        <button class="pm-del-btn" onclick="styledConfirm('Remove this product?',()=>pmDelete(${i}))" title="Remove">&#215;</button>
        <button class="pm-expand-btn" onclick="pmToggleSalesExpand(${i})" title="Sales pricing">▼</button>
      </div>
    </div>`;
  }).join('');
  if(_pmOpenIdx!==null)document.querySelectorAll('#pm-list .pm-row')[_pmOpenIdx]?.classList.add('sales-open');
}
function _normReqs(v){return Array.isArray(v)?v:v?[v]:[];}
function pmToggleReq(parentIdx,subIdx,checked,reqId){
  const t=subIdx!=null?_pmProducts[parentIdx]?.subItems?.[subIdx]:_pmProducts[parentIdx];
  if(!t)return;
  const reqs=_normReqs(t.requires);
  t.requires=checked?[...reqs.filter(r=>r!==reqId),reqId]:reqs.filter(r=>r!==reqId);
  if(!t.requires.length)t.requires=undefined;
  pmMarkDirty();
  const ddId=`pmreqdd-${parentIdx}-${subIdx??'p'}`;
  const sumEl=document.getElementById(ddId)?.querySelector('.pm-req-sum');
  if(sumEl){const c=_normReqs(t.requires).length;sumEl.textContent=c?c+' req.':'None';}
  const lbl=document.getElementById(ddId)?.querySelector(`.pm-req-opt[data-rid="${reqId}"]`);
  if(lbl)lbl.classList.toggle('checked',checked);
}
function pmAddProduct(){
  _pmProducts.push({id:'',label:'',desc:'',billing:'monthly'});
  pmMarkDirty();
  pmRender();
  const lblInputs=document.querySelectorAll('#pm-list [data-lbl]');
  const last=lblInputs[lblInputs.length-1];
  if(last){last.focus();}
}
function pmDelete(i){_pmProducts.splice(i,1);pmMarkDirty();pmRender();}
function pmToggleSalesExpand(i){
  const rows=document.querySelectorAll('#pm-list .pm-row');
  const target=rows[i];
  const wasOpen=target?.classList.contains('sales-open');
  rows.forEach(r=>r.classList.remove('sales-open'));
  _pmOpenIdx=wasOpen?null:i;
  if(!wasOpen)target?.classList.add('sales-open');
}
function pmAddSubItem(i){
  if(!_pmProducts[i].subItems)_pmProducts[i].subItems=[];
  if(_pmProducts[i].subItems.length===0){
    _pmProducts[i].salesCategory=undefined;
    _pmProducts[i].qtySource='';
    _pmProducts[i].requires=undefined;
  }
  _pmProducts[i].subItems.push({id:'sub-'+Date.now(),label:'',saCost:0,defaultPrice:0,billing:'monthly'});
  _pmOpenIdx=i;
  pmMarkDirty();pmRender();
}
function pmDeleteSubItem(i,si){
  _pmProducts[i].subItems.splice(si,1);
  if(!_pmProducts[i].subItems.length)delete _pmProducts[i].subItems;
  pmMarkDirty();pmRender();
}
function pmDragStart(e,i){_pmDrag=i;e.dataTransfer.effectAllowed='move';}
function pmDragOver(e,i){
  e.preventDefault();
  document.querySelectorAll('.pm-row').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  const el=e.currentTarget;
  const upper=e.clientY<el.getBoundingClientRect().top+el.getBoundingClientRect().height/2;
  el.classList.toggle('drag-over-before',upper);
  el.classList.toggle('drag-over-after',!upper);
}
function pmDragLeave(e){if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove('drag-over-before','drag-over-after');}
function pmDragEnd(e){document.querySelectorAll('.pm-row').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));}
function pmSubDragStart(e,i,si){_pmSubDrag={i,si};e.dataTransfer.effectAllowed='move';const el=e.target.closest('.pm-sub-item');if(el)setTimeout(()=>el.classList.add('dragging'),0);}
function pmSubDragOver(e,i,si){
  e.preventDefault();
  if(!_pmSubDrag||_pmSubDrag.i!==i)return;
  document.querySelectorAll('.pm-sub-item').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  const upper=e.clientY<e.currentTarget.getBoundingClientRect().top+e.currentTarget.getBoundingClientRect().height/2;
  e.currentTarget.classList.toggle('drag-over-before',upper);
  e.currentTarget.classList.toggle('drag-over-after',!upper);
}
function pmSubDragLeave(e){if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.classList.remove('drag-over-before','drag-over-after');}
function pmSubDragEnd(e){document.querySelectorAll('.pm-sub-item').forEach(r=>r.classList.remove('drag-over-before','drag-over-after','dragging'));_pmSubDrag=null;}
function pmSubDrop(e,i,si){
  e.preventDefault();
  document.querySelectorAll('.pm-sub-item').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  if(!_pmSubDrag||_pmSubDrag.i!==i){_pmSubDrag=null;return;}
  const srcSi=_pmSubDrag.si;_pmSubDrag=null;
  if(srcSi===si)return;
  const upper=e.clientY<e.currentTarget.getBoundingClientRect().top+e.currentTarget.getBoundingClientRect().height/2;
  const items=_pmProducts[i].subItems;
  const[moved]=items.splice(srcSi,1);
  let insertAt=upper?si:si+1;
  if(srcSi<si)insertAt--;
  items.splice(Math.max(0,insertAt),0,moved);
  _pmOpenIdx=i;pmMarkDirty();pmRender();
}
function pmReorder(si,ti,upper){
  if(si==null||ti==null||si===ti) return;
  const [item]=_pmProducts.splice(si,1);
  let ins=si<ti?(upper?ti-1:ti):(upper?ti:ti+1);
  ins=Math.max(0,Math.min(ins,_pmProducts.length));
  _pmProducts.splice(ins,0,item);
  pmMarkDirty();pmRender();
}
let _pmDragState=null;
function pmMouseDown(e,i,type,si){
  if(e.button!==0)return;
  e.preventDefault();
  let el,container;
  if(type==='row'){
    el=document.querySelector(`#pm-list .pm-row[data-pi="${i}"]`);
    container=document.getElementById('pm-list');
  }else{
    el=e.target.closest('.pm-sub-item');
    container=el?.parentNode;
  }
  if(!el||!container)return;
  const rect=el.getBoundingClientRect();
  const offsetX=e.clientX-rect.left,offsetY=e.clientY-rect.top;
  const ghost=el.cloneNode(true);
  Object.assign(ghost.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',
    opacity:'0.88',pointerEvents:'none',zIndex:'9999',transform:'scale(1.02) rotate(0.5deg)',
    boxShadow:'0 8px 28px rgba(0,0,0,0.5)',borderRadius:'6px',margin:'0',boxSizing:'border-box',transition:'none'});
  document.body.appendChild(ghost);
  const ph=document.createElement('div');
  ph.style.cssText=`height:${el.offsetHeight}px;background:rgba(59,130,246,0.07);border:2px dashed rgba(59,130,246,0.45);border-radius:6px;box-sizing:border-box;flex-shrink:0;`;
  el.parentNode.insertBefore(ph,el);
  const origDisplay=el.style.display;
  el.style.display='none';
  _pmDragState={type,i,si,ghost,ph,el,container,offsetX,offsetY,origDisplay};
  document.addEventListener('mousemove',_pmDragMove,{passive:false});
  document.addEventListener('mouseup',_pmDragUp);
}
function _pmDragMove(e){
  const s=_pmDragState;if(!s)return;
  s.ghost.style.left=(e.clientX-s.offsetX)+'px';
  s.ghost.style.top=(e.clientY-s.offsetY)+'px';
  const cls=s.type==='row'?'pm-row':'pm-sub-item';
  const sibs=[...s.container.children].filter(c=>c!==s.ph&&c.style.display!=='none'&&c.classList.contains(cls));
  let placed=false;
  for(const sib of sibs){
    const r=sib.getBoundingClientRect();
    if(e.clientY<r.top+r.height/2){s.container.insertBefore(s.ph,sib);placed=true;break;}
  }
  if(!placed)s.container.appendChild(s.ph);
}
function _pmDragUp(){
  document.removeEventListener('mousemove',_pmDragMove);
  document.removeEventListener('mouseup',_pmDragUp);
  const s=_pmDragState;_pmDragState=null;
  if(!s)return;
  s.ghost.remove();
  const children=[...s.container.children];
  const phIdx=children.indexOf(s.ph);
  let nextEl=null;
  const cls=s.type==='row'?'pm-row':'pm-sub-item';
  for(let k=phIdx+1;k<children.length;k++){if(children[k].classList.contains(cls)){nextEl=children[k];break;}}
  s.ph.remove();
  s.el.style.display=s.origDisplay;
  if(s.type==='row'){
    const srcI=s.i;
    let targetI=nextEl?parseInt(nextEl.dataset.pi):_pmProducts.length-1;
    if(nextEl&&srcI<parseInt(nextEl.dataset.pi))targetI--;
    if(targetI!==srcI){const[m]=_pmProducts.splice(srcI,1);_pmProducts.splice(Math.max(0,targetI),0,m);pmMarkDirty();pmRender();}
  }else{
    const srcSi=s.si,parentI=s.i;
    const items=_pmProducts[parentI]?.subItems;if(!items)return;
    let targetSi=nextEl?parseInt(nextEl.dataset.si):items.length-1;
    if(nextEl&&srcSi<parseInt(nextEl.dataset.si))targetSi--;
    if(targetSi!==srcSi){const[m]=items.splice(srcSi,1);items.splice(Math.max(0,targetSi),0,m);_pmOpenIdx=parentI;pmMarkDirty();pmRender();}
  }
}
function pmDrop(e,ti){
  e.preventDefault();
  document.querySelectorAll('.pm-row').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  const si=_pmDrag;_pmDrag=null;
  if(si==null||si===ti) return;
  const upper=e.clientY<e.currentTarget.getBoundingClientRect().top+e.currentTarget.getBoundingClientRect().height/2;
  pmReorder(si,ti,upper);
}

// Touch drag-and-drop for mobile (HTML5 drag API doesn't fire on touch)
function pmTouchStart(e,i){
  const touch=e.touches[0];
  const row=e.target.closest('.pm-row');
  const rect=row.getBoundingClientRect();
  const ghost=row.cloneNode(true);
  Object.assign(ghost.style,{
    position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',
    margin:'0',boxSizing:'border-box',opacity:'0.85',pointerEvents:'none',
    zIndex:'9999',transform:'scale(1.02)',boxShadow:'0 4px 16px rgba(0,0,0,0.4)',
    borderRadius:'6px',
  });
  document.body.appendChild(ghost);
  _pmTouch={srcIdx:i,tgtIdx:null,upper:true,ghost,row,offsetY:touch.clientY-rect.top};
  row.style.opacity='0.3';
  e.preventDefault();
}
let _pmSubTouch=null;
function pmSubTouchStart(e,parentI,subI){
  const touch=e.touches[0];
  const row=e.target.closest('.pm-sub-item');
  if(!row)return;
  const rect=row.getBoundingClientRect();
  const ghost=row.cloneNode(true);
  Object.assign(ghost.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',
    margin:'0',boxSizing:'border-box',opacity:'0.88',pointerEvents:'none',display:'flex',
    zIndex:'9999',transform:'scale(1.02)',boxShadow:'0 8px 24px rgba(0,0,0,0.5)',borderRadius:'6px'});
  document.body.appendChild(ghost);
  _pmSubTouch={parentI,subI,ghost,row,container:row.parentNode,offsetY:touch.clientY-rect.top};
  row.style.opacity='0.25';
  e.preventDefault();
}
document.addEventListener('touchmove',e=>{
  if(_pmSubTouch){
    e.preventDefault();
    const touch=e.touches[0];
    _pmSubTouch.ghost.style.top=(touch.clientY-_pmSubTouch.offsetY)+'px';
    _pmSubTouch.ghost.style.display='none';
    const under=document.elementFromPoint(touch.clientX,touch.clientY);
    _pmSubTouch.ghost.style.display='';
    const targetSub=under?.closest?.('.pm-sub-item');
    document.querySelectorAll('.pm-sub-item').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
    if(targetSub&&targetSub!==_pmSubTouch.row&&_pmSubTouch.container.contains(targetSub)){
      const rect=targetSub.getBoundingClientRect();
      const upper=touch.clientY<rect.top+rect.height/2;
      targetSub.classList.toggle('drag-over-before',upper);
      targetSub.classList.toggle('drag-over-after',!upper);
      _pmSubTouch.tgtSi=parseInt(targetSub.dataset.si);
      _pmSubTouch.upper=upper;
    }else{_pmSubTouch.tgtSi=null;}
    return;
  }
  if(!_pmTouch) return;
  e.preventDefault();
  const touch=e.touches[0];
  _pmTouch.ghost.style.top=(touch.clientY-_pmTouch.offsetY)+'px';
  _pmTouch.ghost.style.display='none';
  const under=document.elementFromPoint(touch.clientX,touch.clientY);
  _pmTouch.ghost.style.display='';
  const targetRow=under?.closest?.('#pm-list .pm-row');
  document.querySelectorAll('#pm-list .pm-row').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  if(targetRow&&targetRow!==_pmTouch.row){
    const rect=targetRow.getBoundingClientRect();
    const upper=touch.clientY<rect.top+rect.height/2;
    targetRow.classList.toggle('drag-over-before',upper);
    targetRow.classList.toggle('drag-over-after',!upper);
    _pmTouch.tgtIdx=parseInt(targetRow.dataset.pi);
    _pmTouch.upper=upper;
  } else {_pmTouch.tgtIdx=null;}
},{passive:false});
document.addEventListener('touchend',e=>{
  if(_pmSubTouch){
    _pmSubTouch.ghost.remove();
    _pmSubTouch.row.style.opacity='';
    document.querySelectorAll('.pm-sub-item').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
    const{parentI,subI:srcSi,tgtSi,upper,container}=_pmSubTouch;
    _pmSubTouch=null;
    if(tgtSi==null||tgtSi===srcSi)return;
    const items=_pmProducts[parentI]?.subItems;if(!items)return;
    const[m]=items.splice(srcSi,1);
    let ins=srcSi<tgtSi?(upper?tgtSi-1:tgtSi):(upper?tgtSi:tgtSi+1);
    items.splice(Math.max(0,ins),0,m);
    _pmOpenIdx=parentI;pmMarkDirty();pmRender();
    return;
  }
  if(!_pmTouch) return;
  _pmTouch.ghost.remove();
  _pmTouch.row.style.opacity='';
  document.querySelectorAll('#pm-list .pm-row').forEach(r=>r.classList.remove('drag-over-before','drag-over-after'));
  const{srcIdx:si,tgtIdx:ti,upper}=_pmTouch;
  _pmTouch=null;
  pmReorder(si,ti,upper);
});
async function pmSave(){
  const errors=[];
  const seen=new Set();
  _pmProducts.forEach((p,i)=>{
    const id=(p.id||'').trim(),lbl=(p.label||'').trim();
    if(!id) errors.push(`Product #${i+1} is missing an ID`);
    else if(seen.has(id)) errors.push(`Duplicate product ID: "${id}"`);
    else seen.add(id);
    if(!lbl) errors.push(`Product #${i+1} is missing a name`);
  });
  if(errors.length){showToast(errors[0],'error');return false;}
  appSettings.products=_pmProducts.map(p=>({...p,id:p.id.trim(),label:p.label.trim()}));
  const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)});
  if(r.ok){
    _pmDirty=false;
    const ind=document.getElementById('pm-dirty-indicator');
    if(ind) ind.style.display='none';
    logAction('products_saved',{clientId:null,clientName:null,details:`${appSettings.products?.length||0} products`});
    showToast('Products saved');
    buildProductsGrid();
    return true;
  }else{
    let msg='Failed to save products';
    try{const d=await r.json();if(d.error)msg=d.error;}catch(_){}
    showToast(msg,'error');
    return false;
  }
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('products-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeProductsModal();});
});

// ─── Global log modal ─────────────────────────────────────────────────────────
async function openGlobalLogModal(){
  document.getElementById('global-log-modal').classList.add('show');
  await loadGlobalLog();
}
function closeGlobalLogModal(){
  document.getElementById('global-log-modal').classList.remove('show');
}
async function loadGlobalLog(){
  const el=document.getElementById('global-log-timeline');
  if(el) el.innerHTML='<div style="color:var(--text3);font-size:11px;">Loading…</div>';
  try{
    const r=await fetch('/api/logs?limit=500');
    window._globalLogs=await r.json();
    applyGlobalLogFilter();
  }catch(e){if(el)el.innerHTML=`<div style="color:#fca5a5;font-size:11px;">Failed: ${e.message}</div>`;}
}
function applyGlobalLogFilter(){
  const logs=window._globalLogs||[];
  const cf=(document.getElementById('glog-client-filter')?.value||'').toLowerCase();
  const af=document.getElementById('glog-action-filter')?.value||'';
  renderLogTimeline(document.getElementById('global-log-timeline'),filterLogEntries(logs,cf,af).slice(0,200));
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('global-log-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeGlobalLogModal();});
});

function renderUpdateHint(hint){
  return hint?`<div style="margin-top:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:6px;padding:8px 10px;font-size:11px;color:var(--text2);">
    <strong style="color:var(--danger);">Fix required:</strong> ${escHtml(hint)}
    <button onclick="navigator.clipboard.writeText(${JSON.stringify(hint)}).then(()=>showToast('Copied'))" style="margin-left:8px;font-size:10px;padding:1px 7px;background:none;border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;">Copy</button>
  </div>`:'';
}
async function checkForUpdates(){
  const statusEl=document.getElementById('update-status');
  const applyBtn=document.getElementById('apply-update-btn');
  if(!statusEl) return;
  statusEl.textContent='Checking…';
  applyBtn&&(applyBtn.style.display='none');
  try{
    const r=await fetch('/api/update/status');
    const d=await r.json();
    if(d.error){
      statusEl.innerHTML=`<span style="color:var(--danger);">Error: ${escHtml(d.error)}</span>${renderUpdateHint(d.hint)}`;
      return;
    }
    if(d.upToDate){
      statusEl.innerHTML=`<span style="color:var(--success);">&#10003; Up to date</span>`;
    }else{
      statusEl.innerHTML=`<span style="color:var(--warn);">${d.commits.length} update${d.commits.length>1?'s':''} available:</span>
        <ul style="margin:6px 0 0 16px;padding:0;font-size:11px;color:var(--text2);">${d.commits.map(c=>`<li>${escHtml(c)}</li>`).join('')}</ul>`;
      if(applyBtn) applyBtn.style.display='';
    }
  }catch(e){statusEl.innerHTML=`<span style="color:var(--danger);">Failed: ${escHtml(e.message)}</span>`;}
}
function applyUpdate(){
  styledConfirm('Pull latest changes and restart the server?',async()=>{
  const statusEl=document.getElementById('update-status');
  const applyBtn=document.getElementById('apply-update-btn');
  if(applyBtn) applyBtn.disabled=true;
  statusEl&&(statusEl.textContent='Pulling…');
  try{
    const r=await fetch('/api/update',{method:'POST'});
    const d=await r.json();
    if(d.ok){
      setUpdateAvailable(false);
      statusEl&&(statusEl.innerHTML=`<span style="color:var(--success);">Done! Waiting for server to restart…</span>`);
      showToast('Update applied — reloading when ready','info');
      await new Promise(r=>setTimeout(r,1500));
      const deadline=Date.now()+30000;
      const poll=async()=>{
        if(Date.now()>deadline){statusEl&&(statusEl.innerHTML=`<span style="color:var(--warn);">Server taking longer than expected — <a href="" style="color:var(--accent);">reload manually</a></span>`);return;}
        try{const h=await fetch('/api/health',{cache:'no-store'});if(h.ok){location.reload();return;}}catch(_){} // no-store on index.html means reload always fetches fresh
        setTimeout(poll,1000);
      };
      poll();
    }else{
      statusEl&&(statusEl.innerHTML=`<span style="color:var(--danger);">Error: ${escHtml(d.error||'Unknown error')}</span>${renderUpdateHint(d.hint)}`);
      if(applyBtn) applyBtn.disabled=false;
    }
  }catch(e){
    statusEl&&(statusEl.innerHTML=`<span style="color:var(--danger);">Failed: ${escHtml(e.message)}</span>`);
    if(applyBtn) applyBtn.disabled=false;
  }
  });
}

function renderSidebar(filter){
  const sbFrom=captureBarWidths();
  const list=document.getElementById('client-list');
  const entries=Object.values(clients).filter(c=>!filter||c.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b)=>(b.priority?1:0)-(a.priority?1:0));
  if(!entries.length){list.innerHTML=`<div style="padding:20px 12px;text-align:center;"><div style="font-size:24px;height:30px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;opacity:0.4;">📋</div><div style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:4px;">${filter?'No matches':'No checklists yet'}</div>${filter?'':`<div style="font-size:11px;color:var(--text3);">Use the button below to get started</div>`}</div>`;return;}
  const now=Date.now();
  list.innerHTML=entries.map(c=>{
    const prog=overallProgress(c);
    const pct=prog.total?Math.round((prog.done/prog.total)*100):0;
    const lastMod=c.lastModified||c.createdAt||0;
    const staleDays=appSettings.staleDays||0;
    const stale=c.clientStatus!=='blocked'&&c.clientStatus!=='on-hold'&&staleDays&&((now-new Date(lastMod).getTime())/(1000*60*60*24))>staleDays;
    const staleBadge=stale?`<span class="stale-dot" title="Inactive ${staleDays}+ days">\u25cf</span>`:'';
    const unseen=unseenChanges.get(c.id);
    const unseenBadge=unseen?`<span class="unseen-dot" title="${unseen.techName?unseen.techName+' made changes':'Changes made'}"></span>`:'';
    const statusBadge=(c.clientStatus&&c.clientStatus!=='active')?`<span class="quote-status ${c.clientStatus}">${clientStatusLabel(c.clientStatus)}</span>`:'';
    const starSvg=`<svg width="16" height="16" viewBox="0 0 24 24" fill="${c.priority?'currentColor':'none'}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    return `<div class="client-item ${c.id===activeClientId?'active':''}" title="${c.name}" data-notify-id="cl:${c.id}">
      <div style="padding:7px 32px 7px 14px;" onclick="selectClient('${c.id}')">
        <div class="cn"><span>${c.name}</span>${staleBadge}${statusBadge}</div>
        <div class="cm">${c.tech} \u00b7 ${pct}% org</div>
        <div class="cpbar"><div class="cpbar-fill" style="width:0" data-w="${pct}" data-bar-id="sb-${c.id}"></div></div>
        ${unseenBadge}
      </div>
      <button class="sidebar-star${c.priority?' on':''}" onclick="toggleClientPriority('${c.id}')" title="${c.priority?'Unmark priority':'Mark priority'}">${starSvg}</button>
    </div>`;
  }).join('');
  animateBars(list, sbFrom);
}
function selectClient(id){
  if(isMobile()) closeOverlays();
  // Clear active client dots — new system tracks per client in pendingClientChanges
  notifyStore.clear();
  unseenChanges.delete(id);
  // Load pending changes for the target client into notify store
  const pending=pendingClientChanges.get(id);
  if(pending) addToNotifyStore(pending.changes,id,pending.techName);
  pendingClientChanges.delete(id);
  loadClientChecklist(id);
  renderAllDots();
}
function filterClients(val){renderSidebar(val);}

// \u2500\u2500\u2500 State helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function chk(){return`<svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;}
function getStepState(client,step){
  if(!step.substeps||!step.substeps.length) return client.steps[step.id]?'done':'none';
  const allDone=step.substeps.every(s=>client.steps[s.id]);
  const anyDone=step.substeps.some(s=>client.steps[s.id]);
  if(allDone)return'done';if(anyDone)return'partial';return'none';
}
function isPhaseComplete(c,p){return p.steps.every(s=>getStepState(c,s)==='done');}
function phaseProgress(c,p){const done=p.steps.filter(s=>getStepState(c,s)==='done').length;return{done,total:p.steps.length};}
function overallProgress(c){
  const phases=buildPhases(c);
  const all=phases.flatMap(p=>p.steps);
  const done=all.filter(s=>getStepState(c,s)==='done').length;
  return{done,total:all.length};
}
function devStatus(dev,steps){
  const active=steps.filter(s=>!(dev.skipped&&dev.skipped[s.id]));
  if(!active.length)return'complete';
  const done=active.filter(s=>dev.steps&&dev.steps[s.id]).length;
  if(!done)return'not-started';
  if(done===active.length)return'complete';
  return'in-progress';
}

// \u2500\u2500\u2500 Rendering \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderStep(clientId,step){
  const client=clients[clientId];
  const state=getStepState(client,step);
  const hasSubs=!!(step.substeps&&step.substeps.length);
  const hasFt=!!step.freetext;
  const hasVpn=!!step.vpn_selector;
  const hasGuide=!!step.guide;
  let checkHtml='';
  if(state==='done')checkHtml=chk();
  else if(state==='partial')checkHtml=`<div class="step-partial-dash"></div>`;
  const expandIcon=hasSubs?`<span class="step-expand-icon">&#9654;</span>`:'';
  const guideBtn=hasGuide?`<button class="btn-guide" onclick="event.stopPropagation();openGuide('${step.guide}')">Guide &#x2197;</button>`:'';
  const stepNote=client.stepNotes&&client.stepNotes[step.id]||'';
  const noteBtn=`<button class="quote-note-btn${stepNote?' has-note':''}" onclick="event.stopPropagation();toggleStepNote('${step.id}')" title="Step note">&#9998;</button>`;
  // Tags + guide in same row; guide on far right of badges
  const tags=(step.tags?.length||hasGuide)?`<div class="step-tags">${(step.tags||[]).map(t=>`<span class="step-tag ${t}">${t}</span>`).join('')}${guideBtn}</div>`:'';
  const installerUrl=step.installer_url&&clients[clientId].syncroInstallerUrl;
  const extra=installerUrl?`<div class="installer-link" onclick="event.stopPropagation();copyText('${installerUrl}',this)">&#128279; ${installerUrl} <span style="opacity:0.5;font-size:9px;">(copy)</span></div>`:'';
  let subsHtml='';
  if(hasSubs){
    subsHtml=`<div class="substeps">`+step.substeps.map(sub=>{
      const done=!!client.steps[sub.id];
      const subTags=sub.tags?.length?`<div class="step-tags">${sub.tags.map(t=>`<span class="step-tag ${t}">${t}</span>`).join('')}</div>`:'';
      return `<div class="substep-item ${done?'done':''}" onclick="event.stopPropagation();toggleSubstep('${clientId}','${step.id}','${sub.id}')" data-notify-id="st:${sub.id}">
        <div class="substep-check">${done?chk():''}</div>
        <div><div class="substep-title">${sub.title}</div>${sub.detail?`<div class="substep-detail">${sub.detail}</div>`:''}${subTags}</div>
      </div>`;
    }).join('')+`</div>`;
  }
  let ftHtml='';
  if(hasFt){
    const ft=step.freetext;
    const saved=client.freetexts&&client.freetexts[ft.id]||'';
    ftHtml=`<div class="freetext-block" id="ft-${ft.id}">
      <div class="freetext-header" onclick="event.stopPropagation();toggleFreetext('ft-${ft.id}')">
        <span>${ft.label}</span><span class="freetext-icon">&#9654;</span>
      </div>
      <div class="freetext-body">
        <textarea placeholder="${ft.placeholder}" onblur="saveFreetext('${clientId}','${ft.id}',this.value)">${saved}</textarea>
      </div>
    </div>`;
  }
  let vpnHtml='';
  if(hasVpn){
    vpnHtml=`<div class="vpn-selector">${VPN_OPTIONS.map(v=>`<button class="vpn-btn" onclick="event.stopPropagation();openGuide('${v.id}')">${v.label} VPN Guide &#x2197;</button>`).join('')}</div>`;
  }
  const clickAction=hasSubs?`toggleStepExpand('${step.id}')`:`toggleStep('${clientId}','${step.id}')`;
  return `<div class="step-item ${state}" id="step-${step.id}" data-notify-id="st:${step.id}" data-notify-slot=".step-actions">
    <div class="step-row" onclick="${clickAction}">
      <div class="step-check">${checkHtml}</div>
      <div class="step-body">
        <div class="step-title-row">
          <div class="step-title">${step.title}</div>
          ${noteBtn}
        </div>
        ${state==='done'&&client.stepCompletedBy?.[step.id]?`<div class="step-by">Completed by ${escHtml(client.stepCompletedBy[step.id])}</div>`:''}
        ${step.detail?`<div class="step-detail">${step.detail}</div>`:''}
        ${extra}${tags}
      </div>
      <div class="step-actions">${expandIcon}</div>
    </div>
    ${subsHtml}${ftHtml}${vpnHtml}
    <div class="step-note-area">
      <textarea placeholder="Step note..." onblur="saveStepNote('${clientId}','${step.id}',this.value)">${stepNote}</textarea>
    </div>
  </div>`;
}

function renderPhase(clientId,phase,phaseNum){
  const client=clients[clientId];
  const complete=isPhaseComplete(client,phase);
  const prog=phaseProgress(client,phase);
  return `<div class="phase-block ${complete?'completed':''}" id="phase-${phase.id}" data-notify-id="ph:${phase.id}">
    <div class="phase-header">
      <div class="phase-num">${complete?chk():phaseNum}</div>
      <h3>${phase.title}</h3>
      ${phase.badge?`<span class="phase-badge">${phase.badge}</span>`:''}
      <span class="phase-progress-text">${prog.done}/${prog.total}</span>
    </div>
    <div class="phase-body">${phase.steps.map(s=>renderStep(clientId,s)).join('')}</div>
  </div>`;
}

function renderInstEntry(clientId, dev){
  // Returns HTML for the installer entry in a device step
  const client=clients[clientId];
  const rawUrl=dev.rawInstallerUrl||(client.syncroInstallerMap?.[dev.type])||client.syncroInstallerUrl||null;
  if(rawUrl) return `<div id="inst-${clientId}-${dev.id}"></div>`;
  // No URL — show inline input
  return `<div class="inst-manual" id="imw-${clientId}-${dev.id}" onclick="event.stopPropagation()" style="max-width:540px;">
    <div style="display:flex;gap:6px;margin-top:6px;align-items:center;">
      <input type="text" id="iminp-${dev.id}" style="flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:6px 9px;color:var(--text);font-size:11px;outline:none;font-family:var(--sans);" placeholder="Paste RMM installer URL…" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'">
      <button class="btn-primary" style="white-space:nowrap;flex-shrink:0;padding:6px 12px;font-size:11px;" onclick="event.stopPropagation();saveDevInstUrl('${clientId}','${dev.id}','${escHtml(dev.type||'')}')">Save &amp; Shorten</button>
    </div>
    <div id="imshort-${dev.id}" style="display:none;font-size:10px;color:var(--accent);margin-top:3px;"></div>
  </div>`;
}
async function saveDevInstUrl(clientId, devId, devType){
  const input=document.getElementById('iminp-'+devId);
  const raw=(input?.value||'').trim();
  if(!raw){input?.focus();showToast('Enter a URL first','error');return;}
  let isValidUrl=false;
  try{const u=new URL(raw);isValidUrl=u.protocol==='https:'||u.protocol==='http:';}catch(_){}
  if(!isValidUrl){
    input.style.borderColor='var(--danger)';
    showToast('Please enter a valid https:// URL','error');
    setTimeout(()=>{if(input)input.style.borderColor='var(--border)';},2500);
    return;
  }
  const btn=input?.nextElementSibling;
  if(btn){btn.textContent='Saving…';btn.disabled=true;}
  let shortUrl=null;
  try{
    const r=await fetch(`/api/shorten?url=${encodeURIComponent(raw)}`);
    if(r.ok){const d=await r.json();if(d.short&&d.short!==raw)shortUrl=d.short;}
  }catch(_){}
  const c=clients[clientId];
  if(!c?.devices?.[devId]) return;
  c.devices[devId].rawInstallerUrl=raw;
  c.devices[devId].shortUrl=shortUrl;
  // Cache to installer map so future devices of same type reuse it
  if(devType&&devType!=='Other'){
    if(!c.syncroInstallerMap) c.syncroInstallerMap={};
    c.syncroInstallerMap[devType]=raw;
  }
  await saveClients();
  // Replace the manual input div with the rendered installer block
  const wrap=document.getElementById('imw-'+clientId+'-'+devId);
  if(wrap){
    const cid=`inst-${clientId}-${devId}`;
    const div=document.createElement('div');div.id=cid;
    wrap.replaceWith(div);
    renderInstallerBlock(raw,cid,shortUrl,(s)=>{
      clients[clientId].devices[devId].shortUrl=s;saveClients();
    });
  }
  showToast('Installer URL saved');
}
function renderInstallerBlock(rawUrl, containerId, storedShort, onShortened){
  const el=document.getElementById(containerId);
  if(!el) return;
  const displayUrl=storedShort||rawUrl;
  el.innerHTML=`<div class="installer-block" onclick="event.stopPropagation()">
    <div class="installer-url-row">
      <span class="url-text" id="${containerId}-url">${displayUrl}</span>
      <div class="installer-actions">
        <button class="copy-btn" id="${containerId}-copy" onclick="event.stopPropagation();copyInstUrl('${containerId}',this)">Copy</button>
        <button class="copy-btn" id="${containerId}-qr-btn" onclick="event.stopPropagation();openQrModal(document.getElementById('${containerId}-url').textContent)">QR</button>
      </div>
    </div>
  </div>`;
  if(!storedShort) shortenUrl(rawUrl, containerId, onShortened);
}

function copyInstUrl(containerId, btn){
  const urlEl=document.getElementById(containerId+'-url');
  const text=urlEl?urlEl.textContent.trim():'';
  if(!text){showToast('No URL to copy','error');return;}
  const done=()=>{
    if(!btn) return;
    const orig=btn.textContent;
    btn.textContent='Copied!';btn.style.color='var(--success)';
    setTimeout(()=>{btn.textContent=orig;btn.style.color='';},1500);
  };
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(done).catch(()=>{
      legacyCopy(text);done();
    });
  } else {legacyCopy(text);done();}
}
function legacyCopy(text){
  const ta=document.createElement('textarea');
  ta.value=text;ta.style.cssText='position:fixed;opacity:0;top:0;left:0;';
  document.body.appendChild(ta);ta.focus();ta.select();
  try{document.execCommand('copy');}catch(_){}
  document.body.removeChild(ta);
}

function openQrModal(url){
  if(!url) return;
  const modal=document.getElementById('qr-modal');
  const content=document.getElementById('qr-modal-content');
  document.getElementById('qr-modal-url').textContent=url;
  modal.classList.add('show');
  if(qrCache.has(url)){content.innerHTML=qrCache.get(url);return;}
  content.innerHTML='<div style="width:220px;height:220px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:11px;">Generating…</div>';
  const src=`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
  const img=new Image();
  img.onload=()=>{
    const html=`<img src="${src}" width="220" height="220" style="border-radius:6px;display:block;">`;
    qrCache.set(url,html);
    content.innerHTML=html;
  };
  img.onerror=()=>{content.innerHTML='<div style="color:var(--danger);font-size:11px;">Failed to generate QR code</div>';};
  img.src=src;
}
function closeQrModal(){document.getElementById('qr-modal').classList.remove('show');}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('qr-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeQrModal();});
});

async function shortenUrl(rawUrl, containerId, onShortened){
  const urlEl=document.getElementById(`${containerId}-url`);
  try{
    const r=await fetch(`/api/shorten?url=${encodeURIComponent(rawUrl)}`);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json();
    if(!d.short) throw new Error(d.error||'No short URL returned');
    if(urlEl) urlEl.textContent=d.short;
    if(onShortened) onShortened(d.short);
  }catch(e){
    // Leave raw URL displayed — silent fail, no need to alarm the user
    console.warn('TinyURL failed:', e.message);
  }
}


function renderDeviceGuide(clientId){
  const client=clients[clientId];
  const devSteps=buildDeviceSteps(client);
  const devices=client.devices||{};
  const devList=Object.values(devices);
  const doneCount=devList.filter(d=>devStatus(d,devSteps)==='complete').length;
  const buildStepRow=(dev,s)=>{
    const done=!!(dev.steps&&dev.steps[s.id]);
    const skipped=!!(dev.skipped&&dev.skipped[s.id]);
    const gb=s.vpn_selector?`<div class="vpn-selector">${VPN_OPTIONS.map(v=>`<button class="vpn-btn" onclick="event.stopPropagation();openGuide('${v.id}')">${v.label} VPN Guide &#x2197;</button>`).join('')}</div>`:'';
    const installerHtml=s.installer_url?renderInstEntry(clientId,dev):'';
    const checkMark=done?chk():skipped?`<span style="font-size:9px;color:var(--text3);">N/A</span>`:'';
    return `<div class="device-step-item ${done?'done':skipped?'skipped':''}" onclick="${skipped?`toggleDeviceSkip('${clientId}','${dev.id}','${s.id}')`:`toggleDeviceStep('${clientId}','${dev.id}','${s.id}')`}" id="dvs-${dev.id}-${s.id}" data-notify-id="dvst:${dev.id}:${s.id}">
      <div class="device-step-check">${checkMark}</div>
      <div style="flex:1;min-width:0;">
        <div class="device-step-title">${s.title}</div>
        ${s.detail?`<div class="device-step-detail">${s.detail}</div>`:''}
        ${installerHtml}${gb}
      </div>
      ${!done?`<button class="dev-skip-btn${skipped?' active':''}" onclick="event.stopPropagation();toggleDeviceSkip('${clientId}','${dev.id}','${s.id}')" title="${skipped?'Restore step':'Mark N/A'}">${skipped?'Restore':'N/A'}</button>`:''}
    </div>`;
  };
  const rows=devList.map(dev=>{
    const status=devStatus(dev,devSteps);
    const lmap={'not-started':'Not Started','in-progress':'In Progress','complete':'Complete'};
    const stepsHtml=devSteps.map(s=>buildStepRow(dev,s)).join('');
    return `<div class="device-entry ${isDevExpanded(clientId,dev.id)?'expanded':''}" id="dev-${dev.id}" data-notify-id="dva:${dev.id}">
      <div class="device-entry-header" onclick="toggleDeviceEntry('${clientId}','${dev.id}')">
        <span class="device-entry-name">${dev.name}</span>
        <span class="device-entry-meta">${dev.type||''}</span>
        <span class="dev-status ${status}">${lmap[status]}</span>
        <span class="device-entry-del" onclick="event.stopPropagation();deleteDevice('${clientId}','${dev.id}')" title="Remove">&#10005;</span>
      </div>
      <div class="device-entry-body">
        <div class="device-info-grid">
          <div class="device-info-item"><strong>Hostname</strong>${dev.name}</div>
          <div class="device-info-item"><strong>Type</strong>${dev.type||'\u2014'}</div>
          <div class="device-info-item"><strong>User(s)</strong>${dev.users||'\u2014'}</div>
          <div class="device-info-item"><strong>OS</strong>${dev.os||'\u2014'}</div>
        </div>
        <div class="device-steps">${stepsHtml}</div>
        <div class="device-notes-label">Notes</div>
        <textarea class="device-notes" placeholder="Device-specific notes, issues, config details..." onblur="saveDeviceNotes('${clientId}','${dev.id}',this.value)">${dev.notes||''}</textarea>
      </div>
    </div>`;
  }).join('');
  return `<div id="device-guide-container">
    <div class="device-guide-header">
      <h3 style="font-size:12px;font-weight:600;">Device Deployment Guide</h3>
      <span class="phase-badge gb">PER DEVICE</span>
      <span class="phase-progress-text" id="device-guide-progress">${doneCount}/${devList.length} complete</span>
      <button class="btn-primary btn-sm" style="margin-left:auto;" onclick="showAddDeviceModal('${clientId}')">+ Add Device</button>
    </div>
    <div id="device-guide-body">
      ${devList.length===0?`<div style="padding:10px 3px;font-size:11px;color:var(--text3);">No devices added yet. Click + Add Device to begin tracking deployment.</div>`:`<div class="device-grid">${rows}</div>`}
    </div>
  </div>`;
}

function loadClientChecklist(id){
  activeClientId=id;
  document.getElementById('settings-btn')?.classList.remove('active');
  const client=clients[id];
  const phases=buildPhases(client);
  const prog=overallProgress(client);
  const pct=prog.total?Math.round((prog.done/prog.total)*100):0;
  const activePhases=phases.filter(p=>!isPhaseComplete(client,p));
  const completedPhases=phases.filter(p=>isPhaseComplete(client,p));
  const devSteps=buildDeviceSteps(client);
  const devList=Object.values(client.devices||{});
  const devDone=devList.filter(d=>devStatus(d,devSteps)==='complete').length;

  const myName=localStorage.getItem('myName')||'';

  // Due date badge
  let dueBadge='';
  if(client.dueDate){
    const due=new Date(client.dueDate);
    const now=new Date();
    const diff=Math.ceil((due-now)/(1000*60*60*24));
    const cls=diff<0?'overdue':diff<=appSettings.dueDays?'warn':'ok';
    const label=diff<0?`${Math.abs(diff)}d overdue`:diff===0?'Due today':`${diff}d left`;
    dueBadge=`<span class="due-badge ${cls}">${label}</span>`;
  }

  // Build header
  const _cs=client.clientStatus||'active';
  let html=`<div class="checklist-header">
    <div>
      <h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${client.name}
        <span class="status-badge-wrap">
          <span class="quote-status ${_cs}" onclick="toggleStatusDropdown('${id}')" style="cursor:pointer;" title="Change status">${clientStatusLabel(_cs)}</span>
          <div class="status-dropdown" id="status-dd-${id}">
            <button onclick="closeStatusDropdown('${id}');setClientStatus('${id}','active')">Active</button>
            <button onclick="closeStatusDropdown('${id}');setClientStatus('${id}','on-hold')">On Hold</button>
            <button onclick="closeStatusDropdown('${id}');setClientStatus('${id}','blocked')">Blocked</button>
          </div>
        </span>
      </h2>
      <div class="meta">Tech: ${client.tech} &nbsp;·&nbsp; Created: ${new Date(client.createdAt).toLocaleDateString()}</div>
      ${client.syncroCustomerName?`<div class="meta" style="margin-top:1px;">Syncro: ${client.syncroCustomerName}</div>`:''}
    </div>
    <div class="header-actions">
      <button class="clear-updates-btn" id="clear-updates-btn" style="display:none" onclick="clearAllUpdateDots()">&#9679; Clear updates</button>
      <button class="quote-note-btn${client.notes?' has-note':''}" id="cnotes-btn-${id}" onclick="toggleHeaderNote('${id}','client')" title="Client notes">&#9998;</button>
      <div class="client-menu-wrap" id="cmenu-wrap-${id}">
        <button class="client-menu-btn" onclick="toggleClientMenu('${id}')">&#8230;</button>
        <div class="client-menu-dropdown" id="cmenu-${id}">
          <button class="client-menu-item" onclick="closeClientMenu('${id}');showSummary('${id}')">Summary</button>
          <button class="client-menu-item" onclick="closeClientMenu('${id}');showClientLog('${id}')">View Log</button>
          <button class="client-menu-item warn" onclick="closeClientMenu('${id}');openEditClientModal('${id}')">Edit</button>
          <button class="client-menu-item danger" onclick="closeClientMenu('${id}');confirmDeleteClient('${id}')">Delete</button>
        </div>
      </div>
    </div>
  </div>

  <div class="header-note-area${client.notes?' open':''}" id="cnotes-${id}">
    <textarea class="inline-notes-ta" placeholder="Add notes about this client..." onblur="saveInlineClientNotes('${id}',this.value)">${escHtml(client.notes||'')}</textarea>
  </div>

  ${(client.dueDate||dueBadge)?`<div class="due-date-row">
    ${client.dueDate?`<span>Due ${new Date(client.dueDate+'T12:00:00').toLocaleDateString()}</span>`:''}
    ${dueBadge}
  </div>`:''}

  <div class="tab-bar">
    <button class="tab-btn ${activeChecklistTab!=='devices'?'active':''}" id="tab-btn-org-${id}" data-notify-id="tab:org" onclick="switchChecklistTab('${id}','org')">Organization</button>
    <button class="tab-btn ${activeChecklistTab==='devices'?'active':''}" id="tab-btn-devices-${id}" data-notify-id="tab:devices" onclick="switchChecklistTab('${id}','devices')">Devices (${devDone}/${devList.length})</button>
  </div>

  <div class="progress-bar-wrap">
    <div class="progress-stats"><span>${prog.done} of ${prog.total} org steps complete</span><span>${pct}%</span></div>
    <div class="progress-bar"><div class="progress-bar-fill ${pct===100?'complete':''}" style="width:0" data-w="${pct}" data-bar-id="main"></div></div>
  </div>

  <!-- Org tab -->
  <div class="tab-panel ${activeChecklistTab!=='devices'?'active':''}" id="tab-org-${id}">
  <div class="handoff-thread${(client.comments?.length)?'':' collapsed'}" id="cthread-${id}">
    <div class="handoff-thread-header" onclick="this.closest('.handoff-thread').classList.toggle('collapsed')">
      <span>Team Handoff Notes</span>
      <button class="handoff-toggle" onclick="event.stopPropagation();this.closest('.handoff-thread').classList.toggle('collapsed')" title="Toggle">▼</button>
    </div>
    <div class="handoff-thread-body">
      ${(client.comments||[]).map(c=>`<div class="comment-item" id="hc-${id}-${c.id}">
        <div class="comment-body">
          <div class="comment-meta">${escHtml(c.tech)} · ${relTime(c.ts)}</div>
          <div class="comment-text" id="hct-${c.id}">${escHtml(c.text)}</div>
        </div>
        <div class="comment-actions">
          <button class="comment-action-btn" onclick="editHandoffComment('${id}','${c.id}')" title="Edit">✎</button>
          <button class="comment-action-btn del" onclick="deleteHandoffComment('${id}','${c.id}')" title="Delete">✕</button>
        </div>
      </div>`).join('')}
      <div class="comment-input-row">
        <input class="comment-input" id="comment-input-${id}" placeholder="Add a handoff note for the team..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addHandoffComment('${id}',this.value);this.value='';}">
        <button class="comment-send" onclick="const i=document.getElementById('comment-input-${id}');addHandoffComment('${id}',i.value);i.value='';">Add</button>
      </div>
    </div>
  </div>
  <div class="phase-grid">`;

  activePhases.forEach((p,i)=>{ html+=renderPhase(id,p,i+1); });
  html+=`</div>`;

  if(completedPhases.length){
    html+=`<div class="completed-section"><div class="completed-section-hdr">Completed</div><div class="phase-grid">`;
    completedPhases.forEach(p=>{ html+=renderPhase(id,p,'✓'); });
    html+=`</div></div>`;
  }
  html+=`</div>`;

  // Devices tab
  html+=`<div class="tab-panel ${activeChecklistTab==='devices'?'active':''}" id="tab-devices-${id}">`;
  html+=renderDeviceGuide(id);
  html+=`</div>`;

  document.getElementById('checklist-content').innerHTML=html;
  animateBars(document.getElementById('checklist-content'));
  showView('checklist');
  renderSidebar();
  // Post-render: inject installer blocks for any devices
  setTimeout(()=>{
    const client=clients[id];
    Object.values(client.devices||{}).forEach(dev=>{
      const containerId=`inst-${id}-${dev.id}`;
      const rawUrl=dev.rawInstallerUrl||(client.syncroInstallerMap?.[dev.type])||client.syncroInstallerUrl||null;
      if(document.getElementById(containerId)&&rawUrl){
        renderInstallerBlock(rawUrl,containerId,dev.shortUrl||null,(short)=>{
          clients[id].devices[dev.id].shortUrl=short;
          saveClients();
        });
      }
    });
  },50);
}

function switchChecklistTab(clientId,tab){
  activeChecklistTab=tab;
  ['org','devices'].forEach(t=>{
    document.getElementById(`tab-btn-${t}-${clientId}`)?.classList.toggle('active',t===tab);
    document.getElementById(`tab-${t}-${clientId}`)?.classList.toggle('active',t===tab);
  });
}

function ensureMyName(){
  if(!localStorage.getItem('myName')){
    const n=(prompt('Enter your name — used to identify your changes in shared checklists:')||'').trim();
    if(n) localStorage.setItem('myName',n);
  }
}
function editWhoWorking(){
  openNameModal();
}

function addMeToWorking(clientId){
  const storedName=localStorage.getItem('myName')||'';
  if(!storedName){openNameModal();return;}
  const name=storedName;
  sessionStorage.setItem('who-'+clientId,name);
  const input=document.getElementById('who-input-'+clientId);
  if(input){
    input.value=name;
    // Hide the add-me btn
    input.parentElement.querySelector('.add-me-btn')?.remove();
  }
}

function toggleClientNotes(clientId){
  document.getElementById(`client-notes-block-${clientId}`)?.classList.toggle('open');
}

async function saveClientNotes(clientId,val){
  clients[clientId].notes=val;
  await saveClients();
}

async function saveInlineClientNotes(clientId,val){
  if(!clients[clientId])return;
  clients[clientId].notes=val;
  clients[clientId].lastModified=new Date().toISOString();
  await saveClients();
  const btn=document.getElementById(`cnotes-btn-${clientId}`);
  if(btn)btn.classList.toggle('has-note',!!val);
}
function openClientNotes(clientId){
  const client=clients[clientId];
  const modal=document.getElementById('client-notes-modal');
  document.getElementById('client-notes-modal-title').textContent=(client.name||'Client')+' — Notes';
  document.getElementById('client-notes-ta').value=client.notes||'';
  modal.dataset.clientId=clientId;
  modal.style.display='flex';
}
function closeClientNotesModal(){
  document.getElementById('client-notes-modal').style.display='none';
}
async function saveClientNotesModal(){
  const modal=document.getElementById('client-notes-modal');
  const clientId=modal.dataset.clientId;
  const val=document.getElementById('client-notes-ta').value;
  await saveClientNotes(clientId,val);
  closeClientNotesModal();
  if(activeClientId===clientId){
    const ui=getChecklistUIState();
    loadClientChecklist(clientId);
    restoreChecklistUIState(clientId,ui);
  }
}
document.getElementById('client-notes-modal').addEventListener('click',e=>{
  if(e.target===e.currentTarget) closeClientNotesModal();
});

async function saveDueDate(clientId,val){
  const ui=getChecklistUIState();
  clients[clientId].dueDate=val||null;
  await saveClients();
  loadClientChecklist(clientId);
  restoreChecklistUIState(clientId,ui);
}

// \u2500\u2500\u2500 Edit products \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderEditProducts(clientId){
  const client=clients[clientId];
  return `<div class="edit-products-block" id="edit-products-block">
    <h4>Edit Products</h4>
    <div class="products-grid">${getProducts().map(p=>{
      const checked=client.products.includes(p.id);
      return `<label class="product-toggle ${checked?'selected':''}" id="ep-tog-${p.id}">
        <input type="checkbox" id="ep-${p.id}" ${checked?'checked':''} onchange="toggleEditProduct('${p.id}')">
        <div class="toggle-check"><svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><div class="product-label">${p.label}</div><div class="product-desc">${p.desc}</div></div>
      </label>`;
    }).join('')}</div>
    <div style="display:flex;gap:7px;justify-content:flex-end;">
      <button class="btn-secondary btn-sm" onclick="cancelEditProducts()">Cancel</button>
      <button class="btn-primary btn-sm" onclick="saveEditProducts('${clientId}')">Save Changes</button>
    </div>
  </div>`;
}
function toggleEditProduct(id){const c=document.getElementById(`ep-${id}`);document.getElementById(`ep-tog-${id}`).classList.toggle('selected',c.checked);}
async function saveEditProducts(clientId){
  const newProds=getProducts().filter(p=>document.getElementById(`ep-${p.id}`)?.checked).map(p=>p.id);
  if(!newProds.length){alert('Select at least one product.');return;}
  clients[clientId].products=newProds;
  await saveClients();loadClientChecklist(clientId);
}
function cancelEditProducts(){loadClientChecklist(activeClientId);}
function showEditProducts(clientId){
  if(document.getElementById('edit-products-block')){cancelEditProducts();return;}
  const header=document.querySelector('.checklist-header');
  if(header) header.insertAdjacentHTML('afterend',renderEditProducts(clientId));
}

// \u2500\u2500\u2500 Toggles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ─── Client ... menu ─────────────────────────────────────────────────────────
function toggleClientMenu(clientId){
  const menu=document.getElementById(`cmenu-${clientId}`);
  if(!menu) return;
  const isOpen=menu.classList.contains('open');
  // Close all menus first
  document.querySelectorAll('.client-menu-dropdown.open').forEach(m=>m.classList.remove('open'));
  if(!isOpen) menu.classList.add('open');
}
function closeClientMenu(clientId){
  document.getElementById(`cmenu-${clientId}`)?.classList.remove('open');
}
document.addEventListener('click',e=>{
  if(!e.target.closest('.client-menu-wrap')){
    document.querySelectorAll('.client-menu-dropdown.open').forEach(m=>m.classList.remove('open'));
  }
  if(!e.target.closest('.status-badge-wrap')){
    document.querySelectorAll('.status-dropdown.open').forEach(d=>d.classList.remove('open'));
  }
});

// ─── Edit client modal ────────────────────────────────────────────────────────
let editClientId=null;
let editClientDirty=false;
let editSyncroState=undefined; // undefined=unchanged, null=unlinked, object=new customer

function openEditClientModal(clientId){
  editClientId=clientId;
  editClientDirty=false;
  const client=clients[clientId];
  const body=document.getElementById('edit-client-body');
  const offset=appSettings.defaultDueOffset||90;

  // Build products checklist
  const prodHtml=getProducts().map(p=>`
    <label class="product-toggle ${client.products.includes(p.id)?'selected':''}" id="eptog-${p.id}">
      <input type="checkbox" id="epcheck-${p.id}" ${client.products.includes(p.id)?'checked':''}
        onchange="editClientMarkDirty();document.getElementById('eptog-${p.id}').classList.toggle('selected',this.checked)">
      <div class="toggle-check"><svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div><div class="product-label">${p.label}</div></div>
    </label>`).join('');

  body.innerHTML=`
    <div class="field-group"><label>Client Name</label>
      <input type="text" id="edit-name" value="${client.name.replace(/"/g,'&quot;')}" oninput="editClientMarkDirty()">
    </div>
    <div class="field-group"><label>Tech Assigned</label>
      <input type="text" id="edit-tech" value="${(client.tech||'').replace(/"/g,'&quot;')}" oninput="editClientMarkDirty()">
    </div>
    <div class="field-group"><label>Due Date</label>
      <input type="date" id="edit-duedate" value="${client.dueDate||''}" onchange="editClientMarkDirty()">
    </div>
    <div class="field-group"><label>Syncro Customer <span style="font-weight:400;color:var(--text3);">(optional)</span></label>
      <div id="edit-syncro-area"></div>
    </div>
    <div style="font-size:10px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.04em;margin:12px 0 6px;">Products</div>
    <div class="products-grid">${prodHtml}</div>`;

  editSyncroState=undefined;
  renderEditSyncroArea();
  document.getElementById('edit-client-modal').classList.add('show');
}

function renderEditSyncroArea(){
  const area=document.getElementById('edit-syncro-area');if(!area)return;
  const client=editClientId?clients[editClientId]:null;
  const name=editSyncroState===undefined?(client?.syncroCustomerName||null):(editSyncroState?.business_name||null);
  if(name){
    area.innerHTML=`<div class="syncro-linked-card">
      <span class="syncro-linked-name">&#128279; ${escHtml(name)}</span>
      <button class="btn-secondary btn-sm" onclick="openEditSyncroModal()">Change</button>
      <button class="btn-secondary btn-sm" onclick="editSyncroUnlink()">&#10005;</button>
    </div>`;
  }else{
    area.innerHTML=`<button class="btn-secondary" onclick="openEditSyncroModal()">&#128279; Link Syncro Customer</button>`;
  }
}
function openEditSyncroModal(){
  openSyncroLinkModal(customer=>{
    editSyncroState=customer;
    editClientMarkDirty();
    renderEditSyncroArea();
  });
}
function editSyncroUnlink(){editSyncroState=null;editClientMarkDirty();renderEditSyncroArea();}

function editClientMarkDirty(){editClientDirty=true;}

function closeEditClientModal(){
  if(editClientDirty){
    styledConfirm('Discard unsaved changes?',()=>{
      editClientDirty=false;editClientId=null;
      document.getElementById('edit-client-modal').classList.remove('show');
    });
    return;
  }
  editClientId=null;
  document.getElementById('edit-client-modal').classList.remove('show');
}

async function saveEditClient(){
  if(!editClientId) return;
  const client=clients[editClientId];
  client.name=document.getElementById('edit-name').value.trim()||client.name;
  client.tech=document.getElementById('edit-tech').value.trim()||'Unassigned';
  client.dueDate=document.getElementById('edit-duedate').value||null;
  client.products=getProducts().filter(p=>document.getElementById(`epcheck-${p.id}`)?.checked).map(p=>p.id);
  if(editSyncroState!==undefined){
    client.syncroCustomerName=editSyncroState?.business_name||null;
    client.syncroCustomerId=editSyncroState?.id||null;
    client.syncroInstallerMap=editSyncroState?._installerMap||null;
    if(editSyncroState) logAction('customer_linked',{details:editSyncroState.business_name});
    else logAction('customer_unlinked',{});
  }
  editSyncroState=undefined;
  editClientDirty=false;
  document.getElementById('edit-client-modal').classList.remove('show');
  logAction('checklist_edited',{clientId:editClientId});
  await saveClients();
  loadClientChecklist(editClientId);
  showToast('Checklist updated');
}

document.getElementById('edit-client-modal').addEventListener('click',e=>{
  if(e.target===e.currentTarget) closeEditClientModal();
});

function showSummary(clientId){
  const client=clients[clientId];
  const phases=buildPhases(client);
  const prog=overallProgress(client);
  const pct=prog.total?Math.round(prog.done/prog.total*100):0;
  const devSteps=buildDeviceSteps(client);
  const devList=Object.values(client.devices||{});
  const incomplete=phases.filter(p=>!isPhaseComplete(client,p));

  let body=`<div class="summary-section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div>
        <div style="font-size:13px;font-weight:600;">${escHtml(client.name)}</div>
        <div style="font-size:11px;color:var(--text3);">Tech: ${escHtml(client.tech)} · Created ${new Date(client.createdAt).toLocaleDateString()}</div>
        ${client.syncroCustomerName?`<div style="font-size:11px;color:var(--text3);">Syncro: ${escHtml(client.syncroCustomerName)}</div>`:''}
      </div>
      <div style="font-size:22px;font-weight:700;color:${pct===100?'var(--success)':'var(--accent)'};">${pct}%</div>
    </div>
    <div style="background:var(--bg3);border-radius:4px;height:6px;overflow:hidden;margin-bottom:4px;">
      <div style="background:${pct===100?'var(--success)':'var(--accent)'};width:${pct}%;height:100%;border-radius:4px;"></div>
    </div>
    <div style="font-size:10px;color:var(--text3);">${prog.done} of ${prog.total} steps complete</div>
  </div>`;

  if(client.dueDate){
    const diff=Math.ceil((new Date(client.dueDate+'T12:00:00')-new Date())/(864e5));
    const cls=diff<0?'var(--danger)':diff<=3?'var(--warn)':'var(--success)';
    const label=diff<0?`${Math.abs(diff)}d overdue`:diff===0?'Due today':`${diff}d remaining`;
    body+=`<div class="summary-section"><h4>Due Date</h4><div class="summary-row"><span>${new Date(client.dueDate+'T12:00:00').toLocaleDateString()}</span><span style="color:${cls};font-weight:600;">${label}</span></div></div>`;
  }

  body+=`<div class="summary-section"><h4>Progress by Phase</h4>
    ${phases.map(p=>{
      const pr=phaseProgress(client,p);
      const done=isPhaseComplete(client,p);
      return `<div class="summary-row"><span>${escHtml(p.title)}</span><span style="color:${done?'var(--success)':'var(--text2)'};">${done?'✓ Complete':`${pr.done}/${pr.total}`}</span></div>`;
    }).join('')}
  </div>`;

  if(devList.length){
    const stMap={'not-started':'⏳ Not Started','in-progress':'🔄 In Progress','complete':'✓ Complete'};
    const devDone=devList.filter(d=>devStatus(d,devSteps)==='complete').length;
    body+=`<div class="summary-section"><h4>Devices (${devDone}/${devList.length})</h4>
      ${devList.map(d=>{const st=devStatus(d,devSteps);return`<div class="summary-row"><span>${escHtml(d.name)} <span style="color:var(--text3);font-size:10px;">${d.type||''}</span></span><span style="color:${st==='complete'?'var(--success)':st==='in-progress'?'var(--warn)':'var(--text3)'};">${stMap[st]||st}</span></div>`;}).join('')}
    </div>`;
  }

  if(client.notes){
    body+=`<div class="summary-section"><h4>Notes</h4><p style="font-size:12px;color:var(--text2);line-height:1.5;white-space:pre-wrap;">${escHtml(client.notes)}</p></div>`;
  }

  document.getElementById('summary-title').textContent='Onboarding Summary';
  document.getElementById('summary-body').innerHTML=body;
  document.getElementById('summary-actions').innerHTML=`
    <button class="btn-secondary" onclick="document.getElementById('summary-modal').classList.remove('show')">Close</button>
    <button class="btn-primary" onclick="printSummary()">Print</button>`;
  document.getElementById('summary-modal').classList.add('show');
}

function printSummary(){
  const title=document.getElementById('summary-title').textContent;
  const content=document.getElementById('summary-body').innerHTML;
  const w=window.open('','_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:28px;font-size:13px;color:#1a1d23;}h3{font-size:18px;font-weight:700;margin-bottom:20px;padding-bottom:10px;border-bottom:2px solid #3b82f6;}h4{font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;margin:16px 0 6px;font-weight:700;}.summary-section{margin-bottom:12px;}.summary-row{display:flex;justify-content:space-between;border-bottom:1px solid #f3f4f6;padding:5px 0;font-size:12px;}p{font-size:12px;color:#374151;line-height:1.6;}@media print{body{padding:16px;}}</style></head><body><h3>${title}</h3>${content}</body></html>`);
  w.document.close();w.print();w.close();
}

function showQuoteSummary(quoteId){
  const q=salesQuotes[quoteId];if(!q)return;
  const t=calcQuoteTotals(q);
  const prods=getSalesProducts();
  const sections=[{key:'user',label:'User Products'},{key:'machine',label:'Machine Products'},{key:'site',label:'Site Products'}];
  let body=`<div class="summary-section">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;">
      <div>
        <div style="font-size:13px;font-weight:600;">${escHtml(q.name)}</div>
        ${q.contact?`<div style="font-size:11px;color:var(--text3);">Contact: ${escHtml(q.contact)}</div>`:''}
        <div style="font-size:11px;color:var(--text3);">Tech: ${escHtml(q.tech)} · Created ${relTime(q.createdAt)}</div>
      </div>
    </div>
  </div>
  <div class="summary-section"><h4>Totals</h4>
    <div class="summary-row"><span>Monthly</span><span style="font-weight:600;color:var(--success);">$${t.monthlyClient.toFixed(2)}</span></div>
    <div class="summary-row"><span>One-Time</span><span style="font-weight:600;">$${t.onetimeClient.toFixed(2)}</span></div>
    <div class="summary-row"><span>SA Cost (monthly)</span><span style="color:var(--text3);">$${t.monthlySA.toFixed(2)}</span></div>
    <div class="summary-row" style="font-weight:600;"><span>Monthly Profit</span><span class="${t.profit>=0?'profit-pos':'profit-neg'}">$${t.profit.toFixed(2)}</span></div>
  </div>`;
  sections.forEach(sec=>{
    const enabled=prods.filter(p=>p.salesCategory===sec.key&&q.lineItems?.[p.id]?.enabled);
    const custom=(q.customItems||[]).filter(c=>c.category===sec.key&&c.enabled!==false&&c.qty>0);
    if(!enabled.length&&!custom.length)return;
    body+=`<div class="summary-section"><h4>${sec.label}</h4>`;
    enabled.forEach(p=>{const li=q.lineItems[p.id];body+=`<div class="summary-row"><span>${escHtml(p.label)}</span><span>${li.qty} × $${li.unitPrice.toFixed(2)} <span style="color:var(--text3);font-size:10px;">${p.billing==='onetime'?'OT':'mo'}</span></span></div>`;});
    custom.forEach(c=>{body+=`<div class="summary-row"><span>${escHtml(c.label||'Custom item')}</span><span>${c.qty} × $${c.unitPrice.toFixed(2)} <span style="color:var(--text3);font-size:10px;">${c.billing==='onetime'?'OT':'mo'}</span></span></div>`;});
    body+=`</div>`;
  });
  if(q.notes)body+=`<div class="summary-section"><h4>Notes</h4><p style="font-size:12px;color:var(--text2);line-height:1.5;white-space:pre-wrap;">${escHtml(q.notes)}</p></div>`;
  document.getElementById('summary-title').textContent=`Quote — ${q.name}`;
  document.getElementById('summary-body').innerHTML=body;
  const convertBtn=q.status==='accepted'?`<button class="btn-secondary" onclick="document.getElementById('summary-modal').classList.remove('show');convertQuoteToChecklist('${quoteId}')">&#128203; Create Onboarding</button>`:'';
  document.getElementById('summary-actions').innerHTML=`
    <button class="btn-secondary" onclick="document.getElementById('summary-modal').classList.remove('show')">Close</button>
    ${convertBtn}
    <button class="btn-secondary" onclick="document.getElementById('summary-modal').classList.remove('show');printQuoteCustomer('${quoteId}')">Print (Customer)</button>
    <button class="btn-primary" onclick="document.getElementById('summary-modal').classList.remove('show');printQuote('${quoteId}')">Print (Internal)</button>`;
  document.getElementById('summary-modal').classList.add('show');
}

function convertQuoteToChecklist(quoteId){
  const q=salesQuotes[quoteId];if(!q)return;
  // Pre-fill the new client wizard fields with quote data
  switchSection('onboarding');
  showView('new-client');
  setTimeout(()=>{
    const nameEl=document.getElementById('wiz-clientname');
    const techEl=document.getElementById('wiz-tech');
    if(nameEl) nameEl.value=q.name||'';
    if(techEl) techEl.value=q.tech||localStorage.getItem('myName')||'';
    // Pre-select products that were enabled in the quote
    const enabledIds=new Set(getSalesProducts().filter(p=>q.lineItems?.[p.id]?.enabled).map(p=>p.id));
    document.querySelectorAll('[id^="pcheck-"]').forEach(cb=>{
      const pid=cb.id.replace('pcheck-','');
      if(enabledIds.has(pid)) cb.checked=true;
    });
    showToast('Pre-filled from quote "'+q.name+'" — review and create','info');
  },150);
}

document.getElementById('summary-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.classList.remove('show');});

function toggleStepNote(stepId){
  document.getElementById(`step-${stepId}`)?.classList.toggle('note-open');
}

async function saveStepNote(clientId,stepId,val){
  if(!clients[clientId].stepNotes) clients[clientId].stepNotes={};
  const prev=clients[clientId].stepNotes[stepId]||'';
  if(val===prev) return; // no change
  clients[clientId].stepNotes[stepId]=val;
  const btn=document.querySelector(`#step-${stepId} .step-note-btn`);
  if(btn) btn.classList.toggle('has-note',!!val);
  const def=findStepById(stepId);
  logAction('notes_updated',{stepTitle:def?.title||stepId,details:val?'Note added':'Note cleared',clientId});
  await saveClients();
}

function togglePhase(id){document.getElementById(`phase-${id}`)?.classList.toggle('collapsed');}
function toggleStepExpand(id){document.getElementById(`step-${id}`)?.classList.toggle('expanded');}
function toggleFreetext(id){document.getElementById(id)?.classList.toggle('open');}
async function toggleStep(cid,sid){
  const ui=getChecklistUIState();
  const _op=overallProgress(clients[cid]);const _oPct=_op.total?Math.round(_op.done/_op.total*100):0;
  pendingBarWidths={...captureBarWidths(),main:_oPct+'%'};
  const done=!clients[cid].steps[sid];
  clients[cid].steps[sid]=done;
  const myName=localStorage.getItem('myName')||'';
  if(!clients[cid].stepCompletedBy)clients[cid].stepCompletedBy={};
  if(done) clients[cid].stepCompletedBy[sid]=myName;
  else delete clients[cid].stepCompletedBy[sid];
  const def=findStepById(sid);
  logAction(done?'step_complete':'step_incomplete',{stepTitle:def?.title||sid,phase:findStepPhase(sid)});
  await saveClients();loadClientChecklist(cid);restoreChecklistUIState(cid,ui);
}
async function toggleSubstep(cid,pid,sid){
  const ui=getChecklistUIState();ui.steps[`step-${pid}`]={expanded:true,noteOpen:false};
  const _op2=overallProgress(clients[cid]);const _oPct2=_op2.total?Math.round(_op2.done/_op2.total*100):0;
  pendingBarWidths={...captureBarWidths(),main:_oPct2+'%'};
  const done=!clients[cid].steps[sid];
  clients[cid].steps[sid]=done;
  const def=findStepById(sid);
  logAction(done?'substep_complete':'substep_incomplete',{stepTitle:def?.title||sid,phase:findStepPhase(sid)});
  await saveClients();loadClientChecklist(cid);restoreChecklistUIState(cid,ui);
}
async function toggleDeviceStep(cid,did,sid){
  const c=clients[cid];if(!c.devices||!c.devices[did])return;
  if(!c.devices[did].steps)c.devices[did].steps={};
  const done=!c.devices[did].steps[sid];
  c.devices[did].steps[sid]=done;
  c.devices[did].expanded=true;
  const def=findDevStepById(sid);
  logAction(done?'device_step_complete':'device_step_incomplete',{stepTitle:def?.title||sid,details:c.devices[did].name||did});
  await saveClients();
  refreshDeviceGuide(cid);
}
async function toggleDeviceSkip(cid,did,sid){
  const c=clients[cid];if(!c.devices||!c.devices[did])return;
  if(!c.devices[did].skipped)c.devices[did].skipped={};
  const nowSkipping=!c.devices[did].skipped[sid];
  if(nowSkipping){
    c.devices[did].skipped[sid]=true;
    if(c.devices[did].steps)delete c.devices[did].steps[sid];
  }else{
    delete c.devices[did].skipped[sid];
  }
  c.devices[did].expanded=true;
  await saveClients();
  refreshDeviceGuide(cid);
}
function devExpKey(cid,did){return`devexp-${cid}-${did}`;}
function isDevExpanded(cid,did){
  const s=sessionStorage.getItem(devExpKey(cid,did));
  if(s!==null) return s==='1';
  return !!(clients[cid]?.devices?.[did]?.expanded); // initial state from data
}
function setDevExpanded(cid,did,val){sessionStorage.setItem(devExpKey(cid,did),val?'1':'0');}

function toggleDeviceEntry(cid,did){
  // Session-local: don't save to server, don't broadcast
  const c=clients[cid];if(!c.devices||!c.devices[did])return;
  setDevExpanded(cid,did,!isDevExpanded(cid,did));
  refreshDeviceGuide(cid);
}
function refreshDeviceGuide(clientId){
  const client=clients[clientId];
  const devSteps=buildDeviceSteps(client);
  const devList=Object.values(client.devices||{});
  const doneCount=devList.filter(d=>devStatus(d,devSteps)==='complete').length;
  const tabBtn=document.getElementById(`tab-btn-devices-${clientId}`);
  if(tabBtn) tabBtn.textContent=`Devices (${doneCount}/${devList.length})`;
  const guideEl=document.getElementById('device-guide-container');
  if(!guideEl) return;
  const progText=document.getElementById('device-guide-progress');
  if(progText) progText.textContent=`${doneCount}/${devList.length} complete`;
  const body=document.getElementById('device-guide-body');
  if(!body) return;
  const buildStepRow=(dev,s)=>{
    const done=!!(dev.steps&&dev.steps[s.id]);
    const skipped=!!(dev.skipped&&dev.skipped[s.id]);
    const gb=s.vpn_selector?`<div class="vpn-selector">${VPN_OPTIONS.map(v=>`<button class="vpn-btn" onclick="event.stopPropagation();openGuide('${v.id}')">${v.label} VPN Guide &#x2197;</button>`).join('')}</div>`:'';
    const installerHtml=s.installer_url?renderInstEntry(clientId,dev):'';
    const checkMark=done?chk():skipped?`<span style="font-size:9px;color:var(--text3);">N/A</span>`:'';
    return `<div class="device-step-item ${done?'done':skipped?'skipped':''}" onclick="${skipped?`toggleDeviceSkip('${clientId}','${dev.id}','${s.id}')`:`toggleDeviceStep('${clientId}','${dev.id}','${s.id}')`}" id="dvs-${dev.id}-${s.id}" data-notify-id="dvst:${dev.id}:${s.id}">
      <div class="device-step-check">${checkMark}</div>
      <div style="flex:1;min-width:0;">
        <div class="device-step-title">${s.title}</div>
        ${s.detail?`<div class="device-step-detail">${s.detail}</div>`:''}
        ${installerHtml}${gb}
      </div>
      ${!done?`<button class="dev-skip-btn${skipped?' active':''}" onclick="event.stopPropagation();toggleDeviceSkip('${clientId}','${dev.id}','${s.id}')" title="${skipped?'Restore step':'Mark N/A'}">${skipped?'Restore':'N/A'}</button>`:''}
    </div>`;
  };
  const rows=devList.map(dev=>{
    const status=devStatus(dev,devSteps);
    const lmap={'not-started':'Not Started','in-progress':'In Progress','complete':'Complete'};
    const stepsHtml=devSteps.map(s=>buildStepRow(dev,s)).join('');
    return `<div class="device-entry ${isDevExpanded(clientId,dev.id)?'expanded':''}" id="dev-${dev.id}" data-notify-id="dva:${dev.id}">
      <div class="device-entry-header" onclick="toggleDeviceEntry('${clientId}','${dev.id}')">
        <span class="device-entry-name">${dev.name}</span>
        <span class="device-entry-meta">${dev.type||''}</span>
        <span class="dev-status ${status}">${lmap[status]}</span>
        <span class="device-entry-del" onclick="event.stopPropagation();deleteDevice('${clientId}','${dev.id}')" title="Remove">&#10005;</span>
      </div>
      <div class="device-entry-body">
        <div class="device-info-grid">
          <div class="device-info-item"><strong>Hostname</strong>${dev.name}</div>
          <div class="device-info-item"><strong>Type</strong>${dev.type||'—'}</div>
          <div class="device-info-item"><strong>User(s)</strong>${dev.users||'—'}</div>
          <div class="device-info-item"><strong>OS</strong>${dev.os||'—'}</div>
        </div>
        <div class="device-steps">${stepsHtml}</div>
        <div class="device-notes-label">Notes</div>
        <textarea class="device-notes" placeholder="Device-specific notes, issues, config details..."
          onblur="saveDeviceNotes('${clientId}','${dev.id}',this.value)">${dev.notes||''}</textarea>
      </div>
    </div>`;
  }).join('');
  body.innerHTML=devList.length===0
    ?`<div style="padding:10px 3px;font-size:11px;color:var(--text3);">No devices added yet. Click + Add Device to begin tracking deployment.</div>`
    :`<div class="device-grid">${rows}</div>`;

  // Inject installer blocks per device
  devList.forEach(dev=>{
    const containerId=`inst-${clientId}-${dev.id}`;
    const rawUrl=dev.rawInstallerUrl||(client.syncroInstallerMap?.(dev.type))||client.syncroInstallerUrl||null;
    if(document.getElementById(containerId)&&rawUrl){
      renderInstallerBlock(rawUrl,containerId,dev.shortUrl||null,(short)=>{
        clients[clientId].devices[dev.id].shortUrl=short;
        saveClients();
      });
    }
  });
}

async function saveFreetext(cid,ftId,val){if(!clients[cid].freetexts)clients[cid].freetexts={};clients[cid].freetexts[ftId]=val;await saveClients();}
async function saveDeviceNotes(cid,did,val){
  if(clients[cid].devices&&clients[cid].devices[did]){
    clients[cid].devices[did].notes=val;
    logAction('notes_updated',{details:`Device: ${clients[cid].devices[did].name||did}`});
  }
  await saveClients();
}
async function deleteDevice(cid,did){
  const devName=clients[cid]?.devices?.[did]?.name||did;
  styledConfirm('Remove this device record?',async()=>{
    if(clients[cid].devices)delete clients[cid].devices[did];
    logAction('device_removed',{details:devName});
    await saveClients();refreshDeviceGuide(cid);
  });
}
function clientStatusLabel(s){return s==='blocked'?'Blocked':s==='on-hold'?'On Hold':'Active';}
function toggleStatusDropdown(id){
  const dd=document.getElementById(`status-dd-${id}`);
  const isOpen=dd?.classList.contains('open');
  document.querySelectorAll('.status-dropdown.open').forEach(d=>d.classList.remove('open'));
  if(!isOpen)dd?.classList.add('open');
}
function closeStatusDropdown(id){document.getElementById(`status-dd-${id}`)?.classList.remove('open');}
function toggleHeaderNote(id,type){
  const prefix=type==='client'?'c':'q';
  const wrap=document.getElementById(`${prefix}notes-${id}`);
  const btn=document.getElementById(`${prefix}notes-btn-${id}`);
  if(!wrap)return;
  wrap.classList.toggle('open');
  btn?.classList.toggle('has-note',btn.classList.contains('has-note')||wrap.classList.contains('open'));
  if(wrap.classList.contains('open'))wrap.querySelector('textarea')?.focus();
}
async function toggleClientPriority(id){
  if(!clients[id])return;
  clients[id].priority=!clients[id].priority;
  clients[id].lastModified=new Date().toISOString();
  await saveClients();
  renderSidebar();
  if(activeClientId===id) loadClientChecklist(id);
}
async function setClientStatus(id,status){
  if(!clients[id])return;
  clients[id].clientStatus=status;
  clients[id].lastModified=new Date().toISOString();
  await saveClients();
  renderSidebar();
  loadClientChecklist(id);
}
async function addHandoffComment(id,text){
  if(!clients[id]||!text.trim())return;
  if(!clients[id].comments)clients[id].comments=[];
  const myName=localStorage.getItem('myName')||'Unknown';
  clients[id].comments.unshift({id:Date.now()+'-'+Math.random().toString(36).slice(2,5),tech:myName,ts:new Date().toISOString(),text:text.trim()});
  clients[id].lastModified=new Date().toISOString();
  await saveClients();
  loadClientChecklist(id);
}
function editHandoffComment(clientId,commentId){
  const textEl=document.getElementById('hct-'+commentId);
  if(!textEl)return;
  const comment=(clients[clientId]?.comments||[]).find(c=>c.id===commentId);
  if(!comment)return;
  textEl.innerHTML=`<textarea class="comment-edit-input" id="hce-${commentId}">${escHtml(comment.text)}</textarea><div style="display:flex;gap:4px;margin-top:4px;"><button class="comment-send" onclick="saveHandoffEdit('${clientId}','${commentId}')">Save</button><button class="comment-cancel-btn" onclick="loadClientChecklist('${clientId}')">Cancel</button></div>`;
  const ta=document.getElementById('hce-'+commentId);
  if(ta){ta.focus();ta.selectionStart=ta.selectionEnd=ta.value.length;}
}
async function saveHandoffEdit(clientId,commentId){
  const ta=document.getElementById('hce-'+commentId);
  if(!ta||!ta.value.trim())return;
  const comment=(clients[clientId]?.comments||[]).find(c=>c.id===commentId);
  if(!comment)return;
  comment.text=ta.value.trim();
  clients[clientId].lastModified=new Date().toISOString();
  await saveClients();
  loadClientChecklist(clientId);
}
async function deleteHandoffComment(clientId,commentId){
  if(!clients[clientId])return;
  styledConfirm('Delete this handoff note?',async()=>{
    clients[clientId].comments=(clients[clientId].comments||[]).filter(c=>c.id!==commentId);
    clients[clientId].lastModified=new Date().toISOString();
    await saveClients();
    loadClientChecklist(clientId);
  });
}
async function confirmDeleteClient(id){
  styledConfirm(`Delete checklist for "${clients[id]?.name}"? This cannot be undone.`,async()=>{
    logAction('checklist_deleted',{clientId:id,clientName:clients[id]?.name});
    delete clients[id];await saveClients();activeClientId=null;
    // mobile-title removed
    renderSidebar();showView('empty');
  });
}

// Add device modal
function showAddDeviceModal(cid){
  addDeviceTargetClient=cid;
  ['modal-hostname','modal-users','modal-os'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('modal-devtype').value='Workstation';
  document.getElementById('add-device-modal').classList.add('show');
  setTimeout(()=>document.getElementById('modal-hostname').focus(),100);
}
function closeAddDeviceModal(){document.getElementById('add-device-modal').classList.remove('show');}
function onModalDevTypeChange(){
  const type=document.getElementById('modal-devtype').value;
  const cid=addDeviceTargetClient;
  const map=(cid&&clients[cid]?.syncroInstallerMap)||{};
  const hasUrl=type!=='Other'&&!!map[type];
  const wrap=document.getElementById('modal-manual-url-wrap');
  const lbl=document.getElementById('modal-manual-url-label');
  if(wrap) wrap.style.display=hasUrl?'none':'block';
  if(lbl) lbl.textContent=type==='Other'?'RMM Installer URL':`RMM URL — not in Syncro for ${type}, enter manually`;
  document.getElementById('modal-manual-url').value='';
  document.getElementById('modal-short-url').style.display='none';
  modalShortUrl=null;
}

let modalShortUrl=null;
async function shortenModalUrl(){
  const raw=document.getElementById('modal-manual-url').value.trim();
  if(!raw){showToast('Enter a URL first','error');return;}
  const btn=event.target;btn.textContent='...';
  try{
    const r=await fetch(`/api/shorten?url=${encodeURIComponent(raw)}`);
    const d=await r.json();
    if(!d.short) throw new Error(d.error||'Shortening failed');
    modalShortUrl=d.short;
    const el=document.getElementById('modal-short-url');
    if(el){el.textContent=d.short;el.style.display='block';}
    btn.textContent='Shorten';showToast('Shortened');
  }catch(e){btn.textContent='Shorten';showToast('Failed','error');}
}

async function confirmAddDevice(){
  const name=document.getElementById('modal-hostname').value.trim();
  if(!name){document.getElementById('modal-hostname').focus();return;}
  const cid=addDeviceTargetClient;
  const c=clients[cid];
  if(!c.devices)c.devices={};
  const did='dev-'+Date.now();
  const type=document.getElementById('modal-devtype').value;
  const map=c.syncroInstallerMap||{};
  let rawUrl=map[type]||c.syncroInstallerUrl||null;
  let shortUrl=null;
  if(type==='Other'||!rawUrl){
    rawUrl=document.getElementById('modal-manual-url')?.value.trim()||null;
    shortUrl=modalShortUrl||null;
  }
  c.devices[did]={id:did,name,type,
    users:document.getElementById('modal-users').value.trim(),
    os:document.getElementById('modal-os').value.trim(),
    steps:{},notes:'',expanded:true,
    rawInstallerUrl:rawUrl,shortUrl:shortUrl};
  modalShortUrl=null;
  logAction('device_added',{details:`${name} (${type})`});
  await saveClients();closeAddDeviceModal();refreshDeviceGuide(cid);
}
document.getElementById('add-device-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeAddDeviceModal();});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  // Close modals in z-index order (highest first)
  if(document.getElementById('confirm-overlay')?.classList.contains('show')){document.getElementById('confirm-overlay').classList.remove('show');return;}
  if(document.getElementById('editor-modal')?.classList.contains('show')){closeEditorModal();return;}
  if(document.getElementById('products-modal')?.classList.contains('show')){closeProductsModal();return;}
  if(document.getElementById('global-log-modal')?.classList.contains('show')){closeGlobalLogModal();return;}
  if(document.getElementById('editor-preview-modal')?.classList.contains('show')){document.getElementById('editor-preview-modal').classList.remove('show');return;}
  if(document.getElementById('qr-modal')?.classList.contains('show')){closeQrModal();return;}
  if(document.getElementById('log-modal')?.style.display==='flex'){closeLogModal();return;}
  if(document.getElementById('edit-client-modal')?.classList.contains('show')){closeEditClientModal();return;}
  if(document.getElementById('edit-quote-modal')?.style.display==='flex'){closeEditQuoteModal();return;}
  if(document.getElementById('syncro-link-modal')?.classList.contains('show')){closeSyncroLinkModal();return;}
  closeGuide();
  closeAddDeviceModal();
});

// \u2500\u2500\u2500 API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ─── SSE live sync ────────────────────────────────────────────────────────────
let pendingBarWidths=null;
function captureBarWidths(){
  const m={};
  document.querySelectorAll('[data-bar-id]').forEach(el=>{m[el.dataset.barId]=el.style.width;});
  return m;
}
function animateBars(container, fromWidths){
  // Explicit fromWidths → use it, leave pendingBarWidths alone
  // No argument → consume pendingBarWidths
  let from;
  if(fromWidths!==undefined){from=fromWidths;}
  else{from=pendingBarWidths||{};pendingBarWidths=null;}
  const els=(container||document).querySelectorAll('[data-w]');
  if(from&&Object.keys(from).length){
    els.forEach(el=>{
      if(el.dataset.barId){
        const prev=from[el.dataset.barId];
        if(prev&&prev!=='0%'&&prev!==''){
          el.style.transition='none';
          el.style.width=prev;
          void el.offsetWidth;
          el.style.transition='';
        }
      }
    });
  }
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    els.forEach(el=>{el.style.width=el.dataset.w+'%';});
  }));
}

function getChecklistUIState(){
  const state={phases:{},steps:{},tab:activeChecklistTab,scrollTop:0};
  const pane=document.getElementById('checklist-pane');
  if(pane) state.scrollTop=pane.scrollTop;
  document.querySelectorAll('[id^="phase-"]').forEach(el=>{
    state.phases[el.id]=el.classList.contains('collapsed');
  });
  document.querySelectorAll('[id^="step-"]').forEach(el=>{
    state.steps[el.id]={expanded:el.classList.contains('expanded'),noteOpen:el.classList.contains('note-open')};
  });
  return state;
}

function restoreChecklistUIState(clientId,state){
  if(state.tab!=='org') switchChecklistTab(clientId,state.tab);
  Object.entries(state.phases).forEach(([id,collapsed])=>{
    const el=document.getElementById(id);
    if(el) el.classList.toggle('collapsed',collapsed);
  });
  Object.entries(state.steps).forEach(([id,s])=>{
    const el=document.getElementById(id);
    if(el){el.classList.toggle('expanded',s.expanded);el.classList.toggle('note-open',s.noteOpen);}
  });
  renderAllDots();
  const pane=document.getElementById('checklist-pane');
  if(pane&&state.scrollTop) pane.scrollTop=state.scrollTop;
}

function findStepPhase(id){
  if(!stepsData.phases) return null;
  for(const p of stepsData.phases){
    for(const s of p.steps){
      if(s.id===id) return p.title;
      if(s.substeps) for(const sub of s.substeps){if(sub.id===id) return p.title;}
    }
  }
  return 'Device';
}

function findStepPhaseId(id){
  if(!stepsData.phases) return null;
  for(const p of stepsData.phases){
    for(const s of p.steps){
      if(s.id===id) return p.id;
      if(s.substeps) for(const sub of s.substeps){if(sub.id===id) return p.id;}
    }
  }
  return null;
}

// ── Unified notification system ─────────────────────────────────────────────
function notifyIdsForChange(change,clientId){
  const ids=[];
  if(change.devId||change.deviceAction){
    if(change.stepId) ids.push('dvst:'+change.devId+':'+change.stepId);
    if(change.devId) ids.push('dva:'+change.devId);
    ids.push('tab:devices');
  } else if(change.id){
    ids.push('st:'+change.id);
    const phId=change.phaseId||findStepPhaseId(change.id);
    if(phId) ids.push('ph:'+phId);
    ids.push('tab:org');
  }
  if(clientId) ids.push('cl:'+clientId);
  return ids;
}
function addToNotifyStore(changes,clientId,techName){
  const meta={techName:techName||'',ts:Date.now()};
  changes.forEach(c=>{notifyIdsForChange(c,clientId).forEach(nid=>notifyStore.set(nid,meta));});
}
function pruneTabNotifications(){
  const hasOrg=[...notifyStore.keys()].some(k=>k.startsWith('st:')||k.startsWith('ph:'));
  const hasDev=[...notifyStore.keys()].some(k=>k.startsWith('dvst:')||k.startsWith('dva:'));
  if(!hasOrg) notifyStore.delete('tab:org');
  if(!hasDev) notifyStore.delete('tab:devices');
}
function renderAllDots(){
  document.querySelectorAll('.notify-dot').forEach(d=>d.remove());
  const clearBtn=document.getElementById('clear-updates-btn');
  if(notifyStore.size===0){clearBtn?.style.setProperty('display','none');return;}
  let dotCount=0;
  document.querySelectorAll('[data-notify-id]').forEach(el=>{
    const nid=el.dataset.notifyId;
    const direct=notifyStore.has(nid);
    const inherited=!direct&&[...el.querySelectorAll('[data-notify-id]')].some(d=>notifyStore.has(d.dataset.notifyId));
    if(!direct&&!inherited) return;
    dotCount++;
    const meta=direct?notifyStore.get(nid):[...el.querySelectorAll('[data-notify-id]')].map(d=>notifyStore.get(d.dataset.notifyId)).find(Boolean);
    const dot=document.createElement('span');
    dot.className='notify-dot';
    if(meta?.techName) dot.title='Changed by '+meta.techName;
    const slotSel=el.dataset.notifySlot;
    if(slotSel){
      const slotEl=el.querySelector(slotSel);
      if(slotEl) slotEl.appendChild(dot);
      else el.appendChild(dot);
    } else {
      const anchor=el.querySelector('.step-title,.device-step-title,.substep-title,.phase-progress-text,.device-entry-name,.cn');
      if(anchor) anchor.after(dot); else el.appendChild(dot);
    }
    el.addEventListener('mouseenter',()=>{
      if(direct) notifyStore.delete(nid);
      el.querySelectorAll('[data-notify-id]').forEach(d=>notifyStore.delete(d.dataset.notifyId));
      dot.style.opacity='0';dot.style.animation='none';
      pruneTabNotifications();
      setTimeout(()=>{dot.remove();renderAllDots();},380);
    },{once:true});
  });
  clearBtn?.style[dotCount?'removeProperty':'setProperty']('display','none');
}

function findStepById(id){
  if(!stepsData.phases) return null;
  for(const p of stepsData.phases){
    for(const s of p.steps){
      if(s.id===id) return s;
      if(s.substeps) for(const sub of s.substeps){if(sub.id===id) return sub;}
    }
  }
  return null;
}
function findDevStepById(id){
  return (stepsData.device_steps||[]).find(s=>s.id===id)||null;
}

function detectChangedSteps(oldClient,newClient){
  const changed=[];
  const allIds=new Set([...Object.keys(oldClient.steps||{}),...Object.keys(newClient.steps||{})]);
  allIds.forEach(id=>{
    if((oldClient.steps||{})[id]!==(newClient.steps||{})[id]){
      const def=findStepById(id);
      changed.push({id,done:!!(newClient.steps||{})[id],title:def?.title||'',phase:findStepPhase(id),phaseId:findStepPhaseId(id)});
    }
  });
  // Device additions / removals
  const oldDevIds=new Set(Object.keys(oldClient.devices||{}));
  const newDevIds=new Set(Object.keys(newClient.devices||{}));
  newDevIds.forEach(did=>{
    if(!oldDevIds.has(did)){
      const dev=newClient.devices[did];
      changed.push({id:'dev-added-'+did,devId:did,done:true,title:`Device added: ${dev.name||did}`,phase:'Devices',deviceAction:true});
    }
  });
  oldDevIds.forEach(did=>{
    if(!newDevIds.has(did)){
      const dev=oldClient.devices[did];
      changed.push({id:'dev-removed-'+did,devId:did,done:false,title:`Device removed: ${dev.name||did}`,phase:'Devices',deviceAction:true});
    }
  });
  // Device step toggles + notes changes
  Object.values(newClient.devices||{}).forEach(dev=>{
    const oldDev=(oldClient.devices||{})[dev.id];
    if(!oldDev) return;
    Object.keys(dev.steps||{}).forEach(sid=>{
      if((oldDev.steps||{})[sid]!==(dev.steps||{})[sid]){
        const def=findDevStepById(sid);
        changed.push({id:'dev-'+dev.id+'-'+sid,devId:dev.id,stepId:sid,done:!!(dev.steps||{})[sid],title:def?.title||sid,deviceName:dev.name||dev.id,phase:'Devices'});
      }
    });
    if((oldDev.notes||'')!==(dev.notes||'')){
      changed.push({id:'dev-notes-'+dev.id,devId:dev.id,done:true,title:`Notes updated: ${dev.name||dev.id}`,phase:'Devices',deviceAction:true});
    }
  });
  return changed;
}

function pulseSteps(changes,techName){
  // Populate notify store for active client
  if(activeClientId&&changes.length) addToNotifyStore(changes,activeClientId,techName);
  const pulsedPhases=new Set();
  changes.forEach(({id,done})=>{
    const el=document.getElementById('step-'+id)||document.querySelector('[id$="-'+id+'"]');
    if(el){
      const titleEl=el.querySelector('.step-title,.device-step-title,.substep-title');
      el.classList.remove('sse-pulse');void el.offsetWidth;el.classList.add('sse-pulse');
      if(techName&&titleEl){
        titleEl.querySelector('.sse-attr')?.remove();
        const chip=document.createElement('span');chip.className='sse-attr';
        chip.textContent=(done?'✓ ':'✕ ')+techName;
        titleEl.appendChild(chip);setTimeout(()=>chip.remove(),4200);
      }
      const phase=el.closest('.phase-block');
      if(phase&&!pulsedPhases.has(phase.id)){
        pulsedPhases.add(phase.id);
        const hdr=phase.querySelector('.phase-header');
        if(hdr){hdr.classList.remove('sse-pulse');void hdr.offsetWidth;hdr.classList.add('sse-pulse');}
      }
    } else {
      const sidebarItem=document.querySelector('#client-list .client-item.active');
      if(sidebarItem){sidebarItem.classList.remove('sse-pulse');void sidebarItem.offsetWidth;sidebarItem.classList.add('sse-pulse');}
    }
  });
  renderAllDots();
}


function connectSSE(){
  if(sseSource) sseSource.close();
  sseSource=new EventSource('/api/events');
  sseSource.addEventListener('clients-updated',e=>{
    const payload=JSON.parse(e.data);
    if(payload.sessionId===SESSION_ID) return;
    const updated=payload.clients||payload;
    const techName=payload.techName||'';
    // Find what changed on the active client (for pulse)
    const changedSteps=activeClientId&&updated[activeClientId]?
      detectChangedSteps(clients[activeClientId],updated[activeClientId]):[];
    // Compute active client's old pct from DATA before updating (for bar animation)
    const oldMainPct=activeClientId&&clients[activeClientId]?(()=>{
      const p=overallProgress(clients[activeClientId]);
      return p.total?Math.round(p.done/p.total*100):0;
    })():null;
    // Process ALL changed clients — dots, badges, toasts
    Object.keys(updated).forEach(cid=>{
      const oldC=clients[cid],newC=updated[cid];
      if(!oldC||!newC||oldC.lastModified===newC.lastModified) return;
      const cidChanges=detectChangedSteps(oldC,newC);
      if(!cidChanges.length) return; // expanded/collapsed only — skip
      // Track pending dots for this client
      const pcExisting=pendingClientChanges.get(cid)||{changes:[],techName};
      pcExisting.changes.push(...cidChanges.map(c=>({...c,techName})));
      pcExisting.techName=techName;
      pendingClientChanges.set(cid,pcExisting);
      // Unseen sidebar badge (non-active clients only)
      if(cid!==activeClientId){
        const prev=unseenChanges.get(cid)||{count:0};
        unseenChanges.set(cid,{count:prev.count+1,techName});
      }
      // Toast for all changed clients
      const who=techName||'A tech';
      const phases=[...new Set(cidChanges.map(c=>c.phase).filter(Boolean))];
      const deviceNames=[...new Set(cidChanges.map(c=>c.deviceName).filter(Boolean))];
      const sectionLabel=deviceNames.length===1?deviceNames[0]:(phases.length===1?phases[0]:phases.length>1?phases.join(' · '):'Updated');
      const toastTitle=`${newC.name} · ${sectionLabel} — Updated`;
      // Use per-device key so different devices get separate toasts
      const toastKey=deviceNames.length===1?`${cid}_${deviceNames[0]}`:`${cid}_toast`;
      const bodyLines=cidChanges.map(({title,done})=>`${done?'✓':'○'} ${title||'a step'}`);
      const now=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      const footer=`by ${who} · ${now}`;
      const existingToast=unseenToastTimers.get(toastKey);
      if(existingToast&&existingToast.isConnected&&!existingToast.classList.contains('removing')){
        const bodyEl=existingToast.querySelector('.toast-body');
        if(bodyEl) bodyEl.innerHTML+=`<br>${bodyLines.join('<br>')}`;
        const ftEl=existingToast.querySelector('.toast-footer');
        if(ftEl) ftEl.textContent=`by ${who} · ${now}`;
        clearTimeout(existingToast._expTimer);
        existingToast._expTimer=setTimeout(()=>{existingToast.classList.add('removing');setTimeout(()=>existingToast.remove(),350);},5000);
      } else {
        const t=showRichToastFull({title:toastTitle,body:bodyLines.join('<br>'),footer,type:'info',duration:5500,clientId:cid});
        unseenToastTimers.set(toastKey,t);
      }
    });
    const ui=getChecklistUIState();
    pendingBarWidths=captureBarWidths();
    if(oldMainPct!==null) pendingBarWidths['main']=oldMainPct+'%';
    clients=updated;
    renderSidebar();
    if(activeClientId&&clients[activeClientId]){
      loadClientChecklist(activeClientId);
      restoreChecklistUIState(activeClientId,ui);
      if(changedSteps.length) setTimeout(()=>pulseSteps(changedSteps,techName),80);
    }
  });
  sseSource.addEventListener('steps-updated',async e=>{
    try{const r=await fetch('/steps.json',{cache:'no-store'});if(r.ok)stepsData=await r.json();}catch(_){}
    renderRefList();
    if(activeClientId) loadClientChecklist(activeClientId);
  });
  sseSource.addEventListener('guides-updated',async e=>{
    try{const r=await fetch('/guides.json',{cache:'no-store'});if(r.ok)guides=await r.json();}catch(_){}
  });
  sseSource.addEventListener('config-updated',e=>{
    const cfg=JSON.parse(e.data);
    if(cfg.syncroSubdomain) config.syncroSubdomain=cfg.syncroSubdomain;
  });
  sseSource.addEventListener('backup-activity-updated',e=>{
    const payload=JSON.parse(e.data);
    if(!Array.isArray(payload.data))return;
    _backupActivityData=payload.data;
    _bkActivityLastUpdated=payload.lastUpdated||_bkActivityLastUpdated;
    _bkActivitySource='direct';
    if(_bkMonitorMode){bkDrawMonitor();return;}
    const el=document.getElementById('backups-content');
    if(el&&el.offsetParent!==null){renderBackupsSidebar();bkRenderMain();}
  });
  sseSource.addEventListener('backup-data-updated',e=>{
    const payload=JSON.parse(e.data);
    if(!Array.isArray(payload.data))return;
    _bkLastUpdated=payload.lastUpdated||_bkLastUpdated;
    _bkDataSource='direct';
    _backupLiveData={};
    for(const ent of payload.data){
      if(!_backupLiveData[ent.client])_backupLiveData[ent.client]={usedBytes:0,profiles:[]};
      _backupLiveData[ent.client].usedBytes+=ent.diskSize;
      _backupLiveData[ent.client].profiles.push(ent);
    }
    if(_bkMonitorMode){bkDrawMonitor();return;}
    const el=document.getElementById('backups-content');
    if(el&&el.offsetParent!==null){renderBackupsSidebar();bkRenderMain();}
  });
  sseSource.addEventListener('backup-drive-updated',e=>{
    const payload=JSON.parse(e.data);
    if(!payload.data)return;
    _backupDriveData=payload.data;
    _bkDriveSource='direct';
    if(_bkMonitorMode){bkDrawMonitor();return;}
    const el=document.getElementById('backups-content');
    if(el&&el.offsetParent!==null){renderBackupsSidebar();bkRenderMain();}
  });
  sseSource.addEventListener('purchase-requests-updated',async(e)=>{
    const payload=JSON.parse(e.data);
    if(payload.src===SESSION_ID) return; // this tab's own save — already reflected locally, skip the rebuild
    await loadPurchaseRequests();
    if(activeSection==='quotes'){ renderQuotesSidebar(); renderQuotesDashboard(); }
  });
  sseSource.addEventListener('invoices-updated',async(e)=>{
    const payload=JSON.parse(e.data);
    if(payload.src===SESSION_ID) return;
    await loadInvoices();
    if(activeSection==='quotes'){ renderQuotesSidebar(); renderQuotesDashboard(); }
  });
  sseSource.addEventListener('app-updated',()=>{
    const banner=document.getElementById('update-banner');
    if(banner) banner.style.display='block';
  });
  sseSource.onerror=()=>{ sseSource.close(); setTimeout(()=>{connectSSE();checkServerRestart();},5000); };
}

async function loadConfig(){
  try{
    const [cfgRes,guidesRes,stepsRes]=await Promise.all([
      fetch('/api/config'),fetch('/guides.json'),fetch('/steps.json')
    ]);
    if(!cfgRes.ok) throw new Error(`Config HTTP ${cfgRes.status}`);
    const cfg=await cfgRes.json();
    if(!cfg.syncroSubdomain) throw new Error('config.json missing required fields');
    config={syncroTokenSet:cfg.syncroTokenSet||false,syncroTokenHint:cfg.syncroTokenHint||'',syncroSubdomain:cfg.syncroSubdomain,orgName:cfg.orgName||'System Alternatives'};
    const orgName=config.orgName;
    document.querySelectorAll('.ah-brand').forEach(el=>el.textContent=orgName||'System Alternatives');
    if(guidesRes.ok) guides=await guidesRes.json();
    else console.warn('guides.json not found');
    if(stepsRes.ok) stepsData=await stepsRes.json();
    else console.warn('steps.json not found');
    const settingsRes=await fetch('/api/settings').catch(()=>null);
    if(settingsRes&&settingsRes.ok){const sd=await settingsRes.json();appSettings={...appSettings,...sd};if(!sd.products) appSettings.products=DEFAULT_PRODUCTS;}
    await loadClients();await loadSalesQuotes();await loadPurchaseRequests();await loadInvoices();renderSidebar();buildProductsGrid();document.getElementById('sidebar').classList.add('hidden');showView('home');
  }catch(e){showAlert('config-alert','error',`Failed to load: ${e.message}`);}
}
async function loadClients(){try{const r=await fetch('/api/clients');if(!r.ok)throw new Error();clients=await r.json();}catch(e){clients={};}}
async function saveClients(){
  if(activeClientId&&clients[activeClientId]) clients[activeClientId].lastModified=new Date().toISOString();
  const myName=localStorage.getItem('myName')||'';
  try{await fetch('/api/clients',{method:'PUT',headers:{'Content-Type':'application/json','X-Session-Id':SESSION_ID,'X-Tech-Name':myName},body:JSON.stringify(clients)});}catch(e){console.error(e);}
}

// \u2500\u2500\u2500 Syncro \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderSyncroLinkArea(){
  const area=document.getElementById('syncro-link-area');
  if(!area) return;
  if(syncroCustomer){
    area.innerHTML=`<div class="syncro-linked-card">
      <span class="syncro-linked-name">&#128279; ${syncroCustomer.business_name}</span>
      <button class="btn-secondary btn-sm" onclick="openSyncroLinkModal()">Change</button>
      <button class="btn-secondary btn-sm" onclick="unlinkSyncroCustomer()" title="Unlink">&#10005;</button>
    </div>`;
  }else{
    area.innerHTML=`<button class="btn-secondary" onclick="openSyncroLinkModal()">&#128279; Link Syncro Customer</button>`;
  }
}
let syncroLinkCallback=null;
function openSyncroLinkModal(callback){
  if(!config?.syncroTokenSet){showToast('Add Syncro credentials in Settings first','error');return;}
  syncroLinkCallback=callback||null;
  document.getElementById('slm-input').value='';
  document.getElementById('slm-results').innerHTML='';
  document.getElementById('syncro-link-modal').classList.add('show');
  setTimeout(()=>document.getElementById('slm-input').focus(),80);
}
function closeSyncroLinkModal(){document.getElementById('syncro-link-modal').classList.remove('show');}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('syncro-link-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeSyncroLinkModal();});
});
async function searchSyncroInModal(){
  const q=document.getElementById('slm-input').value.trim();if(!q)return;
  const el=document.getElementById('slm-results');
  el.innerHTML='<span class="spinner"></span>';
  try{
    const r=await fetch(`/api/syncro/search?q=${encodeURIComponent(q)}`);
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const data=await r.json();const list=data.customers||[];
    if(!list.length){el.innerHTML='<div style="color:var(--text3);font-size:11px;padding:6px 0;">No customers found.</div>';return;}
    el.innerHTML=list.map((c,i)=>`<div class="search-result-item" onclick="selectSyncroInModal(${i})"><span class="sri-name">${escHtml(c.business_name)}</span><span class="sri-id">ID: ${escHtml(String(c.id))}</span></div>`).join('');
    el._customers=list;
  }catch(e){el.innerHTML=`<div style="color:#fca5a5;font-size:11px;padding:6px 0;">Error: ${e.message}</div>`;}
}
function selectSyncroInModal(idx){
  const el=document.getElementById('slm-results');
  const list=el._customers;if(!list)return;
  const customer=list[idx];
  customer._installerMap=buildInstallerMap(customer);
  closeSyncroLinkModal();
  if(syncroLinkCallback){syncroLinkCallback(customer);syncroLinkCallback=null;}
  else{syncroCustomer=customer;renderSyncroLinkArea();}
}
function unlinkSyncroCustomer(){syncroCustomer=null;renderSyncroLinkArea();}
// Build installer URL map from Syncro customer properties
function buildInstallerMap(customer){
  const p=customer.properties||{};
  const t=appSettings.urlTemplates||{};
  const map={};
  const types={
    Workstation:{field:'RMM Agent (Workstation)',template:t.Workstation||'https://rmm.syncromsp.com/dl/rs/'},
    Server:{field:'RMM Agent (Server)',template:t.Server||'https://rmm.syncromsp.com/dl/rs/'},
    Mac:{field:'RMM Agent (Mac)',template:t.Mac||'https://production.kabutoservices.com/desktop/macos/setup?token='},
    Linux:{field:'RMM Agent (Linux)',template:t.Linux||'https://systemalternatives.syncromsp.com/download_linux_agent_installers?token='}
  };
  Object.entries(types).forEach(([type,{field,template}])=>{
    const val=p[field]?.toString().trim();
    if(val) map[type]=template+val;
  });
  return map;
}

function selectDevice(type){
  // Legacy — no-op in new flow, device type set at Add Device time
  syncroDeviceType=type;
}

// Get installer URL for a specific device type from stored client data
function getInstallerUrlForType(client, deviceType){
  if(!client.syncroInstallerMap) return client.syncroInstallerUrl||null;
  return client.syncroInstallerMap[deviceType]||null;
}
function copyText(text,btn){
  if(!text){return;}
  navigator.clipboard.writeText(text).then(()=>{
    if(!btn) return;
    const o=btn.textContent;
    btn.textContent='Copied!';
    btn.style.color='var(--success)';
    setTimeout(()=>{btn.textContent=o;btn.style.color='';},1500);
  }).catch(()=>{
    // Fallback for non-https
    const ta=document.createElement('textarea');
    ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');
    document.body.removeChild(ta);
    if(btn){const o=btn.textContent;btn.textContent='Copied!';btn.style.color='var(--success)';setTimeout(()=>{btn.textContent=o;btn.style.color='';},1500);}
  });
}

// \u2500\u2500\u2500 Products grid \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function buildProductsGrid(){
  document.getElementById('products-grid').innerHTML=getProducts().map(p=>`
    <label class="product-toggle" id="ptog-${p.id}">
      <input type="checkbox" id="pcheck-${p.id}" onchange="toggleProduct('${p.id}')">
      <div class="toggle-check"><svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div><div class="product-label">${p.label}</div><div class="product-desc">${p.desc}</div></div>
    </label>`).join('');
}
function toggleProduct(id){const c=document.getElementById(`pcheck-${id}`);document.getElementById(`ptog-${id}`).classList.toggle('selected',c.checked);}

// \u2500\u2500\u2500 Create client \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function createClientChecklist(){
  const name=document.getElementById('wiz-clientname').value.trim();
  const tech=document.getElementById('wiz-tech').value.trim();
  if(!name){showAlert('wizard-alert','error','Checklist name is required.');return;}
  const selectedProds=getProducts().filter(p=>document.getElementById(`pcheck-${p.id}`)?.checked).map(p=>p.id);
  if(!selectedProds.length){showAlert('wizard-alert','error','Select at least one product.');return;}
  const dueDate=document.getElementById('wiz-duedate')?.value||null;
  const id='client-'+Date.now();
  clients[id]={
    id,name,tech:tech||'Unassigned',createdAt:new Date().toISOString(),
    products:selectedProds,
    dueDate:dueDate||null,
    syncroCustomerId:syncroCustomer?.id||null,
    syncroCustomerName:syncroCustomer?.business_name||null,
    syncroInstallerMap:syncroCustomer?._installerMap||null,
    // Legacy single URL field kept for backward compat
    syncroInstallerUrl:null,
    steps:{},devices:{},freetexts:{},priority:false,clientStatus:'active',comments:[]
  };
  logAction('checklist_created',{clientId:id,clientName:clients[id].name});
  await saveClients();renderSidebar();loadClientChecklist(id);
}

// \u2500\u2500\u2500 Views \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const map={home:'view-home',config:'view-config','new-client':'view-new-client',empty:'view-empty',
             checklist:'view-checklist',reference:'view-reference',settings:'view-settings',
             sales:'view-sales','new-quote':'view-new-quote',quote:'view-quote',backups:'view-backups',
             quotes:'view-quotes'};
  document.getElementById(map[name]||'view-home')?.classList.add('active');
  if(name==='home') renderHomeView();
  if(name==='new-client'){
    document.getElementById('wizard-alert').innerHTML='';
    ['wiz-clientname','wiz-tech'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    syncroCustomer=null;syncroAgentUrl=null;
    renderSyncroLinkArea();
    const offset=appSettings.defaultDueOffset||90;
    const defaultDue=new Date();defaultDue.setDate(defaultDue.getDate()+offset);
    const dd=document.getElementById('wiz-duedate');
    if(dd) dd.value=defaultDue.toISOString().slice(0,10);
    buildProductsGrid();
  }
  if(name==='empty') renderDashboard();
  if(name==='sales') renderSalesView();
  if(name==='new-quote'){
    document.getElementById('quote-wizard-alert').innerHTML='';
    ['qwiz-name','qwiz-contact'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    ['qwiz-emp','qwiz-users','qwiz-ws','qwiz-srv','qwiz-backup'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='0';});
    const s=document.getElementById('qwiz-sites');if(s)s.value='1';
    const t=document.getElementById('qwiz-tech');if(t)t.value=localStorage.getItem('myName')||'';
  }
}
function showAlert(id,type,msg){const el=document.getElementById(id);if(el)el.innerHTML=`<div class="alert alert-${type}">${msg}</div>`;}

// \u2500\u2500\u2500 Init \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
applyTheme(currentTheme);
loadConfig();
connectSSE();
startUpdatePolling();
startServerRestartPolling();
checkFirstVisit();

document.addEventListener('wheel',e=>{
  const el=e.target;
  if(el.tagName!=='INPUT'||el.type!=='number')return;
  if(document.activeElement!==el)return;
  e.preventDefault();
  const step=parseFloat(el.step)||1;
  const cur=parseFloat(el.value)||0;
  const min=el.min!==''?parseFloat(el.min):-Infinity;
  const delta=e.deltaY<0?step:-step;
  el.value=Math.max(min,cur+delta).toFixed(step<1?2:0);
  el.dispatchEvent(new Event('input',{bubbles:true}));
},{passive:false});
