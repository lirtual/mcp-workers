/** Public onboarding page: it has no credential, live device list or remote operation. */
export function renderInstallHome(readiness: {windows: boolean; linux: boolean} = {windows:false,linux:false}): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Control Agent · 安装</title>
<style>
:root{
  color-scheme:light;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --bg:#fff;--fg:#151515;--muted:#666;--surface:#f4f4f5;
  --border:#e5e5e5;--button:#151515;--button-fg:#fff;
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
.command{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:15px 16px}
.command-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px}
.command-label{font-size:12px;color:var(--muted)}
code{display:block;font:13.5px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;word-break:break-word;min-width:0;color:var(--fg);white-space:normal}
button.copy{font:inherit;font-size:13px;cursor:pointer;background:var(--button);color:var(--button-fg);border:none;border-radius:7px;padding:8px 13px;flex:none}
button.copy:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,a:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
#message{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.4}
#message:empty{display:none}
ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;list-style:none;padding:24px 0;margin:28px 0 23px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
li{min-width:0;line-height:1.6;font-size:13px;color:var(--muted)}
li strong{color:var(--fg);display:block;font-size:14px;margin-bottom:3px}
@media(prefers-color-scheme:dark){
  :root{color-scheme:dark;--bg:#121316;--fg:#f4f4f5;--muted:#b9b9c0;--surface:#23242a;--border:#404047;--button:#f4f4f5;--button-fg:#151515}
}
@media(max-width:520px){
  body{padding:28px 20px 40px;padding-top:max(28px,env(safe-area-inset-top))}
  h1{font-size:30px;line-height:1.2;margin:20px 0 12px}
  p{font-size:14px;line-height:1.65;margin-bottom:24px}
  [role=tabpanel]{padding-top:16px}
  .command{padding:14px}
  ol{grid-template-columns:1fr;gap:16px;margin:24px 0;padding:22px 0}
}
</style></head>
<body><main><small>Remote Control Agent</small><h1>在你的设备上开始</h1>
<p>复制一条安装命令，在本机终端运行；设备授权只通过已认证的 MCP 所有者审批完成。</p>
<div role="tablist" aria-label="操作系统"><button type="button" id="windows" role="tab" aria-controls="installer" aria-selected="false">Windows</button><button type="button" id="linux" role="tab" aria-controls="installer" aria-selected="false">Linux</button></div>
<section id="installer" role="tabpanel" aria-label="安装命令"><div class="command"><div class="command-head"><span id="shell-label" class="command-label">安装命令</span><button type="button" class="copy" id="copy" aria-label="复制安装命令">复制</button></div><code id="command"></code></div><div id="message" role="status" aria-live="polite"></div></section>
<ol role="list"><li><strong>1 · 安装</strong>运行命令并选择永久或临时</li><li><strong>2 · MCP 授权</strong>核对 10 位配对码与指纹，批准一次</li><li><strong>3 · 验证连接</strong>通过 MCP 确认设备在线并做无害读取</li></ol>
</main>
<script>
(()=>{'use strict';const cmds={windows:'irm https://rca.lirtual.dpdns.org/install.ps1 | iex',linux:'curl -fsSL https://rca.lirtual.dpdns.org/install.sh | sh'};
const ready={windows:${readiness.windows},linux:${readiness.linux}};
const tabs={windows:document.getElementById('windows'),linux:document.getElementById('linux')};
const field=document.getElementById('command'),shellLabel=document.getElementById('shell-label'),message=document.getElementById('message'),copy=document.getElementById('copy');
let platform='windows';
function select(value){
  platform=value;
  shellLabel.textContent=value==='windows'?'PowerShell':'Shell';
  field.textContent=ready[value]?cmds[value]:'安装暂未开放';
  copy.disabled=!ready[value];
  for(const [name,tab] of Object.entries(tabs)){
    tab.setAttribute('aria-selected',String(name===value));
    tab.tabIndex=name===value?0:-1;
  }
  message.textContent=ready[value]?'':'等待经审核的正式安装包发布';
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
  try{await navigator.clipboard.writeText(cmds[platform]);message.textContent='已复制';}
  catch{message.textContent='复制失败，请手动选中命令。';}
});
})();
</script></body></html>`;
}
