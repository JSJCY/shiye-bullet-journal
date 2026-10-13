import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const roots=['app.js','journal-core.js','sync-model.js','sync-engine.js','sync-ui.js','provider.js','config.js','service-worker.js','server.mjs'];
for(const dir of ['backend','src','scripts'])for(const name of await fs.readdir(dir))if(/\.(js|cjs|mjs)$/.test(name))roots.push(dir+'/'+name);
for(const file of roots){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr);process.exit(result.status||1);}}
const script=await fs.readFile('scriptable/拾页.js','utf8');new Function('return (async function(){\n'+script+'\n})();');
const manifest=JSON.parse(await fs.readFile('manifest.webmanifest','utf8'));if(manifest.display!=='standalone'||manifest.icons.length<2)throw new Error('Incomplete PWA manifest');
console.log('Syntax and manifest checks passed ('+roots.length+' modules + Scriptable).');
