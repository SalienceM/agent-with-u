import fs from 'node:fs';
import path from 'node:path';

function walk(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else if (entry.name !== 'service-worker.js') files.push(`./${path.relative(base, full).replace(/\\/g, '/')}`);
  }
  return files;
}

export function generateSW(): void {
  const dist = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) return;
  // 约 11MB，包含 PDF 字体/CMap、Draw.io viewer 等按需资源。只缓存 JS 会让
  // 应用本身能离线打开，却在预览 PDF/图表时再次失败，体验上仍是假离线。
  const assets = walk(dist);
  const cacheName = `awu-shell-${Date.now()}`;
  const source = `const CACHE=${JSON.stringify(cacheName)};
const APP_SHELL=${JSON.stringify(assets)};
self.addEventListener('install',(event)=>event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key.startsWith('awu-shell-')&&key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',(event)=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/ws'))return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).catch(()=>caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached)=>cached||fetch(event.request)));
});
`;
  fs.writeFileSync(path.join(dist, 'service-worker.js'), source, 'utf8');
}
