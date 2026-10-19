'use strict';
/*
 * Router via UPnP-IGD against a fake router (description + SOAP): create/clean up Hostwerk forwardings, readable errors,
 * carrier NAT, DS-Lite with IPv6 pinholes, DynDNS, servers with a public address. Never touches a real router.
 *   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
process.env.HW_TEST = '1';
const R = require('../server/upnp');
const { RouterService } = require('../server/service');
const de = require('../locales/de.json');

const tag = (xml, n) => (xml.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1];
const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);

function fakeRouter({ ext = '93.184.216.34', deny = [], v6 = false } = {}) {
  const map = new Map(); // "TCP:25565" -> entry
  const holes = new Map(); // UniqueID -> { client, port, proto }
  const ST = 'urn:schemas-upnp-org:service:WANIPConnection:1';
  const V6 = 'urn:schemas-upnp-org:service:WANIPv6FirewallControl:1';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.end(`<?xml version="1.0"?><root><device><friendlyName>FRITZ!Box 7590 (Test)</friendlyName><manufacturer>FRITZ! GmbH</manufacturer><modelName>FRITZ!Box 7590</modelName><deviceList><device><serviceList><service><serviceType>${ST}</serviceType><controlURL>/ctl</controlURL></service>${v6 ? `<service><serviceType>${V6}</serviceType><controlURL>/ctl6</controlURL></service>` : ''}</serviceList></device></deviceList><presentationURL>http://192.168.178.1/</presentationURL></device></root>`);
        return;
      }
      const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
      const reply = (inner) => res.end(`<?xml version="1.0"?><s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
      const fault = (code) => { res.statusCode = 500; res.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>x</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
      if (action === 'GetExternalIPAddress') return reply(`<NewExternalIPAddress>${ext}</NewExternalIPAddress>`);
      if (action === 'AddPinhole') { const id = String(holes.size + 1); holes.set(id, { client: tag(body, 'InternalClient'), port: Number(tag(body, 'InternalPort')), proto: tag(body, 'Protocol') }); return reply(`<UniqueID>${id}</UniqueID>`); }
      if (action === 'UpdatePinhole') return holes.has(tag(body, 'UniqueID')) ? reply('') : fault(704);
      if (action === 'DeletePinhole') return holes.delete(tag(body, 'UniqueID')) ? reply('') : fault(704);
      if (action === 'GetStatusInfo') return reply('<NewConnectionStatus>Connected</NewConnectionStatus>');
      if (action === 'AddPortMapping') {
        const port = Number(tag(body, 'NewExternalPort'));
        if (deny.includes(port)) return fault(606);
        const k = `${tag(body, 'NewProtocol')}:${port}`;
        const cur = map.get(k);
        if (cur && cur.client !== tag(body, 'NewInternalClient')) return fault(718);
        map.set(k, { port, proto: tag(body, 'NewProtocol'), client: tag(body, 'NewInternalClient'), desc: tag(body, 'NewPortMappingDescription'), inPort: Number(tag(body, 'NewInternalPort')) });
        return reply('');
      }
      if (action === 'DeletePortMapping') { const k = `${tag(body, 'NewProtocol')}:${tag(body, 'NewExternalPort')}`; if (!map.delete(k)) return fault(714); return reply(''); }
      if (action === 'GetGenericPortMappingEntry') {
        const e = [...map.values()][Number(tag(body, 'NewPortMappingIndex'))];
        if (!e) return fault(713);
        return reply(`<NewRemoteHost></NewRemoteHost><NewExternalPort>${e.port}</NewExternalPort><NewProtocol>${e.proto}</NewProtocol><NewInternalPort>${e.inPort}</NewInternalPort><NewInternalClient>${e.client}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>${e.desc}</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>`);
      }
      fault(401);
    });
  });
  return { srv, map, holes };
}
const listen = (fr) => new Promise((r) => fr.srv.listen(0, '127.0.0.1', r));

/** A host like Hostwerk gives it, with plain objects. */
function fakeHost(lang = 'en') {
  const S = { general: { language: lang } };
  return {
    ctx: { settings: { get: () => S, save: () => {} }, security: { publicPorts: () => [] }, keeper: null },
    t: (s, v) => fill(lang === 'de' && de[s] ? de[s] : s, v),
    core: (n) => { if (n === 'secrets') return { seal: (x) => `sealed:${x}`, open: (x) => String(x).replace(/^sealed:/, '') }; throw new Error(n); },
    broadcast: () => {},
  };
}

