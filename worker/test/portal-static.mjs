// Static regression checks for customer/admin portal access and markup.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../mobile-refinements.css', import.meta.url), 'utf8');
assert.match(html, /id="dashboardModal"/, 'customer dashboard exists');
assert.match(html, /id="tabBtnAdmin"/, 'admin navigation exists');
assert.match(html, /id="tabContentAdmin"/, 'admin panel exists');
assert.match(html, /window\.isStoreAdmin\s*=\s*claimAdmin\s*;/, 'admin UI requires Firebase claim');
assert.doesNotMatch(html, /window\.isStoreAdmin\s*=\s*claimAdmin\s*\|\|/, 'email must not grant admin UI');
assert.match(html, /<link rel="stylesheet" href="\/mobile-refinements\.css">/, 'mobile stylesheet linked');
assert.match(css, /#dashboardModal #dashboardContent/, 'portal mobile styling present');
console.log('PASS customer and admin portal static regression checks');
