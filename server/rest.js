'use strict';
/*
 * Small JSON request helper for routers with their own HTTPS certificate (MikroTik, UniFi): routers in the home network
 * almost always use a self-signed certificate. Only when the user allowed it at sign-in ("insecure") is the certificate
 * not checked – and only for this one router address.
 */
const http = require('http');
const https = require('https');

/** → { status, headers, json, text } */
function request(url, { method = 'GET', headers = {}, body, insecure = false, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(u, { method, timeout, rejectUnauthorized: !insecure, headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('The router does not answer.'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(e.code || e.message)) return reject(Object.assign(new Error('The router uses its own certificate – allow it at sign-in ("Router has its own certificate").'), { code: 'CERT' }));
      // Router aus, falsche Adresse oder Verbindung abgerissen: klare Meldung statt „ECONNRESET“
      if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(e.code || '')) return reject(Object.assign(new Error('The router does not answer.'), { code: e.code }));
      return reject(e);
    });
    if (data) req.write(data);
    req.end();
  });
}

/** "1w2d3h4m5s" (RouterOS) → seconds */
function parseDuration(s) {
  const f = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let n = 0; for (const m of String(s || '').matchAll(/(\d+)([wdhms])/g)) n += Number(m[1]) * f[m[2]];
  return n;
}

module.exports = { request, parseDuration };
