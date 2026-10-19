'use strict';
/*
 * OpenWrt (and routers built on it like GL.iNet, Turris): ubus JSON-RPC over /ubus with the router user
 * (usually root). Devices, Wi-Fi, port forwardings (uci firewall redirect), reboot.
 */
const NULL_SID = '00000000000000000000000000000000';

class OpenWrt {
  constructor({ base, user = 'root', pass = '', timeout = 8000 }) { this.base = String(base).replace(/\/$/, ''); this.user = user || 'root'; this.pass = pass; this.timeout = timeout; this.sid = null; }

  async rpc(sid, obj, method, args = {}) {
    const r = await fetch(`${this.base}/ubus`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(this.timeout), body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'call', params: [sid, obj, method, args] }) });
    if (!r.ok) throw new Error(`The router answers with ${r.status}`);
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.code === -32002 ? 'No permission (sign-in expired or right missing).' : j.error.message || 'Error'); e.code = j.error.code; throw e; }
    const [code, data] = j.result || [];
    if (code && code !== 0) { const e = new Error({ 6: 'No permission for this action.', 4: 'Not found.', 2: 'Invalid details.' }[code] || `ubus error ${code}`); e.code = code; throw e; }
    return data || {};
  }
  async login() {
    const d = await this.rpc(NULL_SID, 'session', 'login', { username: this.user, password: this.pass }).catch((e) => { if (e.code === 6) throw Object.assign(new Error('User name or password for the router is wrong.'), { code: 401 }); throw e; });
    this.sid = d.ubus_rpc_session;
    return true;
  }
  async call(obj, method, args) {
    if (!this.sid) await this.login();
    try { return await this.rpc(this.sid, obj, method, args); } catch (e) { if (e.code === -32002) { await this.login(); return this.rpc(this.sid, obj, method, args); } throw e; }
  }

  async info() {
    const b = await this.call('system', 'board');
    const i = await this.call('system', 'info').catch(() => ({}));
    return { model: b.model || b.board_name, firmware: b.release ? `${b.release.distribution} ${b.release.version}` : b.kernel, uptime: i.uptime || 0, manufacturer: 'OpenWrt' };
  }
  async link() {
    const w = await this.call('network.interface.wan', 'status').catch(() => null);
    const ip = w && w['ipv4-address'] && w['ipv4-address'][0] ? w['ipv4-address'][0].address : null;
    return { connected: !!(w && w.up), uptime: (w && w.uptime) || 0, externalIp: ip, access: w ? w.proto : null, down: 0, up: 0, via: 'wan' };
  }
  async hosts() {
    const leases = await this.call('luci-rpc', 'getDHCPLeases').catch(() => ({}));
    const hints = await this.call('luci-rpc', 'getHostHints').catch(() => ({}));
    const out = new Map();
    for (const l of leases.dhcp_leases || []) out.set(String(l.macaddr).toUpperCase(), { ip: l.ipaddr, mac: String(l.macaddr).toUpperCase(), name: l.hostname || '', active: true, iface: '', speed: 0, guest: false });
    for (const [mac, h] of Object.entries(hints)) {
      const k = mac.toUpperCase();
      const cur = out.get(k) || { ip: (h.ipaddrs || [])[0] || '', mac: k, name: h.name || '', active: false, iface: '', speed: 0, guest: false };
      if (!cur.name && h.name) cur.name = h.name;
      out.set(k, cur);
    }
    return [...out.values()];
  }
  async wifi() {
    const st = await this.call('network.wireless', 'status').catch(() => ({}));
    const out = [];
    for (const [radio, r] of Object.entries(st)) {
      for (const i of r.interfaces || []) {
        out.push({ index: i.section, ssid: (i.config || {}).ssid || '', enabled: !r.disabled && !(i.config || {}).disabled, status: r.up ? 'Up' : 'Down', channel: (r.config || {}).channel || null, standard: (r.config || {}).htmode || '', band: (r.config || {}).band || radio, guest: /guest/i.test((i.config || {}).network || '') || /guest/i.test((i.config || {}).ssid || ''), clients: 0 });
      }
    }
    return out;
  }
  async apply(config) {
    await this.call('uci', 'commit', { config });
    await this.call('uci', 'apply', { rollback: false }).catch(() => {});
    if (config === 'wireless') await this.call('network.wireless', 'up').catch(() => {});
  }
  async setWifi(section, enable) { await this.call('uci', 'set', { config: 'wireless', section, values: { disabled: enable ? '0' : '1' } }); await this.apply('wireless'); return true; }
  async mappings() {
    const r = await this.call('uci', 'get', { config: 'firewall', type: 'redirect' });
    return Object.entries(r.values || {}).map(([sec, v]) => ({ section: sec, remoteHost: '', externalPort: Number(v.src_dport), protocol: String(v.proto || 'tcp').split(' ')[0].toUpperCase(), internalPort: Number(v.dest_port || v.src_dport), internalClient: v.dest_ip || '', enabled: v.enabled !== '0', description: v.name || '', lease: 0 }))
      .filter((m) => m.externalPort);
  }
  async addMapping({ externalPort, internalPort, protocol = 'TCP', client, description }) {
    const r = await this.call('uci', 'add', { config: 'firewall', type: 'redirect', values: { name: String(description || 'Hostwerk').slice(0, 60), src: 'wan', src_dport: String(externalPort), dest: 'lan', dest_ip: client, dest_port: String(internalPort || externalPort), proto: protocol.toLowerCase(), target: 'DNAT' } });
    await this.apply('firewall');
    return !!r.section;
  }
  async removeMapping({ externalPort, protocol = 'TCP' }) {
    const m = (await this.mappings()).find((x) => x.externalPort === Number(externalPort) && x.protocol === protocol);
    if (!m) throw Object.assign(new Error('This forwarding does not exist.'), { code: 714 });
    await this.call('uci', 'delete', { config: 'firewall', section: m.section });
    await this.apply('firewall');
    return true;
  }
  /** IPv6: open a port for this PC in the firewall (a rule instead of a forwarding – IPv6 has no NAT). */
  async addPinhole({ client, port, protocol = 'TCP', description }) {
    const r = await this.call('uci', 'add', { config: 'firewall', type: 'rule', values: { name: String(description || 'Hostwerk').slice(0, 60), src: 'wan', dest: 'lan', family: 'ipv6', dest_ip: client, dest_port: String(port), proto: protocol.toLowerCase(), target: 'ACCEPT' } });
    await this.apply('firewall');
    return r.section || null;
  }
  async pinholes() {
    const r = await this.call('uci', 'get', { config: 'firewall', type: 'rule' });
    return Object.entries(r.values || {}).filter(([, v]) => v.family === 'ipv6' && v.target === 'ACCEPT' && v.dest_port).map(([sec, v]) => ({ id: sec, port: Number(v.dest_port), protocol: String(v.proto || 'tcp').toUpperCase(), client: v.dest_ip || '', description: v.name || '' }));
  }
  async deletePinhole(id) { await this.call('uci', 'delete', { config: 'firewall', section: id }); await this.apply('firewall'); return true; }
  async reboot() { await this.call('system', 'reboot'); return true; }
  async reconnect() { await this.call('network.interface.wan', 'down'); await new Promise((r) => setTimeout(r, 2000)); await this.call('network.interface.wan', 'up'); return true; }
  async wake() { throw new Error('Wake-on-LAN through OpenWrt is not available here (needs the etherwake package).'); }
  async rename() { throw new Error('On OpenWrt, rename devices in the router interface (Network → DHCP).'); }
  async users() { return [{ name: 'root', last: true }]; }
}

/** Detect OpenWrt (ubus answers with a JSON-RPC error even without sign-in). */
async function detect(host) {
  try {
    const r = await fetch(`http://${host}/ubus`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'list', params: [NULL_SID, '*'] }), signal: AbortSignal.timeout(2500) });
    const j = await r.json().catch(() => null);
    return j && j.jsonrpc === '2.0' ? { base: `http://${host}`, model: 'OpenWrt', manufacturer: 'OpenWrt' } : null;
  } catch { return null; }
}

module.exports = { OpenWrt, detect };
