// White / blue file handoff is the source for desktop and mobile app icons.
// Hallmark · pre-emit critique: P4 H5 E4 S4 R5 V4
// Run with tooling Node + sharp; no application runtime dependency is introduced.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url);
let sharp;try{sharp=require(process.env.PICKDROP_SHARP_MODULE||'sharp')}catch{sharp=require(path.resolve(path.dirname(process.execPath),'../node_modules/sharp'))}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'assets/brand/app-icon-source.svg');
const original=await readFile(source,'utf8');
const colors={ink:'#0066e8',cream:'#ffffff',orange:'#007aff',peach:'#ffffff',cheek:'#c7e2ff',brown:'#68adff'};
const css='';
const symbol=original.match(/<!-- symbol-start -->([\s\S]*?)<!-- symbol-end -->/)[1];
const svg=(body,styles=css)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${styles}${body}</svg>`;
const fittedSymbol=symbol;
let resolved=svg(`<rect x="2" y="2" width="60" height="60" rx="14" fill="${colors.peach}" stroke="#e5e9ef" stroke-width=".35"/>${fittedSymbol}`);
const desktop=path.join(root,'apps/desktop/assets'),mobile=path.join(root,'apps/mobile/assets'),brand=path.join(root,'assets/brand');
await mkdir(brand,{recursive:true});
await writeFile(path.join(root,'apps/desktop/public/assets/app-icon.svg'),resolved);
await writeFile(path.join(brand,'app-icon.svg'),resolved);
const records=[];
async function render(input,target,size){let image=sharp(Buffer.from(input)).resize(size,size);if(target===path.join(mobile,'icon.png'))image=image.removeAlpha();await image.png().toFile(target);records.push({file:path.relative(root,target),size});}
await render(resolved,path.join(desktop,'drag-icon.png'),64);
await render(resolved,path.join(desktop,'icon.png'),1024);
const icon=await sharp(Buffer.from(resolved)).resize(840,840).png().toBuffer();
await sharp({create:{width:1024,height:1024,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:icon,left:92,top:92}]).png().toFile(path.join(desktop,'mac-icon.png'));
records.push({file:'apps/desktop/assets/mac-icon.png',size:1024});
const mobileIcon=svg(`<rect width="64" height="64" fill="${colors.peach}"/>${fittedSymbol}`);
const foreground=svg(`<g transform="translate(32 32) scale(.70) translate(-32 -32)">${symbol}</g>`);
const mono=svg(`<g transform="translate(32 32) scale(.70) translate(-32 -32)"><path fill="#000" d="M18 18h15v4H18v27h18v-5h4v7a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V20a2 2 0 0 1 2-2Z"/><path fill="#000" fill-rule="evenodd" d="M26 10h14l11 11v23a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4Zm14 4v9h9ZM28 32v4h11l-4 4 3 3 9-9-9-9-3 3 4 4Z"/></g>`);
await render(mobileIcon,path.join(mobile,'icon.png'),1024);
await render(foreground,path.join(mobile,'adaptive-icon.png'),1024);
await render(mono,path.join(mobile,'monochrome-icon.png'),1024);
await render(svg(fittedSymbol),path.join(mobile,'splash-icon.png'),512);
await render(svg(fittedSymbol),path.join(mobile,'brand-mark.png'),1024);
await render(resolved,path.join(mobile,'favicon.png'),64);
for(const size of [1024,512,256,128,64,32,16])await render(resolved,path.join(brand,`app-icon${size===1024?'':'-'+size}.png`),size);
await copyFile(path.join(desktop,'mac-icon.png'),path.join(brand,'mac-icon.png'));
await copyFile(path.join(mobile,'icon.png'),path.join(brand,'mobile-icon.png'));
await copyFile(path.join(mobile,'adaptive-icon.png'),path.join(brand,'adaptive-foreground.png'));
await copyFile(path.join(mobile,'monochrome-icon.png'),path.join(brand,'monochrome-icon.png'));
for(const [name,value] of [['mobile-icon',mobileIcon],['adaptive-foreground',foreground],['monochrome-icon',mono],['mark',svg(fittedSymbol)],['mark-mono',mono]])await writeFile(path.join(brand,name+'.svg'),value);
await copyFile(path.join(mobile,'brand-mark.png'),path.join(brand,'mark.png'));
await copyFile(path.join(mobile,'monochrome-icon.png'),path.join(brand,'mark-mono.png'));
for(const size of [512,256,128,64,32,16])await sharp(path.join(desktop,'mac-icon.png')).resize(size,size).png().toFile(path.join(brand,`mac-icon-${size}.png`));
await writeFile(path.join(brand,'mac-icon.svg'),svg(`<g transform="translate(32 32) scale(.8203125) translate(-32 -32)"><rect x="2" y="2" width="60" height="60" rx="14" fill="${colors.peach}"/>${fittedSymbol}</g>`));
const tray=svg('<path d="M18 15h20l10 10v24H18Z M38 15v10h10 M25 35h15m-6-6 6 6-6 6" fill="none" stroke="#000" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>');
await writeFile(path.join(brand,'trayTemplate.svg'),tray);
for(const [name,size] of [['trayTemplate.png',18],['trayTemplate@2x.png',36]]){await render(tray,path.join(desktop,name),size);await copyFile(path.join(desktop,name),path.join(brand,name));}
const inspection=[];
for(const row of records){const {data,info}=await sharp(path.join(root,row.file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});let transparent=0,minX=info.width,minY=info.height,maxX=-1,maxY=-1;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const a=data[(y*info.width+x)*4+3];if(a<255)transparent++;if(a>0){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}}inspection.push({...row,width:info.width,height:info.height,nonOpaquePixels:transparent,paintBounds:{minX,minY,maxX,maxY}});}
await writeFile(path.join(brand,'manifest.json'),JSON.stringify({concept:'White / blue file handoff; animals reserved for groups',source:path.relative(root,source),colors,assets:inspection},null,2)+'\n');
console.log('Generated desktop/mobile file handoff assets:',inspection.length);
// Gradle does not regenerate Expo mipmaps when only source PNGs change.
const { syncMobileAndroidIcons } = await import('./sync-mobile-android-icons.js');
await syncMobileAndroidIcons();
