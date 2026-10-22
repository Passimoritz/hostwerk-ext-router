import { useEffect, useState } from 'react';
import { CheckCircle2, RefreshCw, Copy, ExternalLink, Wand2, Plus, Globe2, ListChecks, Trash2, Router as RouterIcon, Radar, Network } from 'lucide-react';
import { get, post, put, useApi, openExternal } from '@hostwerk/api';
import { Btn, Callout, Field, InfoTip, Loading, Modal, Seg, Switch, toast, confirmDialog, TileEmpty } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import RouterAccess from './Access';
import RouterV6 from './V6';
import { RouterOverview, RouterTile } from './Overview';
import './style.css';

/*
 * Router & port forwarding: the router tab in "Go live" (slot "live.tabs", group "Make reachable", same address
 * #/live/router as before), a tile on the dashboard, and the "for friends on the internet" button on every Minecraft server
 * (slot "mc.connect"). Since 1.3 there is no own sidebar entry – the page itself stays reachable from Extensions → Open.
 */
const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Copied'));

/** Where a forwarding comes from: Hostwerk, an extension (by name), added by hand or another device/program. */
export function Origin({ o }) {
  if (!o) return null;
  if (o.kind === 'extension') return <span className="badge accent" title={t('Set up by the extension “{name}”', { name: o.name })}>{o.name}</span>;
  if (o.kind === 'manual') return <span className="badge">{t('by hand')}</span>;
  if (o.kind === 'other') return <span className="badge">{t('other device or program')}</span>;
  return <span className="badge accent">Hostwerk</span>;
}

/** „Von außen erreichbar?“ – fragt eine öffentliche Port-Prüfung (nur TCP), erst auf Klick. */
function ReachCheck({ port, protocol }) {
  const [st, setSt] = useState(null);
  if (protocol !== 'TCP') return <span className="tiny muted" title={t('Only TCP ports can be checked from outside.')}>UDP</span>;
  if (st === 'busy') return <span className="tiny muted">{t('Checking …')}</span>;
  if (st && st.error) return <button type="button" className="link-btn small c-err" onClick={() => setSt(null)}>{t('Check failed')}</button>;
  if (st) return <span className={`badge ${st.reachable ? 'ok' : 'err'}`} title={st.ip ? t('Checked at {ip}', { ip: st.ip }) : ''}>{st.reachable ? t('reachable from outside') : t('not reachable from outside')}</span>;
  return <button type="button" className="btn ghost xs" title={t('Asks a public port check (ifconfig.co) to connect to port {port} of your public address.', { port })} onClick={async () => { setSt('busy'); try { setSt(await get(`/router/reach/${port}`)); } catch (e) { setSt({ error: e.message }); } }}><Radar size={12} /> {t('Reachable?')}</button>;
}

