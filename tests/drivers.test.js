'use strict';
/*
 * MikroTik (RouterOS REST) and UniFi (UniFi OS) against fake routers, TR-064 error codes and Wi-Fi keys,
 * Wi-Fi QR text, origin of every forwarding, "reachable from outside?". Never touches a real router.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { MikroTik } = require('../server/mikrotik');
const { UniFi } = require('../server/unifi');
const { Tr064 } = require('../server/tr064');
const { RouterService, wifiQrText } = require('../server/service');
const { parseDuration } = require('../server/rest');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

test('MikroTik: sign-in, info, dst-nat forwardings create/list/delete, conflicts, DHCP devices', async () => {
  const nat = [{ '.id': '*1', chain: 'srcnat', action: 'masquerade' }];
  let n = 2;
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.headers.authorization !== `Basic ${Buffer.from('admin:pw').toString('base64')}`) return send(401, { error: 401, message: 'Unauthorized' });
    if (req.url === '/rest/system/resource') return send(200, { 'board-name': 'hAP ax3', version: '7.16', uptime: '1d2h3m4s' });
    if (req.url === '/rest/ip/firewall/nat' && req.method === 'GET') return send(200, nat);
    if (req.url === '/rest/ip/firewall/nat' && req.method === 'PUT') { const x = { '.id': `*${n++}`, ...JSON.parse(body) }; nat.push(x); return send(201, x); }
    if (req.method === 'DELETE' && req.url.startsWith('/rest/ip/firewall/nat/')) { const id = decodeURIComponent(req.url.split('/').pop()); nat.splice(nat.findIndex((x) => x['.id'] === id), 1); return send(204, {}); }
    if (req.url === '/rest/ip/dhcp-server/lease') return send(200, [{ address: '192.168.88.20', 'mac-address': 'aa:bb:cc:dd:ee:ff', 'host-name': 'nas', status: 'bound' }]);
    return send(404, { detail: 'no such command' });
  });
  const base = await listen(srv);
  await assert.rejects(new MikroTik({ base, user: 'admin', pass: 'wrong' }).info(), /password/);
  const m = new MikroTik({ base, user: 'admin', pass: 'pw' });
  assert.deepStrictEqual(await m.info(), { model: 'hAP ax3', firmware: 'RouterOS 7.16', uptime: 93784, manufacturer: 'MikroTik' });
  await m.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.88.20', description: 'Hostwerk: Minecraft' });
  await m.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.88.20', description: 'Hostwerk: Minecraft' }); // schon da → nichts doppelt
  let maps = await m.mappings();
  assert.strictEqual(maps.length, 1, 'srcnat is not a forwarding, no duplicates');
  assert.deepStrictEqual([maps[0].externalPort, maps[0].protocol, maps[0].internalClient, maps[0].description], [25565, 'TCP', '192.168.88.20', 'Hostwerk: Minecraft']);
  assert.strictEqual(nat[1]['in-interface-list'], 'WAN');
  await assert.rejects(m.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.88.99' }), (e) => e.code === 718);
  await m.removeMapping({ externalPort: 25565 });
  maps = await m.mappings();
  assert.strictEqual(maps.length, 0);
  await assert.rejects(m.removeMapping({ externalPort: 1 }), (e) => e.code === 714);
  assert.strictEqual((await m.hosts())[0].name, 'nas');
  srv.close();
  assert.strictEqual(parseDuration('1w2d3h4m5s'), 604800 + 172800 + 10800 + 240 + 5);
});

test('UniFi: sign-in with cookie and CSRF, port forwards (tcp_udp counts twice), session renewal, guest Wi-Fi key', async () => {
  const st = { pf: [{ _id: 'p1', name: 'Web', dst_port: '443', fwd: '192.168.1.5', fwd_port: '443', proto: 'tcp_udp', enabled: true }], logins: 0, expireOnce: true };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
    if (req.url === '/api/auth/login') {
      const b = JSON.parse(body);
      if (b.username !== 'hw' || b.password !== 'pw') return send(401, {});
      st.logins++;
      return send(200, {}, { 'set-cookie': [`TOKEN=t${st.logins}; Path=/; HttpOnly`], 'x-csrf-token': 'csrf1' });
    }
    if (!/TOKEN=t\d/.test(req.headers.cookie || '')) return send(401, {});
    if (req.method !== 'GET' && req.headers['x-csrf-token'] !== 'csrf1') return send(403, {});
    const p = req.url.replace('/proxy/network/api/s/default', '');
    if (p === '/rest/portforward' && req.method === 'GET') {
      if (st.expireOnce) { st.expireOnce = false; return send(401, {}); } // Sitzung abgelaufen → neu anmelden
      return send(200, { meta: { rc: 'ok' }, data: st.pf });
    }
    if (p === '/rest/portforward' && req.method === 'POST') { const x = { _id: `p${st.pf.length + 1}`, ...JSON.parse(body) }; st.pf.push(x); return send(200, { meta: { rc: 'ok' }, data: [x] }); }
    if (req.method === 'DELETE' && p.startsWith('/rest/portforward/')) { st.pf = st.pf.filter((x) => x._id !== p.split('/').pop()); return send(200, { meta: { rc: 'ok' }, data: [] }); }
    if (p === '/rest/wlanconf/g1') return send(200, { meta: { rc: 'ok' }, data: [{ _id: 'g1', name: 'Gäste', x_passphrase: 'willkommen', security: 'wpapsk', is_guest: true }] });
    if (p === '/stat/sysinfo') return send(200, { meta: { rc: 'ok' }, data: [{ version: '9.0.114', uptime: 3600 }] });
    if (p === '/stat/device-basic') return send(200, { meta: { rc: 'ok' }, data: [{ type: 'udm', model: 'UDR' }] });
    return send(404, { meta: { rc: 'error', msg: 'api.err.NotFound' } });
  });
  const base = await listen(srv);
  await assert.rejects(new UniFi({ base, user: 'hw', pass: 'x' }).info(), /password/);
  const u = new UniFi({ base, user: 'hw', pass: 'pw' });
  assert.deepStrictEqual(await u.info(), { model: 'UDR', firmware: 'Network 9.0.114', uptime: 3600, manufacturer: 'Ubiquiti' });
  const maps = await u.mappings();
  assert.deepStrictEqual(maps.map((x) => `${x.externalPort}/${x.protocol}`), ['443/TCP', '443/UDP']);
  assert.strictEqual(st.logins, 2, 'expired session renewed once');
  await u.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.1.20', description: 'Hostwerk: MC' });
  assert.strictEqual(st.pf[1].proto, 'tcp');
  await assert.rejects(u.addMapping({ externalPort: 443, protocol: 'TCP', client: '192.168.1.20' }), (e) => e.code === 718);
  await u.removeMapping({ externalPort: 25565 });
  assert.strictEqual(st.pf.length, 1);
  assert.deepStrictEqual(await u.wifiKey('g1'), { ssid: 'Gäste', password: 'willkommen', security: 'WPA' });
  srv.close();
});

test('TR-064: error codes become clear messages; Wi-Fi name and password for the QR code', async () => {
  const resp = (a, f) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${a}Response>${Object.entries(f).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${a}Response></s:Body></s:Envelope>`;
  const srv = http.createServer(async (req, res) => {
    await readBody(req);
    if (req.url === '/tr64desc.xml') { res.end(`<root><device><modelName>FRITZ!Box</modelName><serviceList><service><serviceType>urn:dslforum-org:service:WLANConfiguration:3</serviceType><controlURL>/w3</controlURL></service><service><serviceType>urn:dslforum-org:service:WANIPConnection:1</serviceType><controlURL>/wan</controlURL></service></serviceList></device></root>`); return; }
    const action = String(req.headers.soapaction || '').split('#')[1];
    if (action === 'GetInfo') { res.end(resp('GetInfo', { NewSSID: 'FRITZ!Box Gastzugang', NewBeaconType: '11i' })); return; }
    if (action === 'GetSecurityKeys') { res.end(resp('GetSecurityKeys', { NewKeyPassphrase: 'gast&amp;freund' })); return; }
    if (action === 'GetStatusInfo') { res.end(resp('GetStatusInfo', { NewConnectionStatus: 'Connected' })); return; }
    res.statusCode = 500; res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
  });
  const base = await listen(srv);
  const t = new Tr064({ base, user: 'u', pass: 'p' });
  assert.deepStrictEqual(await t.wifiKey(3), { ssid: 'FRITZ!Box Gastzugang', password: 'gast&freund', security: 'WPA' });
  await assert.rejects(t.addMapping({ externalPort: 80, client: '1.2.3.4' }), (e) => e.code === 718 && /another device/.test(e.message));
  srv.close();
});

test('Wi-Fi QR text: special characters escaped, open networks without password', () => {
  assert.strictEqual(wifiQrText({ ssid: 'Gast;Netz', password: 'a:b\\c,"d' }), 'WIFI:T:WPA;S:Gast\\;Netz;P:a\\:b\\\\c\\,\\"d;;');
  assert.strictEqual(wifiQrText({ ssid: 'Café', password: '' }), 'WIFI:T:nopass;S:Café;;');
  assert.strictEqual(wifiQrText({ ssid: 'X', password: 'p', hidden: true }), 'WIFI:T:WPA;S:X;P:p;H:true;;');
});

function service(extra = {}) {
  const S = { router: { extra: [{ port: 8080, protocol: 'TCP', label: 'Test' }] }, mailserver: { public: true, ports: { smtp: 25, imaps: 993 } } };
  const providers = new Map([['game-servers', () => [{ port: 2456, proto: 'UDP', label: 'Valheim' }]]]);
  const host = {
    ctx: { settings: { get: () => S, save: () => {} }, security: { portProviders: providers, publicPorts: () => [{ port: 25565, proto: 'TCP', label: 'Minecraft: Survival' }, { port: 2456, proto: 'UDP', label: 'Valheim' }, { port: 25, proto: 'TCP', label: 'Mailserver (smtp)' }] }, extMarket: { get: (id) => ({ 'game-servers': { names: { de: 'Spiele-Server' } } })[id] || null }, ...extra },
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s),
    core: () => ({ seal: (x) => x, open: (x) => x }),
  };
  return new RouterService(host, { timers: false });
}

test('every forwarding says where it comes from', () => {
  const w = service().wanted();
  const by = Object.fromEntries(w.map((x) => [`${x.port}/${x.protocol}`, x.origin]));
  assert.deepStrictEqual(by['25565/TCP'], { kind: 'hostwerk' });
  assert.deepStrictEqual(by['2456/UDP'], { kind: 'extension', id: 'game-servers', name: 'Spiele-Server' });
  assert.strictEqual(by['25/TCP'].id, 'mail-server');
  assert.deepStrictEqual(by['8080/TCP'], { kind: 'manual' });
});

test('router.forwards: other packages add and remove their own forwardings, the automatic mode keeps them', async () => {
  const svc = service();
  const done = [];
  svc.forward = async (w) => { done.push(['add', w.port, w.protocol]); return { port: w.port, protocol: w.protocol, client: '192.168.1.5' }; };
  svc.unforward = async (w) => { done.push(['remove', w.port, w.protocol]); return true; };
  const f = svc.forwards;
  assert.deepStrictEqual(await f.add({ port: 2022, label: 'SFTP (file share)' }, 'file-share'), { port: 2022, protocol: 'TCP', client: '192.168.1.5' });
  assert.deepStrictEqual(f.owned('file-share'), [{ port: 2022, protocol: 'TCP', label: 'SFTP (file share)', owner: 'file-share' }]);
  assert.deepStrictEqual(f.list().map((x) => [x.port, x.owner]), [[8080, null], [2022, 'file-share']]);
  // „wanted“ enthält sie mit Herkunft – Abgleich und Automatik legen sie an und räumen sie nicht weg
  const w = svc.wanted().find((x) => x.port === 2022);
  assert.deepStrictEqual(w.origin, { kind: 'extension', id: 'file-share', name: 'file-share' });
  assert.ok(!('owner' in w));
  // Ein anderes Paket darf den Port nicht übernehmen und keine fremden Einträge löschen
  await assert.rejects(f.add({ port: 2022 }, 'bedrock-bridge'), /already used by file-share/);
  assert.strictEqual(await f.remove({ port: 2022 }, 'bedrock-bridge'), false);
  assert.strictEqual(await f.remove({ port: 8080 }, 'file-share'), false, 'by hand stays');
  // Von Hand gemerkt → geht an das Paket über; Port, den Hostwerk selbst braucht, bleibt im Router
  await f.add({ port: 8080, label: 'Web' }, 'file-share', { now: false });
  assert.strictEqual(f.owned('file-share').length, 2);
  assert.ok(!done.some((d) => d[1] === 8080), 'now: false – only remembered');
  assert.strictEqual(await f.remove({ port: 2022 }, 'file-share'), true);
  assert.deepStrictEqual(done.pop(), ['remove', 2022, 'TCP']);
  await f.add({ port: 25565 }, 'file-share', { now: false });
  assert.strictEqual(await f.remove({ port: 25565 }, 'file-share'), true);
  assert.ok(!done.some((d) => d[0] === 'remove' && d[1] === 25565), 'Minecraft stays forwarded');
  await assert.rejects(f.add({ port: 0 }, 'file-share'), /Invalid port/);
  await assert.rejects(f.add({ port: 1, protocol: 'ICMP' }, 'file-share'), /TCP or UDP/);
  assert.throws(() => f.owned('Not An Id'), /owner/);
});

test('reachable from outside: asks the public check, only the port number goes out', async () => {
  const svc = service();
  let asked = null;
  const r = await svc.reach(25565, { fetchFn: async (url) => { asked = url; return { ok: true, json: async () => ({ ip: '203.0.113.7', port: 25565, reachable: true }) }; } });
  assert.strictEqual(asked, 'https://ifconfig.co/port/25565');
  assert.deepStrictEqual([r.reachable, r.ip], [true, '203.0.113.7']);
  await assert.rejects(svc.reach(70000), /Invalid port/);
  await assert.rejects(svc.reach(80, { fetchFn: async () => ({ ok: false }) }), /cannot be reached/);
});

test('UniFi: removing one protocol of a TCP+UDP rule keeps the other; two-factor and lockout read clearly; renewed session cookie is used', async () => {
  const st = { pf: [{ _id: 'p1', name: 'Web', dst_port: '443', fwd: '192.168.1.5', fwd_port: '443', proto: 'tcp_udp', enabled: true }], mode: 'ok', cookies: [] };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
    if (req.url === '/api/auth/login') {
      if (st.mode === 'mfa') return send(499, { code: 'MFA_AUTH_REQUIRED' });
      if (st.mode === 'locked') return send(429, { code: 'AUTHENTICATION_FAILED_LIMIT_REACHED' });
      return send(200, {}, { 'set-cookie': ['TOKEN=t1; Path=/; HttpOnly'], 'x-csrf-token': 'c1' });
    }
    st.cookies.push(req.headers.cookie);
    const p = req.url.replace('/proxy/network/api/s/default', '');
    if (p === '/rest/portforward' && req.method === 'GET') return send(200, { meta: { rc: 'ok' }, data: st.pf }, { 'set-cookie': ['TOKEN=t2; Path=/; HttpOnly'], 'x-updated-csrf-token': 'c2' });
    if (p === '/rest/portforward/p1' && req.method === 'PUT') { Object.assign(st.pf[0], JSON.parse(body)); return send(200, { meta: { rc: 'ok' }, data: st.pf }); }
    if (p === '/rest/portforward/p1' && req.method === 'DELETE') { st.pf = []; return send(200, { meta: { rc: 'ok' }, data: [] }); }
    return send(404, { meta: { rc: 'error', msg: 'api.err.NotFound' } });
  });
  const base = await listen(srv);
  const u = new UniFi({ base, user: 'hw', pass: 'pw' });
  await u.removeMapping({ externalPort: 443, protocol: 'UDP' });
  assert.deepStrictEqual([st.pf.length, st.pf[0].proto], [1, 'tcp'], 'TCP stays');
  assert.strictEqual(st.cookies[st.cookies.length - 1], 'TOKEN=t2', 'renewed TOKEN cookie used');
  await u.removeMapping({ externalPort: 443, protocol: 'TCP' });
  assert.strictEqual(st.pf.length, 0);
  st.mode = 'mfa'; await assert.rejects(new UniFi({ base, user: 'x', pass: 'y' }).info(), /two-factor/);
  st.mode = 'locked'; await assert.rejects(new UniFi({ base, user: 'x', pass: 'y' }).info(), (e) => e.code === 429 && /wait/.test(e.message));
  srv.close();
});

test('MikroTik without interface list "WAN": clear hint, no rule without interface; router off: clear message', async () => {
  const srv = http.createServer(async (req, res) => {
    await readBody(req);
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.method === 'GET') return send(200, []);
    return send(400, { error: 400, message: 'Bad Request', detail: 'input does not match any value of in-interface-list' });
  });
  const base = await listen(srv);
  await assert.rejects(new MikroTik({ base, pass: 'pw' }).addMapping({ externalPort: 80, protocol: 'TCP', client: '192.168.88.2' }), /interface list "WAN"/);
  srv.close();
  await assert.rejects(new MikroTik({ base, pass: 'pw' }).info(), /does not answer/);
});
