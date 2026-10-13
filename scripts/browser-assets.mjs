import {build} from 'esbuild';
import './icons.mjs';
export async function buildBrowserAssets(){
 await build({entryPoints:['src/cloudbase-adapter.js'],outfile:'cloudbase-adapter.js',bundle:true,platform:'browser',format:'iife',target:['safari16','chrome110'],minify:true,legalComments:'eof',logLevel:'warning'});
}
