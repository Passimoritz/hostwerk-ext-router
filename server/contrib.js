'use strict';
/*
 * Beiträge zu Hostwerks Bereichen (SDK 3.5, host.contribute): Selbstwartung (Freigaben erneuern, DynDNS), Notfall-Modus
 * (Hostwerks Freigaben schließen und wieder öffnen) und Änderungsprotokoll. Bis Hostwerk 3.1 im Kern.
 */
function contribute(host, svc) {
  const wanted = () => { try { return svc.wanted(); } catch { return []; } };
  host.contribute('keeper', {
    checks: [{ label: 'Router/DynDNS', run: () => svc.autoTick() }],
    areas: [{
      id: 'router', label: 'Router-Freigaben & DynDNS', url: '#/live/router', every: 'laufend', keys: ['router'],
      auto: () => (svc.cfg && (svc.cfg.auto || svc.cfg.dyndns) ? true : 'teils'),
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
  host.contribute('audit', {
    routes: [[/^\/router\/(forward|map|open|ports?)/, (m, c, req) => ({ kind: 'Router', target: req.body && (req.body.port || req.body.name) ? `Port ${req.body.port || ''} ${req.body.name || ''}`.trim() : 'Freigabe', action: req.method === 'DELETE' ? 'Freigabe entfernt' : 'Port freigegeben' })]],
  });
}

module.exports = { contribute };
