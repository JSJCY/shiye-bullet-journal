'use strict';
const crypto=require('node:crypto');
const Model=require('../sync-model.js');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const docId=(owner,key)=>hash(owner+'|'+key).slice(0,40);
class ApiError extends Error{constructor(code,message,extra={}){super(message);this.code=code;Object.assign(this,extra);}}
const fail=(code,message,extra)=>{throw new ApiError(code,message,extra);};
function createService(store,clock=()=>new Date()){
  async function apply(owner,op){
    let group;try{group=Model.validateOperation(op);}catch(e){fail('INVALID',e.message);}
    const payloadHash=hash(JSON.stringify({key:op.key,baseRevision:op.baseRevision,entries:op.entries}));
    return store.atomic(async tx=>{
      const dedupId=docId(owner,op.opId),previous=await tx.get('sync_ops',dedupId);
      if(previous){if(previous.payloadHash!==payloadHash)fail('INVALID','同一操作标识不能用于不同内容。');return previous.result;}
      const collection='records',id=docId(owner,op.key),current=await tx.get(collection,id);
      if((current?.revision??-1)!==op.baseRevision)fail('CONFLICT','这条记录已在另一设备更新，草稿已保留。',{current:current||{key:op.key,revision:-1,entries:[]}});
      if(current){const ids=new Set(group.entries.map(e=>e.id));if(current.entries.some(e=>!ids.has(e.id)))fail('INVALID','不能丢弃已有的迁移历史。');}
      const at=clock().toISOString(),metaId=docId(owner,'meta'),meta=await tx.get('sync_meta',metaId)||{ownerId:owner,version:0};
      const version=meta.version+1;
      const value={ownerId:owner,key:group.key,revision:group.revision,entries:group.entries.map(e=>({...e,receivedAt:at,serverUpdatedAt:at})),version,updatedAt:at};
      await tx.set(collection,id,value);
      await tx.set('history',docId(owner,op.opId),{ownerId:owner,key:op.key,opId:op.opId,deviceId:String(op.deviceId||'').slice(0,128),occurredAt:op.occurredAt||null,receivedAt:at,baseRevision:op.baseRevision,revision:group.revision});
      await tx.set('change_log',docId(owner,String(version)),{ownerId:owner,version,key:group.key});
      await tx.set('sync_meta',metaId,{ownerId:owner,version,updatedAt:at});
      const result={ownerId:owner,group:value,version};
      await tx.set('sync_ops',dedupId,{ownerId:owner,payloadHash,result,receivedAt:at});
      return result;
    });
  }
  async function pull(owner,cursor=0){
    if(!Number.isSafeInteger(cursor)||cursor<0)fail('INVALID','同步游标无效。');
    for(let attempt=0;attempt<3;attempt++){
      const before=await store.get('sync_meta',docId(owner,'meta'))||{version:0,updatedAt:null};
      let selected,nextCursor=before.version,hasMore=false;
      if(cursor===0||cursor>before.version){selected=await store.list('records',owner);}
      else{
        const changes=(await store.list('change_log',owner)).filter(e=>e.version>cursor&&e.version<=before.version).sort((a,b)=>a.version-b.version).slice(0,100);
        nextCursor=changes.length?changes.at(-1).version:before.version;hasMore=nextCursor<before.version;
        selected=await Promise.all([...new Set(changes.map(e=>e.key))].map(key=>store.get('records',docId(owner,key))));
      }
      const after=await store.get('sync_meta',docId(owner,'meta'))||{version:0};
      if(before.version===after.version)return {ownerId:owner,groups:selected.filter(Boolean),cursor:nextCursor,hasMore,reset:cursor===0||cursor>before.version,updatedAt:before.updatedAt};
    }
    fail('RETRY','记录正在更新，请稍后重试。');
  }
  async function rpc(owner,action,payload={}){
    if(!owner||typeof owner!=='string')fail('AUTH','请先登录。');
    if(payload.expectedOwner&&payload.expectedOwner!==owner)fail('AUTH','登录账号已改变，请重新同步。');
    if(action==='me')return {ownerId:owner,metaId:docId(owner,'meta')};
    if(action==='apply')return apply(owner,payload.operation);
    if(action==='pull')return pull(owner,payload.cursor||0);
    if(action==='tokens'){
      const tokens=(await store.list('widget_tokens',owner)).filter(e=>!e.revoked);
      return {ownerId:owner,tokens:tokens.map(({id,label,createdAt})=>({id,label,createdAt}))};
    }
    if(action==='createToken'){
      const existing=(await store.list('widget_tokens',owner)).filter(e=>!e.revoked);
      if(existing.length>=10)fail('INVALID','请先撤销不用的小组件凭据。');
      const token='shiye_w_'+crypto.randomBytes(32).toString('base64url'),id=hash(token),createdAt=clock().toISOString();
      await store.atomic(tx=>tx.set('widget_tokens',id,{id,ownerId:owner,label:String(payload.label||'iPhone 小组件').slice(0,64),createdAt,revoked:false}));
      return {ownerId:owner,id,token,createdAt};
    }
    if(action==='revokeToken'){
      if(!/^[a-f0-9]{64}$/.test(payload.id||''))fail('INVALID','凭据标识无效。');
      return store.atomic(async tx=>{const x=await tx.get('widget_tokens',payload.id);if(!x||x.ownerId!==owner)fail('NOT_FOUND','找不到此凭据。');await tx.set('widget_tokens',payload.id,{...x,revoked:true,revokedAt:clock().toISOString()});return {ownerId:owner,revoked:true};});
    }
    fail('NOT_FOUND','接口不存在。');
  }
  async function today(token){
    if(!/^shiye_w_[A-Za-z0-9_-]{43}$/.test(token||''))fail('AUTH','小组件凭据无效或已撤销。');
    const permission=await store.get('widget_tokens',hash(token));
    if(!permission||permission.revoked)fail('AUTH','小组件凭据无效或已撤销。');
    const snapshot=await pull(permission.ownerId,0);
    return Model.summary(snapshot.groups.flatMap(g=>g.entries),clock(),snapshot.updatedAt);
  }
  return {rpc,today};
}
module.exports={createService,ApiError,docId,hash};
