'use strict';
/*
 * Router access: TR-064 (FRITZ!Box & co.) with digest sign-in and OpenWrt (ubus) against fake routers.
 * Checks sign-in, wrong password, info, devices, Wi-Fi on/off, forwardings create/list/delete, reboot.
 * Never touches a real router.   node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { Tr064 } = require('../server/tr064');
const { OpenWrt } = require('../server/openwrt');

let fail = 0;
const ok = (name, cond, extra = '') => { if (!cond) { fail++; console.log(`✗ ${name}${extra ? ` – ${extra}` : ''}`); } };
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/* ---------------- Fake FRITZ!Box ---------------- */
function fakeFritz() {
  const USER = 'hostwerk'; const PASS = 'secret!'; const REALM = 'F!Box SOAP-Auth'; const NONCE = 'ABCDEF0123456789';
  const st = { maps: [], wifi: { 1: true, 2: true, 3: false }, rebooted: false };
  const svc = (t, c) => `<service><serviceType>urn:dslforum-org:service:${t}</serviceType><controlURL>${c}</controlURL><SCPDURL>/x.xml</SCPDURL></service>`;
  const desc = `<?xml version="1.0"?><root><device><friendlyName>FRITZ!Box 7590</friendlyName><manufacturer>AVM</manufacturer><modelName>FRITZ!Box 7590</modelName><serviceList>${[
    svc('DeviceInfo:1', '/upnp/control/deviceinfo'), svc('DeviceConfig:1', '/upnp/control/deviceconfig'), svc('LANConfigSecurity:1', '/upnp/control/lanconfigsecurity'),
    svc('Hosts:1', '/upnp/control/hosts'), svc('WLANConfiguration:1', '/upnp/control/wlanconfig1'), svc('WLANConfiguration:2', '/upnp/control/wlanconfig2'), svc('WLANConfiguration:3', '/upnp/control/wlanconfig3'),
    svc('WANCommonInterfaceConfig:1', '/upnp/control/wancommonifconfig1'), svc('WANPPPConnection:1', '/upnp/control/wanpppconn1'), svc('WANIPConnection:1', '/upnp/control/wanipconnection1'),
  ].join('')}</serviceList></device></root>`;
  const resp = (action, fields) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response>${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`;
  const fault = (code, d) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${d}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
  const arg = (b, n) => (b.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1];
  const authOk = (h, uri) => {
    if (!h || !h.startsWith('Digest ')) return false;
    const p = (k) => (h.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
    if (p('username') !== USER) return false;
    const ha1 = md5(`${USER}:${REALM}:${PASS}`); const ha2 = md5(`POST:${uri}`);
    return p('response') === md5(`${ha1}:${p('nonce')}:${p('nc')}:${p('cnonce')}:auth:${ha2}`);
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/tr64desc.xml') { res.end(desc); return; }
      if (req.url === '/hostlist.lua') { res.end('<List><Item><IPAddress>192.168.178.20</IPAddress><MACAddress>AA:BB:CC:00:11:22</MACAddress><HostName>Gaming-PC</HostName><Active>1</Active><InterfaceType>Ethernet</InterfaceType><X_AVM-DE_Speed>1000</X_AVM-DE_Speed></Item><Item><IPAddress>192.168.178.31</IPAddress><MACAddress>AA:BB:CC:00:11:33</MACAddress><HostName>Phone</HostName><Active>0</Active><InterfaceType>802.11</InterfaceType></Item></List>'); return; }
      const action = (req.headers.soapaction || '').split('#')[1];
      if (action === 'X_AVM-DE_GetUserList') { res.end(resp(action, { 'NewX_AVM-DE_UserList': '&lt;List&gt;&lt;Username last_user="1"&gt;hostwerk&lt;/Username&gt;&lt;/List&gt;' })); return; }
      if (!authOk(req.headers.authorization, req.url)) { res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${NONCE}", algorithm=MD5, qop="auth"` }); res.end(); return; }
      const W = req.url.match(/wlanconfig(\d)/);
      const map = {
        GetInfo: () => (W ? { NewEnable: st.wifi[W[1]] ? 1 : 0, NewSSID: W[1] === '3' ? 'FRITZ!Box guest access' : 'FRITZ!Box 7590 XY', NewStatus: st.wifi[W[1]] ? 'Up' : 'Disabled', NewChannel: 6, NewStandard: 'ax' } : { NewModelName: 'FRITZ!Box 7590', NewSoftwareVersion: '154.08.20', NewUpTime: 3600, NewSerialNumber: 'X' }),
        'X_AVM-DE_GetWLANExtInfo': () => ({ 'NewX_AVM-DE_APType': W && W[1] === '3' ? 'guest' : 'normal' }),
        GetTotalAssociations: () => ({ NewTotalAssociations: W && W[1] === '1' ? 4 : 0 }),
        SetEnable: () => { st.wifi[W[1]] = arg(body, 'NewEnable') === '1'; return {}; },
        GetStatusInfo: () => ({ NewConnectionStatus: req.url.includes('pppconn') ? 'Connected' : 'Disconnected', NewUptime: 500 }),
        GetExternalIPAddress: () => ({ NewExternalIPAddress: '80.145.1.2' }),
        GetCommonLinkProperties: () => ({ NewWANAccessType: 'DSL', NewLayer1DownstreamMaxBitRate: 250000000, NewLayer1UpstreamMaxBitRate: 40000000, NewPhysicalLinkStatus: 'Up' }),
        'X_AVM-DE_GetHostListPath': () => ({ 'NewX_AVM-DE_HostListPath': '/hostlist.lua' }),
        GetPortMappingNumberOfEntries: () => ({ NewPortMappingNumberOfEntries: st.maps.length }),
        GetGenericPortMappingEntry: () => { const m = st.maps[Number(arg(body, 'NewPortMappingIndex'))]; if (!m) throw [713, 'SpecifiedArrayIndexInvalid']; return { NewRemoteHost: '', NewExternalPort: m.p, NewProtocol: m.proto, NewInternalPort: m.p, NewInternalClient: m.c, NewEnabled: 1, NewPortMappingDescription: m.d, NewLeaseDuration: 0 }; },
        AddPortMapping: () => { if (!req.url.includes('pppconn')) throw [820, 'wrong connection']; st.maps.push({ p: Number(arg(body, 'NewExternalPort')), proto: arg(body, 'NewProtocol'), c: arg(body, 'NewInternalClient'), d: arg(body, 'NewPortMappingDescription') }); return {}; },
        DeletePortMapping: () => { const n = st.maps.length; st.maps = st.maps.filter((m) => !(m.p === Number(arg(body, 'NewExternalPort')) && m.proto === arg(body, 'NewProtocol'))); if (n === st.maps.length) throw [714, 'NoSuchEntryInArray']; return {}; },
        Reboot: () => { st.rebooted = true; return {}; },
      };
      try { if (!map[action]) throw [401, 'Invalid Action']; const out = map[action](); res.writeHead(200); res.end(resp(action, out)); } catch (e) { res.writeHead(500); res.end(fault(e[0], e[1])); }
    });
  });
  return { srv, st, USER, PASS };
}

