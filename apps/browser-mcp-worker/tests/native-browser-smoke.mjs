// Explicit opt-in Windows smoke test for installed Chrome/Edge (Spec #418).
// Only a disposable user-data-dir; never loads or alters an existing profile.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const [executable, source, upgradeSource] = process.argv.slice(2);
if (process.platform !== "win32" || !executable || !source ||
    !fs.existsSync(executable) || !fs.existsSync(path.join(source, "manifest.json")) ||
    (upgradeSource && !fs.existsSync(path.join(upgradeSource, "manifest.json")))) {
  throw Error("Usage on Windows: node native-browser-smoke.mjs <chrome-or-edge.exe> <original-extension-dir> [updated-extension-dir]");
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec418-browser-smoke-"));
const profile = path.join(root, "profile");
const fixtureHost = "spec418-test.example";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(req.url?.startsWith("/clean")
    ? "<!doctype html><title>Clean fixture</title><h1>Clean Browser MCP page</h1><p>No sensitive fields</p>"
    : "<!doctype html><title>Local fixture</title><h1>Browser MCP isolated fixture</h1><p>Public fixture text</p><input type=password value=fixture-secret-123>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const fixturePort = server.address().port;
const extension = path.join(root, "extension");
fs.cpSync(source, extension, { recursive: true });
const chrome = spawn(executable, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-sync", "--disable-component-update",
  "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-proxy-server", "--host-resolver-rules=MAP spec418-test.example 127.0.0.1",
  "--user-data-dir=" + profile, "about:blank"
], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], windowsHide: true });
let stdout = "", stderr = "";
chrome.stdout.on("data", c => { stdout = (stdout + String(c)).slice(-1500); });
chrome.stderr.on("data", c => { stderr = (stderr + String(c)).slice(-1500); });

