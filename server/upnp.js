'use strict';
/*
 * Talk to the router via UPnP-IGD (Internet Gateway Device) and NAT-PMP – no third-party library, the same on Windows,
 * Linux and servers:
 *   gateway()          default gateway and our own address in that network
 *   discover()         find the router via SSDP → device (vendor, model, web interface) and control URL
 *   externalIp()       public address according to the router
 *   mappings()         every port forwarding in the router (also other devices')
 *   add()/remove()     create/remove a port forwarding
 *   natpmp*()          fallback for routers without UPnP but with NAT-PMP (e.g. Apple, some OpenWrt)
 *   addPinhole()       IPv6: open ports for this PC in the router firewall (UPnP-IGDv2 WANIPv6FirewallControl)
 *   globalV6()/publicV4()/publicV6()  own IPv6 addresses and the addresses the internet sees us with
 *
 * Checks run against real routers; the tests use a fake router (tests/upnp.test.js).
 * Error messages are English; the extension translates them for the interface (locales/de.json).
 */
const dgram = require('dgram');
const os = require('os');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SSDP = { host: '239.255.255.250', port: 1900 };
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, out) => resolve(String(out || ''))));

const ipNum = (ip) => ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
const isCgnat = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
// DS-Lite: the router only has the tunnel address 192.0.0.x (B4 element) for IPv4 – public IPv4 is shared
const isDsLite = (ip) => /^192\.0\.0\.\d+$/.test(ip || '');
const V6FW = 'urn:schemas-upnp-org:service:WANIPv6FirewallControl:1';

/** Global IPv6 addresses of this computer (no link-local fe80::, no private fd00::). */
function globalV6() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv6' || n.internal) continue;
      const a = n.address.toLowerCase();
      if (/^(fe80|fc|fd)/.test(a) || a === '::1' || a.startsWith('::ffff:')) continue;
      if (/^[23]/.test(a)) out.push({ iface: name, address: n.address });
    }
  }
  return out;
}
/**
 * Stable global IPv6 of this computer – the address for incoming connections. Windows and Linux use changing privacy
 * addresses ("temporary") for outgoing traffic; forwardings and DynDNS need the stable one.
 */
async function stableV6() {
  const all = globalV6().map((x) => x.address.toLowerCase());
  if (!all.length) return null;
  if (IS_WIN) {
    // netsh depends on the language: temporary addresses are called "Temporär" or "Temporary"
    const out = await run('netsh', ['interface', 'ipv6', 'show', 'addresses']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+([0-9a-f:]+)\s*$/i);
      if (m && !/^temp/i.test(m[1]) && all.includes(m[2].toLowerCase())) return m[2];
    }
  } else {
    const out = await run('ip', ['-6', 'addr', 'show', 'scope', 'global']);
    for (const line of out.split('\n')) {
      const m = line.match(/inet6 ([0-9a-f:]+)\/\d+/i);
      if (m && !/temporary|deprecated/.test(line) && all.includes(m[1].toLowerCase())) return m[1];
    }
  }
  return all[0];
}
/** Public addresses as seen from outside (two sources per family). */
async function outside(urls) {
  for (const u of urls) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(6000) }); if (r.ok) { const t = (await r.text()).trim(); if (t.length < 60) return t; } } catch { /* next source */ }
  }
  return null;
}
const publicV4 = () => outside(['https://api.ipify.org', 'https://ipv4.icanhazip.com']);
const publicV6 = () => outside(['https://api6.ipify.org', 'https://ipv6.icanhazip.com']);

/** Open the IPv6 firewall → UniqueID (to renew/delete). lease in seconds (max. 86400 by the standard). */
async function addPinhole(control6, { client, port, protocol = 'TCP', lease = 86400 }) {
  const xml = await soap(control6, 'AddPinhole', { RemoteHost: '', RemotePort: 0, InternalClient: client, InternalPort: port, Protocol: protocol === 'UDP' ? 17 : 6, LeaseTime: lease });
  return tag(xml, 'UniqueID');
}
async function updatePinhole(control6, id, lease = 86400) { await soap(control6, 'UpdatePinhole', { UniqueID: id, NewLeaseTime: lease }); return true; }
async function deletePinhole(control6, id) { await soap(control6, 'DeletePinhole', { UniqueID: id }); return true; }
async function v6FirewallStatus(control6) {
  try { const x = await soap(control6, 'GetFirewallStatus'); return { enabled: tag(x, 'FirewallEnabled') === '1', allowed: tag(x, 'InboundPinholeAllowed') === '1' }; } catch { return null; }
}

