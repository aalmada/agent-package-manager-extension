import { test, expect } from '@playwright/test';
import { contentSecurityPolicy } from '../../src/views/csp';
import { renderMarkdown } from '../../src/views/markdown';

test('README images make no remote request by default and load only after opt-in', async ({ page }) => {
  const url = 'https://images.example.test/chart.svg';
  let requests = 0;
  await page.route(/^https?:\/\/images\.example\.test\//, async route => {
    requests++;
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' });
  });
  const blocked = renderMarkdown(`![chart](${url})`);
  const policy = contentSecurityPolicy('https://vscode-webview.test', 'test');
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${policy}"><article>${blocked.html}</article>`);
  await expect(page.locator('article')).toContainText('Image blocked: chart');
  await expect(page.locator('img')).toHaveCount(0);
  const violation = await page.evaluate(source => new Promise<string>(resolve => {
    document.addEventListener('securitypolicyviolation', event => resolve(event.violatedDirective), { once: true });
    const image = document.createElement('img'); image.src = source; document.body.append(image);
  }), url);
  expect(violation).toBe('img-src');
  expect(requests).toBe(0);

  await page.goto('about:blank');
  const allowed = renderMarkdown(`![chart](${url})`, true);
  const allowedPolicy = contentSecurityPolicy('https://vscode-webview.test', 'test', true);
  const request = page.waitForRequest(url);
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${allowedPolicy}"><article>${allowed.html}</article>`);
  await request;
  await expect(page.locator('img')).toBeVisible();
  expect(requests).toBe(1);

  const insecureUrl = 'http://images.example.test/insecure.svg';
  const insecure = renderMarkdown(`![insecure](${insecureUrl})`, true);
  expect(insecure.blockedImages).toEqual({ https: false, insecure: true });
  expect(insecure.html).not.toContain('<img');
  const insecureViolation = await page.evaluate(source => new Promise<string>(resolve => {
    document.addEventListener('securitypolicyviolation', event => resolve(event.violatedDirective), { once: true });
    const image = document.createElement('img'); image.src = source; document.body.append(image);
  }), insecureUrl);
  expect(insecureViolation).toBe('img-src');
  expect(requests).toBe(1);
});
