'use strict';
/*
 * UniFi (UniFi OS: Dream Machine, Cloud Gateway, Express …): Network application API with a local user.
 * Sign-in at /api/auth/login → session cookie + CSRF token; port forwardings under
 * /proxy/network/api/s/<site>/rest/portforward. Hostwerk's own carry the name "Hostwerk: …".
 */
const { request } = require('./rest');

class UniFi {
  constructor({ base, user = '', pass = '', insecure = false, site = 'default', timeout = 8000 }) {
    this.base = String(base).replace(/\/$/, ''); this.user = user; this.pass = pass; this.insecure = !!insecure; this.site = site || 'default'; this.timeout = timeout;
    this.cookie = null; this.csrf = null;
  }
  async login() {
    const r = await request(`${this.base}/api/auth/login`, { method: 'POST', body: { username: this.user, password: this.pass, rememberMe: false }, insecure: this.insecure, timeout: this.timeout });
    if (r.status === 401 || r.status === 403 || r.status === 400) throw Object.assign(new Error('User name or password for the router is wrong.'), { code: 401 });
    if (r.status >= 400) throw Object.assign(new Error(`The router answers with ${r.status}`), { code: r.status });
    const set = [].concat(r.headers['set-cookie'] || []);
    this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    this.csrf = r.headers['x-csrf-token'] || r.headers['x-updated-csrf-token'] || null;
    return true;
  }
  async call(method, p, body, retry = true) {
    if (!this.cookie) await this.login();
    const r = await request(`${this.base}/proxy/network/api/s/${encodeURIComponent(this.site)}${p}`, { method, body, insecure: this.insecure, timeout: this.timeout, headers: { cookie: this.cookie, ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) } });
    if (r.headers['x-updated-csrf-token']) this.csrf = r.headers['x-updated-csrf-token'];
    if (r.status === 401 && retry) { this.cookie = null; return this.call(method, p, body, false); }
    if (r.status === 401) throw Object.assign(new Error('User name or password for the router is wrong.'), { code: 401 });
    if (r.status === 403) throw Object.assign(new Error('The UniFi user lacks the right for this (needs the role "Site Admin" for Network).'), { code: 606 });
    const meta = (r.json && r.json.meta) || {};
    if (r.status >= 400 || meta.rc === 'error') throw Object.assign(new Error(meta.msg ? `UniFi: ${meta.msg}` : `The router answers with ${r.status}`), { code: r.status });
    return (r.json && r.json.data) || [];
  }
  async info() {
    if (!this.cookie) await this.login(); // falsches Passwort deutlich melden, nicht in den Zusatzangaben verschlucken
    const sys = await this.call('GET', '/stat/sysinfo').catch(() => []);
    const dev = await this.call('GET', '/stat/device-basic').catch(() => []);
    const gw = (dev || []).find((d) => /^(udm|ugw|uxg|ucg)/i.test(d.type || '')) || (dev || [])[0] || {};
    const s = (sys || [])[0] || {};
    return { model: gw.model || gw.name || 'UniFi', firmware: s.version ? `Network ${s.version}` : 'UniFi Network', uptime: Number(s.uptime) || 0, manufacturer: 'Ubiquiti' };
  }
  async link() {
    const h = await this.call('GET', '/stat/health').catch(() => []);
    const wan = (h || []).find((x) => x.subsystem === 'wan') || {};
    return { connected: wan.status === 'ok', uptime: Number(wan.uptime) || 0, externalIp: wan.wan_ip || null, access: wan.isp_name || null, down: 0, up: 0, via: 'UniFi' };
  }
  async hosts() {
    const list = await this.call('GET', '/stat/sta');
    return (list || []).map((c) => ({ ip: c.ip || '', mac: String(c.mac || '').toUpperCase(), name: c.name || c.hostname || '', active: true, iface: c.is_wired ? 'Ethernet' : '802.11', speed: 0, guest: !!c.is_guest }));
  }
  async wifi() {
    const list = await this.call('GET', '/rest/wlanconf');
    return (list || []).map((w) => ({ index: w._id, ssid: w.name, enabled: w.enabled !== false, status: w.enabled !== false ? 'Up' : 'Down', channel: null, standard: '', band: null, guest: !!w.is_guest, clients: 0 }));
  }
  async setWifi(id, enable) { await this.call('PUT', `/rest/wlanconf/${encodeURIComponent(id)}`, { enabled: !!enable }); return true; }
  async wifiKey(id) { const w = ((await this.call('GET', `/rest/wlanconf/${encodeURIComponent(id)}`)) || [])[0] || {}; return { ssid: w.name || '', password: w.x_passphrase || '', security: w.security === 'open' ? 'nopass' : 'WPA' }; }
  async mappings() {
    const list = await this.call('GET', '/rest/portforward');
    const out = [];
    for (const x of list || []) {
      for (const proto of x.proto === 'tcp_udp' ? ['TCP', 'UDP'] : [String(x.proto || 'tcp').toUpperCase()]) {
        out.push({ id: x._id, remoteHost: '', externalPort: Number(String(x.dst_port).split(/[-,]/)[0]), protocol: proto, internalPort: Number(x.fwd_port || x.dst_port), internalClient: x.fwd || '', enabled: x.enabled !== false, description: x.name || '', lease: 0 });
      }
    }
    return out;
  }
  async addMapping({ externalPort, internalPort, protocol = 'TCP', client, description }) {
    const exists = (await this.mappings()).find((m) => m.externalPort === Number(externalPort) && m.protocol === protocol);
    if (exists && exists.internalClient !== client) throw Object.assign(new Error('The port is already forwarded to another device in the router.'), { code: 718 });
    if (exists) return true;
    await this.call('POST', '/rest/portforward', { name: String(description || 'Hostwerk').slice(0, 60), enabled: true, src: 'any', dst_port: String(externalPort), fwd: client, fwd_port: String(internalPort || externalPort), proto: protocol.toLowerCase(), log: false, pfwd_interface: 'wan' });
    return true;
  }
  async removeMapping({ externalPort, protocol = 'TCP' }) {
    const m = (await this.mappings()).find((x) => x.externalPort === Number(externalPort) && x.protocol === protocol);
    if (!m) throw Object.assign(new Error('This forwarding does not exist.'), { code: 714 });
    await this.call('DELETE', `/rest/portforward/${encodeURIComponent(m.id)}`);
    return true;
  }
  async reboot() { throw new Error('Restart the UniFi gateway in the UniFi app – it would also restart the whole network.'); }
  async reconnect() { throw new Error('On UniFi reconnect the internet in the UniFi app.'); }
  async wake() { throw new Error('Wake-on-LAN is not available through UniFi.'); }
  async rename(mac, name) {
    const u = ((await this.call('GET', `/stat/user/${encodeURIComponent(String(mac).toLowerCase())}`)) || [])[0];
    if (!u || !u._id) throw new Error('UniFi does not know this device yet.');
    await this.call('PUT', `/rest/user/${encodeURIComponent(u._id)}`, { name });
    return true;
  }
  async users() { return [{ name: this.user, last: true }]; }
}

module.exports = { UniFi };