let buffer = Buffer.alloc(0), seq = 0;
const pending = new Map();
chrome.stdio[4].on("data", data => {
  buffer = Buffer.concat([buffer, data]);
  let cut;
  while ((cut = buffer.indexOf(0)) !== -1) {
    const frame = buffer.subarray(0, cut);
    buffer = buffer.subarray(cut + 1);
    if (!frame.length) continue;
    let message;
    try { message = JSON.parse(frame.toString("utf8")); }
    catch { continue; }
    if (pending.has(message.id)) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      handler(message);
    }
  }
});
function request(method, params = {}, sessionId, timeout = 10000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ": timeout")); }, timeout);
    pending.set(id, result => {
      clearTimeout(timer);
      if (result.error) reject(Error(method + ": " + JSON.stringify(result.error)));
      else resolve(result.result);
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}
async function retry(fn, attempts = 30) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(200); }
  }
  throw last;
}
async function main() {
  const version = await retry(() => request("Browser.getVersion", {}, undefined, 2000));
  console.log("BROWSER", version.product);
  const installed = await request("Extensions.loadUnpacked", { path: extension });
  const id = installed.id;
  if (typeof id !== "string" || !/^[a-p]{32}$/.test(id)) throw Error("Invalid extension ID returned");
  console.log("EXTENSION_INSTALLED", id);
  const targets = await retry(async () => {
    const result = await request("Target.getTargets");
    if (!result.targetInfos.some(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://" + id + "/")))
      throw Error("Service worker not registered");
    return result.targetInfos;
  });
  console.log("SERVICE_WORKER", targets.filter(t => t.type === "service_worker" && t.url.includes(id)).length);
  const tab = await request("Target.createTarget", { url: "chrome-extension://" + id + "/popup.html" });
  const connection = await request("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
  const session = connection.sessionId;
  await request("Runtime.enable", {}, session);
  const evalExpression = async expression => {
    const value = await request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (value.exceptionDetails) throw Error("Page evaluation failed: " + value.exceptionDetails.text);
    return value.result.value;
  };
  const status = await retry(() => evalExpression(
    "chrome.storage.local.get(null).then(s=>({...s,authorization:s.authorization||'unpaired',connection:s.connection||'offline'}))"
  ));
  const untrusted=await evalExpression("new Promise(resolve=>chrome.runtime.sendMessage({type:'status'},r=>resolve(r)))");
  if(untrusted?.error!=="untrusted_sender")throw Error("Tab impersonated trusted Popup: "+JSON.stringify(untrusted));
  console.log("UNTRUSTED_TAB_SENDER_DENIED",untrusted.error);
  if (status.authorization !== "unpaired" || status.connection !== "offline" || status.credential) {
    throw Error("Initial extension grants or status invalid");
  }
  console.log("ISOLATED_EXTENSION_INITIAL_STATUS", status.authorization, status.connection);
  let manageSession=null;
  if(upgradeSource){
    const management=await request("Target.createTarget",{url:"chrome://extensions"});
    manageSession=(await request("Target.attachToTarget",{targetId:management.targetId,flatten:true})).sessionId;
    await request("Runtime.enable",{},manageSession);
    const mg=await request("Runtime.evaluate",{expression:"({url:location.href,dpReload:typeof chrome?.developerPrivate?.reload})",returnByValue:true,awaitPromise:true},manageSession);
    if(mg.result.value?.dpReload!=="function")throw Error("Management reload API unavailable");
    console.log("MANAGEMENT_RELOAD_CAPABILITY",JSON.stringify(mg.result.value));
  }
  // This API exercise uses a synthetic local page and privileged test CDP context.
  // It does not bypass Owner approval or make an MCP request in production.
  const fixtureUrl = `http://${fixtureHost}:${fixturePort}/page`;
  await request("Target.createTarget", { url: fixtureUrl });
  const worker = targets.find(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://" + id + "/"));
  const workerAttach = await request("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const workerSession = workerAttach.sessionId;
  await request("Runtime.enable", {}, workerSession);
  const workerEval = async expression => {
    const value = await request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, workerSession);
    if (value.exceptionDetails) throw Error("Extension observation exception: " + value.exceptionDetails.text);
    return value.result.value;
  };
  const matching = await retry(async () => {
    const list = await workerEval('executeBrowserRead("tabs")');
    const found = list.tabs.find(t => t.origin === `http://${fixtureHost}:${fixturePort}`);
    if (!found) throw Error("Fixture tab not discoverable");
    return found;
  });
  const snap = await retry(async () => {
    const result = await workerEval(`executeBrowserRead("snapshot",${matching.tab_id})`);
    if (!result.text?.includes("Browser MCP isolated fixture")) throw Error("Snapshot unavailable: " + JSON.stringify(result));
    return result;
  });
  if (JSON.stringify(snap).includes("fixture-secret-123")) throw Error("Password input leaked into snapshot");
  console.log("REAL_TAB_AND_SNAPSHOT", matching.tab_id, snap.document_id, "password_excluded");
  const screenshot = await workerEval(`executeBrowserRead("screenshot",${matching.tab_id})`);
  if (screenshot.data_url) throw Error("Screenshot disclosed a password form");
  if (!["sensitive_surface","unsupported_background_capture"].includes(screenshot.error_code))
    throw Error("Unexpected screenshot response: " + JSON.stringify(screenshot));
  console.log("SCREENSHOT_DENIED", screenshot.error_code);
  const cleanUrl = `http://${fixtureHost}:${fixturePort}/clean`;
  await request("Target.createTarget", { url: cleanUrl });
  const clean = await retry(async () => {
    const list = await workerEval('executeBrowserRead("tabs")');
    const matchingTabs = list.tabs.filter(t => t.origin === `http://${fixtureHost}:${fixturePort}` && t.tab_id !== matching.tab_id);
    if (matchingTabs.length !== 1) throw Error("Clean fixture tab not available");
    return matchingTabs[0];
  });
  const clearScreenshot = await retry(async () => {
    const snap = await workerEval(`executeBrowserRead("snapshot",${clean.tab_id})`);
    if (!snap.text?.includes("Clean Browser MCP page")) throw Error("Clean fixture not loaded");
    return workerEval(`executeBrowserRead("screenshot",${clean.tab_id})`);
  });
  if (clearScreenshot.data_url) {
    if (!clearScreenshot.data_url.startsWith("data:image/png;base64,")) throw Error("Invalid screenshot format");
    console.log("CLEAN_SCREENSHOT", "PASS", clearScreenshot.data_url.length);
  } else if (clearScreenshot.error_code === "unsupported_background_capture") {
    console.log("CLEAN_SCREENSHOT", "BLOCKED_HEADLESS_FOCUS");
  } else {
    throw Error("Clean fixture screenshot failed: " + JSON.stringify(clearScreenshot));
  }
  // DevTools-created extension TAB is not a trusted action Popup.
  // Probe Stop only in this disposable test worker; do not call this a human UI test.
  await workerEval("stopLocal()");
  const stored = await retry(async () => {
    const result = await evalExpression("chrome.storage.local.get(null)");
    if (result.authorization !== "stopped") throw Error("Isolated-worker Stop not yet persisted");
    return result;
  });
  if (stored.authorization !== "stopped" || stored.credential || stored.endpoint_id)
    throw Error("Local Stop not retained or credential unexpectedly present");
  console.log("PERSISTED_LOCAL_STOP_TEST_WORKER_ONLY", stored.authorization);
  if(upgradeSource){
    // Disposable test Profile ONLY. Synthetic markers are not live pairing grants.
    const fakeEndpoint="00000000-0000-4000-8000-000000000418";
    await evalExpression("chrome.storage.local.set({endpoint_id:"+JSON.stringify(fakeEndpoint)+",credential:'nonproduction-test-only',authorization:'stopped',alias:'t9-synthetic'}).then(()=>true)");
    await evalExpression("chrome.storage.session.set({browser_sensitive_grants:{lan:true,private:true,revision:'synthetic-test-only'}}).then(()=>true)");
    const before=await evalExpression("Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]).then(([local,session])=>({local,session}))");
    if(before.local.endpoint_id!==fakeEndpoint||before.local.authorization!=="stopped"||!before.session.browser_sensitive_grants?.lan)
      throw Error("Synthetic pre-upgrade state missing");
    const oldManifest=JSON.parse(fs.readFileSync(path.join(extension,"manifest.json"),"utf8"));
    const newManifest=JSON.parse(fs.readFileSync(path.join(upgradeSource,"manifest.json"),"utf8"));
    if(oldManifest.key!==newManifest.key)throw Error("Upgrade identity differs");
    const updatedFiles=fs.readdirSync(upgradeSource).filter(file=>fs.statSync(path.join(upgradeSource,file)).isFile());
    for(const file of updatedFiles)fs.copyFileSync(path.join(upgradeSource,file),path.join(extension,file));
    for(const file of updatedFiles)if(!fs.readFileSync(path.join(extension,file)).equals(fs.readFileSync(path.join(upgradeSource,file))))
      throw Error("Upgrade file differs: "+file);
    const reloaded=await request("Runtime.evaluate",{expression:"new Promise(resolve=>chrome.developerPrivate.reload("+JSON.stringify(id)+",{failQuietly:false},()=>resolve({error:chrome.runtime.lastError?.message||null})))",returnByValue:true,awaitPromise:true},manageSession);
    if(reloaded.exceptionDetails||reloaded.result.value?.error)throw Error("Developer reload unavailable: "+JSON.stringify(reloaded.exceptionDetails||reloaded.result.value));
    let upgraded=null;
    try { upgraded=await retry(async()=>{
      const tab=await request("Target.createTarget",{url:"chrome-extension://"+id+"/popup.html"});
      const sid=(await request("Target.attachToTarget",{targetId:tab.targetId,flatten:true})).sessionId;
      await request("Runtime.enable",{},sid);
      const r=await request("Runtime.evaluate",{expression:"Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]).then(([local,session])=>({local,session,runtimeId:chrome.runtime.id}))",returnByValue:true,awaitPromise:true},sid);
      if(r.exceptionDetails)throw Error("Reloaded extension context unavailable: "+r.exceptionDetails.text);
      if(!r.result.value?.runtimeId)throw Error("Reloaded runtime missing");
      return r.result.value;
    },10); } catch(error) {
      // Some Chromium DevTools-installed unpacked extensions lose an extension
      // API context after management reload. This is a harness limitation, not
      // proof that a normal owner-installed extension loses local storage.
      if(version.product.startsWith("Chrome/") && /Reloaded extension context unavailable/.test(error.message))
        console.log("IN_PLACE_UPGRADE", "BLOCKED_DEVTOOLS_RELOAD_CONTEXT",id);
      else throw error;
    }
    if(upgraded && (upgraded.runtimeId!==id||upgraded.local.endpoint_id!==fakeEndpoint||upgraded.local.credential!=="nonproduction-test-only"||upgraded.local.authorization!=="stopped"))
      throw Error("Synthetic local identity/Stop lost after same-path update: "+JSON.stringify({runtimeId:upgraded.runtimeId,storedEndpoint:upgraded.local.endpoint_id,authorization:upgraded.local.authorization}));
    if(upgraded && (upgraded.session.browser_sensitive_grants?.lan||upgraded.session.browser_sensitive_grants?.private))
      throw Error("Sensitive session grants unexpectedly retained after extension reload");
    if(upgraded)console.log("IN_PLACE_UPGRADE", "PASS",id,"stopped_and_synthetic_identity_preserved","sensitive_session_grants_cleared");
  }
  console.log("PASS isolated browser read and stopped-state storage; REAL_POPUP=NOT_RUN");
}
try { await main(); }
catch (e) { console.error("FAIL native browser smoke:", e.message, "stderr:", stderr.slice(-1000)); process.exitCode = 1; }
finally {
  for (const [id, cb] of pending) { pending.delete(id); cb({ error: { message: "shutting down" } }); }
  chrome.kill();
  await sleep(800);
  await new Promise(resolve => server.close(resolve));
  if (chrome.exitCode === null && chrome.pid) {
    // Kill only the test process tree belonging to the isolated profile.
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { windowsHide: true });
    await new Promise(resolve => killer.on("exit", resolve));
  }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { console.error("CLEANUP_WARNING", e.message); }
}
