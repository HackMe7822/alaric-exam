const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildExamUrl(token) {
  const base = process.env.APP_URL || 'http://localhost:3000';
  return `${base}/exam/${token}`;
}

module.exports = { generateToken, buildExamUrl };
