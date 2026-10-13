import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import {buildBrowserAssets} from './browser-assets.mjs';
import {httpsUrl} from './deployment-config.mjs';
const args=process.argv.slice(2),arg=name=>args.includes(name)?args[args.indexOf(name)+1]:'';
const envId=arg('--env')||process.env.JOURNAL_ENV_ID||'';
const appUrl=httpsUrl(arg('--app-url')||process.env.JOURNAL_APP_URL||'',{root:true}),widgetApiUrl=httpsUrl(arg('--widget-url')||process.env.JOURNAL_WIDGET_URL||'');
const root=process.cwd(),web=path.join(root,'dist','web'),functions=path.join(root,'dist','functions');
await fs.mkdir(web,{recursive:true});await fs.mkdir(functions,{recursive:true});
await buildBrowserAssets();
const publicFiles=['index.html','styles.css','app.js','journal-core.js','sync-model.js','sync-engine.js','sync-ui.js','provider.js','manifest.webmanifest','cloudbase-adapter.js'];
for(const file of publicFiles)await fs.copyFile(file,path.join(web,file));
await fs.cp('icons',path.join(web,'icons'),{recursive:true});await fs.cp('scriptable',path.join(web,'scriptable'),{recursive:true});
const config={mode:envId?'cloud':'local',auth:{emailEnabled:args.includes('--email-login')},cloudbase:{envId,region:arg('--region')||process.env.JOURNAL_REGION||'ap-shanghai',functionName:'journal',database:'postgresql'},appUrl,widgetApiUrl};
await fs.writeFile(path.join(web,'config.js'),'window.JOURNAL_CONFIG = Object.freeze('+JSON.stringify(config)+');\n');
const hash=crypto.createHash('sha256');for(const file of [...publicFiles,'config.js'])hash.update(await fs.readFile(path.join(web,file)));
const shellHash=hash.digest('hex').slice(0,12);
let sw=await fs.readFile('service-worker.js','utf8');sw=sw.replace('shiye-shell-v0.3.1','shiye-shell-'+shellHash);
await fs.writeFile(path.join(web,'service-worker.js'),sw);
for(const name of ['journal','journal-widget']){
 const dir=path.join(functions,name);await fs.mkdir(dir,{recursive:true});
 await build({entryPoints:[name==='journal'?'backend/cloud-function.cjs':'backend/widget-http.cjs'],outfile:path.join(dir,'index.js'),bundle:true,platform:'node',format:'cjs',target:'node20',external:[],logLevel:'warning'});
 const packageJson={name:'shiye-'+name,version:'0.3.1',private:true,main:'index.js'};
 if(name==='journal-widget'){
  await fs.writeFile(path.join(dir,'scf_bootstrap'),'#!/bin/bash\nexport PORT=9000\n/var/lang/node20/bin/node index.js\n',{mode:0o755});
 }
 await fs.writeFile(path.join(dir,'package.json'),JSON.stringify(packageJson,null,2)+'\n');
}
const cloudConfig={envId,region:arg('--region')||process.env.JOURNAL_REGION||'ap-shanghai',functionRoot:'dist/functions',database:{type:'postgresql',migrations:'./cloudbase/migrations'},functions:[
 {name:'journal',type:'Event',handler:'index.main',runtime:'Nodejs20.19',timeout:30,memorySize:256,installDependency:false,envVariables:{JOURNAL_ENV_ID:envId}},
 {name:'journal-widget',type:'HTTP',handler:'index.main',runtime:'Nodejs20.19',timeout:30,memorySize:128,installDependency:false,envVariables:{JOURNAL_ENV_ID:envId}}
]};
await fs.writeFile('cloudbaserc.json',JSON.stringify(cloudConfig,null,2)+'\n');
await fs.writeFile(path.join(root,'dist','build-info.json'),JSON.stringify({builtAt:new Date().toISOString(),envId,appUrl,widgetApiUrl,clientMode:config.mode,shellHash,web:'dist/web',functions:['journal','journal-widget'],database:'postgresql',serverCredentialsRequired:true},null,2));
console.log('Built PWA + Event journal + HTTP journal-widget; mode='+config.mode+'; PostgreSQL.');
