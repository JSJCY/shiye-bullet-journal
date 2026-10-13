(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./journal-core.js'):root.JournalCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.JournalSyncModel=api;})(globalThis,function(Core){
'use strict';
const clone=value=>JSON.parse(JSON.stringify(value));
const keyOf=e=>'record:'+(e.type==='task'?e.taskId:e.id);
const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
function groups(raw){
  const map=new Map();
  for(const entry of Core.normalize(raw)){const key=keyOf(entry);if(!map.has(key))map.set(key,{key,revision:0,entries:[]});const g=map.get(key);g.entries.push(entry);g.revision=Math.max(g.revision,entry.revision);}
  for(const g of map.values())g.entries.sort((a,b)=>a.id.localeCompare(b.id));
  return map;
}
function visible(raw){return Core.normalize(raw).filter(e=>!e.trashedAt);}
function setTrashed(raw,selections,trashed=true,now=new Date()){
 const entries=Core.normalize(raw),map=groups(entries),selected=new Map(selections.map(s=>[s.key,s.revision]));
 const at=new Date(now).toISOString();
 for(const [key,revision]of selected){const g=map.get(key);if(!g||g.revision!==revision)throw new Error('记录已在其他窗口变化，请重新查看列表后操作。');}
 const histories=new Map();
 for(const [key]of selected){const g=map.get(key),entry=Core.taskFor(g.entries,g.entries[0]);if(Boolean(entry.trashedAt)===trashed)continue;histories.set(key,{revision:g.revision+1,history:[...entry.history,{id:uid(),kind:trashed?'trashed':'restored',at}]});}
 const result=Core.normalize(entries.map(entry=>{const change=histories.get(keyOf(entry));return change?{...entry,...clone(change),trashedAt:trashed?at:null,updatedAt:at}:entry;}));
 if(trashed&&histories.size){
  try{
   const next=groups(result),selections=[...histories.keys()].map(key=>({key,revision:next.get(key).revision}));
   for(const operation of diff(entries,result,'trash-check'))validateOperation(operation);
   const restored=setTrashed(result,selections,false,now).map(entry=>histories.has(keyOf(entry))?{...entry,receivedAt:entry.receivedAt||at,serverUpdatedAt:at}:entry);
   for(const operation of diff(result,restored,'restore-check'))validateOperation(operation);
  }catch{throw new Error('所选记录历史或体积过大，无法保证完整恢复。请先导出备份；本次未移动。');}
 }
 return result;
}
function diff(before,after,deviceId){
  const old=groups(before),fresh=groups(after),operations=[];
  for(const [key,g] of fresh){const previous=old.get(key);if(!previous||JSON.stringify(previous.entries)!==JSON.stringify(g.entries)){
    operations.push({opId:uid(),deviceId,key,baseRevision:previous?.revision??-1,entries:clone(g.entries),occurredAt:new Date().toISOString()});
  }}
  for(const key of old.keys())if(!fresh.has(key))throw new Error('记录不能直接删除，请先划掉并保留历史。');
  return operations;
}
function replace(entries,key,incoming){return Core.normalize([...entries.filter(e=>keyOf(e)!==key),...clone(incoming||[])]);}
function validateOperation(op){
  if(!op||typeof op!=='object'||typeof op.opId!=='string'||!/^[\w.:-]{1,128}$/.test(op.opId)||typeof op.key!=='string'||op.key.length>180||!Number.isInteger(op.baseRevision)||op.baseRevision< -1)throw new Error('同步操作格式无效。');
  if(!Array.isArray(op.entries)||!op.entries.length||op.entries.length>200||JSON.stringify(op.entries).length>600000)throw new Error('单项记录过大，请导出备份后精简。');
  const clean=op.entries.map(e=>{
    if(!e||typeof e.id!=='string'||!/^[\w.:-]{1,128}$/.test(e.id)||typeof e.text!=='string'||!e.text.trim()||e.text.length>2000||String(e.memo||'').length>4000)throw new Error('记录内容或标识无效。');
    const allowed=['id','text','type','status','priority','inspiration','location','date','collection','taskId','taskState','eventState','sourceId','target','createdAt','updatedAt','recordedAt','startedAt','completedAt','occurredAt','cancelledAt','plannedDate','plannedTime','dueDate','dueTime','history','revision','memo','trashedAt','receivedAt','serverUpdatedAt'];
    const x=Object.fromEntries(allowed.filter(k=>Object.hasOwn(e,k)).map(k=>[k,clone(e[k])]));
    if(!Number.isInteger(x.revision)||x.revision<0||!Array.isArray(x.history)||x.history.length>2000)throw new Error('记录版本或历史无效。');
    for(const k of ['createdAt','updatedAt','recordedAt','startedAt','completedAt','occurredAt','cancelledAt','trashedAt'])if(x[k]!=null&&!Number.isFinite(Date.parse(x[k])))throw new Error('记录时间无效。');
    return x;
  });
  const map=groups(clean);
  if(map.size!==1||!map.has(op.key))throw new Error('一次操作必须包含同一项任务的完整迁移链。');
  const g=map.get(op.key);
  if(g.revision<=op.baseRevision)throw new Error('同步版本没有前进。');
  const ids=new Set(g.entries.map(e=>e.id));
  for(const e of g.entries)if(e.type==='task'&&((e.sourceId&&!ids.has(e.sourceId))||(e.target&&!ids.has(e.target))))throw new Error('任务迁移链缺少来源或去向。');
  return g;
}
function summary(raw,now=new Date(),updatedAt=null){
  const entries=Core.normalize(raw,now).filter(e=>!e.trashedAt),today=Core.getToday(now),tasks=Core.activeTasks(entries);
  const selected=tasks.filter(e=>e.taskState!=='cancelled'&&((e.plannedDate||(e.location==='daily'?e.date:null))===today||e.dueDate===today||(e.completedAt&&Core.getToday(new Date(e.completedAt))===today)));
  const completed=selected.filter(e=>e.taskState==='completed');
  const overdue=tasks.filter(e=>['open','doing'].includes(e.taskState)&&Core.isLate(e,now));
  const pending=[...new Map([...selected.filter(e=>['open','doing'].includes(e.taskState)),...overdue].map(e=>[e.taskId,e])).values()].sort((a,b)=>Number(b.priority)-Number(a.priority)||(a.dueDate||a.plannedDate||'9999').localeCompare(b.dueDate||b.plannedDate||'9999'));
  const simplify=e=>({id:e.id,taskId:e.taskId||null,text:e.text,priority:e.priority,symbol:e.type==='event'?'○':e.taskState==='completed'?'×':'•',state:e.eventState||e.taskState,plannedTime:e.plannedTime||null,overdue:e.type==='task'&&Core.isLate(e,now)});
  return {date:today,timeZone:'Asia/Shanghai',updatedAt,total:selected.length,completed:completed.length,overdue:overdue.length,pending:pending.slice(0,8).map(simplify),events:entries.filter(e=>e.type==='event'&&(e.plannedDate||e.date)===today&&e.eventState!=='cancelled').sort((a,b)=>(a.plannedTime||'99:99').localeCompare(b.plannedTime||'99:99')).slice(0,5).map(simplify)};
}
return {clone,keyOf,uid,groups,visible,setTrashed,diff,replace,validateOperation,summary};
});
