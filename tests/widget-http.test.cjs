'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {FileStore}=require('../backend/file-store.cjs'),{createService}=require('../backend/service.cjs'),{createWidgetHandler}=require('../backend/widget-http.cjs');
test('HTTP widget only permits GET with a live scoped widget token',async()=>{
 const service=createService(await new FileStore().init()),issued=await service.rpc('A','createToken',{});
 const server=http.createServer(createWidgetHandler(service));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(url+'/today')).status,401);
  assert.equal((await fetch(url+'/today',{headers:{Authorization:'Bearer '+issued.token}})).status,200);
  assert.equal((await fetch(url+'/today',{method:'POST',headers:{Authorization:'Bearer '+issued.token}})).status,405);
  assert.equal((await fetch(url+'/api/rpc',{headers:{Authorization:'Bearer '+issued.token}})).status,404);
  await service.rpc('A','revokeToken',{id:issued.id});
  assert.equal((await fetch(url+'/today',{headers:{Authorization:'Bearer '+issued.token}})).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
