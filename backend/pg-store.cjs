'use strict';
const collections=new Set(['records','history','change_log','sync_meta','sync_ops','widget_tokens']);
class PgStore{
 constructor({envId,apiKey,fetchImpl=fetch}={}){
  if(!envId||!apiKey)throw new Error('CloudBase PostgreSQL server credentials are not configured.');
  this.url='https://'+envId+'.api.tcloudbasegateway.com/v1/rdb/rest/rpc/shiye_store';this.apiKey=apiKey;this.fetch=fetchImpl;
 }
 async call(action,params={}){
  const response=await this.fetch(this.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.apiKey},body:JSON.stringify({p_action:action,p_args:params}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('PostgreSQL request failed ('+response.status+').');
  return response.json();
 }
 check(c){if(!collections.has(c))throw new Error('Unsupported journal collection.');}
 async read(c,id){this.check(c);return this.call('get',{collection:c,id});}
 async get(c,id){return (await this.read(c,id))?.value||null;}
 async list(c,ownerId){
  this.check(c);const all=[];
  for(let offset=0;offset<=10000;offset+=100){const batch=await this.call('list',{collection:c,ownerId,offset});all.push(...batch);if(batch.length<100)return all;}
  throw new Error('Too many records; archive older notes first.');
 }
 async atomic(work){
  for(let attempt=0;attempt<5;attempt++){
   const reads=new Map(),writes=new Map(),key=(c,id)=>c+'|'+id;
   const load=async(c,id)=>{
    this.check(c);const k=key(c,id);if(!reads.has(k)){const r=await this.read(c,id);reads.set(k,{collection:c,id,version:r?.version||0,value:r?.value||null});}
    return reads.get(k);
   };
   const result=await work({
    get:async(c,id)=>structuredClone(writes.get(key(c,id))?.value??(await load(c,id)).value),
    set:async(c,id,value)=>{await load(c,id);writes.set(key(c,id),{collection:c,id,value:structuredClone(value)});}
   });
   if(!writes.size)return result;
   const committed=await this.call('commit',{reads:[...reads.values()].map(({value,...r})=>r),writes:[...writes.values()]});
   if(committed===true)return result;
  }
  const e=new Error('Cloud records are busy. Please retry.');e.code='RETRY';throw e;
 }
}
module.exports={PgStore};