/* ---------------- Fake OpenWrt ---------------- */
function fakeOpenWrt() {
  const st = { sid: null, redirects: { cfg01: { name: 'Old', src_dport: '8080', dest_ip: '192.168.1.5', dest_port: '80', proto: 'tcp' } }, wifiDisabled: false, committed: [], rebooted: false };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const [sid, obj, method, args] = j.params || [];
      const out = (code, data) => res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: data === undefined ? [code] : [code, data] }));
      if (j.method === 'list') { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32002, message: 'Access denied' } })); return; }
      if (obj === 'session' && method === 'login') { if (args.username === 'root' && args.password === 'pw') { st.sid = 'S'.repeat(32); out(0, { ubus_rpc_session: st.sid }); } else out(6); return; }
      if (sid !== st.sid) { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32002, message: 'Access denied' } })); return; }
      const k = `${obj}.${method}`;
      if (k === 'system.board') return out(0, { model: 'GL.iNet GL-MT6000', release: { distribution: 'OpenWrt', version: '24.10.0' } });
      if (k === 'system.info') return out(0, { uptime: 999 });
      if (k === 'luci-rpc.getDHCPLeases') return out(0, { dhcp_leases: [{ macaddr: 'aa:bb:cc:dd:ee:ff', ipaddr: '192.168.1.20', hostname: 'laptop' }] });
      if (k === 'luci-rpc.getHostHints') return out(0, { 'AA:BB:CC:DD:EE:FF': { name: 'laptop', ipaddrs: ['192.168.1.20'] }, '11:22:33:44:55:66': { name: 'nas', ipaddrs: ['192.168.1.30'] } });
      if (k === 'network.wireless.status') return out(0, { radio0: { up: true, disabled: false, config: { channel: 36, band: '5g', htmode: 'HE80' }, interfaces: [{ section: 'default_radio0', config: { ssid: 'Home', network: ['lan'], disabled: st.wifiDisabled } }] } });
      if (k === 'uci.set' && args.config === 'wireless') { st.wifiDisabled = args.values.disabled === '1'; return out(0); }
      if (k === 'uci.get') return out(0, { values: Object.fromEntries(Object.entries(st.redirects).map(([s, v]) => [s, { '.type': 'redirect', ...v }])) });
      if (k === 'uci.add') { const s = `cfg${Object.keys(st.redirects).length + 10}`; st.redirects[s] = args.values; return out(0, { section: s }); }
      if (k === 'uci.delete') { delete st.redirects[args.section]; return out(0); }
      if (k === 'uci.commit') { st.committed.push(args.config); return out(0); }
      if (k === 'uci.apply' || k === 'network.wireless.up') return out(0);
      if (k === 'system.reboot') { st.rebooted = true; return out(0); }
      out(4);
    });
  });
  return { srv, st };
}

