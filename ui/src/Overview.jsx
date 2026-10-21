import { useState } from 'react';
import { Router as RouterIcon, ListChecks, Radar, Globe2, Copy, Share2, Shield, AlertTriangle } from 'lucide-react';
import { post, useApi } from '@hostwerk/api';
import { Btn, Callout, InfoTip, Loading, toast } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';

/*
 * Überblick oben im Router-Reiter und als Kachel auf der Übersicht: Router erkannt (mit UPnP-Zustand), Freigaben,
 * von außen erreichbar (gesammelte Prüfung), öffentliche IPv4/IPv6 – plus Konflikte und eine ehrliche Erklärung bei
 * Carrier-NAT/DS-Lite (dann helfen Freigaben nicht, Tunnel oder VPN-Dienste schon).
 */
const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Copied'));
const UPNP = { on: 'UPnP on', limited: 'UPnP only partly allowed', natpmp: 'NAT-PMP on', off: 'UPnP off', none: 'no router found' };

/** Ergebnis „von außen erreichbar?“ als kurzer Text */
export function outsideText(o) {
  if (!o) return t('not checked yet');
  if (o.reachable === true) return t('yes');
  if (o.reachable === false) { const bad = o.results.filter((r) => r.reachable === false).length; return pl(bad, '{n} port not reachable', '{n} ports not reachable'); }
  return t('cannot be checked (UDP only)');
}

