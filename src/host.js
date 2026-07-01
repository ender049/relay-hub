(function(){
const STORE_KEYS=['apm_s','apm_ch','apm_tab','apm_font','relay_theme','apm_ar'];
const memStore={};
let storeSig='';
const pendingFetch={};
const pendingCopy=[];
const pendingSidePanel=[];
const pendingSiteTokens=[];
const pendingSiteLogin=[];
const hasHost=window.parent!==window;
const inExtensionPage=/extension:/i.test(location.protocol);
const defaultCapabilities={ready:false,platform:inExtensionPage?'extension-page':'standalone',nativeFetch:hasHost,openSidePanel:false,siteLogin:false,siteTokenRead:false,browserFetch:false,browserFetchContext:'',loginAutofill:false,loginTargetName:'登录页',tokenSourceName:'登录页'};
let hostCapabilities={...defaultCapabilities};
const listeners={store:[],openMode:[],capabilities:[]};
function hasMem(k){return Object.prototype.hasOwnProperty.call(memStore,k)}
function curStoreSig(){return STORE_KEYS.map(k=>k+'='+(hasMem(k)?memStore[k]:'')).join('\n')}
function post(message){if(hasHost)window.parent.postMessage(message,'*')}
function getStore(k){if(hasHost)return hasMem(k)?memStore[k]:null;try{return localStorage.getItem(k)}catch{return hasMem(k)?memStore[k]:null}}
function setStore(k,v){memStore[k]=String(v);storeSig=curStoreSig();if(hasHost){post({type:'RELAY_STORE_SET',key:k,value:String(v)});return}try{localStorage.setItem(k,v)}catch{}}
function requestStore(){if(hasHost)post({type:'RELAY_STORE_GET'})}
function requestOpenMode(){if(hasHost)post({type:'RELAY_OPEN_MODE_GET'})}
function normalizeCapabilities(value){return{...defaultCapabilities,...(value&&typeof value==='object'?value:{}),ready:true}}
function requestCapabilities(){if(hasHost)post({type:'RELAY_HOST_CAPABILITIES_GET'})}
function capabilities(){return{...hostCapabilities}}
function hasCapability(name){return !!hostCapabilities[name]}
function setOpenMode(mode){if(hasHost)post({type:'RELAY_OPEN_MODE_SET',mode});else try{localStorage.setItem('relay_open_mode',mode)}catch{}}
function openSidePanel(){if(!hasHost)return Promise.resolve({ok:false,error:'请在扩展弹窗中打开侧边栏'});return new Promise(resolve=>{pendingSidePanel.push(resolve);post({type:'RELAY_OPEN_SIDEPANEL'})})}
async function copyText(text){if(!hasHost){try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(String(text||''));return{ok:true}}}catch(e){return{ok:false,error:e&&e.message?e.message:String(e)}}return{ok:false,error:'剪贴板不可用'}}return new Promise(resolve=>{pendingCopy.push(resolve);post({type:'RELAY_COPY_TEXT',text:String(text||'')})})}
function fetchViaHost(payload){if(!hasHost)return Promise.resolve(null);const id='req_'+Date.now()+'_'+Math.random().toString(16).slice(2);return new Promise((resolve,reject)=>{pendingFetch[id]=resolve;post({type:'CPA_CHANNEL_FETCH',id,payload});setTimeout(()=>{if(pendingFetch[id]){delete pendingFetch[id];reject(new Error('扩展请求超时'))}},30000)})}
function openSiteLogin(payload){if(!hasHost)return Promise.resolve({ok:false,error:'客户端宿主不可用'});return new Promise(resolve=>{pendingSiteLogin.push(resolve);post({type:'RELAY_OPEN_SITE_LOGIN',payload:payload||{}})})}
function readSiteTokens(siteUrl,siteType){if(!hasHost)return Promise.resolve({ok:false,error:'请从扩展弹窗、侧边栏或客户端读取站点令牌'});return new Promise(resolve=>{pendingSiteTokens.push(resolve);post({type:'RELAY_READ_SITE_TOKENS',siteUrl,siteType})})}
function openExternal(url){const target=String(url||'');if(!target)return;if(hasHost){post({type:'RELAY_OPEN_EXTERNAL',url:target});return}window.open(target,'_blank','noopener,noreferrer')}
function onStoreData(fn){listeners.store.push(fn)}
function onOpenModeData(fn){listeners.openMode.push(fn)}
function onCapabilitiesData(fn){listeners.capabilities.push(fn)}
window.addEventListener('message',e=>{const m=e.data;if(!m)return;if(m.type==='RELAY_STORE_DATA'&&m.data){Object.assign(memStore,m.data);const sig=curStoreSig();if(sig===storeSig)return;storeSig=sig;listeners.store.forEach(fn=>fn(m.data,sig));return}if(m.type==='RELAY_OPEN_MODE_DATA'){listeners.openMode.forEach(fn=>fn(m.mode));return}if(m.type==='RELAY_HOST_CAPABILITIES'){hostCapabilities=normalizeCapabilities(m.capabilities||m.data);listeners.capabilities.forEach(fn=>fn(capabilities()));return}if(m.type==='RELAY_COPY_TEXT_RESULT'){const resolve=pendingCopy.shift();if(resolve)resolve({ok:!!m.ok,error:m.error||''});return}if(m.type==='RELAY_OPEN_SIDEPANEL_RESULT'){const resolve=pendingSidePanel.shift();if(resolve)resolve(m.response||{ok:true});return}if(m.type==='RELAY_OPEN_SITE_LOGIN_RESULT'){const resolve=pendingSiteLogin.shift();if(resolve)resolve(m.response||{ok:false,error:'宿主无响应'});return}if(m.type==='RELAY_READ_SITE_TOKENS_RESULT'){const resolve=pendingSiteTokens.shift();if(resolve)resolve(m.response||{ok:false,error:'宿主无响应'});return}if(m.type==='CPA_CHANNEL_FETCH_RESULT'&&m.id&&pendingFetch[m.id]){pendingFetch[m.id](m.response);delete pendingFetch[m.id]}});
window.RelayHost={hasHost,inExtensionPage,getStore,setStore,requestStore,requestOpenMode,requestCapabilities,capabilities,hasCapability,setOpenMode,openSidePanel,copyText,fetch:fetchViaHost,openSiteLogin,readSiteTokens,openExternal,onStoreData,onOpenModeData,onCapabilitiesData,storeSignature:()=>storeSig};
})();