test('UPnP forwardings, errors, carrier NAT, DS-Lite, DynDNS, data centre', async () => {
  const fr = fakeRouter({ deny: [80] });
  await listen(fr);
  const svc = new RouterService(fakeHost('en'), { timers: false });
  svc.net = async () => ({ v6: { local: [], stable: null, public: null }, v4public: '93.184.216.34' });
  try {
    const d = await R.describe(`http://127.0.0.1:${fr.srv.address().port}/desc.xml`);
    assert.ok(d.device.model === 'FRITZ!Box 7590' && /\/ctl$/.test(d.control.url), 'description read');
    svc.igd = async () => ({ gateway: '127.0.0.1', localIp: '192.168.178.168', iface: 'Test', addresses: ['192.168.178.168'], upnp: d, natpmp: false });
    let st = await svc.status();
    assert.ok(st.router.model === 'FRITZ!Box 7590' && st.externalIp === '93.184.216.34' && st.hint && st.hint.vendor === 'FRITZ!Box' && st.connection === 'Connected', 'status: model, public IP, vendor tip');
    await svc.forward({ port: 25565, label: 'Minecraft: Survival' });
    st = await svc.status();
    const m = st.mappings.find((x) => x.externalPort === 25565);
    assert.ok(m && m.ours && m.here && m.internalClient === '192.168.178.168', 'forwarding to this PC, marked as Hostwerk');
    fr.map.set('TCP:8080', { port: 8080, proto: 'TCP', client: '192.168.178.20', desc: 'NAS', inPort: 8080 });
    await assert.rejects(svc.forward({ port: 8080 }), /another device/);
    await assert.rejects(svc.forward({ port: 80 }), /does not allow automatic forwardings/);
    const r = await svc.sync();
    assert.ok(r.removed.includes(25565) && !fr.map.has('TCP:25565') && fr.map.has('TCP:8080'), 'sync cleans up own forwardings that are no longer needed');
    svc.cfg.extra = [{ port: 27015, protocol: 'TCP', label: 'Game server' }];
    const r2 = await svc.sync();
    assert.ok(r2.added.includes(27015) && fr.map.has('TCP:27015'), 'remembered own forwarding is created and kept');
    svc.cfg.extra = [];
    await svc.unforward({ port: 27015 });
    assert.ok(!fr.map.has('TCP:27015'));

    // Carrier NAT
    const fr2 = fakeRouter({ ext: '100.72.10.5' });
    await listen(fr2);
    const d2 = await R.describe(`http://127.0.0.1:${fr2.srv.address().port}/d.xml`);
    svc.igd = async () => ({ gateway: '127.0.0.1', localIp: '192.168.178.168', addresses: ['192.168.178.168'], upnp: d2, natpmp: false });
    st = await svc.status();
    assert.ok(st.problems.some((p) => /carrier NAT/.test(p)), 'carrier NAT detected');
    fr2.srv.close();

    // DS-Lite: the router only has 192.0.0.2, a public IPv6 exists → detect it, open ports for IPv6
    const fr3 = fakeRouter({ ext: '192.0.0.2', v6: true });
    await listen(fr3);
    const d3 = await R.describe(`http://127.0.0.1:${fr3.srv.address().port}/d.xml`);
    assert.ok(!!d3.control6 && /\/ctl6$/.test(d3.control6.url), 'IPv6 firewall of the router found');
    svc.igd = async () => ({ gateway: '127.0.0.1', localIp: '192.168.178.168', addresses: ['192.168.178.168'], upnp: d3, natpmp: false });
    svc.net = async () => ({ v6: { local: ['2001:db8::5'], stable: '2001:db8::5', public: '2001:db8::99' }, v4public: '80.1.2.3' });
    st = await svc.status();
    assert.ok(st.dslite === true && st.problems.some((p) => /DS-Lite/.test(p) && /DynDNS/.test(p)), 'DS-Lite detected with a way out');
    assert.ok(st.ipv6.address === '2001:db8::5' && st.ipv6.auto === true);
    svc.cfg.extra = [{ port: 27016, protocol: 'TCP', label: 'Game' }, { port: 19132, protocol: 'UDP', label: 'Bedrock' }];
    let r3 = await svc.sync();
    const holes = [...fr3.holes.values()];
    assert.ok(r3.v6.opened.includes(27016) && r3.v6.opened.includes(19132) && holes.every((h) => h.client === '2001:db8::5') && holes.some((h) => h.proto === '17'), JSON.stringify(holes));
    assert.strictEqual(r3.failed.length, 0, 'no error with DS-Lite when IPv6 works');
    r3 = await svc.sync();
    assert.strictEqual(fr3.holes.size, 2, 'syncing again renews instead of creating twice');
    svc.cfg.extra = [{ port: 27016, protocol: 'TCP', label: 'Game' }];
    await svc.sync();
    assert.ok(fr3.holes.size === 1 && [...fr3.holes.values()][0].port === 27016, 'IPv6 hole no longer needed is closed');
    svc.cfg.extra = [];
    await svc.sync();
    fr3.srv.close();

    // DynDNS (own provider) – needs a local https server; uses "selfsigned" when it can be found (Hostwerk's own copy)
    let selfsigned = null;
    try { selfsigned = require(require.resolve('selfsigned', { paths: [__dirname, path.join(__dirname, '..', '..', '..', 'hostwerk')] })); } catch { /* skipped in CI */ }
    if (selfsigned) {
      const https = require('https');
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
      const hits = [];
      const dyn = https.createServer({ key: pems.private, cert: pems.cert }, (q, a) => { hits.push(q.url); a.end('good'); });
      await new Promise((res) => dyn.listen(0, '127.0.0.1', res));
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      Object.assign(svc.dyn, { provider: 'custom', domain: 'test.example', url: `https://127.0.0.1:${dyn.address().port}/upd?h={domain}&a={ip4}&b={ip6}`, token: '', last: null });
      const last = await svc.dynUpdate(true);
      assert.ok(last.ok && hits[0] === '/upd?h=test.example&a=80.1.2.3&b=2001%3Adb8%3A%3A5', hits[0]);
      await svc.dynUpdate();
      assert.strictEqual(hits.length, 1, 'DynDNS only reports changes');
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      dyn.close();
      svc.cfg.dyndns = { provider: '', domain: '', token: '', last: null };
    }

    // Server in a data centre: public address right on the computer → no router needed
    svc.igd = async () => ({ gateway: '5.9.0.1', localIp: '5.9.10.20', addresses: ['5.9.10.20'], upnp: null, natpmp: false });
    st = await svc.status();
    assert.ok(st.direct === true && !st.kind, 'public address directly on the computer');
  } finally { fr.srv.close(); }
});

test('problems and errors read German with a German interface', async () => {
  const fr = fakeRouter({ ext: '100.72.10.5' });
  await listen(fr);
  const svc = new RouterService(fakeHost('de'), { timers: false });
  svc.net = async () => ({ v6: { local: [], stable: null, public: null }, v4public: '80.1.2.3' });
  try {
    const d = await R.describe(`http://127.0.0.1:${fr.srv.address().port}/d.xml`);
    svc.igd = async () => ({ gateway: '127.0.0.1', localIp: '192.168.178.168', addresses: ['192.168.178.168'], upnp: d, natpmp: false });
    const st = await svc.status();
    assert.ok(st.problems.some((p) => /Carrier-NAT/.test(p)), st.problems.join(' | '));
    assert.match(st.hint.text, /Selbstständige Portfreigaben/);
    await assert.rejects(svc.forward({ port: 0 }), /Ungültiger Port/);
  } finally { fr.srv.close(); }
});

test('UPnP error messages all have German', () => {
  for (const msg of Object.values(R.UPNP_ERRORS)) assert.ok(de[msg], `German missing: ${msg}`);
});
