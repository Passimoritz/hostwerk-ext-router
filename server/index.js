'use strict';
/*
 * Native part of "Router & port forwarding" (SDK 2.7). Provides "router" to Hostwerk and other extensions
 * (Bedrock bridge, game servers, AI helper, emergency mode use it when it is there). Same API as when it was built in:
 * /api/router, /api/router/forward, /api/router/sync, /api/router/login, /api/router/devices … (see service.js).
 * Other packages add their forwardings with an owner through router.forwards (add/remove/list/owned) – since 1.2.
 */
const { RouterService } = require('./service');

let svc = null;

function activate(host) {
  svc = new RouterService(host, { timers: !process.env.HW_TEST });
  host.provide('router', svc);
  svc.routes(host.router);
  host.on('shutdown', () => svc && svc.stop());
}

function deactivate() { if (svc) svc.stop(); svc = null; }

module.exports = { activate, deactivate };
