(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./sync-model.js'):root.JournalSyncModel,typeof module==='object'&&module.exports?require('./journal-core.js'):root.JournalCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.JournalSync=api;})(globalThis,function(Model,Core){
'use strict';
const blank=()=>({schema:1,entries:null,base:{},outbox:[],conflicts:[],drafts:[],cursor:0,updatedAt:null});
class Cache{
  constructor(indexedDB=globalThis.indexedDB,name='shiye-journal-v3'){this.indexedDB=indexedDB;this.name=name;}
  async open(){
    if(this.db)return this.db;if(this.opening)return this.opening;
    if(!this.indexedDB)throw new Error('当前浏览器无法使用本地数据库，请先导出笔记。');
    this.opening=new Promise((resolve,reject)=>{const r=this.indexedDB.open(this.name,1);r.onupgradeneeded=()=>r.result.createObjectStore('accounts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('请关闭旧窗口后重试。'));});
    try{this.db=await this.opening;}finally{this.opening=null;}
    this.db.onversionchange=()=>{this.db.close();this.db=null;};return this.db;
  }
  async read(scope){const db=await this.open();return new Promise((resolve,reject)=>{const r=db.transaction('accounts').objectStore('accounts').get(scope);r.onsuccess=()=>resolve(r.result?Model.clone(r.result):null);r.onerror=()=>reject(r.error);});}
  async update(scope,change){
    const db=await this.open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('accounts','readwrite'),store=tx.objectStore('accounts'),r=store.get(scope);let result;
      r.onsuccess=()=>{try{result=change(Model.clone(r.result||blank()));if(result?.then)throw new Error('本地事务不能等待网络。');store.put(result,scope);}catch(e){reject(e);tx.abort();}};
      tx.oncomplete=()=>resolve(Model.clone(result));tx.onerror=()=>reject(tx.error||new Error('本地保存失败。'));tx.onabort=()=>reject(tx.error||new Error('本地保存已取消。'));
    });
  }
}
class Engine{
  constructor({cache=new Cache(),onChange=()=>{},onStatus=()=>{},deviceId=Model.uid(),online=()=>globalThis.navigator?.onLine!==false}={}){
    Object.assign(this,{cache,onChange,onStatus,deviceId,online,scope:'guest',owner:null,provider:null,state:blank(),epoch:0,syncing:false,error:null});
    if(typeof window!=='undefined'){
      if(typeof BroadcastChannel!=='undefined'){this.channel=new BroadcastChannel('shiye-journal-v3');this.channel.onmessage=e=>{if(e.data.scope===this.scope)this.reload().catch(e=>this.problem(e));};}
      window.addEventListener('storage',e=>{if(e.key==='shiye.journal.changed')this.reload().catch(e=>this.problem(e));});
      window.addEventListener('online',()=>this.flush().catch(e=>this.problem(e)));
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.reload().then(()=>this.flush()).catch(e=>this.problem(e));});
    }
  }
  status(){return {owner:this.owner,mode:this.owner?this.provider?.mode:'guest',pending:this.state.outbox.length,conflicts:this.state.conflicts.length,syncing:this.syncing,online:this.online(),updatedAt:this.state.updatedAt,error:this.error};}
  problem(e){this.error=e.message||'同步暂时不可用。';this.onStatus(this.status());}
  publish(state,scope=this.scope){if(scope!==this.scope)return;this.state=state;this.onChange(Model.clone(state.entries||[]),this.status());this.onStatus(this.status());}
  signal(scope=this.scope){this.channel?.postMessage({scope});if(typeof localStorage!=='undefined')try{localStorage.setItem('shiye.journal.changed',JSON.stringify({scope,at:Date.now(),id:Model.uid()}));}catch{}}
  async init(seed=[]){const s=await this.cache.update('guest',x=>{if(x.entries===null)x.entries=Core.normalize(seed);return x;});this.publish(s);return s.entries;}
  async reload(){const scope=this.scope,s=await this.cache.read(scope);if(s)this.publish(s,scope);return s;}
  async connect(provider,identity,{deferSync=false}={}){
    this.epoch++;this.provider=provider;this.owner=identity.ownerId;this.error=null;
    this.scope=provider.namespace+':'+this.owner;
    const s=await this.cache.update(this.scope,x=>{if(x.entries===null)x.entries=[];return x;});this.publish(s);this.signal();
    if(deferSync)void this.flush().catch(e=>this.problem(e));else await this.flush();return this.status();
  }
  async disconnect(){this.epoch++;this.owner=null;this.provider=null;this.scope='guest';this.error=null;const s=await this.cache.read('guest');this.publish(s||blank());this.signal();}
  async mutate(change,{expectedScope=this.scope}={}){
    const scope=this.scope,connected=!!this.owner;
    if(scope!==expectedScope)throw new Error('账号已切换，请重新打开列表。');
    const s=await this.cache.update(scope,x=>{
      if(this.scope!==scope)throw new Error('账号已切换，操作未执行。');
      const before=Core.normalize(x.entries||[]),after=Core.normalize(change(Model.clone(before)));
      const ops=Model.diff(before,after,this.deviceId);
      x.entries=after;
      if(connected)for(const op of ops){const conflict=x.conflicts.find(c=>c.key===op.key);if(conflict)conflict.local=op.entries;x.outbox.push(op);}
      return x;
    });
    this.error=null;this.publish(s,scope);this.signal(scope);if(connected)void this.flush().catch(e=>this.problem(e));return s.entries;
  }
  async importEntries(raw){
    const imported=Core.normalize(raw);let added=0,skipped=0;
    if(imported.length)await this.mutate(current=>{
      const existing=Model.groups(current),fresh=[];
      for(const [key,g]of Model.groups(imported)){if(existing.has(key)){skipped++;continue;}fresh.push(...g.entries);added++;}
      return [...current,...fresh];
    });
    return {added,skipped};
  }
  async importGuest(){const guest=await this.cache.read('guest');return this.importEntries(guest?.entries||[]);}
  async legacyPreview(mode='cleanup'){
    if(!this.owner)throw new Error('请先登录需要清理的账号。');
    const scope=this.scope,guest=await this.cache.read('guest');
    if(scope!==this.scope)throw new Error('账号已切换，请重新打开列表。');
    const old=Model.groups(guest?.entries||[]),current=Model.groups(this.state.entries||[]),candidates=[];
    for(const [key,g]of old){
      const present=current.get(key),source=Core.taskFor(g.entries,g.entries[0]);
      if(mode==='import'){
        if(!present&&!source.trashedAt)candidates.push({...g,entry:source});
      }else if(present){
        const entry=Core.taskFor(present.entries,present.entries[0]);
        if(!entry.trashedAt)candidates.push({...present,entry,changed:entry.text!==source.text||entry.revision!==source.revision});
      }
    }
    return {scope,candidates};
  }
  async trashSelections(selections,{scope=this.scope,restore=false}={}){
    await this.mutate(raw=>Model.setTrashed(raw,selections,!restore),{expectedScope:scope});
    return selections.length;
  }
  async importSelection(preview,keys){
    if(preview.scope!==this.scope)throw new Error('账号已切换，请重新打开列表。');
    const selected=new Set(keys),raw=preview.candidates.filter(g=>selected.has(g.key)).flatMap(g=>g.entries);
    return this.importEntries(raw);
  }
  async flush(){
    if(!this.owner||!this.provider||!this.online()){this.onStatus(this.status());return;}
    if(this.running){await this.running;if(this.owner&&this.online())return this.flush();return;}
    const scope=this.scope,owner=this.owner,provider=this.provider,epoch=this.epoch;
    const active=()=>this.epoch===epoch&&this.scope===scope;
    this.syncing=true;this.onStatus(this.status());
    const rpc=async(action,payload={})=>{const r=await provider.rpc(action,{...payload,expectedOwner:owner});if(r.ownerId!==owner)throw new Error('登录账号已改变，笔记仍保留在原账号。');return r;};
    this.running=(async()=>{
      while(active()&&this.online()){
        const s=await this.cache.read(scope),blocked=new Set(s.conflicts.map(c=>c.key)),op=s.outbox.find(o=>!blocked.has(o.key));
        if(!op)break;
        try{
          const result=await rpc('apply',{operation:op});
          const next=await this.cache.update(scope,x=>{
            x.outbox=x.outbox.filter(o=>o.opId!==op.opId);x.base[op.key]=result.group;
            if(!x.outbox.some(o=>o.key===op.key))x.entries=Model.replace(x.entries,op.key,result.group.entries);
            x.updatedAt=result.group.updatedAt;return x;
          });this.publish(next,scope);this.signal(scope);
        }catch(e){
          if(e.code==='CONFLICT'||e.code==='INVALID'){
            const next=await this.cache.update(scope,x=>{
              const current=Model.groups(x.entries).get(op.key);
              if(!x.conflicts.some(c=>c.key===op.key))x.conflicts.push({key:op.key,local:current?.entries||op.entries,cloud:e.current||null,message:e.message,at:new Date().toISOString()});
              if(e.current)x.base[op.key]=e.current;return x;
            });this.publish(next,scope);this.signal(scope);continue;
          }
          throw e;
        }
      }
      if(!active()||!this.online())return;
      let more=true;
      while(more&&active()){
        const previous=await this.cache.read(scope),response=await rpc('pull',{cursor:previous.cursor});
        const next=await this.cache.update(scope,x=>{
          const pending=new Set(x.outbox.map(o=>o.key));
          for(const g of response.groups){
            if((x.base[g.key]?.version||0)>(g.version||0))continue;
            x.base[g.key]=g;if(!pending.has(g.key))x.entries=Model.replace(x.entries,g.key,g.entries);
          }
          x.cursor=response.cursor;x.updatedAt=response.updatedAt;return x;
        });this.publish(next,scope);this.signal(scope);more=response.hasMore;
      }
      if(active())this.error=null;
    })();
    try{await this.running;}catch(e){if(active())this.problem(e);}
    finally{this.running=null;if(active()){this.syncing=false;this.onStatus(this.status());}}
  }
  async resolve(key,mode){
    const scope=this.scope,now=new Date();
    const s=await this.cache.update(scope,x=>{
      const conflict=x.conflicts.find(c=>c.key===key);if(!conflict)throw new Error('冲突已在另一窗口处理。');
      x.drafts.push({...conflict,resolvedAt:now.toISOString()});x.outbox=x.outbox.filter(o=>o.key!==key);x.conflicts=x.conflicts.filter(c=>c.key!==key);
      const cloud=x.base[key]||conflict.cloud;if(!cloud&&mode==='cloud')throw new Error('请先重新同步获取云端版本。');
      x.entries=Model.replace(x.entries,key,cloud?.entries||[]);
      if(mode==='note'){
        const original=Core.taskFor(conflict.local,conflict.local[0])||conflict.local[0];
        const note=Core.makeEntry({type:'note',text:('冲突草稿 · '+original.text).slice(0,2000),location:'daily',date:Core.getToday(now)},now);
        const after=[...x.entries,note];x.outbox.push(...Model.diff(x.entries,after,this.deviceId));x.entries=after;
      }
      return x;
    });this.publish(s,scope);this.signal(scope);void this.flush().catch(e=>this.problem(e));
  }
  async backup(){return {version:3,exportedAt:new Date().toISOString(),entries:Model.clone(this.state.entries||[]),outbox:Model.clone(this.state.outbox),conflicts:Model.clone(this.state.conflicts),drafts:Model.clone(this.state.drafts)};}
}
return {Cache,Engine,blank};
});
