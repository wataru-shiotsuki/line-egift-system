const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecipientToken, hashRecipientToken, recipientTokenFromRequest } = require('../lib/recipient-token');

test('gift ID alone cannot authenticate a recipient request', () => {
  const token = createRecipientToken();
  const otherToken = createRecipientToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, otherToken);
  assert.notEqual(hashRecipientToken(token), token);
  assert.notEqual(hashRecipientToken(token), hashRecipientToken(otherToken));
  assert.equal(hashRecipientToken('GT-example'), null);
  assert.equal(recipientTokenFromRequest({ get: () => undefined }), null);
  assert.equal(recipientTokenFromRequest({ get: () => `Bearer ${token}` }), hashRecipientToken(token));
  assert.equal(recipientTokenFromRequest({ get: () => `Bearer ${token.slice(1)}` }), null);
});
