/** 创作预览：复用正式消息/脚本宿主，在独立的外层沙箱内运行。 */
import type { CardProjectPreview } from "../../src/card-authoring-types.ts";
import { buildSrcDoc, looksLikeProgramApp } from "./frameDoc.ts";
import { buildScriptHostDoc, AUTHOR_SCRIPTS_GLOBAL, SCRIPT_HOST_SANDBOX } from "./scriptHostDoc.ts";
import { splitRichContentParts } from "./richContentParts.ts";
import { rulesAtDepth } from "../../src/cardfront.ts";
import { applyMacros } from "../../src/card-macros.ts";
import { mountMvuPanel } from "../../src/mvu.ts";

/** 外层用 data: 的独立 opaque origin；子 srcdoc 可同源访问预览壳，无法访问真实应用。 */
export const CARD_PREVIEW_SANDBOX = "allow-scripts allow-same-origin";
export const cardPreviewUrl = (doc: string): string => "data:text/html;charset=utf-8," + encodeURIComponent(doc);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function diagnostics(doc: string, variables: Record<string, unknown>, source: string): string {
	const code = [
		"window.__liyuanVariables=" + json({ stat_data: variables }) + ";",
		"function report(level,message){try{parent.__liyuanPreviewReport(level," + json(source) + ",String(message));}catch(e){}}",
		"addEventListener('error',function(e){report('error',e.message||('资源加载失败：'+(e.target&&e.target.src||'')));},true);",
		"addEventListener('unhandledrejection',function(e){report('error',e.reason&&e.reason.message||e.reason);});",
		"addEventListener('securitypolicyviolation',function(e){report('warning','预览限制：'+e.violatedDirective+' '+e.blockedURI);});",
		"['error','warn'].forEach(function(k){var old=console[k];console[k]=function(){report(k==='warn'?'warning':'error',Array.from(arguments).map(String).join(' '));old.apply(console,arguments);};});",
		// 预览 UI 存储留在沙箱内；chat/message 写入仍由正式垫片拒绝。
		"window.__liyuanAuthorVarsRead=function(t){return parent.__liyuanPreviewUi[t]||{};};",
		"window.__liyuanAuthorVarsWrite=function(t,p,mode){var v=mode==='replace'?{}:window.__liyuanAuthorVarsRead(t);return parent.__liyuanPreviewUi[t]=Object.assign({},v,p);};",
		// DOM 摘要：agent 看不见屏幕，只能读这份（可见文本、元素数、标签分布、坏图、高度）。载入后报一次，父页请求快照时再报。
		"function __liyuanSummary(){var b=document.body;if(!b)return null;var els=b.getElementsByTagName('*'),tags={};for(var i=0;i<els.length;i++){var t=els[i].tagName.toLowerCase();tags[t]=(tags[t]||0)+1;}var imgs=b.getElementsByTagName('img'),broken=0;for(var j=0;j<imgs.length;j++){if(imgs[j].complete&&imgs[j].naturalWidth===0)broken++;}var text=(b.innerText||'').replace(/[ \\t]+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n');return JSON.stringify({text:text.slice(0,3000),textLength:text.length,elements:els.length,tags:tags,images:imgs.length,brokenImages:broken,height:document.documentElement.scrollHeight});}",
		"function __liyuanSnapshot(){var s=__liyuanSummary();if(s)report('dom',s);}",
		"addEventListener('load',function(){setTimeout(__liyuanSnapshot,800);});",
		"addEventListener('message',function(e){if(e.data&&e.data.liyuanPreviewSnapshot)__liyuanSnapshot();});",
	].join("\n");
	return doc.replace(/<head([^>]*)>/i, (_m, attrs: string) => "<head" + attrs + "><script>" + code + "</script>");
}

