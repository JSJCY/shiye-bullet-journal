'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Core=require('../journal-core.js'),Model=require('../sync-model.js');
const {FileStore}=require('../backend/file-store.cjs'),{createService}=require('../backend/service.cjs'),{Cache,Engine}=require('../sync-engine.js'),{indexedDB}=require('fake-indexeddb');
const now=new Date('2026-10-13T02:00:00Z'),later=new Date('2026-10-13T04:00:00Z');
const task=()=>Core.makeEntry({type:'task',text:'同步任务',location:'daily',date:'2026-10-13'},now);
async function fixture(){const store=await new FileStore().init(),service=createService(store,()=>later);return {store,service};}
const op=(before,after)=>Model.diff(before,after,'device-A')[0];
test('idempotency survives a lost acknowledgement; reused IDs with other payloads fail',async()=>{
 const {service}=await fixture(),entry=task(),operation=op([], [entry]);
 const first=await service.rpc('A','apply',{operation}),again=await service.rpc('A','apply',{operation});assert.deepEqual(first,again);
 assert.equal((await service.rpc('A','pull')).cursor,1);
 await assert.rejects(service.rpc('A','apply',{operation:{...operation,entries:[{...entry,text:'other'}]}}),e=>e.code==='INVALID');
});
test('concurrent edits conflict only for the same task and isolate accounts',async()=>{
 const {service}=await fixture(),entry=task();await service.rpc('A','apply',{operation:op([],[entry])});
 const a=Core.updateEntry([entry],entry.id,{text:'PC'},later,0),b=Core.updateEntry([entry],entry.id,{text:'iPhone'},later,0);
 const result=await Promise.allSettled([service.rpc('A','apply',{operation:op([entry],a)}),service.rpc('A','apply',{operation:op([entry],b)})]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.code,'CONFLICT');
 assert.equal((await service.rpc('B','pull')).groups.length,0);
 await assert.rejects(service.rpc('B','pull',{expectedOwner:'A'}),e=>e.code==='AUTH');
});
test('migration commits an intact chain and preserves offline occurrence time',async()=>{
 const {service}=await fixture(),entry=task();await service.rpc('A','apply',{operation:op([],[entry])});
 const migrated=Core.migrate([entry],entry.id,{location:'future',date:'2026-10-14'},now);
 await service.rpc('A','apply',{operation:op([entry],migrated)});
 const leaf=Core.activeTasks(migrated)[0],completed=Core.changeTask(migrated,leaf.id,'complete',now);
 await service.rpc('A','apply',{operation:op(migrated,completed)});
 const snapshot=await service.rpc('A','pull');assert.equal(snapshot.groups.length,1);const values=snapshot.groups[0].entries;
 assert.equal(values.length,2);assert.equal(Core.activeTasks(values).length,1);assert.equal(values.find(e=>e.id===entry.id).status,'scheduled');
 assert.equal(Core.activeTasks(values)[0].completedAt,now.toISOString());assert.equal(Core.activeTasks(values)[0].receivedAt,later.toISOString());
});
test('type changes keep one entity identity; malformed migration cannot be uploaded',async()=>{
 const entry=task(),changed=Core.updateEntry([entry],entry.id,{type:'note'},later,0),operation=op([entry],changed);
 assert.equal(operation.key,op([],[entry]).key);
 const bad=Core.migrate([entry],entry.id,{location:'future',date:'2026-10-14'},now);bad.pop();
 assert.throws(()=>Model.validateOperation({...op([],[entry]),entries:bad}));
});
test('widget credentials cannot mutate or read another account and revocation takes effect',async()=>{
 const {service}=await fixture(),entry=task();await service.rpc('A','apply',{operation:op([],[entry])});
 const credential=await service.rpc('A','createToken');
 const summary=await service.today(credential.token);assert.equal(summary.pending[0].text,'同步任务');
 await assert.rejects(service.rpc('B','revokeToken',{id:credential.id}),e=>e.code==='NOT_FOUND');
 await service.rpc('A','revokeToken',{id:credential.id});await assert.rejects(service.today(credential.token),e=>e.code==='AUTH');
});
test('IndexedDB transactions serialize two tabs without losing edits and publish only after persistence',async()=>{
 const dbName='test-'+Model.uid(),a=new Cache(indexedDB,dbName),b=new Cache(indexedDB,dbName);
 await a.update('guest',s=>({...s,entries:[]}));
 const first=task(),second={...task(),text:'second'};
 await Promise.all([a.update('guest',s=>{s.entries.push(first);return s;}),b.update('guest',s=>{s.entries.push(second);return s;})]);
 assert.equal((await a.read('guest')).entries.length,2);
 await assert.rejects(a.update('guest',()=>{throw new Error('save failed');}));assert.equal((await a.read('guest')).entries.length,2);
 a.db.close();b.db.close();
});
test('offline queue drains after reconnect, idempotent retries and conflict drafts remain available',async()=>{
 const {service}=await fixture();let online=false;
 const provider={mode:'local',namespace:'test',rpc:(action,payload)=>service.rpc('A',action,payload)};
 const engine=new Engine({cache:new Cache(indexedDB,'engine-'+Model.uid()),online:()=>online});
 await engine.init([]);await engine.connect(provider,{ownerId:'A'});const entry=task();await engine.mutate(values=>[...values,entry]);
 assert.equal(engine.state.outbox.length,1);online=true;await engine.flush();assert.equal(engine.state.outbox.length,0);
 online=false;await engine.mutate(values=>Core.updateEntry(values,entry.id,{text:'offline draft'},later,0));
 const remote=Core.updateEntry([entry],entry.id,{text:'remote'},later,0);await service.rpc('A','apply',{operation:op([entry],remote)});
 online=true;await engine.flush();assert.equal(engine.state.conflicts.length,1);assert.equal(engine.state.entries[0].text,'offline draft');
 await engine.resolve(Model.keyOf(entry),'note');await engine.flush();assert.equal(engine.state.conflicts.length,0);
 assert.ok(engine.state.entries.some(e=>e.text==='remote'));assert.ok(engine.state.entries.some(e=>e.type==='note'&&e.text.includes('offline draft')));assert.equal(engine.state.drafts.length,1);engine.cache.db.close();
});
test('today summary changes at Shanghai midnight and retains event symbols',()=>{
 const event=Core.makeEntry({type:'event',text:'讨论',date:'2026-10-14',location:'daily',plannedDate:'2026-10-14',plannedTime:'09:00'},now);
 assert.equal(Model.summary([event],new Date('2026-10-13T15:59:59Z')).events.length,0);
 const next=Model.summary([event],new Date('2026-10-13T16:00:00Z'));assert.equal(next.events[0].symbol,'○');assert.equal(next.date,'2026-10-14');
});