/** Default gateway (IPv4) and our own address in the same network. */
async function gateway() {
  let gw = null;
  if (IS_WIN) {
    // "route print" does not depend on the language: rows "0.0.0.0  0.0.0.0  <gateway>  <interface>  <metric>"
    const out = await run('route', ['print', '-4', '0.0.0.0']);
    const rows = [...out.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/gm)].map((m) => ({ gw: m[1], iface: m[2], metric: Number(m[3]) }));
    rows.sort((a, b) => a.metric - b.metric);
    if (rows[0]) gw = rows[0].gw;
  } else {
    const out = await run('ip', ['-4', 'route', 'show', 'default']);
    const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
    if (m) gw = m[1];
  }
  // Own address: the interface whose network contains the gateway (otherwise the first private one)
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) all.push({ name, ip: n.address, mask: n.netmask });
  let local = null;
  if (gw) local = all.find((n) => (ipNum(n.ip) & ipNum(n.mask)) === (ipNum(gw) & ipNum(n.mask))) || null;
  if (!local) local = all.find((n) => isPrivate(n.ip)) || all[0] || null;
  return { gateway: gw, localIp: local ? local.ip : null, iface: local ? local.name : null, addresses: all.map((n) => n.ip) };
}

/* ------------------------------------------------------------------ UPnP */
const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null; };

/** SSDP search for internet gateways → list of LOCATION URLs. */
function ssdpSearch({ timeout = 2500, bind } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { resolve([]); return; }
    const done = () => { try { sock.close(); } catch { /* already closed */ } resolve([...found]); };
    sock.on('error', done);
    sock.on('message', (msg) => {
      const m = String(msg).match(/^location:\s*(\S+)/im);
      if (m) found.add(m[1]);
    });
    sock.bind(0, bind, () => {
      try { sock.setMulticastTTL(2); } catch { /* ignore */ }
      const targets = ['urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:device:InternetGatewayDevice:1', ...SERVICES];
      for (const st of targets) {
        const req = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        sock.send(req, SSDP.port, SSDP.host, () => {});
      }
      setTimeout(done, timeout);
    });
  });
}

/** Read the device description → { device, control: { url, type } } (first WAN connection). */
async function describe(location) {
  const r = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await r.text();
  const base = tag(xml, 'URLBase') || location;
  const services = [...xml.matchAll(/<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/gi)].map((m) => ({ type: tag(m[1], 'serviceType'), control: tag(m[1], 'controlURL') }));
  let svc = null;
  for (const t of SERVICES) { svc = services.find((s) => s.type === t && s.control); if (svc) break; }
  const pres = tag(xml, 'presentationURL');
  const fw6 = services.find((s) => s.type === V6FW && s.control);
  return {
    location,
    control6: fw6 ? { url: new URL(fw6.control, base).href, type: fw6.type } : null,
    device: { name: tag(xml, 'friendlyName'), manufacturer: tag(xml, 'manufacturer'), model: tag(xml, 'modelName'), modelNumber: tag(xml, 'modelNumber'), web: pres ? new URL(pres, base).href : `${new URL(location).protocol}//${new URL(location).hostname}/` },
    control: svc ? { url: new URL(svc.control, base).href, type: svc.type } : null,
  };
}

const UPNP_ERRORS = {
  402: 'Invalid details for the router.',
  501: 'The router rejected the request.',
  // FRITZ!Box answers 403 "Not available Action" when this device may not create forwardings on its own
  403: 'The router does not allow automatic forwardings for this device. Either allow it in the router (FRITZ!Box: Internet → Permit Access → device of this PC → "Permit independent port sharing") – or sign in under "Router access" with your router user, then Hostwerk creates the forwarding directly.',
  606: 'The router does not allow automatic forwardings for this device. Allow it in the router or sign in under "Router access" with your router user.',
  713: 'This forwarding does not exist.',
  714: 'This forwarding does not exist.',
  718: 'The port is already forwarded to another device in the router.',
  724: 'The router requires the same internal and external port.',
  725: 'The router only supports permanent forwardings.',
  729: 'The router refuses forwardings for this port (often ports below 1024).',
};

