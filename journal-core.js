(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JournalCore = api;
})(globalThis, function () {
  'use strict';
  const TASK_STATES = ['open', 'doing', 'completed', 'cancelled'];
  const ENTRY_STATES = [...TASK_STATES, 'migrated', 'scheduled'];
  const EVENT_STATES = ['planned', 'occurred', 'cancelled'];
  const ARCHIVED = ['migrated', 'scheduled'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const clock = now => now instanceof Date ? now : new Date(now || Date.now());
  const stamp = now => clock(now).toISOString();
  function getToday(now) {
    const parts = new Intl.DateTimeFormat('en', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(clock(now));
    return ['year','month','day'].map(name => parts.find(part => part.type === name).value).join('-');
  }
  function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
  }
  function isValidMonth(value) { return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
  function isValidTime(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
  const empty = value => value === '' || value === undefined ? null : value;
  function timeValue(date, time, endOfDay = false) {
    return date ? Date.parse(date + 'T' + (time || (endOfDay ? '23:59:59.999' : '00:00:00')) + '+08:00') : NaN;
  }
  function validatePlacement(entry, now, enforceFuture = false) {
    if (!['daily','monthly','future','collection'].includes(entry.location)) throw new Error('请选择有效的目标页面。');
    if (entry.location === 'monthly' && !isValidMonth(entry.date)) throw new Error('请选择有效的月份。');
    if (['daily','future'].includes(entry.location) && !isValidDate(entry.date)) throw new Error('请选择有效的日期。');
    if (entry.location === 'collection' && !String(entry.collection || '').trim()) throw new Error('请选择主题集合。');
    if (enforceFuture && entry.location === 'future' && entry.date <= getToday(now)) throw new Error('未来计划的日期需要晚于今天。');
  }
  function validateTiming(entry, checkOrder = true) {
    for (const key of ['plannedDate','dueDate']) if (entry[key] && !isValidDate(entry[key])) throw new Error('请填写有效日期。');
    for (const key of ['plannedTime','dueTime']) if (entry[key] && !isValidTime(entry[key])) throw new Error('请填写有效时间。');
    if (entry.plannedTime && !entry.plannedDate) throw new Error('设置计划时间前，请先选择计划日期。');
    if (entry.dueTime && !entry.dueDate) throw new Error('设置截止时间前，请先选择截止日期。');
    if (checkOrder && entry.plannedDate && entry.dueDate && timeValue(entry.dueDate,entry.dueTime,true) < timeValue(entry.plannedDate,entry.plannedTime)) throw new Error('截止时间不能早于计划时间。');
  }
  const placement = entry => ({location:entry.location,date:entry.date,collection:entry.collection || null});
  function normalize(raw, now) {
    if (!Array.isArray(raw)) throw new Error('无法读取保存的笔记，请先备份原始数据。');
    const entries = clone(raw), ids = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.text !== 'string' || !['task','event','note'].includes(entry.type)) throw new Error('笔记数据有无效或重复条目，请先备份。');
      ids.add(entry.id);
      if (!ENTRY_STATES.includes(entry.status)) throw new Error('笔记状态无法识别，请先备份。');
      validatePlacement(entry,now);
      entry.priority = Boolean(entry.priority); entry.inspiration = Boolean(entry.inspiration);
      const legacyEventTime=entry.type==='event' && !Object.hasOwn(entry,'plannedTime') ? /^(\d{1,2}):(\d{2})\s/.exec(entry.text) : null;
      for (const key of ['createdAt','updatedAt','startedAt','completedAt','occurredAt','cancelledAt','plannedDate','plannedTime','dueDate','dueTime']) entry[key] = empty(entry[key]) ?? null;
      if (entry.plannedDate && !isValidDate(entry.plannedDate)) throw new Error('保存的计划日期无效，请先备份。');
      if (entry.dueDate && !isValidDate(entry.dueDate)) throw new Error('保存的截止日期无效，请先备份。');
      if ((entry.plannedTime && !isValidTime(entry.plannedTime)) || (entry.dueTime && !isValidTime(entry.dueTime))) throw new Error('保存的时间无效，请先备份。');
      if (!entry.plannedDate && ['daily','future'].includes(entry.location) && entry.type !== 'note') entry.plannedDate = entry.date;
      entry.history = Array.isArray(entry.history) ? entry.history : [];
      entry.revision = Number.isInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0;
      if (entry.type === 'event') {
        if(legacyEventTime && entry.plannedDate){const time=legacyEventTime[1].padStart(2,'0')+':'+legacyEventTime[2];if(isValidTime(time))entry.plannedTime=time;}
        entry.eventState = EVENT_STATES.includes(entry.eventState) ? entry.eventState : entry.status === 'cancelled' ? 'cancelled' : 'planned';
      }
    }
    const tasks = entries.filter(entry => entry.type === 'task');
    const parents = new Map(tasks.map(entry => [entry.id,entry.id]));
    const byId = new Map(tasks.map(entry => [entry.id,entry]));
    function find(id) { const parent=parents.get(id); if(parent===id)return id; const result=find(parent);parents.set(id,result);return result; }
    function union(a,b) { if(byId.has(a)&&byId.has(b)){const ra=find(a),rb=find(b);if(ra!==rb)parents.set(rb,ra);} }
    const byTaskId = new Map();
    for (const entry of tasks) {
      if(entry.sourceId) union(entry.id,entry.sourceId);
      if(entry.target) union(entry.id,entry.target);
      if(entry.taskId){if(byTaskId.has(entry.taskId))union(entry.id,byTaskId.get(entry.taskId));else byTaskId.set(entry.taskId,entry.id);}
    }
    const groups = new Map();
    for(const entry of tasks){const key=find(entry.id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(entry);}
    for (const group of groups.values()) {
      const leaves=group.filter(entry=>!ARCHIVED.includes(entry.status));
      if(leaves.length!==1)throw new Error('任务的迁移链不完整，请先备份原始数据。');
      const leaf=leaves[0], origin=group.find(entry=>!entry.sourceId || !byId.has(entry.sourceId)) || group[0];
      const taskState=TASK_STATES.includes(leaf.taskState) ? leaf.taskState : leaf.status;
      const history = [...leaf.history];
      for(const entry of group) if(entry.target && !history.some(item=>item.id==='legacy-move-'+entry.id) && !history.some(item=>item.from?.id===entry.id)) {
        const target=byId.get(entry.target);
        if(!target)throw new Error('任务的去向无法读取，请先备份。');
        history.push({id:'legacy-move-'+entry.id,kind:'migrated',at:null,from:{...placement(entry),id:entry.id},to:{...placement(target),id:target.id}});
      }
      const common={taskId:origin.taskId || origin.id,taskState,text:leaf.text,priority:leaf.priority,inspiration:leaf.inspiration,createdAt:origin.createdAt || leaf.createdAt || null,updatedAt:leaf.updatedAt,startedAt:leaf.startedAt,completedAt:leaf.completedAt,cancelledAt:leaf.cancelledAt,plannedDate:leaf.plannedDate,plannedTime:leaf.plannedTime,dueDate:leaf.dueDate,dueTime:leaf.dueTime,history,revision:Math.max(...group.map(entry=>entry.revision))};
      for(const entry of group)Object.assign(entry,clone(common));
      leaf.status=taskState;
    }
    return entries;
  }
  function makeEntry(input, now) {
    const id=input.id || uid(), type=input.type || 'task', at=stamp(now);
    if(!['task','event','note'].includes(type))throw new Error('请选择有效的条目类型。');
    const entry={id,text:String(input.text || '').trim(),type,status:'open',priority:false,inspiration:false,location:'daily',date:getToday(now),createdAt:at,updatedAt:at,startedAt:null,completedAt:null,occurredAt:null,cancelledAt:null,plannedDate:null,plannedTime:null,dueDate:null,dueTime:null,revision:0,history:[],...clone(input)};
    if(!entry.text)throw new Error('请写下记录内容。');
    for(const key of ['plannedDate','plannedTime','dueDate','dueTime'])entry[key]=empty(entry[key]) ?? null;
    validatePlacement(entry,now,true);
    if(!entry.plannedDate && ['daily','future'].includes(entry.location) && type!=='note') entry.plannedDate=entry.date;
    validateTiming(entry);
    entry.history=[{id:uid(),kind:'created',at}];
    if(type==='task'){entry.taskId=id;entry.taskState='open';entry.status='open';}
    if(type==='event'){entry.eventState='planned';entry.status='open';}
    return entry;
  }
  function taskFor(entries, entryOrId) {
    const entry=typeof entryOrId==='string' ? entries.find(item=>item.id===entryOrId) : entryOrId;
    if(!entry)return null;
    if(entry.type!=='task')return entry;
    return entries.find(item=>item.type==='task' && item.taskId===entry.taskId && !ARCHIVED.includes(item.status)) || entry;
  }
  function activeTasks(entries) {
    const seen=new Set();
    return entries.filter(entry=>{if(entry.type!=='task'||ARCHIVED.includes(entry.status)||seen.has(entry.taskId || entry.id))return false;seen.add(entry.taskId || entry.id);return true;});
  }
  function setGroup(entries, entry, patch, event, now) {
    const history=[...entry.history,{id:uid(),...event,at:stamp(now)}];
    const common={...patch,history,updatedAt:stamp(now),revision:entry.revision+1};
    for(const item of entries.filter(item=>item.type==='task' && item.taskId===entry.taskId)){
      Object.assign(item,clone(common));
      if(!ARCHIVED.includes(item.status))item.status=item.taskState;
    }
  }
  function changeTask(raw,id,action,now) {
    const entries=normalize(raw,now),entry=taskFor(entries,id);
    if(!entry || entry.type!=='task')throw new Error('这条任务已经不存在。');
    const state=entry.taskState;
    const transitions={start:'doing',complete:'completed',reopen:'open',cancel:'cancelled'};
    if(!transitions[action])throw new Error('不支持这个操作。');
    if(action==='start' && state!=='open')throw new Error('只有待办任务可以开始。');
    if(action==='complete' && !['open','doing'].includes(state))throw new Error('这条任务已经处理过了。');
    if(action==='cancel' && !['open','doing'].includes(state))throw new Error('这条任务已经处理过了。');
    if(action==='reopen' && !['completed','cancelled','doing'].includes(state))throw new Error('这条任务已经是待办。');
    const patch={taskState:transitions[action]};
    if(action==='start')patch.startedAt=stamp(now);
    if(action==='complete')patch.completedAt=stamp(now);
    if(action==='cancel')patch.cancelledAt=stamp(now);
    if(action==='reopen'){patch.startedAt=null;patch.completedAt=null;patch.cancelledAt=null;}
    setGroup(entries,entry,patch,{kind:action,late:action==='complete' ? isLate(entry,now) : undefined},now);
    return entries;
  }
  function changeEvent(raw,id,action,now) {
    const entries=normalize(raw,now),entry=entries.find(item=>item.id===id);
    if(!entry || entry.type!=='event')throw new Error('这条事件已经不存在。');
    const transitions={occur:'occurred',reopen:'planned',cancel:'cancelled'};
    if(!transitions[action])throw new Error('不支持这个操作。');
    if(action!=='reopen' && entry.eventState!=='planned')throw new Error('事件已经处理过了。');
    if(action==='reopen' && entry.eventState==='planned')throw new Error('事件已经是待发生。');
    entry.eventState=transitions[action];entry.status=action==='cancel'?'cancelled':'open';
    entry.occurredAt=action==='occur'?stamp(now):null;
    entry.cancelledAt=action==='cancel'?stamp(now):null;
    entry.updatedAt=stamp(now);entry.revision++;
    entry.history.push({id:uid(),kind:action==='occur'?'occurred':action,at:stamp(now)});
    return entries;
  }
  function updateEntry(raw,id,patch,now,expectedRevision) {
    const entries=normalize(raw,now),original=entries.find(item=>item.id===id),entry=taskFor(entries,original);
    if(!entry)throw new Error('这条记录已经不存在。');
    if(expectedRevision!==undefined && entry.revision!==expectedRevision)throw new Error('这条记录已在其他窗口更新，请重新打开编辑；当前草稿仍保留。');
    const editable=['text','type','priority','inspiration','plannedDate','plannedTime','dueDate','dueTime','memo'];
    const changes=Object.fromEntries(Object.entries(patch).filter(([key])=>editable.includes(key)));
    if(changes.text!==undefined){changes.text=String(changes.text).trim();if(!changes.text)throw new Error('请写下记录内容。');}
    if(changes.type && !['task','event','note'].includes(changes.type))throw new Error('请选择有效的条目类型。');
    if(changes.type && changes.type!==entry.type && entry.type==='task' && entries.filter(item=>item.taskId===entry.taskId).length>1)throw new Error('有迁移历史的任务请保留任务类型。');
    for(const key of ['plannedDate','plannedTime','dueDate','dueTime']) if(Object.hasOwn(changes,key))changes[key]=empty(changes[key]) ?? null;
    const candidate={...entry,...changes};
    const timingKeys=['plannedDate','plannedTime','dueDate','dueTime'];
    const timingChanged=timingKeys.some(key=>candidate[key]!==entry[key]);
    validateTiming(candidate,timingChanged);
    const before=Object.fromEntries(timingKeys.map(key=>[key,entry[key]])),after=Object.fromEntries(timingKeys.map(key=>[key,candidate[key]]));
    if(changes.type && changes.type!==entry.type){
      Object.assign(entry,changes,{status:'open',createdAt:entry.createdAt,startedAt:null,completedAt:null,occurredAt:null,cancelledAt:null});
      delete entry.taskId;delete entry.taskState;delete entry.eventState;
      if(entry.type==='task'){entry.taskId=entry.id;entry.taskState='open';}
      if(entry.type==='event')entry.eventState='planned';
    }
    if(entry.type==='task'){
      if(Object.hasOwn(changes,'plannedDate') && changes.plannedDate && entry.location==='future'){
        entry.date=changes.plannedDate;
        if(entry.date<=getToday(now))entry.location='daily';
      }
      setGroup(entries,entry,changes,{kind:timingChanged?'rescheduled':'edited',before,after},now);
    }
    else{
      Object.assign(entry,changes);
      if(entry.type==='event' && entry.plannedDate && ['daily','future'].includes(entry.location)){entry.date=entry.plannedDate;if(entry.location==='future' && entry.date<=getToday(now))entry.location='daily';}
      entry.history.push({id:uid(),kind:timingChanged?'rescheduled':'edited',at:stamp(now),before,after});
      entry.updatedAt=stamp(now);entry.revision++;
    }
    return entries;
  }
  function migrate(raw,id,destination,now) {
    const entries=normalize(raw,now),source=entries.find(item=>item.id===id);
    if(!source || source.type!=='task' || ARCHIVED.includes(source.status) || !['open','doing'].includes(source.taskState))throw new Error('只有当前未完成任务可以迁移。');
    const targetPlacement={location:destination.location,date:destination.date,collection:destination.collection || null};
    validatePlacement(targetPlacement,now,true);
    if(source.location===targetPlacement.location && (source.location==='collection' ? source.collection===targetPlacement.collection : source.date===targetPlacement.date))throw new Error('这件事已经在这个页面里了。');
    const target={...clone(source),...targetPlacement,id:uid(),sourceId:source.id,status:source.taskState,recordedAt:stamp(now)};
    delete target.target;
    source.status=destination.location==='future'?'scheduled':'migrated';source.target=target.id;
    entries.push(target);
    const patch={};
    if(['daily','future'].includes(destination.location))patch.plannedDate=destination.date;
    if(destination.location==='monthly'){patch.plannedDate=null;patch.plannedTime=null;}
    setGroup(entries,target,patch,{kind:'migrated',from:{...placement(source),id:source.id},to:{...placement(target),id:target.id}},now);
    return entries;
  }
  function isLate(entry,now) {
    if(!entry.dueDate || (entry.taskState==='completed' && !entry.completedAt))return false;
    const end=entry.completedAt && entry.taskState==='completed' ? Date.parse(entry.completedAt) : clock(now).getTime();
    return end > timeValue(entry.dueDate,entry.dueTime,true);
  }
  function tracking(raw,now) {
    const result={overdue:[],today:[],older:[],upcoming:[],undated:[],completed:[]},today=getToday(now);
    for(const entry of activeTasks(raw)){
      if(entry.taskState==='completed'){result.completed.push(entry);continue;}
      if(entry.taskState==='cancelled')continue;
      const plan=entry.plannedDate || (entry.location==='daily'?entry.date:null);
      if(isLate(entry,now))result.overdue.push(entry);
      else if(plan===today || entry.dueDate===today)result.today.push(entry);
      else if(plan && plan<today)result.older.push(entry);
      else if(plan && plan>today)result.upcoming.push(entry);
      else result.undated.push(entry);
    }
    for(const list of Object.values(result))list.sort((a,b)=>(a.dueDate || a.plannedDate || '9999').localeCompare(b.dueDate || b.plannedDate || '9999'));
    return result;
  }
  return {getToday,isValidDate,isValidMonth,isValidTime,timeValue,normalize,makeEntry,taskFor,activeTasks,changeTask,changeEvent,updateEntry,migrate,isLate,tracking};
});
