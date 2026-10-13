'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('cloud account restores offline without a network identity request or cached token',async()=>{
 const values=new Map(),localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 let offline=false;
 const auth={getCurrentUser:async()=>{if(offline)throw new Error('offline');return {username:'my-account'};},signOut:async()=>({data:{}})};
 const app={auth:()=>auth,callFunction:async()=>({result:{ok:true,data:{ownerId:'verified-A',metaId:'meta-A'}}})};
 const context={cloudbase:{init:()=>app},localStorage,window:{JournalProviders:{unpack:x=>x.data}}};
 vm.runInNewContext(fs.readFileSync('src/cloudbase-adapter.js','utf8').replace(/^import[^\n]+\n/,''),context);
 const Provider=context.window.CloudBaseProvider,config={cloudbase:{envId:'example'}};
 await new Provider(config).identity();offline=true;
 const resumed=await new Provider(config).resume();assert.equal(resumed.ownerId,'verified-A');
 assert.deepEqual(Object.keys(JSON.parse(values.values().next().value)).sort(),['metaId','ownerId','username']);
 await new Provider(config).logout();assert.equal(values.size,0);
 await assert.rejects(new Provider(config).resume(),/offline/);
});