export function buildCardAuthoringPreview(
	data: CardProjectPreview,
	message: string,
	variables: Record<string, unknown>,
	token: string,
): string {
	// 与正式显示路径同源：宏 → MVU 挂载点补挂 → 显示规则 → HTML 分块 → 消息帧。
	const text = applyMacros(message, { charName: data.front.charName, userName: data.front.userName });
	// MVU 卡：正式运行时由 postprocess 在最新一条正文补挂占位点；预览同一条判据，让状态栏模板真的被触发
	const mounted = mountMvuPanel(text, data.front.rules);
	const parts = splitRichContentParts(mounted, { ...data.front, rules: rulesAtDepth(data.front.rules, 0) }).map((p, i) =>
		p.kind === "text" ? p : {
			kind: "html", doc: diagnostics(buildSrcDoc(p.html, p.scripts, true, 640), variables, "消息 " + (i + 1)),
			height: looksLikeProgramApp(p.html, p.scripts) ? 640 : 240,
		});
	const hostDoc = diagnostics(buildScriptHostDoc(), variables, "页面脚本");
	const boot = [
		"var token=" + json(token) + ",parts=" + json(parts) + ",frames=[];",
		"window.__liyuanPreviewUi={global:{},script:{}};",
		"window.__liyuanPreviewReport=function(level,source,message){parent.postMessage({liyuanCardPreview:{token:token,level:level,source:source,message:String(message)}},'*');};",
		"var report=window.__liyuanPreviewReport;",
		"window." + AUTHOR_SCRIPTS_GLOBAL + "=" + json(data.front.scripts) + ";",
		"window.triggerSlash=function(text){report('action','交互',text);return Promise.resolve('');};",
		"window.TavernHelper={generate:function(p){report('action','交互',p&&p.user_input||'生成请求');return Promise.resolve('');},stopAllGeneration:function(){}};",
		"var events=new Map();window.eventOn=function(n,f){if(!events.has(n))events.set(n,[]);events.get(n).push(f);};window.eventEmit=function(n){var args=Array.from(arguments).slice(1);(events.get(n)||[]).forEach(function(f){f.apply(null,args);});};",
		"window.__liyuanToast=function(level,text){report(level,'提示',text);};",
		"function frame(doc,height,name){var f=document.createElement('iframe');f.name=name;f.title=name;f.sandbox=" + json(SCRIPT_HOST_SANDBOX) + ";f.style.cssText='display:block;width:100%;border:0;height:'+height+'px';f.srcdoc=doc;frames.push(f);document.getElementById('root').appendChild(f);return f;}",
		"parts.forEach(function(p,i){if(p.kind==='text'){var el=document.createElement('div');el.className='text';el.textContent=p.text;document.getElementById('root').appendChild(el);}else frame(p.doc,p.height,'preview-message-'+i);});",
		"addEventListener('message',function(e){var f=frames.find(function(f){return f.contentWindow===e.source;});if(!f)return;var d=e.data||{};if(typeof d.liyuanFrameHeight==='number')f.style.height=Math.min(12000,Math.max(80,d.liyuanFrameHeight))+'px';if(d.liyuanVariablesReady)f.contentWindow.postMessage({liyuanVariables:" + json({ stat_data: variables }) + "},'*');});",
		data.front.scripts.length ? "var host=frame(" + json(hostDoc) + ",0,'preview-script-host');host.style.visibility='hidden';" : "",
		// 父页请求快照：转给每个帧，外层自己报纯文本段
		"addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.liyuanPreviewSnapshot){frames.forEach(function(f){try{f.contentWindow.postMessage({liyuanPreviewSnapshot:true},'*');}catch(x){}});report('dom','预览',JSON.stringify({text:(document.getElementById('root').innerText||'').slice(0,3000),frames:frames.length}));}});",
		"report('ready','预览','已加载');",
	].join("\n");
	// connect-src 限制也由 srcdoc 子帧继承，预览不能调用正式 REST/WS 改剧情。
	const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; style-src 'unsafe-inline' https: http:; img-src https: http: data: blob:; font-src https: http: data:; media-src https: http: data: blob:; frame-src 'self' about: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
	return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"" + csp +
		"\"><style>html,body{margin:0;background:#faf8f5;color:#302d29;font:14px/1.6 system-ui}*{box-sizing:border-box}.text{white-space:pre-wrap;padding:12px}#root{min-height:100vh}</style></head><body><main id=\"root\"></main><script>" +
		boot + "</script></body></html>";
}
