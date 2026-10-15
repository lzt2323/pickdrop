// Render every HTML screen and check responsive geometry with the existing workspace Playwright.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) && file !== root) throw Error('Invalid path');
    const bytes = await fs.readFile(file); res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });res.end(bytes);
  } catch { res.writeHead(404);res.end('Not found'); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true });
const screens = [], issues = [];
const categories = process.argv.includes('--desktop-only') ? ['desktop'] : ['desktop','mobile','states'];
for (const category of categories) {
  const records = JSON.parse(await fs.readFile(path.join(root,category,'manifest.json'),'utf8'));
  for (const record of records) screens.push({ ...record, directory:category, key:`${category}-${record.id}` });
}
try {
  for (const screen of screens) {
    const page = await browser.newPage({ viewport:{width:screen.width,height:screen.height}, deviceScaleFactor:1 });
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('requestfailed',request=>errors.push(`Resource: ${request.url()}`));
    await page.goto(`${base}/${screen.directory}/${screen.file}`,{waitUntil:'networkidle'});
    if (!(await page.locator('body').innerText()).trim() && !(await page.locator('button[aria-label],a[aria-label]').count())) errors.push('Empty screen');
    const semantics = await page.evaluate(() => [...document.querySelectorAll('button,a[href]')].filter(node => {
      const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&!node.getAttribute('aria-label')&&!node.getAttribute('title')&&!node.textContent.trim()&&!node.querySelector('img[alt]');
    }).map(node=>node.outerHTML.slice(0,120)));
    if(semantics.length)errors.push(...semantics.map(node=>`Unlabelled control: ${node}`));
    const links = await page.locator('a[href]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')).filter(href=>href&&href.split(/[?#]/)[0].endsWith('.html')));
    for(const href of links){try{await fs.access(path.resolve(root,screen.directory,href.split(/[?#]/)[0]));}catch{errors.push(`Missing link: ${href}`);}}
    await page.screenshot({path:path.join(root,'shots',`${screen.key}.png`),fullPage:false});
    for (const width of [320,375,414,768]) {
      await page.setViewportSize({width,height:screen.height});
      const geometry = await page.evaluate(() => {
        const overflow = Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>innerWidth+1;
        const wrapped = [...document.querySelectorAll('button,.btn,nav a')].filter(node=>{
          const r=node.getBoundingClientRect();if(!r.width||!r.height)return false;
          return node.scrollWidth>node.clientWidth+2;
        }).map(node=>(node.textContent||node.getAttribute('aria-label')||'').trim().slice(0,50));
        const images = [...document.images].filter(img=>!img.complete||!img.naturalWidth).map(img=>img.getAttribute('src'));
        const clippedControls = [...document.querySelectorAll('button,input,textarea,.btn,img')].filter(node=>{
          const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&(r.left < -1 || r.right > innerWidth+1);
        }).map(node=>node.getAttribute('aria-label')||node.textContent?.trim().slice(0,50)||node.tagName);
        return {overflow,wrapped,images,clippedControls};
      });
      if(geometry.overflow||geometry.wrapped.length||geometry.images.length||geometry.clippedControls.length) issues.push({screen:screen.key,width,...geometry});
    }
    if(errors.length)issues.push({screen:screen.key,errors});
    await page.close();
  }
  // The user can open the HTML directly, without a development server.
  const filePage = await browser.newPage({viewport:{width:390,height:844}});
  for (const directory of categories) {
    const first=screens.find(screen=>screen.directory===directory);await filePage.goto(`file://${path.join(root,first.directory,first.file)}`,{waitUntil:'load'});
    if(!(await filePage.locator('body').innerText()).trim() && !(await filePage.locator('button[aria-label],a[aria-label]').count()))issues.push({screen:`file-url-${directory}`,error:'Direct file open failed'});
  }
  await filePage.close();
  const report={screenCount:screens.length,responsiveWidths:[320,375,414,768],issues,passed:issues.length===0};
  await fs.writeFile(path.join(root,categories.length===1?'qa-desktop.json':'qa-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
  if(issues.length)process.exitCode=1;
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
