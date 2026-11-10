const crypto = require('crypto');

function createRecipientToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashRecipientToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function recipientTokenFromRequest(req) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '');
  return match ? hashRecipientToken(match[1]) : null;
}

module.exports = { createRecipientToken, hashRecipientToken, recipientTokenFromRequest };
