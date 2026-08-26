/**
 * 页面级脚本宿主的 srcdoc（纯函数，供 ScriptHost 与测试）。
 *
 * 与 frameDoc 的分工：frameDoc 拼**消息级**帧（气泡内那份 HTML 界面），本文件拼
 * **页面级**帧（作者声明的运行时脚本）。两者共用同一份垫片与同一份 CSP，但定位相反——
 * 消息帧是要显示的内容，宿主帧自己不显示任何东西（0×0、隐藏），它的产物挂在**父页**。
 *
 * ## 为什么宿主帧必须是 iframe，而不是直接 eval 在梨园页面里
 * 1. **作者脚本就是写给这个形状的**：实测三个页面级 UI 脚本开头逐字都是
 *    `pdoc = (parent && parent.document) ? parent.document : document`——它们假定自己
 *    跑在一个子帧里、要跨一层去父页挂 DOM。酒馆助手就是这么跑的。直接在父页 eval，
 *    `parent` 是浏览器窗口本身，这段降级分支会把球挂到别处。
 * 2. **隔离炸弹**：一份 3.5MB 的作者脚本抛异常、死循环、污染全局，都关在帧里，
 *    梨园的 React 树不受影响；帧还能整个换掉（换卡即换帧）。
 * 3. **同源是必需的**：`sandbox` 必须带 `allow-same-origin`，否则 `parent.document`
 *    抛 SecurityError、脚本走降级分支把 UI 挂进这个 0×0 的帧里 = 用户什么也看不见。
 *
 * ## 作者代码不进 HTML
 * 载荷经 `parent.__liyuanAuthorScripts` 同源直读，再由加载器用 `textContent` 建
 * `<script>` 元素执行——**不拼进 srcdoc**。两个理由：
 * - 作者脚本里含字面量 `</script>`（拿模板串拼整页 HTML 的写法极常见），拼进 HTML
 *   会被解析器当场截断，frameDoc 为此专门写了个 JS 状态机（findScriptCloseIndex）。
 *   走 textContent 通道压根不经 HTML 解析，这类转义问题从根上不存在。
 * - 单份脚本实测可达 3.5MB，srcdoc 是个属性字符串，不该塞这个量级。
 */

import { SCRIPT_FRAME_CSP } from "./frameDoc.ts";
import { IFRAME_TAVERN_BRIDGE_SNIPPET, IFRAME_TAVERN_GLOBALS_SNIPPET } from "./tavernShim.ts";

/** 父页挂载点：宿主帧同源直读这个全局取脚本（挂 window 而非模块变量，跨帧才看得见） */
export const AUTHOR_SCRIPTS_GLOBAL = "__liyuanAuthorScripts";

/**
 * 加载器：同源读父页清单 → 逐条建 `<script>` 执行。
 *
 * - **逐条独立**：一条一个 `<script>` 元素，各是独立编译单元。某条语法错误只废它自己，
 *   后面的照跑（拼成一大段就是一错全废）。
 * - **顺序同步**：同步 append 保证按清单顺序执行（预设在前、卡在后，见 authorScripts.ts）。
 * - **报回父页**：跑完发一帧 `liyuanScriptHostBooted`，父页据此确认宿主活了（诊断用，
 *   不参与任何判据）。
 */
const LOADER_SNIPPET = `<script>(function(){
try{
  var g=window;
  function parentWin(){try{return (g.parent&&g.parent!==g)?g.parent:null;}catch(e){return null;}}
  function readList(){
    try{ var p=parentWin(); return p?p["${AUTHOR_SCRIPTS_GLOBAL}"]:null; }catch(e){ return null; }
  }
  function run(list){
    var ok=0,bad=0;
    for(var i=0;i<list.length;i++){
      var item=list[i]||{};
      try{
        var el=document.createElement("script");
        el.setAttribute("data-liyuan-author-script",String(item.id||i));
        el.textContent=String(item.content||"");
        document.body.appendChild(el);
        ok++;
      }catch(e){ bad++; console.error("[liyuan scriptHost] 脚本执行失败",item&&item.name,e); }
    }
    try{
      var pw=parentWin();
      if(pw)pw.postMessage({liyuanScriptHostBooted:{ok:ok,failed:bad,total:list.length}},"*");
    }catch(e2){}
  }
  // 父页在渲染期就挂好了清单，正常一次就读到。轮询只是兜底（并发渲染/提交时序的意外），
  // 读到即跑、超时即算这张卡没脚本——不重试、不报错弹窗。
  var tries=0;
  (function poll(){
    var list=readList();
    if(list&&list.length)return run(list);
    if(++tries>60)return;
    setTimeout(poll,16);
  })();
}catch(e){console.error("[liyuan scriptHost loader]",e);}
})();</script>`;

/**
 * 宿主帧文档。自身不渲染任何内容（透明、零尺寸），只提供一个跑脚本的同源沙箱。
 * 垫片顺序与消息帧一致：bridge → globals → 加载器，保证 `$`/`errorCatched`/
 * `getAllVariables`/`Mvu`/`toastr` 在作者第一行代码前就位。
 */
export function buildScriptHostDoc(): string {
	return (
		`<!doctype html><html><head>` +
		`<meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${SCRIPT_FRAME_CSP}">` +
		`<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>` +
		IFRAME_TAVERN_BRIDGE_SNIPPET +
		IFRAME_TAVERN_GLOBALS_SNIPPET +
		`</head><body>` +
		LOADER_SNIPPET +
		`</body></html>`
	);
}

/** 宿主帧沙箱：same-origin 是硬需求（见文件头②③），其余对齐脚本型消息帧 */
export const SCRIPT_HOST_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";
