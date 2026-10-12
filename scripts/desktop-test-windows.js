// Test helpers distinguish content from the separate native animal surface.
export async function firstContentWindow(app) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (page.url().includes('native-anchor.html')) continue;
      try { if (await page.evaluate(() => Boolean(window.pickdrop?.bootstrap))) return page; } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Content window did not become ready');
}
export function nextContentWindow(app) {
  return app.waitForEvent('window', { predicate: async page => {
    try {
      await page.waitForURL(url => ['http:', 'https:', 'file:'].includes(url.protocol));
      return !page.url().includes('native-anchor.html');
    } catch { return false; }
  }});
}
export async function nativeWindowPage(app, id) {
  for (const page of app.windows()) {
    const handle = await app.browserWindow(page);
    try { if (await handle.evaluate(win => win.id) === id) return page; }
    finally { await handle.dispose(); }
  }
  throw new Error(`Native window ${id} has no renderer page`);
}
