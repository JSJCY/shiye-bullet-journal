import {writeFile,mkdir} from 'node:fs/promises';
import zlib from 'node:zlib';
const directory=new URL('../icons/',import.meta.url);await mkdir(directory,{recursive:true});
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,checksum]);}
for(const size of [180,192,512]){
 const scan=Buffer.alloc((size*4+1)*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const dot=(x-size/2)**2+(y-size/2)**2<(size*.105)**2,color=dot?[32,43,54]:[39,221,194],offset=y*(size*4+1)+1+x*4;scan[offset]=color[0];scan[offset+1]=color[1];scan[offset+2]=color[2];scan[offset+3]=255;}
 const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
 await writeFile(new URL(size===180?'apple-touch-icon.png':'icon-'+size+'.png',directory),png);
}
await writeFile(new URL('app.svg',directory),"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' fill='#27ddc2'/><circle cx='256' cy='256' r='54' fill='#202b36'/></svg>");
