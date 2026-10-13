'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{PgStore}=require('../backend/pg-store.cjs'),{createService}=require('../backend/service.cjs');
const Core=require('../journal-core.js'),Model=require('../sync-model.js');
async function fixture(){
 const db=new PGlite();
 await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT current_user::text'; CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql AS 'SELECT null::text'; GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;");
 await db.exec(fs.readFileSync('cloudbase/migrations/20261013000100_journal.sql','utf8'));await db.exec('SET ROLE service_role');
 const fetchImpl=async(url,options)=>{
  const {p_action,p_args}=JSON.parse(options.body);
  try{const r=await db.query('SELECT public.shiye_store($1,$2::jsonb) AS result',[p_action,JSON.stringify(p_args)]);return {ok:true,json:async()=>r.rows[0].result};}
  catch(e){return {ok:false,status:400,json:async()=>({error:e.message})};}
 };
 const store=new PgStore({envId:'test',apiKey:'fixture-only',fetchImpl});return {db,store,service:createService(store)};
}
test('PostgreSQL RPC commits migrations atomically and rejects stale concurrent edits',async()=>{
 const {db,service}=await fixture();
 try{
  const e=Core.makeEntry({type:'task',text:'PC + iPhone',date:'2026-10-13',location:'daily'});
  const operation=Model.diff([], [e], 'PC')[0];
  const first=await service.rpc('owner-A','apply',{operation});
  assert.deepEqual(await service.rpc('owner-A','apply',{operation}),first);
  const migrated=Core.migrate([e],e.id,{location:'future',date:'2026-10-14'});
  await service.rpc('owner-A','apply',{operation:Model.diff([e],migrated,'PC')[0]});
  const leaf=Core.activeTasks(migrated)[0];
  const edits=['PC','iPhone'].map(text=>Model.diff(migrated,Core.updateEntry(migrated,leaf.id,{text},new Date(),leaf.revision),'device')[0]);
  const results=await Promise.allSettled(edits.map(operation=>service.rpc('owner-A','apply',{operation})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'CONFLICT');
  const pulled=await service.rpc('owner-A','pull');assert.equal(pulled.cursor,3);assert.equal(pulled.groups[0].entries.length,2);
  assert.equal((await service.rpc('owner-B','pull')).groups.length,0);
 }finally{await db.close();}
});
test('PostgreSQL blocks caller roles and rolls back the entire write batch on failure',async()=>{
 const {db,store}=await fixture();
 try{
  for(const role of ['anon','authenticated']){
   await db.exec('RESET ROLE; SET ROLE '+role);
   await assert.rejects(db.query("SELECT public.shiye_store('list',$1::jsonb)",[JSON.stringify({collection:'records',ownerId:'A'})]));
   await assert.rejects(db.query('INSERT INTO public.shiye_documents VALUES($1,$2,$3,$4,1)',['records','x','A',{ownerId:'A'}]));
  }
  await db.exec('RESET ROLE; SET ROLE service_role');
  await assert.rejects(store.call('commit',{reads:[],writes:[{collection:'records',id:'first',value:{ownerId:'A'}},{collection:'invalid-collection',id:'second',value:{ownerId:'A'}}]}));
  assert.equal(await store.get('records','first'),null);
  assert.equal(await store.call('commit',{reads:[{collection:'records',id:'first',version:0}],writes:[{collection:'records',id:'first',value:{ownerId:'A',text:'saved'}}]}),true);
  assert.equal(await store.call('commit',{reads:[{collection:'records',id:'first',version:0}],writes:[{collection:'records',id:'first',value:{ownerId:'A',text:'stale'}}]}),false);
  assert.equal((await store.get('records','first')).text,'saved');
 }finally{await db.close();}
});