export function RouterOverview({ d, setData }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ok = d.wanted.filter((w) => w.state === 'ok').length;
  const check = async () => {
    setBusy(true);
    try { const o = await post('/router/reach-all'); setData({ ...d, outside: o }); setOpen(true); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const v6 = d.ipv6 && (d.ipv6.address || d.ipv6.outgoing);
  const o = d.outside;
  const stuck = d.reachability === 'cgnat' || d.reachability === 'double';
  return (
    <div className="stack">
      <div className="router-overview" role="group" aria-label={t('Router at a glance')}>
        <div className="router-ov-tile">
          <span className="tiny muted row-tight"><RouterIcon size={14} aria-hidden="true" />Router</span>
          <b className="ellipsis">{d.router ? d.router.model || d.router.name : t('not found')}</b>
          <span className={`tiny ${d.upnp && (d.upnp.state === 'off' || d.upnp.state === 'limited') ? 'c-warn' : 'muted'}`}>{d.access && d.access.loggedIn ? t('signed in · {u}', { u: t(UPNP[d.upnp ? d.upnp.state : 'none']) }) : t(UPNP[d.upnp ? d.upnp.state : 'none'])}</span>
        </div>
        <div className="router-ov-tile">
          <span className="tiny muted row-tight"><ListChecks size={14} aria-hidden="true" />Forwardings</span>
          <b>{t('{ok} of {all}', { ok, all: d.wanted.length })}</b>
          <span className={`tiny ${d.conflicts && d.conflicts.length ? 'c-warn' : 'muted'}`}>{d.conflicts && d.conflicts.length ? pl(d.conflicts.length, '{n} conflict', '{n} conflicts') : t('no conflicts')}</span>
        </div>
        <div className="router-ov-tile">
          <span className="tiny muted row-tight"><Radar size={14} aria-hidden="true" />Reachable from outside</span>
          <b className={o && o.reachable === false ? 'c-err' : o && o.reachable ? 'c-ok' : ''}>{outsideText(o)}</b>
          <span className="row-tight tiny muted">{o ? new Date(o.at).toLocaleString() : ''}<Btn className="xs ghost" busy={busy} disabled={!ok} title={ok ? 'A public port check (ifconfig.co) tries every forwarded TCP port – only the port numbers go out.' : 'Nothing forwarded yet'} onClick={check}>Check now</Btn></span>
        </div>
        <div className="router-ov-tile">
          <span className="tiny muted row-tight"><Globe2 size={14} aria-hidden="true" />Public address</span>
          <span className="row-tight router-min"><code className="ellipsis">{d.externalIp || (d.net && d.net.v4public) || t('no IPv4')}</code>{(d.externalIp || (d.net && d.net.v4public)) && <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy IPv4" onClick={() => copy(d.externalIp || d.net.v4public)}><Copy /></button>}</span>
          <span className="row-tight router-min"><code className="ellipsis tiny">{v6 || t('no IPv6')}</code>{v6 && <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy IPv6" onClick={() => copy(v6)}><Copy /></button>}</span>
        </div>
      </div>
      {open && o && o.results.length > 0 && (
        <div className="card">
          <div className="card-head"><Radar size={16} /><h3>Checked from outside</h3>{o.ip && <span className="tiny muted mono">{o.ip}</span>}<div className="right"><button type="button" className="btn ghost xs" onClick={() => setOpen(false)}>Close</button></div></div>
          {o.results.map((r) => (
            <div key={r.protocol + r.port} className="list-item">
              <span className="mono small router-port">{r.port}/{r.protocol}</span>
              <span className="grow small ellipsis">{r.label}</span>
              {r.reachable === true ? <span className="badge ok">reachable</span> : r.reachable === false ? <span className="badge err">not reachable</span> : <span className="badge" title={r.error || t('Only TCP ports can be checked from outside.')}>{r.error ? t('check failed') : t('not checkable')}</span>}
            </div>
          ))}
          {o.reachable === false && <div className="card-body tiny muted">Forwarded but not reachable: is the service running? Does the firewall of this PC let it through (Go live → Firewall)? Some providers block single ports.</div>}
        </div>
      )}
      {d.conflicts && d.conflicts.length > 0 && (
        <Callout kind="warn" icon={AlertTriangle} title={pl(d.conflicts.length, '{n} conflict with forwardings', '{n} conflicts with forwardings')} dismissible={false}>
          <ul className="router-list">{d.conflicts.map((c) => <li key={c.kind + c.port + c.protocol}>{c.text}</li>)}</ul>
        </Callout>
      )}
      {stuck && (
        <Callout kind="info" title={d.reachability === 'cgnat' ? 'Forwardings do not help with this connection' : 'There is another router in front'} dismissible={false}>
          {d.reachability === 'cgnat' ? 'Your provider shares one public IPv4 among many customers – nobody can reach this PC from outside over IPv4, whatever is forwarded here. What works:' : 'Forwardings have to be set up on the front device too (often the provider’s modem). Or skip them:'}
          <div className="row-tight router-wrap router-note">
            <a className="btn sm" href="#/live/teilen"><Share2 size={14} />Share a page (tunnel)</a>
            <a className="btn sm" href="#/ext?detail=vpn"><Shield size={14} />VPN without forwarding (Tailscale & co.)</a>
            <InfoTip pop title="Why?">A tunnel or a service like Tailscale opens the connection from the inside – that works behind every connection. Asking the provider for a public IPv4 (often free, sometimes called “dual stack”) also solves it.</InfoTip>
          </div>
        </Callout>
      )}
    </div>
  );
}

/** Übersichtskachel: Router, Freigaben, von außen erreichbar, öffentliche IP. */
export function RouterTile() {
  const r = useApi('/router', [], { live: false, poll: false });
  if (!r.data) return r.error ? <div className="card-body small muted">{r.error}</div> : <div className="card-body"><Loading /></div>;
  const d = r.data;
  const ok = d.wanted.filter((w) => w.state === 'ok').length;
  return (
    <a className="card-body stack router-tile" href="#/live/router">
      <span className="row-tight"><RouterIcon size={16} aria-hidden="true" /><b className="ellipsis">{d.router ? d.router.model || d.router.name : t('No router found')}</b></span>
      <span className="small">{t('Forwardings: {ok} of {all}', { ok, all: d.wanted.length })}{d.conflicts && d.conflicts.length ? <span className="c-warn"> · {pl(d.conflicts.length, '{n} conflict', '{n} conflicts')}</span> : null}</span>
      <span className="small">{t('From outside: {state}', { state: outsideText(d.outside) })}</span>
      <span className="small muted mono ellipsis">{d.externalIp || (d.net && d.net.v4public) || t('no IPv4')}{d.ipv6 && d.ipv6.address ? ` · ${d.ipv6.address}` : ''}</span>
      {(d.reachability === 'cgnat' || d.reachability === 'dslite') && <span className="small c-warn">{d.reachability === 'cgnat' ? t('Carrier NAT – forwardings do not help') : t('DS-Lite – reachable over IPv6 only')}</span>}
    </a>
  );
}
