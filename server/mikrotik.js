'use strict';
/*
 * MikroTik (RouterOS 7.1 and newer): REST API under https://<router>/rest with the router user (Basic sign-in).
 * Port forwardings are dst-nat rules in /ip/firewall/nat; Hostwerk's own carry the comment "Hostwerk: …".
 * Same interface as the TR-064 and OpenWrt drivers – features RouterOS does not offer this way say so clearly.
 */
const { request, parseDuration } = require('./rest');

class MikroTik {
  constructor({ base, user = 'admin', pass = '', insecure = false, timeout = 8000 }) {
    this.base = String(base).replace(/\/$/, ''); this.user = user || 'admin'; this.pass = pass; this.insecure = !!insecure; this.timeout = timeout;
  }
  async call(method, p, body) {
    const r = await request(`${this.base}/rest${p}`, { method, body, insecure: this.insecure, timeout: this.timeout, headers: { authorization: `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString('base64')}` } });
    if (r.status === 401) throw Object.assign(new Error('User name or password for the router is wrong.'), { code: 401 });
    if (r.status === 403) throw Object.assign(new Error('The router user lacks the right for this (needs the "rest-api" and "write" policies).'), { code: 606 });
    if (r.status >= 400) throw Object.assign(new Error((r.json && (r.json.detail || r.json.message)) || `The router answers with ${r.status}`), { code: r.status });
    return r.json;
  }
  async info() {
    const r = await this.call('GET', '/system/resource');
    return { model: r['board-name'] || 'MikroTik', firmware: r.version ? `RouterOS ${r.version}` : 'RouterOS', uptime: parseDuration(r.uptime), manufacturer: 'MikroTik' };
  }
  async link() {
    // Öffentliche Adresse über den MikroTik-Cloud-Dienst (falls eingeschaltet), sonst unbekannt
    const c = await this.call('GET', '/ip/cloud').catch(() => null);
    return { connected: true, uptime: 0, externalIp: (c && (c['public-address'] || c['public-address-ipv4'])) || null, access: null, down: 0, up: 0, via: 'RouterOS' };
  }
  async hosts() {
    const leases = await this.call('GET', '/ip/dhcp-server/lease');
    return (leases || []).map((l) => ({ ip: l['active-address'] || l.address, mac: String(l['mac-address'] || '').toUpperCase(), name: l['host-name'] || l.comment || '', active: l.status === 'bound', iface: '', speed: 0, guest: false }));
  }
  async wifi() { return []; }
  async setWifi() { throw new Error('Switch Wi-Fi on MikroTik in WinBox or WebFig.'); }
  async mappings() {
    const list = await this.call('GET', '/ip/firewall/nat');
    return (list || []).filter((x) => x.chain === 'dstnat' && x.action === 'dst-nat' && x['dst-port']).map((x) => ({
      id: x['.id'], remoteHost: '', externalPort: Number(String(x['dst-port']).split(/[-,]/)[0]), protocol: String(x.protocol || 'tcp').toUpperCase(),
      internalPort: Number(x['to-ports'] || x['dst-port']), internalClient: x['to-addresses'] || '', enabled: x.disabled !== 'true' && x.disabled !== true, description: x.comment || '', lease: 0,
    }));
  }
  async addMapping({ externalPort, internalPort, protocol = 'TCP', client, description }) {
    const exists = (await this.mappings()).find((m) => m.externalPort === Number(externalPort) && m.protocol === protocol);
    if (exists && exists.internalClient !== client) throw Object.assign(new Error('The port is already forwarded to another device in the router.'), { code: 718 });
    if (exists) return true;
    await this.call('PUT', '/ip/firewall/nat', { chain: 'dstnat', action: 'dst-nat', protocol: protocol.toLowerCase(), 'dst-port': String(externalPort), 'in-interface-list': 'WAN', 'to-addresses': client, 'to-ports': String(internalPort || externalPort), comment: String(description || 'Hostwerk').slice(0, 60) });
    return true;
  }
  async removeMapping({ externalPort, protocol = 'TCP' }) {
    const m = (await this.mappings()).find((x) => x.externalPort === Number(externalPort) && x.protocol === protocol);
    if (!m) throw Object.assign(new Error('This forwarding does not exist.'), { code: 714 });
    await this.call('DELETE', `/ip/firewall/nat/${encodeURIComponent(m.id)}`);
    return true;
  }
  async reboot() { await this.call('POST', '/system/reboot', {}); return true; }
  async reconnect() { throw new Error('On MikroTik reconnect the internet interface in WinBox or WebFig.'); }
  async wake(mac) { await this.call('POST', '/tool/wol', { mac, interface: 'bridge' }); return true; }
  async rename() { throw new Error('On MikroTik rename devices as a comment of the DHCP lease (WinBox → IP → DHCP Server).'); }
  async users() { return [{ name: this.user, last: true }]; }
}

module.exports = { MikroTik };
