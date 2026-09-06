import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorDetails } from './errors.js';

function safeSegment(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
}

export async function saveDiagnostics({ rootPath, list, page, error, startedAt }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(rootPath, `${stamp}-${safeSegment(list.id)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let html = '';
  let url = list.url;
  let title = '';
  if (page) {
    try { html = await page.content(); } catch {}
    try { url = page.url(); } catch {}
    try { title = await page.title(); } catch {}
    try {
      await page.screenshot({ path: join(directory, 'page.png'), fullPage: true });
    } catch {}
  }
  await writeFile(join(directory, 'page.html'), html, { mode: 0o600 });
  await writeFile(join(directory, 'metadata.json'), JSON.stringify({
    listId: list.id,
    listName: list.name,
    configuredUrl: list.url,
    finalUrl: url,
    pageTitle: title,
    startedAt,
    capturedAt: new Date().toISOString(),
    error: errorDetails(error)
  }, null, 2), { mode: 0o600 });
  return directory;
}