export function RouterTab() {
  const r = useApi('/router');
  const [busy, setBusy] = useState(null);
  const [add, setAdd] = useState(null);
  const [details, setDetails] = useState(false);
  const [list, setList] = useState('ours');
  if (!r.data) return <Loading text="Looking for the router …" />;
  const d = r.data;
  // Forwarding works through UPnP/NAT-PMP or – after signing in – directly through the router access
  const logged = !!(d.access && d.access.loggedIn);
  const showAll = d.kind === 'upnp' || d.mappingsVia === 'login';
  const ready = !!d.kind || logged;
  const act = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { toast.error(e); } setBusy(null); };
  const sync = () => act('sync', async () => {
    const x = await post('/router/sync');
    r.setData(x.status);
    const v6 = x.result.v6 && x.result.v6.opened.length ? ` · ${t('IPv6 open: {ports}', { ports: x.result.v6.opened.join(', ') })}` : '';
    if (x.result.failed.length) toast.error(x.result.failed.map((f) => f.error).join('\n'));
    else toast.success((x.result.added.length ? t('Forwarded: port {ports}', { ports: x.result.added.join(', ') }) : t('All forwardings are up to date.')) + v6);
  });
  const unfwd = (m) => act(`rm-${m.protocol}-${m.externalPort}`, async () => { if (await confirmDialog({ title: t('Remove the forwarding for port {port}?', { port: m.externalPort }), text: m.description || '', confirm: 'Remove', danger: true })) r.setData(await post('/router/unforward', { port: m.externalPort, protocol: m.protocol })); });
  const ways = [
    { id: 'upnp', label: 'UPnP', on: d.kind === 'upnp', text: d.kind === 'upnp' ? 'The router accepts forwardings automatically' : 'Usually switched on in the router under home network/forwardings' },
    { id: 'natpmp', label: 'NAT-PMP', on: d.kind === 'natpmp', text: d.kind === 'natpmp' ? 'active' : 'Apple/MikroTik routers' },
    { id: 'login', label: logged ? t('Router login ({model})', { model: (d.access && d.access.model) || d.access.kind }) : t('Router login'), on: logged, text: logged ? 'Forwardings directly through the router access' : 'FRITZ!Box (TR-064) and OpenWrt – sign in below' },
    { id: 'manual', label: 'By hand', on: !ready, text: ready ? 'not needed' : 'Enter the ports in the router interface' },
  ];
  // Aufbau ohne Scrollen: Anmelden ganz oben (Statuszeile), Überblick als Kennzahlen, eine Karte „Automatisch freigeben“
  // (mit den Wegen als Chips), Ports und Router-Freigaben in einer Karte mit Umschalter; Anschluss-Details im Dialog
  return (
    <div className="stack router-page">
      {!logged && <RouterAccess onChange={() => r.reload()} />}
      {d.direct && !d.kind && <InfoTip title="No router needed" icon={CheckCircle2}>{t('This computer has a public address directly ({ip}) – typical for rented servers in a data centre. Ports only have to be open in the firewall (tab “Security”).', { ip: d.localIp })}</InfoTip>}
      <RouterOverview d={d} setData={r.setData} />
      {d.problems.map((p) => <Callout key={p} kind="warn">{p}</Callout>)}
      <div className="card">
        <div className="card-head"><Wand2 size={16} /><h3>Forward automatically</h3>
          {d.kind ? <span className="badge ok">{d.kind === 'upnp' ? 'UPnP' : 'NAT-PMP'}</span> : logged ? <span className="badge ok">{t('Router login')}</span> : d.gateway ? <span className="badge warn">No automatic forwardings</span> : null}
          <InfoTip pop title="Forward automatically">Hostwerk forwards the ports of your public services (websites with a domain, Minecraft, mail server, remote access) in the router and keeps them up to date – also after new servers or changed ports.</InfoTip>
          <div className="right row-tight">
            <Btn className="ghost sm" icon={Network} onClick={() => setDetails(true)}>Connection details …</Btn>
            <button type="button" className="btn ghost sm icon" title="Search again" aria-label="Search again" onClick={() => act('refresh', async () => r.setData(await get('/router?refresh=1')))}><RefreshCw /></button>
          </div>
        </div>
        <div className="card-body">
          <div className="row-tight router-wrap">
            <Switch checked={d.auto} disabled={!ready} label="Manage forwardings automatically" onChange={(v) => act('auto', async () => r.setData(await put('/router/settings', { auto: v })))} />
            <span className="small">Manage forwardings automatically</span>
            <InfoTip pop title="Manage forwardings automatically">Checks every 30 minutes and after the start; cleans up Hostwerk forwardings that are no longer needed.</InfoTip>
            <span className="router-sep" aria-hidden="true" />
            <Btn className="primary sm" icon={Wand2} busy={busy === 'sync'} disabled={!ready} onClick={sync}>Sync now</Btn>
            <Btn className="sm" icon={Plus} disabled={!ready} onClick={() => setAdd({ port: '', protocol: 'TCP', label: '' })}>Own forwarding</Btn>
            {d.router && d.router.web && <Btn className="ghost sm" icon={ExternalLink} onClick={() => openExternal(d.router.web)}>Open the router interface</Btn>}
            <span className="grow" />
            <span className="row-tight router-wrap" role="list" aria-label={t('Ways to forward')}>
              {ways.map((w) => <span key={w.id} role="listitem" className={`chip router-way ${w.on ? 'on' : ''}`} title={`${w.label}: ${t(w.text)}`}>{w.on ? <CheckCircle2 size={12} aria-hidden="true" /> : null}{w.label}<span className="sr-only"> – {w.on ? t('active') : t('off')}</span></span>)}
            </span>
            {d.hint && !logged && <InfoTip pop title={t('Tip for {vendor}', { vendor: d.hint.vendor })}>{d.hint.text}{d.hint.web && <> <button type="button" className="link-btn" onClick={() => openExternal(d.hint.web)}>{t('Open router')}</button></>}</InfoTip>}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">{list === 'router' ? <ListChecks size={16} /> : <Globe2 size={16} />}<h3>{list === 'router' ? t('All forwardings in the router') : t("Hostwerk's ports")}</h3><span className="badge">{list === 'router' ? d.mappings.length : d.wanted.length}</span>
          {showAll && <div className="right"><Seg value={list} onChange={setList} options={[{ id: 'ours', label: "Hostwerk's ports" }, { id: 'router', label: 'All in the router' }]} /></div>}
        </div>
        {list !== 'router' ? (d.wanted.length === 0 ? <TileEmpty text="Nothing public yet – as soon as websites with a domain, Minecraft servers or remote access run, their ports show up here." /> : d.wanted.map((w) => (
          <div key={w.protocol + w.port} className="list-item">
            <span className="mono small router-port">{w.port}/{w.protocol}</span>
            <div className="grow small row-tight router-wrap">{w.label}<Origin o={w.origin} /></div>
            {w.state === 'ok' ? <span className="badge ok">forwarded</span> : w.state === 'other' ? <span className="badge warn">{t('given to {ip}', { ip: w.other })}</span> : <span className="badge">not forwarded</span>}
            {w.state === 'missing' && ready && <Btn className="xs" busy={busy === `f-${w.port}`} onClick={() => act(`f-${w.port}`, async () => r.setData(await post('/router/forward', { port: w.port, protocol: w.protocol, label: w.label })))}>Forward</Btn>}
            {w.state === 'ok' && <ReachCheck port={w.port} protocol={w.protocol} />}
          </div>
        ))) : d.mappings.length === 0 ? <TileEmpty text="No forwardings set up." /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Port</th><th>to</th><th>Description</th><th>Set up by</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {d.mappings.map((m) => (
              <tr key={m.protocol + m.externalPort}>
                <td className="mono small">{m.externalPort}/{m.protocol}{m.internalPort !== m.externalPort ? ` → ${m.internalPort}` : ''}</td>
                <td className="mono small">{m.internalClient}{m.here && <span className="badge router-gap">this PC</span>}</td>
                <td className="small">{m.description}</td>
                <td className="small"><Origin o={m.origin} />{m.origin && m.origin.stale ? <span className="tiny muted"> · {t('no longer needed')}</span> : null}</td>
                <td className="actions">{(m.ours || m.here) && <Btn className="ghost xs icon" icon={Trash2} title="Remove" aria-label="Remove" busy={busy === `rm-${m.protocol}-${m.externalPort}`} onClick={() => unfwd(m)} />}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </div>
      {logged && <RouterAccess onChange={() => r.reload()} />}
      {details && (
        <Modal size="wide" title="Connection details" onClose={() => setDetails(false)} footer={<Btn onClick={() => setDetails(false)}>Close</Btn>}>
          <div className="stack">
            <dl className="kv">
              {d.router && d.router.manufacturer && <><dt>Manufacturer</dt><dd>{d.router.manufacturer}</dd></>}
              <dt>Router</dt><dd>{d.router ? d.router.model || d.router.name : '–'}</dd>
              <dt>Router address</dt><dd className="mono">{d.gateway || '–'}</dd>
              <dt>This computer</dt><dd className="mono">{d.localIp || '–'}{d.iface && <span className="tiny muted"> · {d.iface}</span>}</dd>
              <dt>Public address</dt><dd className="mono row-tight">{d.externalIp || '–'}{d.externalIp && <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(d.externalIp)}><Copy /></button>}</dd>
              {d.connection && <><dt>Internet</dt><dd>{d.connection === 'Connected' ? t('connected') : d.connection}</dd></>}
            </dl>
            {d.ipv6 && <RouterV6 d={d} setData={r.setData} />}
          </div>
        </Modal>
      )}
      {add && (
        <Modal title="Own forwarding" onClose={() => setAdd(null)} footer={<><Btn onClick={() => setAdd(null)}>Cancel</Btn><Btn className="primary" busy={busy === 'add'} disabled={!(Number(add.port) > 0)} onClick={() => act('add', async () => { r.setData(await post('/router/forward', { ...add, port: Number(add.port), remember: true })); setAdd(null); toast.success('Forwarded'); })}>Forward</Btn></>}>
          <div className="form-grid">
            <Field label="Port"><input className="input mono" type="number" value={add.port} onChange={(e) => setAdd({ ...add, port: e.target.value })} /></Field>
            <Field label="Protocol"><Seg value={add.protocol} onChange={(v) => setAdd({ ...add, protocol: v })} options={[{ id: 'TCP', label: 'TCP' }, { id: 'UDP', label: 'UDP' }]} /></Field>
            <Field label="Label" className="span-2"><input className="input" placeholder="e.g. game server" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></Field>
          </div>
          <div className="tiny muted router-note">{t('The forwarding points to this PC ({ip}) and is kept by the automatic sync.', { ip: d.localIp })}</div>
        </Modal>
      )}
    </div>
  );
}

/** Minecraft server: "for friends on the internet" – forward the server port with one click. */
export function FriendsShare({ s }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = () => get('/router').then(setSt).catch(() => setSt({ error: true }));
  useEffect(() => { check(); }, [s.port]); // eslint-disable-line react-hooks/exhaustive-deps -- asks the router (slow); again only when the port changes
  if (!st || st.error || (!st.kind && !st.direct && !(st.access && st.access.loggedIn))) return st && !st.error && st.gateway ? <div className="tiny muted">{t('For friends over the internet: forward port {port} in the router to this PC', { port: s.port })} (<a href="#/live/router">{t('Router')}</a>).</div> : null;
  const w = st.mappings.find((m) => m.externalPort === s.port && m.protocol === 'TCP');
  const addr = st.externalIp ? `${st.externalIp}${s.port === 25565 ? '' : `:${s.port}`}` : null;
  if (st.direct && !st.kind) return addr ? <div className="row-tight"><code className="grow ellipsis">{addr}</code><span className="tiny muted">for friends</span></div> : null;
  if (w && w.here) return <div className="row-tight"><code className="grow ellipsis">{addr}</code><span className="badge ok">Forwarded for friends</span><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(addr)}><Copy /></button></div>;
  return (
    <Btn className="sm" icon={Globe2} busy={busy} onClick={async () => {
      setBusy(true);
      try { await post('/router/forward', { port: s.port, label: `Minecraft: ${s.name}` }); toast.success(t('Forwarded – friends connect to {addr}', { addr })); await check(); } catch (e) { toast.error(e); }
      setBusy(false);
    }}>Forward for friends on the internet</Btn>
  );
}

function RouterPage() {
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><RouterIcon /> Router & port forwarding</h1>
          <p>Reach your servers from the internet: forwardings, IPv6, DynDNS and – after signing in – devices and Wi-Fi of your router.</p>
        </div>
        <div className="actions"><a className="btn sm ghost" href="#/live/router">Open in Go live</a></div>
      </div>
      <RouterTab />
    </div>
  );
}

export default {
  pages: { main: RouterPage },
  slots: {
    'live.tabs': [{ id: 'router', title: 'Router', icon: RouterIcon, Component: RouterTab, order: 30, group: 'erreichbar', after: 'teilen' }],
    'dashboard.tiles': [{ id: 'state', title: 'Router', icon: RouterIcon, size: 'third', Component: RouterTile }],
    'mc.connect': [{ id: 'friends', title: 'For friends', Component: FriendsShare, order: 40 }],
  },
};
