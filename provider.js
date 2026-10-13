(function(root){
'use strict';
function unpack(result){
 if(result?.ok)return result.data;
 const detail=result?.error||{};const e=new Error(detail.message||'连接暂时不可用。');Object.assign(e,detail);throw e;
}
class LocalProvider{
 constructor(){this.mode='local';this.namespace='local:'+location.origin;this.session=null;}
 async resume(){try{const s=JSON.parse(localStorage.getItem('shiye.local-session')||'null');if(s&&s.expiresAt>Date.now())this.session=s;}catch{}return this.session;}
 async login(username,password,register=false){
  const r=await fetch('/api/local/'+(register?'register':'login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  this.session=unpack(await r.json());localStorage.setItem('shiye.local-session',JSON.stringify(this.session));return this.session;
 }
 async logout(){this.session=null;localStorage.removeItem('shiye.local-session');}
 async rpc(action,payload={}){
  const token=this.session?.token;
  const r=await fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},body:JSON.stringify({action,payload}),signal:AbortSignal.timeout(20000)});
  return unpack(await r.json());
 }
 subscribe(){return {close(){}};}
}
async function make(config){
 if(config.mode!=='cloud')return new LocalProvider();
 if(!config.cloudbase?.envId)throw new Error('尚未配置云环境，请先完成部署。');
 if(!root.CloudBaseProvider)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='./cloudbase-adapter.js';script.onload=resolve;script.onerror=()=>reject(new Error('云连接模块未构建或无法加载。'));document.head.append(script);});
 return new root.CloudBaseProvider(config);
}
root.JournalProviders={make,unpack};
})(globalThis);
