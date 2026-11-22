'use strict';
/*
 * Beiträge zu Hostwerks Bereichen (SDK 3.5, host.contribute): Selbstwartung (Freigaben erneuern, DynDNS), Notfall-Modus
 * (Hostwerks Freigaben schließen und wieder öffnen) und Änderungsprotokoll. Bis Hostwerk 3.1 im Kern.
 * SDK 3.11: Punkte auf der Lage im Livebetrieb (live.overview) – offene oder fehlgeschlagene Portfreigaben.
 */
const HREF = '#/live/online/router';

/**
 * Punkte für Livebetrieb → Lage aus dem eigenen Stand (letzte Abfrage/letzter Abgleich, keine Netzabfrage):
 * fehlgeschlagene Freigaben = Fehler, noch offene = Warnung, alles freigegeben = ok. Ohne Router (Rechenzentrum),
 * ohne gewünschte Ports oder hinter Carrier-NAT/DS-Lite (Freigaben helfen dort nicht) gibt es keinen Punkt.
 */
function overviewPoints(svc) {
  const t = svc.t;
  const st = svc.lastState;
  if (!st || st.noRouter || !st.total) return [];
  // Fehlgeschlagen = beim letzten Abgleich gescheitert und laut letzter Abfrage noch immer nicht freigegeben
  const failed = ((svc.lastSync && svc.lastSync.failed) || []).filter((f) => st.open.includes(f.port));
  if (failed.length) return [{ area: 'online', level: 'err', title: t('Router forwardings'), detail: t('{n} failed: {error}', { n: failed.length, error: failed[0].error }), href: HREF }];
  if (st.stuck) return [];
  if (st.open.length) return [{ area: 'online', level: 'warn', title: t('Router forwardings'), detail: t('Not forwarded yet: port {ports}', { ports: st.open.slice(0, 5).join(', ') }), href: HREF }];
  return [{ area: 'online', level: 'ok', title: t('Router forwardings'), detail: t('{n} of {n} forwarded', { n: st.total }), href: HREF }];
}
function contribute(host, svc) {
  const wanted = () => { try { return svc.wanted(); } catch { return []; } };
  host.contribute('keeper', {
    checks: [{ label: 'Router/DynDNS', run: () => svc.autoTick() }],
    areas: [{
      id: 'router', label: 'Router-Freigaben & DynDNS', url: '#/live/online/router', every: 'laufend', keys: ['router'],
      // dyndns ist nach der ersten Abfrage immer ein (leeres) Objekt – zählt nur mit Anbieter
      auto: () => (svc.cfg && (svc.cfg.auto || (svc.cfg.dyndns && svc.cfg.dyndns.provider)) ? true : 'teils'),
      text: 'Freigaben werden erneuert, DynDNS aktualisiert – sofern eingerichtet.',
      detail: ['Portfreigaben am Router werden regelmäßig erneuert, DynDNS bekommt neue IP-Adressen.', 'Einmal im Livebetrieb einrichten.'],
    }],
  });
  host.contribute('emergency', {
    preview(en) {
      if (!svc.cfg) return [];
      const out = wanted().map((w) => ({ kind: 'router', label: en ? 'Router forwarding' : 'Router-Freigabe', detail: `${w.port}/${w.protocol || 'TCP'}${w.label ? ` · ${w.label}` : ''}` }));
      if (svc.cfg.auto) out.push({ kind: 'router-auto', label: en ? 'Automatic router sync pauses' : 'Automatischer Router-Abgleich pausiert', detail: '' });
      return out;
    },
    // Automatik pausieren und Hostwerks Freigaben entfernen – der Stand kommt beim Wiederherstellen zurück
    async close({ en, step }) {
      if (!svc.cfg) return undefined;
      const ports = wanted();
      const saved = { auto: !!svc.cfg.auto, ports };
      svc.cfg.auto = false;
      if (ports.length) await step(en ? `${ports.length} router forwarding(s)` : `${ports.length} Router-Freigabe(n)`, async () => { for (const w of ports) await svc.unforward({ port: w.port, protocol: w.protocol }).catch(() => {}); });
      return saved;
    },
    // Stand vor Hostwerk 3.2 stand direkt in before (routerAuto, routerPorts)
    async reopen(saved, { en, step, before = {} }) {
      if (!svc.cfg) return;
      const s = saved || { auto: !!before.routerAuto, ports: before.routerPorts || [] };
      svc.cfg.auto = !!s.auto;
      if ((s.ports || []).length) await step(en ? 'Router forwardings' : 'Router-Freigaben', async () => { for (const w of s.ports) await svc.forward({ port: w.port, protocol: w.protocol, label: w.label }); });
    },
  });
  // Neu in SDK 3.11 – ältere Hostwerk-Versionen kennen die Art nicht und werfen
  try { host.contribute('live.overview', { list: () => overviewPoints(svc) }); } catch { /* older Hostwerk */ }
  host.contribute('audit', {
    // Entfernen läuft über POST /router/unforward (früher fehlte es im Protokoll)
    routes: [[/^\/router\/(unforward|forward|map|open|ports?)/, (m, c, req) => ({ kind: 'Router', target: req.body && (req.body.port || req.body.name) ? `Port ${req.body.port || ''} ${req.body.name || ''}`.trim() : 'Freigabe', action: req.method === 'DELETE' || m[1] === 'unforward' ? 'Freigabe entfernt' : 'Port freigegeben' })]],
  });
}

module.exports = { contribute, overviewPoints };