test('router access: TR-064 (FRITZ!Box) and OpenWrt against fake routers', async () => {
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    /* TR-064 */
    const F = fakeFritz();
    const fp = await listen(F.srv);
    const base = `http://127.0.0.1:${fp}`;
    const anon = new Tr064({ base });
    const users = await anon.users();
    ok('TR-064: user names without sign-in', users.length === 1 && users[0].name === 'hostwerk' && users[0].last);
    let err = '';
    try { await new Tr064({ base, user: 'hostwerk', pass: 'wrong' }).info(); } catch (e) { err = e.message; }
    ok('TR-064: wrong password → clear message', /password/.test(err), err);
    const t = new Tr064({ base, user: F.USER, pass: F.PASS });
    const info = await t.info();
    ok('TR-064: sign-in (digest) and device info', info.model === 'FRITZ!Box 7590' && info.firmware === '154.08.20');
    const link = await t.link();
    ok('TR-064: line through the connected PPP connection', link.connected && link.externalIp === '80.145.1.2' && link.down === 250000000 && link.via === 'WANPPPConnection', JSON.stringify(link));
    const hosts = await t.hosts();
    ok('TR-064: device list', hosts.length === 2 && hosts[0].name === 'Gaming-PC' && hosts[0].active && !hosts[1].active, hosts.map((h) => h.name).join(', '));
    let wifi = await t.wifi();
    ok('TR-064: Wi-Fi with guest access detected', wifi.length === 3 && wifi.find((w) => w.guest).index === 3 && !wifi[2].enabled && wifi[0].clients === 4);
    await t.setWifi(3, true);
    wifi = await t.wifi();
    ok('TR-064: switch on guest Wi-Fi', wifi[2].enabled && F.st.wifi[3]);
    await t.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.178.20', description: 'Hostwerk: Minecraft' });
    const maps = await t.mappings();
    ok('TR-064: create a forwarding (over the right connection) and list it', maps.length === 1 && maps[0].externalPort === 25565 && maps[0].internalClient === '192.168.178.20');
    await t.removeMapping({ externalPort: 25565 });
    ok('TR-064: delete a forwarding', (await t.mappings()).length === 0);
    err = ''; try { await t.removeMapping({ externalPort: 1234 }); } catch (e) { err = e.message; }
    ok('TR-064: deleting a missing forwarding → clear message', /does not exist/.test(err), err);
    await t.reboot();
    ok('TR-064: reboot', F.st.rebooted);
    F.srv.close();

    /* OpenWrt */
    const O = fakeOpenWrt();
    const op = await listen(O.srv);
    const obase = `http://127.0.0.1:${op}`;
    err = ''; try { await new OpenWrt({ base: obase, user: 'root', pass: 'x' }).info(); } catch (e) { err = e.message; }
    ok('OpenWrt: wrong password → clear message', /password/.test(err), err);
    const o = new OpenWrt({ base: obase, user: 'root', pass: 'pw' });
    const oi = await o.info();
    ok('OpenWrt: sign-in and device info', oi.model === 'GL.iNet GL-MT6000' && /OpenWrt 24/.test(oi.firmware));
    const oh = await o.hosts();
    ok('OpenWrt: devices from DHCP and hints', oh.length === 2 && oh.some((h) => h.name === 'nas'));
    await o.setWifi('default_radio0', false);
    ok('OpenWrt: switch off Wi-Fi (uci + commit)', O.st.wifiDisabled && O.st.committed.includes('wireless'));
    await o.addMapping({ externalPort: 25565, protocol: 'TCP', client: '192.168.1.20', description: 'Hostwerk: MC' });
    const om = await o.mappings();
    ok('OpenWrt: create a forwarding (firewall redirect)', om.length === 2 && om.some((m) => m.externalPort === 25565 && m.internalClient === '192.168.1.20') && O.st.committed.includes('firewall'));
    await o.removeMapping({ externalPort: 25565 });
    ok('OpenWrt: delete a forwarding', (await o.mappings()).length === 1);
    await o.reboot();
    ok('OpenWrt: reboot', O.st.rebooted);
    O.srv.close();
  } catch (e) { ok('runs without an exception', false, e.stack); }
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
});

