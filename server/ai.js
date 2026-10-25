'use strict';
/*
 * KI-Werkzeuge für den Router (SDK 3.5, host.aiExtend): Status, Portfreigaben, Geräte, WLAN, Neustart. Bis Hostwerk 3.1
 * im Kern. Beschreibungen sind – wie Hostwerks eigene – Deutsch: die KI liest sie, der Nutzer sieht label/describe.
 */
function routerAi(router) {
  const ctx = { router };
  return {
    vocab: ['Router', 'FRITZ!Box', 'UPnP', 'Portfreigabe', 'DynDNS'],
    tools({ add, S, L, clip }) {
      add('router_status', 'live', 'Router dieses Rechners: Modell, öffentliche IP, ob automatische Freigaben (UPnP) gehen, welche Hostwerk-Ports freigegeben sind und alle Freigaben.', {}, [], async () => {
        const r = await ctx.router.status();
        return clip({ router: r.router, automatisch: r.kind, oeffentlicheIp: r.externalIp, dieserRechner: r.localIp, keinRouterNoetig: r.direct && !r.kind, probleme: r.problems, hostwerkPorts: r.wanted.map((w) => ({ port: w.port, dienst: w.label, zustand: w.state })), freigaben: r.mappings.map((m) => ({ port: m.externalPort, protokoll: m.protocol, an: m.internalClient, beschreibung: m.description })), tipp: r.hint && r.hint.text });
      }, { risk: 'read' });
      add('router_forward', 'live', 'Port im Router an diesen Rechner freigeben (UPnP). Ohne port: alle Ports der öffentlichen Hostwerk-Dienste abgleichen.', { port: { type: 'number', description: 'Port (leer = alle Hostwerk-Dienste)' }, label: S('Bezeichnung (optional)') }, [], async ({ port, label }) => {
        if (!port) { const r = await ctx.router.sync(); return clip({ freigegeben: r.added, entfernt: r.removed, fehler: r.failed }); }
        await ctx.router.forward({ port: Number(port), label }); return L(`Port ${port} im Router freigegeben.`, `Port ${port} forwarded in the router.`);
      }, { risk: 'system', label: L('Port im Router freigeben', 'Forward port in router'), undo: true, effect: L('Der Port ist danach aus dem Internet erreichbar. Lässt sich unter Livebetrieb → Router wieder entfernen.', 'The port is then reachable from the internet. Can be removed again under Live → Router.'), describe: ({ port, label }) => (port ? L(`Router: Port ${port} an diesen PC freigeben${label ? ` („${label}“)` : ''}`, `Router: forward port ${port} to this PC`) : L('Router: Ports aller öffentlichen Hostwerk-Dienste freigeben', 'Router: forward ports of all public Hostwerk services')) });
      // Mit Router-Zugang (Anmeldung unter Livebetrieb → Router): Geräte, WLAN, Neustart
      const noLogin = L('Kein Router-Zugang eingerichtet – unter Livebetrieb → Router → „Router-Zugang“ mit dem Router-Benutzer anmelden.', 'No router access – log in under Live → Router → “Router access”.');
      add('router_devices', 'live', 'Geräte im Heimnetz laut Router (Name, IP, MAC, online, WLAN/LAN). Braucht den Router-Zugang.', { online: { type: 'boolean', description: 'nur gerade verbundene' } }, [], async ({ online }) => {
        if (!ctx.router.driver()) return noLogin;
        const list = await ctx.router.via((d) => d.hosts());
        return clip(list.filter((x) => !online || x.active).map((x) => ({ name: x.name, ip: x.ip, mac: x.mac, online: x.active, verbindung: x.iface })));
      }, { risk: 'read' });
      add('router_wifi', 'live', 'WLAN-Netze des Routers (Name, an/aus, Gast-WLAN, verbundene Geräte, index). Braucht den Router-Zugang.', {}, [], async () => {
        if (!ctx.router.driver()) return noLogin;
        return clip(await ctx.router.via((d) => d.wifi()));
      }, { risk: 'read' });
      add('router_wifi_set', 'live', 'Ein WLAN des Routers ein- oder ausschalten (index aus router_wifi, z. B. das Gast-WLAN). Braucht den Router-Zugang.', { index: S('index aus router_wifi'), enabled: { type: 'boolean', description: 'true = ein, false = aus' } }, ['index', 'enabled'], async ({ index, enabled }) => {
        if (!ctx.router.driver()) return noLogin;
        await ctx.router.via((d) => d.setWifi(index, !!enabled));
        return L(`WLAN ${index} ${enabled ? 'eingeschaltet' : 'ausgeschaltet'} ✓`, `Wi-Fi ${index} ${enabled ? 'on' : 'off'} ✓`);
      }, { risk: 'system', label: L('WLAN schalten', 'Switch Wi-Fi'), undo: true, effect: L('Ändert das WLAN im Router – Geräte in diesem WLAN verlieren beim Ausschalten die Verbindung.', 'Changes the Wi-Fi in the router – devices in this Wi-Fi lose the connection when it is turned off.'), describe: ({ index, enabled }) => L(`Router: WLAN ${index} ${enabled ? 'einschalten' : 'ausschalten'}`, `Router: turn Wi-Fi ${index} ${enabled ? 'on' : 'off'}`) });
      add('router_power', 'live', 'Router neu starten (action reboot – Internet 2–4 Min. weg) oder neu verbinden für eine neue öffentliche IP (action reconnect). Braucht den Router-Zugang.', { action: { type: 'string', enum: ['reboot', 'reconnect'] } }, ['action'], async ({ action }) => {
        if (!ctx.router.driver()) return noLogin;
        await ctx.router.via((d) => (action === 'reboot' ? d.reboot() : d.reconnect()));
        return action === 'reboot' ? L('Router startet neu – Internet ist gleich für einige Minuten weg.', 'Router is restarting.') : L('Verbindung wird neu aufgebaut.', 'Reconnecting.');
      }, { risk: 'system', label: L('Router neu starten', 'Restart router'), undo: false, effect: L('Internet und WLAN sind für alle im Haus kurz weg; laufende Downloads, Anrufe und Spiele brechen ab.', 'Internet and Wi-Fi are briefly gone for everyone in the house; running downloads, calls and games are interrupted.'), describe: ({ action }) => (action === 'reboot' ? L('Router neu starten – Internet und WLAN sind 2–4 Minuten weg (für alle im Haus).', 'Restart the router – internet and Wi-Fi are gone for 2–4 minutes.') : L('Internet neu verbinden (meist neue öffentliche IP, kurz offline).', 'Reconnect the internet (usually new public IP).')) });
    },
  };
}

module.exports = { routerAi };
