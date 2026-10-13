'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {clone}=require('../sync-model.js');
class FileStore{
  constructor(filename=null){this.filename=filename;this.data={};this.queue=Promise.resolve();}
  async init(){if(this.filename){try{this.data=JSON.parse(await fs.readFile(this.filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}return this;}
  async get(collection,id){return clone(this.data[collection]?.[id]??null);}
  async list(collection,ownerId){return clone(Object.values(this.data[collection]||{}).filter(x=>x.ownerId===ownerId));}
  async atomic(work){
    const run=this.queue.then(async()=>{
      const staged=clone(this.data),tx={get:async(c,id)=>clone(staged[c]?.[id]??null),set:async(c,id,value)=>{(staged[c]??={})[id]=clone(value);}};
      const result=await work(tx);
      if(this.filename){await fs.mkdir(path.dirname(this.filename),{recursive:true});const temp=this.filename+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify(staged),{mode:0o600});await fs.rename(temp,this.filename);}
      this.data=staged;return result;
    });
    this.queue=run.catch(()=>{});return run;
  }
}
module.exports={FileStore};
