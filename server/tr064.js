'use strict';
/*
 * TR-064 (FRITZ!Box and other routers with TR-064): SOAP with HTTP digest sign-in.
 * With it Hostwerk manages the router directly – devices in the network, Wi-Fi/guest Wi-Fi, port forwardings (even when
 * "independent port sharing" is off for this PC), the line, reboot, new IP, Wake-on-LAN.
 */
const crypto = require('crypto');

const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : ''; };
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const ERRORS = {
  401: 'User name or password for the router is wrong.',
  402: 'Invalid details for the router.',
  606: 'The router user lacks the right for this (on a FRITZ!Box: System → FRITZ!Box Users → right "FRITZ!Box settings").',
  714: 'This forwarding does not exist.',
  718: 'The port is already forwarded to another device in the router.',
  820: 'The router refused the action.',
};

class Tr064 {
  /** base e.g. http://192.168.178.1:49000 */
  constructor({ base, user = '', pass = '', timeout = 8000 }) {
    this.base = String(base).replace(/\/$/, '');
    this.user = user; this.pass = pass; this.timeout = timeout;
    this.services = null; this.digest = null; this.nc = 0;
  }

  /** Load the description → services (type without prefix → controlURL). */
  async load() {
    if (this.services) return this.services;
    const r = await fetch(`${this.base}/tr64desc.xml`, { signal: AbortSignal.timeout(this.timeout) });
    if (!r.ok) throw new Error('The router does not offer TR-064.');
    const xml = await r.text();
    this.desc = { model: tag(xml, 'modelName') || tag(xml, 'friendlyName'), manufacturer: tag(xml, 'manufacturer'), name: tag(xml, 'friendlyName') };
    this.services = {};
    for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
      const type = tag(m[1], 'serviceType');
      if (type) this.services[type.replace(/^urn:dslforum-org:service:/, '')] = { type, control: tag(m[1], 'controlURL') };
    }
    return this.services;
  }
  has(svc) { return !!(this.services && this.services[svc]); }

  authHeader(uri) {
    const d = this.digest;
    if (!d) return null;
    const nc = (++this.nc).toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = md5(`${this.user}:${d.realm}:${this.pass}`);
    const ha2 = md5(`POST:${uri}`);
    const response = d.qop ? md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
    return `Digest username="${this.user}", realm="${d.realm}", nonce="${d.nonce}", uri="${uri}", response="${response}", algorithm=MD5${d.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${d.opaque ? `, opaque="${d.opaque}"` : ''}`;
  }

  /** SOAP call with sign-in → answer XML. svc e.g. 'Hosts:1'. */
  async call(svc, action, args = {}, { auth = true } = {}) {
    await this.load();
    const s = this.services[svc];
    if (!s) throw new Error(`The router does not know ${svc.replace(/:\d$/, '')}.`);
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${s.type}">${Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
    const send = (authz) => fetch(this.base + s.control, { method: 'POST', body, signal: AbortSignal.timeout(this.timeout), headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `${s.type}#${action}`, ...(authz ? { Authorization: authz } : {}) } });
    let r = await send(auth ? this.authHeader(s.control) : null);
    if (r.status === 401 && auth) {
      const h = r.headers.get('www-authenticate') || '';
      const p = (k) => (h.match(new RegExp(`${k}="?([^",]+)"?`, 'i')) || [])[1];
      this.digest = { realm: p('realm'), nonce: p('nonce'), qop: /qop="?[^"]*auth/i.test(h), opaque: p('opaque') };
      this.nc = 0;
      await r.text().catch(() => '');
      r = await send(this.authHeader(s.control));
    }
    const xml = await r.text();
    if (r.status === 401) { const e = new Error(ERRORS[401]); e.code = 401; throw e; }
    if (!r.ok) {
      const code = Number(tag(xml, 'errorCode')) || r.status;
      const e = new Error(ERRORS[code] || tag(xml, 'errorDescription') || `The router answers with ${r.status}`);
      e.code = code;
      throw e;
    }
    return xml;
  }
  async get(svc, action, args) {
    const xml = await this.call(svc, action, args);
    const out = {};
    for (const m of xml.matchAll(/<(New[\w-]+)>([\s\S]*?)<\/\1>/g)) out[m[1].replace(/^New/, '')] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return out;
  }

  /* ---------------- without sign-in ---------------- */
  /** User names of the router (FRITZ!Box: readable without sign-in) → [{ name, last }] */
  async users() {
    try {
      const xml = await this.call('LANConfigSecurity:1', 'X_AVM-DE_GetUserList', {}, { auth: false });
      const list = tag(xml, 'NewX_AVM-DE_UserList');
      return [...list.matchAll(/<Username([^>]*)>([^<]*)<\/Username>/g)].map((m) => ({ name: m[2], last: /last_user="1"/.test(m[1]) }));
    } catch { return []; }
  }

  /* ---------------- with sign-in ---------------- */
  async info() {
    const i = await this.get('DeviceInfo:1', 'GetInfo');
    return { model: i.ModelName || this.desc.model, firmware: i.SoftwareVersion, serial: i.SerialNumber, uptime: Number(i.UpTime) || 0, manufacturer: i.ManufacturerName || this.desc.manufacturer };
  }
  /** The connection the internet runs over (DSL/PPP or cable/fibre/IP). */
  async wanService() {
    await this.load();
    for (const svc of ['WANPPPConnection:1', 'WANIPConnection:1']) {
      if (!this.has(svc)) continue;
      try { const s = await this.get(svc, 'GetStatusInfo'); if (s.ConnectionStatus === 'Connected') return svc; } catch { /* next */ }
    }
    return this.has('WANIPConnection:1') ? 'WANIPConnection:1' : 'WANPPPConnection:1';
  }
  async link() {
    const svc = await this.wanService();
    const st = await this.get(svc, 'GetStatusInfo').catch(() => ({}));
    const ip = await this.get(svc, 'GetExternalIPAddress').catch(() => ({}));
    const l = this.has('WANCommonInterfaceConfig:1') ? await this.get('WANCommonInterfaceConfig:1', 'GetCommonLinkProperties').catch(() => ({})) : {};
    return {
      connected: st.ConnectionStatus === 'Connected', uptime: Number(st.Uptime) || 0, externalIp: ip.ExternalIPAddress || null, access: l.WANAccessType || null,
      down: Number(l.Layer1DownstreamMaxBitRate) || 0, up: Number(l.Layer1UpstreamMaxBitRate) || 0, link: l.PhysicalLinkStatus || null, via: svc.replace(/:1$/, ''),
    };
  }
  /** Every device in the network (from the router's device list). */
  async hosts() {
    let xml = '';
    try {
      const p = await this.get('Hosts:1', 'X_AVM-DE_GetHostListPath');
      const r = await fetch(this.base + p['X_AVM-DE_HostListPath'], { signal: AbortSignal.timeout(this.timeout) }).catch(() => null);
      if (r && r.ok) xml = await r.text();
    } catch { /* older router: ask one by one */ }
    if (xml) {
      return [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) => ({
        ip: tag(m[1], 'IPAddress'), mac: tag(m[1], 'MACAddress'), name: tag(m[1], 'HostName'), active: tag(m[1], 'Active') === '1',
        iface: tag(m[1], 'InterfaceType'), speed: Number(tag(m[1], 'X_AVM-DE_Speed')) || 0, guest: tag(m[1], 'X_AVM-DE_Guest') === '1',
      }));
    }
    const n = Number((await this.get('Hosts:1', 'GetHostNumberOfEntries')).HostNumberOfEntries) || 0;
    const out = [];
    for (let i = 0; i < Math.min(n, 250); i++) {
      const h = await this.get('Hosts:1', 'GetGenericHostEntry', { NewIndex: i }).catch(() => null);
      if (h) out.push({ ip: h.IPAddress, mac: h.MACAddress, name: h.HostName, active: h.Active === '1', iface: h.InterfaceType, speed: 0, guest: false });
    }
    return out;
  }
  async wake(mac) { await this.call('Hosts:1', 'X_AVM-DE_WakeOnLANByMACAddress', { NewMACAddress: mac }); return true; }
  async rename(mac, name) { await this.call('Hosts:1', 'X_AVM-DE_SetHostNameByMACAddress', { NewMACAddress: mac, NewHostName: name }); return true; }

  /** Wi-Fi networks (2.4 GHz, 5 GHz, guest …) with name, state and connected devices. */
  async wifi() {
    await this.load();
    const idx = Object.keys(this.services).filter((k) => /^WLANConfiguration:\d+$/.test(k)).map((k) => Number(k.split(':')[1])).sort((a, b) => a - b);
    const out = [];
    for (const i of idx) {
      const svc = `WLANConfiguration:${i}`;
      const g = await this.get(svc, 'GetInfo').catch(() => null);
      if (!g) continue;
      const ext = await this.get(svc, 'X_AVM-DE_GetWLANExtInfo').catch(() => ({}));
      const n = await this.get(svc, 'GetTotalAssociations').catch(() => ({}));
      const apType = ext['X_AVM-DE_APType'] || '';
      out.push({ index: i, ssid: g.SSID, enabled: g.Enable === '1', status: g.Status, channel: Number(g.Channel) || null, standard: g.Standard,
        band: ext['X_AVM-DE_FrequencyBand'] || (i === 1 ? '2400' : i === 2 ? '5000' : null), guest: /guest/i.test(apType) || (i === idx[idx.length - 1] && idx.length >= 3 && !apType), clients: Number(n.TotalAssociations) || 0 });
    }
    return out;
  }
  async setWifi(index, enable) { await this.call(`WLANConfiguration:${Number(index)}`, 'SetEnable', { NewEnable: enable ? 1 : 0 }); return true; }

  /* Port forwardings over the router's internet connection */
  async mappings() {
    const svc = await this.wanService();
    const n = Number((await this.get(svc, 'GetPortMappingNumberOfEntries').catch(() => ({}))).PortMappingNumberOfEntries) || 0;
    const out = [];
    for (let i = 0; i < Math.min(n || 64, 128); i++) {
      let m;
      try { m = await this.get(svc, 'GetGenericPortMappingEntry', { NewPortMappingIndex: i }); } catch { break; }
      out.push({ remoteHost: m.RemoteHost || '', externalPort: Number(m.ExternalPort), protocol: m.Protocol, internalPort: Number(m.InternalPort), internalClient: m.InternalClient, enabled: m.Enabled !== '0', description: m.PortMappingDescription || '', lease: Number(m.LeaseDuration) || 0 });
    }
    return out;
  }
  async addMapping({ externalPort, internalPort, protocol = 'TCP', client, description }) {
    const svc = await this.wanService();
    await this.call(svc, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol, NewInternalPort: internalPort || externalPort, NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: String(description || 'Hostwerk').slice(0, 60), NewLeaseDuration: 0 });
    return true;
  }
  async removeMapping({ externalPort, protocol = 'TCP' }) {
    const svc = await this.wanService();
    await this.call(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: protocol });
    return true;
  }

  async reboot() { await this.call('DeviceConfig:1', 'Reboot'); return true; }
  /** New internet connection (usually a new public IP) – the internet is gone for a moment. */
  async reconnect() { const svc = await this.wanService(); await this.call(svc, 'ForceTermination').catch((e) => { if (e.code !== 707) throw e; }); return true; }
}

/** Router with TR-064? → base address or null (port 49000, without sign-in). */
async function detect(host) {
  try {
    const r = await fetch(`http://${host}:49000/tr64desc.xml`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const xml = await r.text();
    return /dslforum-org/.test(xml) ? { base: `http://${host}:49000`, model: tag(xml, 'modelName') || tag(xml, 'friendlyName'), manufacturer: tag(xml, 'manufacturer') } : null;
  } catch { return null; }
}

module.exports = { Tr064, detect, tag };