/** SOAP call; throws { code, message } on a UPnP error. */
async function soap(control, action, args = {}) {
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${control.type}">${Object.entries(args).map(([k, v]) => `<${k}>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(control.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${control.type}#${action}"` }, body, signal: AbortSignal.timeout(5000) });
  const xml = await r.text();
  if (!r.ok) {
    const code = Number(tag(xml, 'errorCode')) || r.status;
    const e = new Error(UPNP_ERRORS[code] || tag(xml, 'errorDescription') || `The router answers with ${r.status}`);
    e.code = code;
    throw e;
  }
  return xml;
}

async function externalIp(control) { return tag(await soap(control, 'GetExternalIPAddress'), 'NewExternalIPAddress'); }
async function connectionStatus(control) { try { return tag(await soap(control, 'GetStatusInfo'), 'NewConnectionStatus'); } catch { return null; } }

/** Every forwarding in the router (at most 256). */
async function mappings(control) {
  const out = [];
  for (let i = 0; i < 256; i++) {
    let xml;
    try { xml = await soap(control, 'GetGenericPortMappingEntry', { NewPortMappingIndex: i }); } catch { break; }
    out.push({
      remoteHost: tag(xml, 'NewRemoteHost') || '', externalPort: Number(tag(xml, 'NewExternalPort')), protocol: tag(xml, 'NewProtocol'),
      internalPort: Number(tag(xml, 'NewInternalPort')), internalClient: tag(xml, 'NewInternalClient'), enabled: tag(xml, 'NewEnabled') !== '0',
      description: tag(xml, 'NewPortMappingDescription') || '', lease: Number(tag(xml, 'NewLeaseDuration')) || 0,
    });
  }
  return out;
}

async function add(control, { externalPort, internalPort, protocol = 'TCP', client, description, lease = 0 }) {
  const args = (l) => ({ NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol, NewInternalPort: internalPort || externalPort, NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: String(description || 'Hostwerk').slice(0, 60), NewLeaseDuration: l });
  try { await soap(control, 'AddPortMapping', args(lease)); } catch (e) {
    // Some routers want an expiry time, others only permanent forwardings
    if (e.code === 725 && lease) return soap(control, 'AddPortMapping', args(0));
    if ((e.code === 402 || e.code === 501) && !lease) return soap(control, 'AddPortMapping', args(604800));
    throw e;
  }
  return true;
}
async function remove(control, { externalPort, protocol = 'TCP' }) {
  await soap(control, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol });
  return true;
}

/* ------------------------------------------------------------------ NAT-PMP (RFC 6886) */
function natpmp(gw, payload, { timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let tries = 0;
    let timer;
    const finish = (err, res) => { clearTimeout(timer); try { sock.close(); } catch { /* ignore */ } if (err) reject(err); else resolve(res); };
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => finish(null, msg));
    const send = () => {
      if (tries++ >= 3) { finish(new Error('No answer via NAT-PMP')); return; }
      sock.send(payload, 5351, gw, () => {});
      timer = setTimeout(send, timeout * tries);
    };
    sock.bind(0, send);
  });
}
async function natpmpExternalIp(gw) {
  const r = await natpmp(gw, Buffer.from([0, 0]));
  if (r.length < 12 || r.readUInt16BE(2) !== 0) throw new Error('NAT-PMP refused');
  return `${r[8]}.${r[9]}.${r[10]}.${r[11]}`;
}
async function natpmpMap(gw, { internalPort, externalPort, protocol = 'TCP', lifetime = 7200 }) {
  const b = Buffer.alloc(12);
  b[0] = 0; b[1] = protocol === 'UDP' ? 1 : 2;
  b.writeUInt16BE(internalPort, 4); b.writeUInt16BE(externalPort || internalPort, 6); b.writeUInt32BE(lifetime, 8);
  const r = await natpmp(gw, b);
  const code = r.readUInt16BE(2);
  if (code !== 0) throw new Error(`NAT-PMP error ${code}`);
  return { externalPort: r.readUInt16BE(10), lifetime: r.readUInt32BE(12) };
}

module.exports = { gateway, ssdpSearch, describe, soap, externalIp, connectionStatus, mappings, add, remove, natpmpExternalIp, natpmpMap, isPrivate, isCgnat, isDsLite, globalV6, stableV6, publicV4, publicV6, addPinhole, updatePinhole, deletePinhole, v6FirewallStatus, UPNP_ERRORS };
