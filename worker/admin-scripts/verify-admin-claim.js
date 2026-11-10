'use strict';
// Read-only verification of the Firebase admin custom claim.
// Run locally: npm run verify:admin
const admin = require('./init');
const email = 'l@valentinolopez.de';
(async () => {
  const user = await admin.auth().getUserByEmail(email);
  const enabled = user.customClaims?.admin === true;
  console.log('Firebase project:', admin.app().options.projectId);
  console.log('Account:', email);
  console.log('Admin custom claim:', enabled ? 'admin=true (OK)' : 'admin fehlt (NICHT OK)');
  if (!enabled) process.exitCode = 1;
})().catch(err => {
  console.error('Pruefung fehlgeschlagen:', err.message);
  process.exitCode = 1;
});
