'use strict';
/*
 * 1.3: Überblick (Konflikte, Erreichbarkeit, gesammelte Prüfung von außen), verständliche Fehler – und die Treiber gegen
 * Hostwerks Nachbildungen echter Router (scripts/lib/sim: MikroTik RouterOS 7 REST, UniFi OS – HTTPS mit eigenem
 * Zertifikat, Sitzungen, Fehlerfälle). Die Nachbildungen liegen im Haupt-Repo; fehlt es (CI), werden diese Tests
 * übersprungen. Kein echter Router wird angefasst.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { RouterService, friendly, findConflicts, reachability } = require('../server/service');
const { MikroTik } = require('../server/mikrotik');
const { UniFi } = require('../server/unifi');

const HW = process.env.HOSTWERK_DIR || path.join(__dirname, '..', '..', '..', 'hostwerk');
const SIM = path.join(HW, 'scripts', 'lib', 'sim');
const hasSim = fs.existsSync(path.join(SIM, 'mikrotik.js')) && fs.existsSync(path.join(SIM, 'unifi.js'));

function service(extra = {}) {
  const S = { router: { extra: [{ port: 8080, protocol: 'TCP', label: 'Test' }, { port: 25565, protocol: 'TCP', owner: 'file-share' }] } };
  const host = {
    ctx: { settings: { get: () => S, save: () => {} }, security: { portProviders: new Map(), publicPorts: () => [{ port: 25565, proto: 'TCP', label: 'Minecraft: Survival' }] }, extMarket: { get: () => null }, ...extra },
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s),
    core: () => ({ seal: (x) => x, open: (x) => x }),
  };
  return { svc: new RouterService(host, { timers: false }), S };
}

test('errors read like sentences: timeouts, router off, NAT-PMP, raw status codes', () => {
  assert.match(friendly(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), /took too long/);
  assert.match(friendly(new Error('The operation was aborted due to timeout')), /took too long/);
  assert.match(friendly(Object.assign(new Error('connect ECONNREFUSED 192.168.1.1:80'), { code: 'ECONNREFUSED' })), /does not answer/);
  assert.match(friendly(new Error('fetch failed')), /does not answer/);
  assert.match(friendly(Object.assign(new Error('getaddrinfo ENOTFOUND fritz.box'), { code: 'ENOTFOUND' })), /cannot be found/);
  assert.match(friendly(new Error('No answer via NAT-PMP')), /switch on UPnP or NAT-PMP/);
  assert.match(friendly(new Error('NAT-PMP error 2')), /refused the forwarding/);
  assert.match(friendly(new Error('The router answers with 500')), /internal error/);
  assert.strictEqual(friendly(new Error('The port is already forwarded to another device in the router.')), 'The port is already forwarded to another device in the router.', 'sentences stay');
});

test('conflicts: port given to another device, wanted twice, no longer needed', () => {
  const c = findConflicts({
    wanted: [{ port: 25565, protocol: 'TCP', state: 'other', other: '192.168.1.77', label: 'Minecraft' }, { port: 80, protocol: 'TCP', state: 'ok' }],
    mappings: [{ externalPort: 8443, protocol: 'TCP', ours: true, origin: { kind: 'hostwerk', stale: true } }, { externalPort: 80, protocol: 'TCP', ours: true, origin: { kind: 'hostwerk' } }],
    extra: [{ port: 25565, protocol: 'TCP', owner: 'file-share' }, { port: 9000, protocol: 'UDP' }],
    publicPorts: [{ port: 25565, proto: 'TCP', label: 'Minecraft' }, { port: 9000, proto: 'TCP' }],
    nameOf: (id) => (id === 'file-share' ? 'File share' : id),
  });
  assert.deepStrictEqual(c.map((x) => `${x.kind} ${x.port}/${x.protocol}`), ['other 25565/TCP', 'double 25565/TCP', 'stale 8443/TCP']);
  assert.deepStrictEqual([c[0].vars.ip, c[1].vars.a, c[1].vars.b], ['192.168.1.77', 'File share', 'Minecraft']);
  assert.deepStrictEqual(findConflicts({}), []);
});

test('reachability: data centre, normal, carrier NAT (with and without IPv6), DS-Lite, double NAT, offline', () => {
  assert.strictEqual(reachability({ direct: true, kind: null, gateway: '10.0.0.1' }), 'direct');
  assert.strictEqual(reachability({ gateway: '192.168.1.1' }), 'normal');
  assert.strictEqual(reachability({ gateway: '192.168.1.1', cgnat: true, net: { v6: {} } }), 'cgnat');
  assert.strictEqual(reachability({ gateway: '192.168.1.1', cgnat: true, net: { v6: { stable: '2001:db8::5' } } }), 'dslite', 'IPv6 still gets in');
  assert.strictEqual(reachability({ gateway: '192.168.1.1', dslite: true }), 'dslite');
  assert.strictEqual(reachability({ gateway: '192.168.1.1', doubleNat: true }), 'double');
  assert.strictEqual(reachability({ gateway: null }), 'offline');
});

test('check from outside, all at once: only forwarded TCP ports, result remembered for the tile', async () => {
  const { svc, S } = service();
  svc.status = async () => ({ wanted: [{ port: 25565, protocol: 'TCP', state: 'ok', label: 'Minecraft' }, { port: 8080, protocol: 'TCP', state: 'ok', label: 'Web' }, { port: 51820, protocol: 'UDP', state: 'ok', label: 'WireGuard' }, { port: 9000, protocol: 'TCP', state: 'missing' }] });
  const asked = [];
  const fetchFn = async (url) => { asked.push(url); const port = Number(url.split('/').pop()); return { ok: true, json: async () => ({ ip: '203.0.113.7', reachable: port === 25565 }) }; };
  const r = await svc.reachAll({ fetchFn });
  assert.deepStrictEqual(asked, ['https://ifconfig.co/port/25565', 'https://ifconfig.co/port/8080'], 'UDP and unforwarded ports are not asked');
  assert.deepStrictEqual(r.results.map((x) => [x.port, x.reachable]), [[25565, true], [8080, false], [51820, null]]);
  assert.strictEqual(r.reachable, false);
  assert.strictEqual(r.ip, '203.0.113.7');
  assert.strictEqual(S.router.outside, r, 'remembered');
  const down = await svc.reachAll({ fetchFn: async () => ({ ok: false }) });
  assert.strictEqual(down.reachable, null);
  assert.match(down.results[0].error, /cannot be reached right now/);
});

test('routes: technical errors become sentences, never a 401 (that would sign the user out of Hostwerk)', async () => {
  const { svc } = service();
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  svc.routes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') });
  assert.ok(routes['POST /router/reach-all']);
  svc.via = async () => { throw Object.assign(new Error('User name or password for the router is wrong.'), { code: 401 }); };
  await assert.rejects(routes['GET /router/devices']({}, {}), (e) => e.status === 400 && /password/.test(e.message));
  svc.via = async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); };
  await assert.rejects(routes['GET /router/wifi']({}, {}), (e) => e.status === 502 && e.message === 'The router does not answer.');
});

test('MikroTik driver against the RouterOS 7 replica: certificate, rights, forwardings, conflicts, devices', { skip: !hasSim && 'Hostwerk replicas not found (HOSTWERK_DIR)' }, async () => {
  const { startMikroTik } = require(path.join(SIM, 'mikrotik.js'));
  const mt = await startMikroTik({ users: { admin: { pass: 'geheim', write: true }, reader: { pass: 'lesen', write: false } } });
  try {
    await assert.rejects(new MikroTik({ base: mt.url, user: 'admin', pass: 'geheim' }).info(), (e) => e.code === 'CERT' && /own certificate/.test(e.message), 'own certificate needs consent');
    const m = new MikroTik({ base: mt.url, user: 'admin', pass: 'geheim', insecure: true });
    assert.deepStrictEqual(await m.info(), { model: 'hAP ax3', firmware: 'RouterOS 7.16.1 (stable)', uptime: 788645, manufacturer: 'MikroTik' });
    assert.strictEqual((await m.link()).externalIp, '203.0.113.7');
    await m.addMapping({ externalPort: 51820, protocol: 'UDP', client: '192.168.88.20', description: 'Hostwerk: WireGuard (VPN)' });
    await m.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.88.20', description: 'Hostwerk: Minecraft' });
    const maps = await m.mappings();
    assert.deepStrictEqual(maps.map((x) => `${x.externalPort}/${x.protocol}>${x.internalClient}`).sort(), ['25565/TCP>192.168.88.20', '51820/UDP>192.168.88.20']);
    assert.ok(mt.state.nat.filter((x) => x.chain === 'dstnat').every((x) => x['in-interface-list'] === 'WAN'), 'only from the internet side');
    await assert.rejects(m.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.88.99' }), (e) => e.code === 718);
    await m.removeMapping({ externalPort: 51820, protocol: 'UDP' });
    assert.strictEqual((await m.mappings()).length, 1);
    assert.strictEqual((await m.hosts())[0].name, 'nas');
    await assert.rejects(new MikroTik({ base: mt.url, user: 'reader', pass: 'lesen', insecure: true }).addMapping({ externalPort: 80, protocol: 'TCP', client: '192.168.88.20' }), (e) => e.code === 606 && /policies/.test(e.message));
    await assert.rejects(new MikroTik({ base: mt.url, user: 'admin', pass: 'falsch', insecure: true }).info(), (e) => e.code === 401);
  } finally { await mt.close(); }
  const noWan = await startMikroTik({ wanList: false });
  try { await assert.rejects(new MikroTik({ base: noWan.url, user: 'admin', pass: 'geheim', insecure: true }).addMapping({ externalPort: 80, protocol: 'TCP', client: '192.168.88.20' }), /WAN/); } finally { await noWan.close(); }
});

test('UniFi driver against the UniFi OS replica: sign-in, CSRF, renewed session, forwardings, guest Wi-Fi QR data, 2FA', { skip: !hasSim && 'Hostwerk replicas not found (HOSTWERK_DIR)' }, async () => {
  const { startUniFi } = require(path.join(SIM, 'unifi.js'));
  const u = await startUniFi({ users: { hw: 'geheim', cloud: 'x' }, mfaUsers: ['cloud'], rotateEvery: 3 });
  try {
    const d = new UniFi({ base: u.url, user: 'hw', pass: 'geheim', insecure: true });
    assert.strictEqual((await d.info()).manufacturer || 'Ubiquiti', 'Ubiquiti');
    for (let i = 0; i < 4; i++) await d.mappings(); // Sitzung wird unterwegs erneuert
    assert.ok(u.state.rotations >= 1, 'session renewed by the replica');
    await d.addMapping({ externalPort: 51820, protocol: 'UDP', client: '192.168.1.5', description: 'Hostwerk: WireGuard (VPN)' });
    assert.ok((await d.mappings()).some((m) => m.externalPort === 51820 && m.protocol === 'UDP' && m.internalClient === '192.168.1.5'));
    assert.strictEqual(u.state.csrfRejected, 0, 'CSRF token always sent');
    await d.removeMapping({ externalPort: 51820, protocol: 'UDP' });
    assert.ok(!(await d.mappings()).some((m) => m.externalPort === 51820));
    // TCP+UDP-Regel: nur UDP entfernen, TCP bleibt
    await d.removeMapping({ externalPort: 443, protocol: 'UDP' });
    assert.deepStrictEqual((await d.mappings()).filter((m) => m.externalPort === 443).map((m) => m.protocol), ['TCP']);
    const guest = (await d.wifi()).find((w) => w.guest && w.enabled);
    assert.deepStrictEqual(await d.wifiKey(guest.index), { ssid: 'Gäste; "Café"', password: 'willkommen:2026', security: 'WPA' });
    // Sitzung abgelaufen → neu anmelden, ohne dass der Nutzer etwas merkt
    u.expireSessions();
    assert.ok(Array.isArray(await d.mappings()));
    await assert.rejects(new UniFi({ base: u.url, user: 'cloud', pass: 'x', insecure: true }).info(), /two-factor/);
    await assert.rejects(new UniFi({ base: u.url, user: 'hw', pass: 'falsch', insecure: true }).info(), (e) => e.code === 401);
  } finally { await u.close(); }
});

test('1.6: points for Go live → Status come from the own state – failed, open, all forwarded, none without router', () => {
  const { overviewPoints } = require('../server/contrib');
  const { svc } = service();
  assert.deepStrictEqual(overviewPoints(svc), [], 'nothing asked yet → no point');
  svc.lastState = { at: 1, total: 2, open: [25565], noRouter: false, stuck: false };
  let p = overviewPoints(svc);
  assert.strictEqual(p[0].level, 'warn'); assert.strictEqual(p[0].area, 'online'); assert.strictEqual(p[0].href, '#/live/online/router');
  svc.lastSync = { at: 2, failed: [{ port: 25565, error: 'Port 25565 is already given to 192.168.1.9 in the router.' }] };
  p = overviewPoints(svc);
  assert.strictEqual(p[0].level, 'err'); assert.match(p[0].detail, /1 failed/);
  svc.lastState = { at: 3, total: 2, open: [], noRouter: false, stuck: false };
  assert.strictEqual(overviewPoints(svc)[0].level, 'ok', 'forwarded meanwhile → ok');
  svc.lastState = { at: 4, total: 2, open: [8080], noRouter: false, stuck: true };
  assert.deepStrictEqual(overviewPoints(svc), [], 'carrier NAT: forwardings do not help → no warning');
  svc.lastState = { at: 5, total: 2, open: [8080], noRouter: true, stuck: false };
  assert.deepStrictEqual(overviewPoints(svc), []);
});

test('Prüfung 2026-11: forward checks the protocol, sign-in names a wrong address, keeper and audit read right', async () => {
  const { svc, S } = service();
  svc.igd = async () => { throw new Error('must not ask the router'); };
  await assert.rejects(svc.forward({ port: 8080, protocol: 'SCTP' }), (e) => e.status === 400 && /TCP or UDP/.test(e.message));
  await assert.rejects(svc.forward({ port: 70000 }), (e) => e.status === 400 && /Invalid port/.test(e.message));
  // lowercase is accepted and reaches the router as TCP
  let sent = null;
  svc.igd = async () => ({ localIp: '192.168.1.5', upnp: { control: {} } });
  const R = require('../server/upnp'); const add = R.add; R.add = async (c, x) => { sent = x; return true; };
  try { assert.strictEqual((await svc.forward({ port: 8080, protocol: 'tcp' })).protocol, 'TCP'); } finally { R.add = add; }
  assert.strictEqual(sent.protocol, 'TCP');
  await assert.rejects(svc.login({ kind: 'mikrotik', base: 'router.local' }), (e) => e.status === 400 && /Invalid router address/.test(e.message));
  await assert.rejects(svc.login({ kind: 'cisco', base: 'https://192.168.1.1' }), (e) => /router type/.test(e.message));
  // keeper: an empty DynDNS object (created by the first status) does not count as "set up"
  const got = {};
  require('../server/contrib').contribute({ contribute: (k, v) => { got[k] = v; } }, svc);
  S.router.dyndns = { provider: '', domain: '' };
  assert.strictEqual(got.keeper.areas[0].auto(), 'teils');
  S.router.dyndns.provider = 'duckdns';
  assert.strictEqual(got.keeper.areas[0].auto(), true);
  // audit: removing a forwarding is named as such
  const [re, fn] = got.audit.routes[0];
  const m = '/router/unforward'.match(re);
  assert.ok(m);
  assert.strictEqual(fn(m, {}, { method: 'POST', body: { port: 25565 } }).action, 'Freigabe entfernt');
  assert.strictEqual(fn('/router/forward'.match(re), {}, { method: 'POST', body: { port: 25565 } }).action, 'Port freigegeben');
});

test('Prüfung 2026-11 (2): unforward checks port and protocol, lowercase removes the remembered entry, input errors are 400', async () => {
  const { svc, S } = service();
  svc.igd = async () => { throw new Error('must not ask the router'); };
  await assert.rejects(svc.unforward({ port: 'x' }), (e) => e.status === 400 && /Invalid port/.test(e.message));
  await assert.rejects(svc.unforward({ port: 8080, protocol: 'ICMP' }), (e) => e.status === 400 && /TCP or UDP/.test(e.message));
  // lowercase reaches the router as TCP, and the route forgets the remembered 8080/TCP
  let gone = null;
  svc.igd = async () => ({ localIp: '192.168.1.5', upnp: { control: {} } });
  svc.status = async () => ({ ok: true });
  const R = require('../server/upnp'); const rm = R.remove; R.remove = async (c, x) => { gone = x; return true; };
  const routes = {}; const reg = (m) => (p, fn) => { routes[`${m} ${p}`] = fn; };
  svc.routes({ get: reg('get'), post: reg('post'), put: reg('put'), delete: reg('delete') });
  try { await routes['post /router/unforward']({ body: { port: 8080, protocol: 'tcp' } }, { json: () => {} }); } finally { R.remove = rm; }
  assert.deepStrictEqual(gone, { externalPort: 8080, protocol: 'TCP' });
  assert.ok(!S.router.extra.some((e) => e.port === 8080), 'remembered forwarding forgotten');
  // DynDNS input errors are the user's fault (400), not "the router does not answer" (502)
  await assert.rejects(routes['put /router/dyndns']({ body: { provider: 'duckdns' } }, { json: () => {} }), (e) => e.status === 400);
  await assert.rejects(svc.login({ kind: 'unifi', base: 'https://192.168.1.1', user: '' }), (e) => e.status === 400);
});

test('own forwarding with another internal port is remembered with it; the status names the last sync', async () => {
  const { svc, S } = service();
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  svc.routes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE') });
  const sent = [];
  svc.forward = async (b) => { sent.push(b); return { port: b.port, protocol: b.protocol || 'TCP' }; };
  svc.status = async () => ({ lastSync: svc.lastSync ? svc.lastSync.at : null });
  await routes['POST /router/forward']({ body: { port: 2222, internalPort: 22, label: 'SSH', remember: true } }, { json() {} });
  assert.deepStrictEqual(S.router.extra.find((e) => e.port === 2222), { port: 2222, protocol: 'TCP', label: 'SSH', internalPort: 22 });
  assert.strictEqual(svc.wanted().find((w) => w.port === 2222).internalPort, 22, 'the sync forwards to the internal port');
  await routes['POST /router/forward']({ body: { port: 3000, internalPort: 3000, remember: true } }, { json() {} });
  assert.ok(!('internalPort' in S.router.extra.find((e) => e.port === 3000)), 'same port – nothing extra stored');
});
