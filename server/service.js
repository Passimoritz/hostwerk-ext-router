'use strict';
/*
 * Router management: finds the router of the computer Hostwerk runs on (PC, home server or rented server), shows model,
 * public address and every port forwarding – and, if wanted, forwards the ports of public Hostwerk services automatically
 * (UPnP, fallback NAT-PMP). With "automatic" the forwardings stay up to date (new Minecraft servers, changed ports) and are
 * renewed regularly.
 *
 * Hostwerk's own forwardings carry the description "Hostwerk: …" – only those are cleaned up again.
 * A server with a public address right on its network card (data centre, VPS) needs no router.
 *
 * IPv6 and DS-Lite: many connections (cable, fibre) no longer have their own public IPv4 (DS-Lite/carrier NAT) but a public
 * IPv6. This is detected; ports are opened for IPv6 as well (UPnP pinhole or OpenWrt rule, otherwise instructions) and DynDNS
 * keeps a fixed name on the changing address. Visitors without IPv6 can use the tunnel or ask the provider for public IPv4.
 *
 * Router access (sign-in with the router user): TR-064 (FRITZ!Box & co.) and OpenWrt are found by themselves; MikroTik
 * (RouterOS 7 REST) and UniFi (UniFi OS) are chosen by hand – then forwardings go directly through the router.
 * Every forwarding says where it comes from (Hostwerk, which extension, added by hand, another device); "reachable from
 * outside?" asks a public port check (ifconfig.co) – only when the user clicks.
 *
 * Data stays where it always was: settings.router (forwardings, sign-in, DynDNS).
 */
const R = require('./upnp');
const TR = require('./tr064');
const OW = require('./openwrt');
const { MikroTik } = require('./mikrotik');
const { UniFi } = require('./unifi');

