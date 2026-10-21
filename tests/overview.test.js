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
