/** Public onboarding page: it has no credential, live device list or remote operation. */
export function renderInstallHome(readiness: {windows: boolean; linux: boolean} = {windows:false,linux:false}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Control Agent · Install</title>
<style>
:root{
  color-scheme:light;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --bg:#fff;--fg:#151515;--muted:#666;--surface:#f4f4f5;
  --border:#e5e5e5;--icon-hover:rgba(20,20,24,.07);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;padding:48px 20px 40px;background:var(--bg);color:var(--fg)}
main{width:100%;max-width:650px;margin:0 auto}
small{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{font-size:clamp(28px,4vw,40px);line-height:1.2;font-weight:650;letter-spacing:-.045em;margin:20px 0 12px}
p{color:var(--muted);font-size:15px;line-height:1.65;margin:0 0 25px;max-width:56ch}
[role=tablist]{display:flex;border-bottom:1px solid var(--border);gap:24px}
[role=tab]{font:inherit;cursor:pointer;border:0;background:transparent;padding:12px 3px;color:var(--muted);border-bottom:2px solid transparent}
[role=tab][aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg);font-weight:600}
[role=tabpanel]{padding:17px 0 0}
.command{background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:22px 24px 25px;min-width:0}
.command-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
.command-label{font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--fg)}
.command-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin}
code{display:block;width:max-content;max-width:none;font:clamp(14px,2.6vw,17px)/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;color:var(--fg);user-select:all}
button.copy{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;flex:none;border:0;border-radius:10px;padding:8px;background:transparent;color:var(--fg);cursor:pointer}
button.copy:hover:not(:disabled){background:var(--icon-hover)}
button.copy svg{display:block;width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}
button.copy .icon-check{display:none}
button.copy[data-copied="true"] .icon-copy{display:none}
button.copy[data-copied="true"] .icon-check{display:block}
button.copy:disabled{opacity:.45;cursor:not-allowed}
@media(prefers-reduced-motion:no-preference){button.copy{transition:background-color .15s ease}}
button:focus-visible,a:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
#message{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.4}
#message:empty{display:none}
ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;list-style:none;padding:24px 0;margin:28px 0 23px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
li{min-width:0;line-height:1.6;font-size:13px;color:var(--muted)}
li strong{color:var(--fg);display:block;font-size:14px;margin-bottom:3px}
@media(prefers-color-scheme:dark){
  :root{color-scheme:dark;--bg:#121316;--fg:#f4f4f5;--muted:#b9b9c0;--surface:#23242a;--border:#404047;--icon-hover:rgba(255,255,255,.1)}
}
@media(max-width:520px){
  body{padding:24px 20px 32px;padding-top:max(24px,env(safe-area-inset-top));min-height:100svh;display:flex;flex-direction:column}
  main{margin:auto}
  small{font-size:10px;letter-spacing:.13em}
  h1{font-size:27px;line-height:1.25;margin:14px 0 10px}
  p{font-size:13.5px;line-height:1.55;margin-bottom:17px}
  [role=tablist]{gap:21px}
  [role=tab]{font-size:15px;padding:10px 2px}
  [role=tabpanel]{padding-top:14px}
  .command{border-radius:20px;padding:16px 17px 18px}
  .command-head{margin-bottom:12px}
  .command-label{font-size:15px}
  button.copy{width:36px;height:36px;padding:7px;border-radius:8px}
  button.copy svg{width:22px;height:22px}
  .command-scroll{overflow-x:visible}
  code{width:auto;max-width:100%;font-size:13px;line-height:1.6;white-space:normal;overflow-wrap:normal;word-break:normal}
  ol{grid-template-columns:1fr;gap:13px;margin:20px 0 12px;padding:18px 0}
  li{font-size:12.5px;line-height:1.5}
  li strong{font-size:13.5px;margin-bottom:2px}
}
</style></head>
<body><main><small>Remote Control Agent</small><h1>Install on your device</h1>
<p>Run the command, then approve in MCP.</p>
<div role="tablist" aria-label="Operating system"><button type="button" id="windows" role="tab" aria-controls="installer" aria-selected="false">Windows</button><button type="button" id="linux" role="tab" aria-controls="installer" aria-selected="false">Linux</button></div>
<section id="installer" role="tabpanel" aria-label="Install command"><div class="command"><div class="command-head"><span id="shell-label" class="command-label">PowerShell</span><button type="button" class="copy" id="copy" aria-label="Copy install command" title="Copy install command"><svg class="icon-copy" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="3" width="13" height="13" rx="2"></rect><rect x="3" y="8" width="13" height="13" rx="2"></rect></svg><svg class="icon-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12l5 5L20 6"></path></svg></button></div><div class="command-scroll"><code id="command"></code></div></div><div id="message" role="status" aria-live="polite"></div></section>
<ol role="list"><li><strong>1 · Install</strong>Run the command; choose temporary or permanent</li><li><strong>2 · Approve</strong>Match the 10-character code and fingerprint in MCP</li><li><strong>3 · Verify</strong>Confirm online status with a safe read</li></ol>
</main>
<script>
(()=>{'use strict';const cmds={windows:'irm https://rca.lirtual.dpdns.org/install.ps1 | iex',linux:'curl -fsSL https://rca.lirtual.dpdns.org/install.sh | sh'};
const ready={windows:${readiness.windows},linux:${readiness.linux}};
const tabs={windows:document.getElementById('windows'),linux:document.getElementById('linux')};
const field=document.getElementById('command'),shellLabel=document.getElementById('shell-label'),message=document.getElementById('message'),copy=document.getElementById('copy');
let platform='windows';
let copyResetTimer;
function resetCopyFeedback(){
  clearTimeout(copyResetTimer);
  copy.removeAttribute('data-copied');
  copy.setAttribute('aria-label','Copy install command');
  copy.setAttribute('title','Copy install command');
}
function select(value){
  resetCopyFeedback();
  platform=value;
  shellLabel.textContent=value==='windows'?'PowerShell':'Shell';
  field.textContent=ready[value]?cmds[value]:'Not available';
  // Let narrow screens wrap at the URL path boundary, never inside .ps1/.sh.
  // Keep the command as plain text, with no inserted characters when copied.
  if(ready[value]){
    const boundary=cmds[value].indexOf('/install');
    const node=field.firstChild;
    if(boundary>=0&&node){
      field.insertBefore(document.createElement('wbr'),node.splitText(boundary+1));
    }
  }
  copy.disabled=!ready[value];
  for(const [name,tab] of Object.entries(tabs)){
    tab.setAttribute('aria-selected',String(name===value));
    tab.tabIndex=name===value?0:-1;
  }
  message.textContent=ready[value]?'':'Installer not released.';
}
for(const [name,tab] of Object.entries(tabs)){
  tab.addEventListener('click',()=>select(name));
  tab.addEventListener('keydown',event=>{
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      event.preventDefault();
      const other=name==='windows'?'linux':'windows';
      select(other);tabs[other].focus();
    }
  });
}
const detected=(navigator.userAgentData?.platform||navigator.platform||'').toLowerCase();
select(detected.includes('linux')?'linux':'windows');
copy.addEventListener('click',async()=>{
  if(!ready[platform])return;
  const requestedPlatform=platform;
  try{
    await navigator.clipboard.writeText(cmds[requestedPlatform]);
    if(platform!==requestedPlatform)return;
    resetCopyFeedback();
    copy.setAttribute('data-copied','true');
    copy.setAttribute('aria-label','Command copied');
    copy.setAttribute('title','Command copied');
    message.textContent='';
    copyResetTimer=setTimeout(resetCopyFeedback,1600);
  }catch{
    if(platform===requestedPlatform){
      resetCopyFeedback();
      message.textContent='Copy failed. Select the command manually.';
    }
  }
});
})();
</script></body></html>`;
}
