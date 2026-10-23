/** Public onboarding page: it has no credential, live device list or remote operation. */
export function renderInstallHome(readiness: {windows: boolean; linux: boolean} = {windows:false,linux:false}): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Control Agent · 安装</title>
<style>
:root{color-scheme:light;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#111}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:40px 18px}
main{width:100%;max-width:650px}small{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#666}
h1{font-size:clamp(28px,5vw,42px);font-weight:650;letter-spacing:-.045em;margin:26px 0 10px}
p{color:#626262;line-height:1.6;margin:0 0 28px}
[role=tablist]{display:flex;border-bottom:1px solid #dedede;gap:24px}
[role=tab]{font:inherit;cursor:pointer;border:0;background:transparent;padding:12px 3px;color:#707070;border-bottom:2px solid transparent}
[role=tab][aria-selected=true]{color:#111;border-bottom-color:#111}
[role=tabpanel]{padding:20px 0 4px}.command{background:#f5f5f5;border:1px solid #ebebeb;border-radius:10px;display:flex;align-items:center;gap:10px;padding:12px}
code{font-size:13px;overflow-wrap:anywhere;flex:1;min-width:0;line-height:1.65}button.copy{cursor:pointer;background:#111;color:#fff;border:none;border-radius:6px;padding:10px 13px;flex:none}
button.copy:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,a:focus-visible{outline:2px solid #111;outline-offset:3px}
#message{min-height:24px;margin:9px 0 0;color:#555;font-size:13px}
ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;padding:28px 0 18px;margin:30px 0;border-top:1px solid #eee;border-bottom:1px solid #eee;list-style-position:inside}
li{line-height:1.6;font-size:13px;color:#555}li strong{color:#111;display:block;font-size:14px}footer{display:flex;gap:24px;font-size:13px}a{color:#555;text-decoration:none}a:hover{text-decoration:underline}
@media(max-width:520px){ol{grid-template-columns:1fr;gap:13px}.command{align-items:flex-start;flex-direction:column}button.copy{align-self:flex-end}body{place-items:start center;padding-top:12vh}}
</style></head>
<body><main><small>Remote Control Agent</small><h1>在你的设备上开始</h1>
<p>复制一条安装命令，在本机终端运行；设备授权只通过已认证的 MCP 所有者审批完成。</p>
<div role="tablist" aria-label="操作系统"><button type="button" id="windows" role="tab" aria-controls="installer" aria-selected="false">Windows</button><button type="button" id="linux" role="tab" aria-controls="installer" aria-selected="false">Linux</button></div>
<section id="installer" role="tabpanel" aria-label="安装命令"><div class="command"><code id="command"></code><button type="button" class="copy" id="copy" aria-label="复制安装命令">复制</button></div><div id="message" role="status" aria-live="polite"></div></section>
<ol><li><strong>1 · 安装</strong>运行命令并选择永久或临时</li><li><strong>2 · MCP 授权</strong>核对 10 位配对码与指纹，批准一次</li><li><strong>3 · 验证连接</strong>通过 MCP 确认设备在线并做无害读取</li></ol>
<footer><a href="https://github.com/lirtual/remote-control-agent" rel="noopener noreferrer">源码</a><a href="https://github.com/lirtual/remote-control-agent#readme" rel="noopener noreferrer">文档</a></footer></main>
<script>
(()=>{'use strict';const cmds={windows:'irm https://rca.lirtual.dpdns.org/install.ps1 | iex',linux:'curl -fsSL https://rca.lirtual.dpdns.org/install.sh | sh'};
const ready={windows:${readiness.windows},linux:${readiness.linux}};
const tabs={windows:document.getElementById('windows'),linux:document.getElementById('linux')};const field=document.getElementById('command'),message=document.getElementById('message'),copy=document.getElementById('copy');let platform='linux';
function select(value){platform=value;field.textContent=ready[value]?cmds[value]:'安装暂未开放';copy.disabled=!ready[platform];for(const [name,tab] of Object.entries(tabs)){tab.setAttribute('aria-selected',String(name===value));tab.tabIndex=name===value?0:-1;}message.textContent=ready[value]?'':'等待经审核的正式安装包发布';}
for(const [name,tab] of Object.entries(tabs)){tab.addEventListener('click',()=>select(name));tab.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const other=name==='windows'?'linux':'windows';select(other);tabs[other].focus();}});}
const detected=(navigator.userAgentData?.platform||navigator.platform||navigator.userAgent||'').toLowerCase();select(detected.includes('win')?'windows':'linux');
copy.addEventListener('click',async()=>{if(!ready[platform])return;try{await navigator.clipboard.writeText(cmds[platform]);message.textContent='已复制';}catch{message.textContent='复制失败，请手动选中命令。';}});
})();
</script></body></html>`;
}
