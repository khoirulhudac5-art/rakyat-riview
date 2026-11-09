import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../scripts/preview-accounts.mjs';

test('both activation previews serve the actual logo and their frontend resources', async () => {
  const server = createPreview();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/aktivasi.html', '/pembeli/aktivasi.html']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      const html = await response.text();
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        if (!/\.(?:css|js|png)(?:\?|$)/.test(match[1])) continue;
        const resource = await fetch(new URL(match[1], origin + path));
        assert.equal(resource.status, 200, `${path}: ${match[1]}`);
      }
    }
    const accountScript = await (await fetch(origin + '/pembeli/account.js')).text();
    assert.match(accountScript, /src="\.\.\/assets\/rakyat-review-logo\.png"/);
    const logo = await fetch(origin + '/assets/rakyat-review-logo.png');
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('cache-control'), 'no-store');
    assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0, 8)], [137,80,78,71,13,10,26,10]);
    // Serving the legacy form must not expose its production API through preview.
    assert.equal((await fetch(origin + '/api/activate-card', {method:'POST'})).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