/** Router types with sign-in: found by themselves (tr064, openwrt) or chosen by hand (mikrotik, unifi). */
const KINDS = ['tr064', 'openwrt', 'mikrotik', 'unifi'];
const MANUAL = [{ kind: 'mikrotik', label: 'MikroTik (RouterOS 7)', user: 'admin' }, { kind: 'unifi', label: 'UniFi (UniFi OS)', user: '' }];
/** Text of a Wi-Fi QR code (WIFI:T:WPA;S:name;P:password;;) – \ ; , : " are escaped as the format wants. */
function wifiQrText({ ssid, password = '', security = 'WPA', hidden = false }) {
  const e = (s) => String(s || '').replace(/([\\;,:"])/g, '\\$1');
  const T = security === 'nopass' || !password ? 'nopass' : security === 'WEP' ? 'WEP' : 'WPA';
  return `WIFI:T:${T};S:${e(ssid)};${T === 'nopass' ? '' : `P:${e(password)};`}${hidden ? 'H:true;' : ''};`;
}

const PREFIX = 'Hostwerk: ';
const VENDOR_HINTS = [
  { re: /fritz|avm/i, name: 'FRITZ!Box', web: 'http://fritz.box', text: 'On the FRITZ!Box under Internet → Permit Access → Port Sharing, switch on "Permit independent port sharing for this device" for this PC. Otherwise it refuses automatic forwardings.' },
  { re: /speedport|telekom/i, name: 'Speedport', web: 'http://speedport.ip', text: 'On the Speedport under Home network → Network settings → UPnP, switch on "Activate UPnP".' },
  { re: /vodafone|arris|technicolor|compal|connect box/i, name: 'Vodafone router', web: null, text: 'Many Vodafone routers allow UPnP only partly. If automatic forwardings fail: enter them by hand in the router under Advanced settings → Port forwarding.' },
  { re: /tp-?link|archer|deco/i, name: 'TP-Link', web: 'http://tplinkwifi.net', text: 'On TP-Link switch on UPnP under Advanced → NAT Forwarding.' },
  { re: /asus|rt-|zenwifi/i, name: 'ASUS', web: 'http://router.asus.com', text: 'On ASUS set "Enable UPnP" to Yes under WAN → Internet connection.' },
  { re: /netgear|nighthawk|orbi/i, name: 'NETGEAR', web: 'http://routerlogin.net', text: 'On NETGEAR switch on UPnP under Advanced → Advanced Setup.' },
  { re: /openwrt|miniupnp/i, name: 'OpenWrt', web: null, text: 'On OpenWrt install the package "luci-app-upnp" and activate UPnP/NAT-PMP.' },
];

class RouterService {
  /** host: extension host (ctx, t, core(), broadcast) */
  constructor(host, { timers = true } = {}) {
    this.host = host;
    this.ctx = host.ctx;
    this.t = host.t;
    this.secrets = host.core('secrets');
    this.cache = null; // { t, igd }
    if (timers) {
      this.timer = setTimeout(() => this.autoTick().catch(() => {}), 25000);
      this.interval = setInterval(() => this.autoTick().catch(() => {}), 30 * 60000);
      for (const x of [this.timer, this.interval]) if (x.unref) x.unref();
    }
  }
  stop() { clearTimeout(this.timer); clearInterval(this.interval); }
  get cfg() { const s = this.ctx.settings.get(); s.router = s.router || {}; if (s.router.auto === undefined) s.router.auto = false; s.router.extra = s.router.extra || []; s.router.pinholes = s.router.pinholes || []; if (s.router.ipv6 === undefined) s.router.ipv6 = true; return s.router; }

  /* ---------------- IPv6 & DS-Lite ---------------- */
  /** Addresses and connection type: { v6: { local, stable, public }, v4public } (cached for 5 min). */
  async net(force = false) {
    if (!force && this.netCache && Date.now() - this.netCache.t < 300000) return this.netCache.v;
    const [stable, pub4, pub6] = await Promise.all([R.stableV6(), R.publicV4(), R.publicV6()]);
    const v = { v6: { local: R.globalV6().map((x) => x.address), stable, public: pub6 }, v4public: pub4 };
    this.netCache = { t: Date.now(), v };
    return v;
  }
  /** Open ports for IPv6: router access (OpenWrt) or UPnP pinhole. Returns { opened, failed, how }. */
  async syncV6(st) {
    const { t } = this;
    const out = { opened: [], failed: [], how: null };
    if (!this.cfg.ipv6) return out;
    const net = await this.net();
    const client = net.v6.stable;
    if (!client) return out;
    const igd = await this.igd();
    const drv = this.driver();
    const keep = [];
    for (const w of st.wanted) {
      const have = this.cfg.pinholes.find((p) => p.port === w.port && p.protocol === w.protocol && p.client === client);
      try {
        if (drv && drv.addPinhole) {
          out.how = 'login';
          if (!have) { const id = await drv.addPinhole({ client, port: w.port, protocol: w.protocol, description: PREFIX + (w.label || `Port ${w.port}`) }); keep.push({ id, port: w.port, protocol: w.protocol, client, via: 'login' }); } else keep.push(have);
          out.opened.push(w.port);
        } else if (igd.upnp && igd.upnp.control6) {
          out.how = 'upnp';
          if (igd.fw6 && igd.fw6.allowed === false) throw new Error(t('The router does not allow automatic IPv6 forwardings for this PC (FRITZ!Box: Internet → Permit Access → device of this PC → "Permit independent port sharing" – applies to IPv6 too) – or sign in under "Router access".'));
          if (have && have.via === 'upnp') { try { await R.updatePinhole(igd.upnp.control6, have.id); keep.push(have); out.opened.push(w.port); continue; } catch { /* expired → new */ } }
          const id = await R.addPinhole(igd.upnp.control6, { client, port: w.port, protocol: w.protocol });
          keep.push({ id, port: w.port, protocol: w.protocol, client, via: 'upnp' });
          out.opened.push(w.port);
        } else { out.failed.push({ port: w.port, error: t('The router offers no automatic IPv6 forwarding.') }); }
      } catch (e) { out.failed.push({ port: w.port, error: t(e.message) }); }
    }
    // Close own pinholes that are no longer wanted
    for (const p of this.cfg.pinholes.filter((x) => !keep.includes(x) && !keep.some((k) => k.id === x.id))) {
      try { if (p.via === 'login' && drv && drv.deletePinhole) await drv.deletePinhole(p.id); else if (p.via === 'upnp' && igd.upnp && igd.upnp.control6) await R.deletePinhole(igd.upnp.control6, p.id); } catch { /* already gone */ }
    }
    this.cfg.pinholes = keep;
    this.ctx.settings.save();
    return out;
  }

  /* ---------------- DynDNS: a fixed name for changing addresses ---------------- */
  get dyn() { const c = this.cfg; c.dyndns = c.dyndns || { provider: '', domain: '', token: '', last: null }; return c.dyndns; }
  /** Send the addresses to the provider (only when they changed, or with force). */
  async dynUpdate(force = false) {
    const { t } = this;
    const d = this.dyn;
    if (!d.provider || !d.domain) return null;
    const net = await this.net(force);
    const ip4 = net.v4public || '';
    const ip6 = net.v6.stable || '';
    if (!force && d.last && d.last.ip4 === ip4 && d.last.ip6 === ip6 && Date.now() - d.last.t < 24 * 3600000) return d.last;
    const tok = this.secrets.open(d.token || '');
    const enc = encodeURIComponent;
    let url; let headers = {};
    if (d.provider === 'duckdns') url = `https://www.duckdns.org/update?domains=${enc(d.domain.replace(/\.duckdns\.org$/, ''))}&token=${enc(tok)}&ip=${enc(ip4)}&ipv6=${enc(ip6)}`;
    else if (d.provider === 'dynv6') url = `https://dynv6.com/api/update?hostname=${enc(d.domain)}&token=${enc(tok)}${ip6 ? `&ipv6=${enc(ip6)}&ipv6prefix=auto` : ''}${ip4 ? `&ipv4=${enc(ip4)}` : ''}`;
    else if (d.provider === 'desec') { url = `https://update.dedyn.io/?hostname=${enc(d.domain)}${ip4 ? `&myipv4=${enc(ip4)}` : '&myipv4=preserve'}${ip6 ? `&myipv6=${enc(ip6)}` : '&myipv6=preserve'}`; headers = { Authorization: `Basic ${Buffer.from(`${d.domain}:${tok}`).toString('base64')}` }; }
    else if (d.provider === 'custom') url = String(d.url || '').replace(/\{ip4\}/g, enc(ip4)).replace(/\{ip6\}/g, enc(ip6)).replace(/\{domain\}/g, enc(d.domain)).replace(/\{token\}/g, enc(tok));
    if (!/^https:\/\//.test(url || '')) throw new Error(t('DynDNS: invalid provider address.'));
    const res = await fetch(url, { headers: { 'User-Agent': 'Hostwerk', ...headers }, signal: AbortSignal.timeout(15000) });
    const text = (await res.text()).trim().slice(0, 200);
    const ok = res.ok && !/^(KO|badauth|nohost|notfqdn|abuse|911|invalid)/i.test(text);
    d.last = { t: Date.now(), ip4, ip6, ok, answer: text };
    this.ctx.settings.save();
    if (this.ctx.keeper) this.ctx.keeper.note('dyndns', { ok, label: `DynDNS (${d.domain})`, text: ok ? `${d.domain} → ${[ip4, ip6].filter(Boolean).join(` ${t('and')} `)}` : t('The provider reports: {text}', { text }) });
    if (!ok) throw new Error(t('The DynDNS provider reports: {text}', { text: text || res.status }));
    return d.last;
  }

  /* ---------------- Router access (sign-in with the router user) ---------------- */
  /** Which management does the router offer? TR-064 (FRITZ!Box & co.), OpenWrt – otherwise only UPnP. */
  async detect() {
    const g = await R.gateway();
    if (!g.gateway) return { gateway: null, kinds: [] };
    const [tr, ow] = await Promise.all([TR.detect(g.gateway), OW.detect(g.gateway)]);
    const kinds = [];
    if (tr) kinds.push({ kind: 'tr064', base: tr.base, label: tr.model || 'TR-064', users: await new TR.Tr064({ base: tr.base }).users() });
    if (ow) kinds.push({ kind: 'openwrt', base: ow.base, label: 'OpenWrt', users: [{ name: 'root', last: true }] });
    // Ohne eigene Suche: MikroTik und UniFi wählt man selbst (Adresse vorgeschlagen, änderbar)
    for (const m of MANUAL) kinds.push({ kind: m.kind, base: `https://${g.gateway}`, label: m.label, manual: true, users: m.user ? [{ name: m.user, last: true }] : [] });
    return { gateway: g.gateway, kinds };
  }
  /** Signed-in driver or null. */
  driver() {
    const l = this.cfg.login;
    if (!l || !l.base) return null;
    if (this.drv && this.drvSig === `${l.kind}|${l.base}|${l.user}|${l.pass}`) return this.drv;
    const opts = { base: l.base, user: l.user || '', pass: this.secrets.open(l.pass || ''), insecure: !!l.insecure };
    this.drv = RouterService.makeDriver(l.kind, opts);
    this.drvSig = `${l.kind}|${l.base}|${l.user}|${l.pass}`;
    return this.drv;
  }
  static makeDriver(kind, opts) {
    if (kind === 'openwrt') return new OW.OpenWrt(opts);
    if (kind === 'mikrotik') return new MikroTik(opts);
    if (kind === 'unifi') return new UniFi(opts);
    return new TR.Tr064(opts);
  }
  async login({ kind, base, user, pass, insecure }) {
    if (!KINDS.includes(kind) || !/^https?:\/\/[^\s/]+\/?$/.test(base || '')) throw new Error(this.t('Please choose the router type.'));
    const opts = { base: String(base).replace(/\/$/, ''), user: String(user || '').trim(), pass: String(pass || ''), insecure: !!insecure };
    // Some routers (FRITZ!Box with "password only", OpenWrt) need no user name – then take the last used one or "root"
    if (!opts.user) {
      if (kind === 'openwrt') opts.user = 'root';
      else if (kind === 'mikrotik') opts.user = 'admin';
      else if (kind === 'unifi') throw new Error(this.t('UniFi needs the name of a local UniFi user.'));
      else { const users = await new TR.Tr064(opts).users().catch(() => []); opts.user = ((users.find((u) => u.last) || users[0]) || {}).name || ''; }
    }
    const d = RouterService.makeDriver(kind, opts);
    const info = await d.info(); // checks the sign-in
    this.cfg.login = { kind, base: opts.base, user: opts.user, pass: this.secrets.seal(opts.pass), insecure: opts.insecure || undefined, model: info.model || null, at: Date.now() };
    this.ctx.settings.save();
    this.drv = null; this.cache = null;
    return this.loginStatus();
  }
  logout() { delete this.cfg.login; this.drv = null; this.ctx.settings.save(); return { loggedIn: false }; }
  loginStatus() { const l = this.cfg.login; return l ? { loggedIn: true, kind: l.kind, base: l.base, user: l.user, model: l.model, at: l.at } : { loggedIn: false }; }
  /** Router call with a readable error; a wrong password marks the access as invalid. */
  async via(fn) {
    const d = this.driver();
    if (!d) throw Object.assign(new Error(this.t('Please sign in under "Router access" first.')), { status: 400 });
    try { return await fn(d); } catch (e) { if (e.code === 401 && this.cfg.login) { this.cfg.login.invalid = true; this.ctx.settings.save(); } throw e; }
  }

  /** Find the router (cached for 60 s). */
  async igd(force = false) {
    if (!force && this.cache && Date.now() - this.cache.t < 60000) return this.cache.igd;
    const g = await R.gateway();
    const igd = { gateway: g.gateway, localIp: g.localIp, iface: g.iface, addresses: g.addresses, upnp: null, natpmp: false };
    if (g.gateway) {
      const locs = await R.ssdpSearch({ bind: g.localIp || undefined });
      // Prefer the device at the gateway (repeaters/mesh nodes answer too in some networks)
      locs.sort((a, b) => (new URL(b).hostname === g.gateway) - (new URL(a).hostname === g.gateway));
      for (const loc of locs) {
        try { const d = await R.describe(loc); if (d.control) { igd.upnp = d; break; } } catch { /* next */ }
      }
      if (!igd.upnp) { try { await R.natpmpExternalIp(g.gateway); igd.natpmp = true; } catch { /* no NAT-PMP */ } }
      if (igd.upnp && igd.upnp.control6) igd.fw6 = await R.v6FirewallStatus(igd.upnp.control6);
    }
    this.cache = { t: Date.now(), igd };
    return igd;
  }

  /** Ports that would be forwarded (public services + own entries). */
  wanted() {
    const origin = this.origins();
    const list = this.ctx.security ? this.ctx.security.publicPorts().map((p) => { const protocol = p.proto === 'UDP' ? 'UDP' : 'TCP'; return { port: p.port, protocol, label: p.label, origin: origin.get(`${p.port}/${protocol}`) || { kind: 'hostwerk' } }; }) : [];
    for (const x of this.cfg.extra) if (!list.some((p) => p.port === x.port && p.protocol === x.protocol)) list.push({ ...x, origin: { kind: 'manual' } });
    return list;
  }
  /**
   * Where a wanted port comes from: an extension (port provider of Hostwerk's security service, e.g. game servers),
   * the mail server, or Hostwerk itself. → Map "port/PROTO" → { kind: 'extension' | 'hostwerk', id, name }
   */
  origins() {
    const out = new Map();
    const sec = this.ctx.security;
    const nameOf = (id) => { try { const e = this.ctx.extMarket && this.ctx.extMarket.get(id); const n = e && (e.names ? (e.names.de || e.names.en) : e.name); return (n && typeof n === 'object' ? n.de || n.en : n) || id; } catch { return id; } };
    for (const [id, fn] of (sec && sec.portProviders) || []) {
      try { for (const p of [].concat(fn() || [])) if (p && Number.isInteger(p.port)) out.set(`${p.port}/${p.proto === 'UDP' ? 'UDP' : 'TCP'}`, { kind: 'extension', id, name: nameOf(id) }); } catch { /* ein Beitrag fällt aus */ }
    }
    const ms = this.ctx.settings.get().mailserver;
    if (ms && ms.public && ms.ports) for (const k of ['smtp', 'submission', 'submissions', 'imaps', 'pop3s', 'https']) if (ms.ports[k] && !out.has(`${ms.ports[k]}/TCP`)) out.set(`${ms.ports[k]}/TCP`, { kind: 'extension', id: 'mail-server', name: nameOf('mail-server') });
    return out;
  }

  /**
   * "Reachable from outside?" – a public port check (ifconfig.co) tries to connect to this connection's public address.
   * Only TCP can be checked like this. → { port, reachable, ip } – sends nothing but the port number.
   */
  async reach(port, { fetchFn = fetch } = {}) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw Object.assign(new Error(this.t('Invalid port')), { status: 400 });
    const r = await fetchFn(`https://ifconfig.co/port/${p}`, { headers: { accept: 'application/json', 'user-agent': 'Hostwerk' }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!r || !r.ok) throw Object.assign(new Error(this.t('The outside check (ifconfig.co) cannot be reached right now.')), { status: 502 });
    const j = await r.json().catch(() => ({}));
    return { port: p, reachable: !!j.reachable, ip: j.ip || null, at: Date.now() };
  }

  async status(force = false) {
    const { t } = this;
    const igd = await this.igd(force);
    const out = {
      gateway: igd.gateway, localIp: igd.localIp, iface: igd.iface, auto: !!this.cfg.auto,
      // Public address right on the computer → data centre/VPS: no router, only the firewall
      direct: igd.addresses.some((a) => !R.isPrivate(a) && !R.isCgnat(a) && !a.startsWith('127.')),
      router: null, kind: igd.upnp ? 'upnp' : igd.natpmp ? 'natpmp' : null, externalIp: null, connection: null, mappings: [], wanted: this.wanted(), hint: null, problems: [],
    };
    if (igd.upnp) {
      const d = igd.upnp.device;
      out.router = { name: d.name, manufacturer: d.manufacturer, model: d.model, web: d.web };
      try { out.externalIp = await R.externalIp(igd.upnp.control); } catch (e) { out.problems.push(t(e.message)); }
      out.connection = await R.connectionStatus(igd.upnp.control);
      try { out.mappings = (await R.mappings(igd.upnp.control)).map((m) => ({ ...m, ours: m.description.startsWith(PREFIX), here: m.internalClient === igd.localIp })); } catch { /* some routers cannot list */ }
    } else if (igd.natpmp) {
      try { out.externalIp = await R.natpmpExternalIp(igd.gateway); } catch { /* ignore */ }
      out.router = { name: t('Router with NAT-PMP'), web: `http://${igd.gateway}/` };
    } else if (igd.gateway) out.router = { name: t('Router without UPnP'), web: `http://${igd.gateway}/` };
    const vendor = out.router && VENDOR_HINTS.find((v) => v.re.test(`${out.router.name} ${out.router.manufacturer || ''} ${out.router.model || ''}`));
    if (vendor) out.hint = { vendor: t(vendor.name), text: t(vendor.text), web: vendor.web || (out.router && out.router.web) };
    // IPv6 and connection type (DS-Lite / carrier NAT / double NAT)
    try { out.net = await this.net(force); } catch { out.net = null; }
    const v4seen = out.net && out.net.v4public;
    out.dslite = R.isDsLite(out.externalIp) || (!!out.externalIp && R.isCgnat(out.externalIp) && !!(out.net && out.net.v6.public));
    out.cgnat = !out.dslite && !!out.externalIp && R.isCgnat(out.externalIp);
    out.doubleNat = !!out.externalIp && R.isPrivate(out.externalIp);
    out.v4mismatch = !!(v4seen && out.externalIp && v4seen !== out.externalIp && !R.isPrivate(out.externalIp) && !R.isCgnat(out.externalIp) && !R.isDsLite(out.externalIp));
    out.ipv6 = { enabled: !!this.cfg.ipv6, address: out.net ? out.net.v6.stable : null, outgoing: out.net ? out.net.v6.public : null, pinholes: this.cfg.pinholes, auto: !!(igd.upnp && igd.upnp.control6 && !(igd.fw6 && igd.fw6.allowed === false)) || !!(this.driver() && this.driver().addPinhole), denied: !!(igd.fw6 && igd.fw6.allowed === false) };
    out.dyndns = { provider: this.dyn.provider, domain: this.dyn.domain, last: this.dyn.last, hasToken: !!this.dyn.token };
    if (out.dslite) out.problems.push(t('Your connection uses DS-Lite: no own public IPv4, but a public IPv6. Hostwerk opens the ports for IPv6 – over IPv4 this PC cannot be reached from outside. Ways out: set up DynDNS for IPv6 (below), use the tunnel for visitors without IPv6, or ask your provider for "dual stack" or a public IPv4.'));
    else if (out.cgnat) out.problems.push(t('Your connection has no own public IPv4 (carrier NAT, {ip}). Forwardings in the router are not enough then – {v6}ask your provider for a public IPv4 or use a tunnel.', { ip: out.externalIp, v6: out.net && out.net.v6.stable ? t('you can be reached over IPv6 though (set up DynDNS), otherwise ') : '' }));
    else if (out.doubleNat) out.problems.push(t('Your router sits behind another router (double NAT, {ip}). Forwardings have to be set up on the front device as well.', { ip: out.externalIp }));
    const drv = this.driver();
    out.access = this.loginStatus();
    if (drv) {
      try { out.mappings = (await drv.mappings()).map((m) => ({ ...m, ours: m.description.startsWith(PREFIX), here: m.internalClient === igd.localIp })); out.mappingsVia = 'login'; } catch (e) { out.problems.push(t('Router access: {msg}', { msg: t(e.message) })); }
    }
    for (const w of out.wanted) {
      const m = out.mappings.find((x) => x.externalPort === w.port && x.protocol === w.protocol);
      w.state = !m ? 'missing' : m.internalClient === igd.localIp ? 'ok' : 'other';
      if (m && m.internalClient !== igd.localIp) w.other = m.internalClient;
    }
    // Herkunft jeder Freigabe im Router: Hostwerks eigene wie gewünscht, fremde von einem anderen Gerät oder Programm
    for (const m of out.mappings) { const w = out.wanted.find((x) => x.port === m.externalPort && x.protocol === m.protocol); m.origin = m.ours ? (w ? w.origin : { kind: 'hostwerk', stale: true }) : { kind: 'other' }; }
    return out;
  }

  async forward({ port, internalPort, protocol = 'TCP', label = '' }) {
    const { t } = this;
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('Invalid port'));
    const igd = await this.igd();
    if (!igd.localIp) throw new Error(t('No network connection found.'));
    const description = PREFIX + (label || `Port ${port}`);
    // With router access create it directly – works even if the router forbids UPnP forwardings for this PC
    const drv = this.driver();
    if (drv) {
      try { await drv.addMapping({ externalPort: port, internalPort: Number(internalPort) || port, protocol, client: igd.localIp, description }); return { port, protocol, client: igd.localIp, via: 'login' }; } catch (e) { if (!igd.upnp || e.code === 718) throw e; }
    }
    if (igd.upnp) await R.add(igd.upnp.control, { externalPort: port, internalPort: Number(internalPort) || port, protocol, client: igd.localIp, description });
    else if (igd.natpmp) await R.natpmpMap(igd.gateway, { internalPort: Number(internalPort) || port, externalPort: port, protocol, lifetime: 7200 });
    else throw new Error(t('No router with UPnP or NAT-PMP found – please set up the forwarding by hand in the router.'));
    return { port, protocol, client: igd.localIp };
  }

  async unforward({ port, protocol = 'TCP' }) {
    const igd = await this.igd();
    const drv = this.driver();
    if (drv) { try { await drv.removeMapping({ externalPort: Number(port), protocol }); return true; } catch (e) { if (!igd.upnp) throw e; } }
    if (igd.upnp) await R.remove(igd.upnp.control, { externalPort: Number(port), protocol });
    else if (igd.natpmp) await R.natpmpMap(igd.gateway, { internalPort: Number(port), externalPort: 0, protocol, lifetime: 0 });
    else throw new Error(this.t('No router with UPnP or NAT-PMP found.'));
    return true;
  }

  /** Forward every wanted port, remove own outdated forwardings. → { added, removed, failed } */
  async sync({ cleanup = true } = {}) {
    const { t } = this;
    const st = await this.status(true);
    if (st.direct && !st.kind) return { added: [], removed: [], failed: [], direct: true };
    const res = { added: [], removed: [], failed: [] };
    for (const w of st.wanted) {
      if (w.state === 'ok') continue;
      if (w.state === 'other') { res.failed.push({ port: w.port, error: t('Port {port} is already given to {other} in the router.', { port: w.port, other: w.other }) }); continue; }
      try { await this.forward(w); res.added.push(w.port); } catch (e) { res.failed.push({ port: w.port, error: t(e.message) }); }
    }
    if (cleanup) {
      for (const m of st.mappings.filter((x) => x.ours && x.here && !st.wanted.some((w) => w.port === x.externalPort && w.protocol === x.protocol))) {
        try { await this.unforward({ port: m.externalPort, protocol: m.protocol }); res.removed.push(m.externalPort); } catch { /* ignore */ }
      }
    }
    // IPv6: open the same ports in the router firewall (the only way in with DS-Lite)
    try { res.v6 = await this.syncV6(st); } catch (e) { res.v6 = { opened: [], failed: [{ port: 0, error: t(e.message) }] }; }
    try { await this.dynUpdate(); } catch { /* shows up in self-maintenance */ }
    // DS-Lite/carrier NAT: IPv4 forwardings fail by nature – not an error when IPv6 works
    if ((st.dslite || st.cgnat) && res.v6 && res.v6.opened.length) res.failed = [];
    this.cache = null;
    return res;
  }

  /** Automatic mode: keep forwardings up to date (and renew NAT-PMP forwardings). */
  async autoTick() {
    // Keep DynDNS current always (also without automatic forwardings)
    try { await this.dynUpdate(); } catch { /* shows up in self-maintenance */ }
    if (!this.cfg.auto) return;
    const r = await this.sync();
    if (r.added.length) this.host.broadcast({ type: 'toast', kind: 'info', text: this.t('Router: port {ports} forwarded.', { ports: r.added.join(', ') }) });
    if (r.failed.length && !this.lastFail) this.host.broadcast({ type: 'toast', kind: 'warn', text: this.t('Router: {msg}', { msg: r.failed[0].error }) });
    this.lastFail = r.failed.length > 0;
  }

  routes(r) {
    const { t } = this;
    r.get('/router', async (req, res) => res.json(await this.status(req.query.refresh === '1')));
    r.post('/router/forward', async (req, res) => {
      const b = req.body || {};
      const x = await this.forward(b);
      if (b.remember) { this.cfg.extra = [...this.cfg.extra.filter((e) => !(e.port === x.port && e.protocol === x.protocol)), { port: x.port, protocol: x.protocol, label: b.label || '' }]; this.ctx.settings.save(); }
      this.cache = null;
      res.json(await this.status(true));
    });
    r.post('/router/unforward', async (req, res) => {
      const b = req.body || {};
      await this.unforward(b);
      this.cfg.extra = this.cfg.extra.filter((e) => !(e.port === Number(b.port) && e.protocol === (b.protocol || 'TCP')));
      this.ctx.settings.save();
      this.cache = null;
      res.json(await this.status(true));
    });
    r.post('/router/sync', async (req, res) => res.json({ result: await this.sync(), status: await this.status() }));
    r.put('/router/ipv6', async (req, res) => { this.cfg.ipv6 = !!(req.body || {}).enabled; this.ctx.settings.save(); res.json(await this.status(true)); });
    r.put('/router/dyndns', async (req, res) => {
      const b = req.body || {};
      const d = this.dyn;
      if (b.provider !== undefined) { if (!['', 'duckdns', 'dynv6', 'desec', 'custom'].includes(b.provider)) throw new Error(t('Unknown DynDNS provider.')); d.provider = b.provider; }
      if (typeof b.domain === 'string') { if (b.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$|^[a-z0-9-]+$/i.test(b.domain.trim())) throw new Error(t('Invalid name.')); d.domain = b.domain.trim().toLowerCase(); }
      if (typeof b.token === 'string' && b.token.trim()) d.token = this.secrets.seal(b.token.trim());
      if (typeof b.url === 'string') { if (b.url && !/^https:\/\//.test(b.url)) throw new Error(t('The address must start with https://.')); d.url = b.url.trim(); }
      d.last = null;
      this.ctx.settings.save();
      let result = null; let error = null;
      if (d.provider && d.domain) { try { result = await this.dynUpdate(true); } catch (e) { error = t(e.message); } }
      res.json({ result, error, status: await this.status() });
    });
    // Router access: sign in and manage the router from Hostwerk
    r.get('/router/detect', async (req, res) => res.json({ ...(await this.detect()), access: this.loginStatus() }));
    r.put('/router/login', async (req, res) => res.json(await this.login(req.body || {})));
    r.delete('/router/login', (req, res) => res.json(this.logout()));
    r.get('/router/manage', async (req, res) => res.json(await this.via(async (d) => {
      const [info, link] = await Promise.all([d.info(), d.link().catch(() => null)]);
      return { info, link, access: this.loginStatus() };
    })));
    r.get('/router/devices', async (req, res) => res.json(await this.via((d) => d.hosts())));
    r.get('/router/wifi', async (req, res) => res.json(await this.via((d) => d.wifi())));
    // QR-Code zum Beitreten (Gast-WLAN): Name und Passwort aus dem Router, wenn er sie herausgibt – sonst von Hand
    r.get('/router/wifi/:index/key', async (req, res) => res.json(await this.via(async (d) => { if (!d.wifiKey) throw new Error(t('This router does not give out the Wi-Fi password – enter it by hand.')); return d.wifiKey(req.params.index); })));
    r.post('/router/wifi-qr', async (req, res) => {
      const b = req.body || {};
      const ssid = String(b.ssid || '').slice(0, 64);
      if (!ssid) throw Object.assign(new Error(t('The Wi-Fi needs a name.')), { status: 400 });
      const text = wifiQrText({ ssid, password: String(b.password || '').slice(0, 64), security: b.security, hidden: !!b.hidden });
      const svg = await this.host.lib('qrcode').toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      res.json({ svg });
    });
    r.get('/router/reach/:port', async (req, res) => res.json(await this.reach(req.params.port)));
    r.put('/router/wifi/:index', async (req, res) => { await this.via((d) => d.setWifi(req.params.index, !!(req.body || {}).enabled)); res.json(await this.via((d) => d.wifi())); });
    r.post('/router/devices/:mac/wake', async (req, res) => { await this.via((d) => d.wake(req.params.mac)); res.json({ ok: true }); });
    r.put('/router/devices/:mac', async (req, res) => { await this.via((d) => d.rename(req.params.mac, String((req.body || {}).name || '').slice(0, 60))); res.json({ ok: true }); });
    r.post('/router/reboot', async (req, res) => { await this.via((d) => d.reboot()); res.json({ ok: true }); });
    r.post('/router/reconnect', async (req, res) => { await this.via((d) => d.reconnect()); this.cache = null; res.json({ ok: true }); });
    r.put('/router/settings', async (req, res) => {
      const b = req.body || {};
      if (b.auto !== undefined) this.cfg.auto = !!b.auto;
      this.ctx.settings.save();
      if (this.cfg.auto) this.autoTick().catch(() => {});
      res.json(await this.status());
    });
  }
}

module.exports = { RouterService, PREFIX, VENDOR_HINTS, KINDS, wifiQrText };
