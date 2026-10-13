'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Core=require('../journal-core.js'),Model=require('../sync-model.js');
const {Engine,Cache}=require('../sync-engine.js'),{indexedDB}=require('fake-indexeddb');
const {FileStore}=require('../backend/file-store.cjs'),{createService}=require('../backend/service.cjs');
const now=new Date('2026-10-13T02:00:00Z'),later=new Date('2026-10-13T04:00:00Z');
const make=(text,type='task')=>Core.makeEntry({text,type,date:'2026-10-13',location:'daily'},now);
const selection=raw=>[...Model.groups(raw).values()].map(g=>({key:g.key,revision:g.revision}));
async function fixture(){
 const service=createService(await new FileStore().init(),()=>later);let online=false;
 const cache=new Cache(indexedDB,'trash-'+Model.uid());
 const provider={mode:'local',namespace:'qa',rpc:(action,payload)=>service.rpc('A',action,payload)};
 const engine=new Engine({cache,online:()=>online});
 return {service,cache,provider,engine,setOnline:value=>online=value};
}
test('trash and restore preserve a complete migration chain, state and completion time',()=>{
 const original=make('migrated'),kept=make('keep','note');
 const moved=Core.migrate([original],original.id,{location:'future',date:'2026-10-14'},now);
 const leaf=Core.activeTasks(moved)[0],completed=Core.changeTask(moved,leaf.id,'complete',later);
 const before=Core.normalize([...completed,kept]),items=selection(completed),trashed=Model.setTrashed(before,items,true,later);
 assert.equal(Model.visible(trashed).length,1);assert.equal(Core.activeTasks(trashed).length,0);
 assert.deepEqual(trashed.find(e=>e.id===kept.id),before.find(e=>e.id===kept.id));
 assert.equal(trashed.filter(e=>e.trashedAt).length,2);
 const restored=Model.setTrashed(trashed,selection(trashed.filter(e=>e.id!==kept.id)),false,later);
 assert.equal(Model.visible(restored).length,3);assert.equal(Core.activeTasks(restored)[0].completedAt,later.toISOString());
 assert.equal(Core.activeTasks(restored)[0].taskState,'completed');
 assert.equal(restored.find(e=>e.id===original.id).status,'scheduled');
 assert.equal(Core.activeTasks(restored)[0].history.at(-1).kind,'restored');
});
test('trash rejects a stale selection atomically, without touching other selected records',()=>{
 const raw=Core.normalize([make('first'),make('second','note')]),items=selection(raw);items[1].revision++;
 assert.throws(()=>Model.setTrashed(raw,items),/记录已/);
 assert.equal(raw.some(e=>e.trashedAt),false);
});
test('cleanup matches old IDs only and preserves unrelated notes with the same text',async()=>{
 const f=await fixture(),old=make('same text','note'),keep=make('same text','note');
 await f.engine.init([old]);await f.engine.connect(f.provider,{ownerId:'A'});
 await f.engine.importGuest();await f.engine.importEntries([keep]);
 const preview=await f.engine.legacyPreview();assert.equal(preview.candidates.length,1);assert.equal(preview.candidates[0].entry.id,old.id);
 await f.engine.trashSelections(preview.candidates.map(g=>({key:g.key,revision:g.revision})),{scope:preview.scope});
 assert.deepEqual(Model.visible(f.engine.state.entries).map(e=>e.id),[keep.id]);
 assert.equal((await f.engine.legacyPreview()).candidates.length,0);
 assert.equal((await f.engine.importGuest()).added,0);assert.equal(f.engine.state.entries.find(e=>e.id===old.id).trashedAt!==null,true);
 f.cache.db.close();
});
test('account switching invalidates a cleanup preview without modifying the original account',async()=>{
 const f=await fixture(),old=make('old','note');
 await f.engine.init([old]);await f.engine.connect(f.provider,{ownerId:'A'});await f.engine.importGuest();
 const preview=await f.engine.legacyPreview(),before=await f.cache.read(preview.scope);
 await f.engine.connect({...f.provider,rpc:(action,payload)=>f.service.rpc('B',action,payload)},{ownerId:'B'});
 await assert.rejects(f.engine.trashSelections(preview.candidates.map(g=>({key:g.key,revision:g.revision})),{scope:preview.scope}),/账号已切换/);
 assert.deepEqual((await f.cache.read(preview.scope)).entries,before.entries);assert.equal(f.engine.state.entries.length,0);
 f.cache.db.close();
});
test('offline trash persists, syncs to another session and can be restored there',async()=>{
 const f=await fixture(),old=make('old'),keep=make('keep','note');
 await f.engine.init([old]);await f.engine.connect(f.provider,{ownerId:'A'});await f.engine.importEntries([old,keep]);
 const preview=await f.engine.legacyPreview();
 await f.engine.trashSelections(preview.candidates.map(g=>({key:g.key,revision:g.revision})),{scope:preview.scope});
 const reopened=new Engine({cache:f.cache,online:()=>false});await reopened.init([]);await reopened.connect(f.provider,{ownerId:'A'});
 assert.equal(Model.visible(reopened.state.entries).length,1);assert.ok(reopened.state.outbox.length);
 f.setOnline(true);await f.engine.flush();
 const other=new Engine({cache:new Cache(indexedDB,'other-'+Model.uid()),online:()=>true});await other.init([]);await other.connect(f.provider,{ownerId:'A'});
 assert.equal(Model.visible(other.state.entries).length,1);
 const hidden=other.state.entries.filter(e=>e.trashedAt);await other.trashSelections(selection(hidden),{restore:true});await other.flush();await f.engine.flush();
 assert.equal(Model.visible(f.engine.state.entries).length,2);assert.equal(f.engine.state.outbox.length,0);
 f.cache.db.close();other.cache.db.close();
});
test('server and widget omit trashed tasks and events, while preserving unrelated notes',async()=>{
 const service=createService(await new FileStore().init(),()=>later);
 const items=Core.normalize([make('task'),make('event','event'),make('keep','note')]);
 for(const operation of Model.diff([],items,'PC'))await service.rpc('A','apply',{operation});
 const {token}=await service.rpc('A','createToken');assert.equal((await service.today(token)).total,1);
 const hidden=Model.setTrashed(items,selection(items.filter(e=>e.type!=='note')),true,later);
 for(const operation of Model.diff(items,hidden,'PC'))await service.rpc('A','apply',{operation});
 const snapshot=await service.rpc('A','pull'),summary=await service.today(token);
 assert.equal(summary.total,0);assert.equal(summary.events.length,0);
 assert.equal(Model.visible(snapshot.groups.flatMap(g=>g.entries))[0].text,'keep');
 assert.equal((await service.rpc('B','pull')).groups.length,0);
 const clean=snapshot.groups.flatMap(g=>g.entries),restored=Model.setTrashed(clean,selection(clean.filter(e=>e.trashedAt)),false,later);
 for(const operation of Model.diff(clean,restored,'phone'))await service.rpc('A','apply',{operation});
 assert.equal((await service.today(token)).events.length,1);
});
test('simultaneous imports of the same guest group do not duplicate records',async()=>{
 const f=await fixture(),old=make('old','note');await f.engine.init([old]);await f.engine.connect(f.provider,{ownerId:'A'});
 const results=await Promise.all([f.engine.importGuest(),f.engine.importGuest()]);
 assert.equal(results.reduce((sum,r)=>sum+r.added,0),1);assert.equal(f.engine.state.entries.length,1);
 f.cache.db.close();
});

test('trash refuses records that cannot fit a complete restoration operation',()=>{
 const entry=Core.normalize([make('long history')])[0];entry.history=Array.from({length:1999},(_,i)=>({id:'h'+i,kind:'edited',at:now.toISOString()}));
 assert.throws(()=>Model.setTrashed([entry],selection([entry])),/无法保证完整恢复/);assert.equal(entry.trashedAt,null);
});
