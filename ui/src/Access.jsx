import { useEffect, useState } from 'react';
import { KeyRound, LogOut, MonitorSmartphone, Wifi, Power, RefreshCw, Gauge, Zap, Search, Pencil, Router as RouterIcon, ShieldCheck, QrCode, Eye, EyeOff, Printer } from 'lucide-react';
import { get, put, del, post, useApi } from '@hostwerk/api';
import { Btn, Callout, Empty, Field, InfoTip, Loading, Modal, Seg, Switch, toast, confirmDialog, promptDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * Router access: sign in with the router user and manage the essentials – devices in the network (with Wake-on-LAN),
 * Wi-Fi/guest Wi-Fi, the line, new IP, reboot. Forwardings then go directly through the access (even if the router
 * forbids UPnP forwardings for this PC). TR-064 (FRITZ!Box and others) and OpenWrt are found by themselves, MikroTik
 * (RouterOS 7) and UniFi are chosen by hand; other routers: UPnP + link to the router. Guest Wi-Fi with a QR code.
 */
const fmtUp = (s) => (s > 86400 ? t('{d} d {h} h', { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600) }) : s > 3600 ? t('{h} h {m} min', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) }) : t('{m} min', { m: Math.floor(s / 60) }));
const mbit = (b) => (b ? `${Math.round(b / 1e6)} Mbit/s` : '–');

function Login({ det, onDone }) {
  const kinds = det.kinds || [];
  const [kind, setKind] = useState(kinds[0] ? kinds[0].kind : null);
  const k = kinds.find((x) => x.kind === kind);
  const [user, setUser] = useState(() => ((k && k.users.find((u) => u.last)) || (k && k.users[0]) || {}).name || '');
  const [pass, setPass] = useState('');
  const [base, setBase] = useState(k ? k.base : '');
  const [insecure, setInsecure] = useState(true);
  const [busy, setBusy] = useState(false);
  const pick = (id) => { const x = kinds.find((y) => y.kind === id); setKind(id); setBase(x ? x.base : ''); setUser(((x && x.users.find((u) => u.last)) || (x && x.users[0]) || {}).name || ''); };
  if (!kinds.length) {
    return (
      <Callout kind="info" title="This router cannot be managed directly">
        {det.gateway ? t('Hostwerk can sign in to FRITZ!Box routers (and others with TR-064) and OpenWrt. Your router uses UPnP for forwardings – everything else is in the router interface at http://{gw}/.', { gw: det.gateway }) : t('Hostwerk can sign in to FRITZ!Box routers (and others with TR-064) and OpenWrt. Your router uses UPnP for forwardings.')}
        {' '}{t('FRITZ!Box: under Home Network → Network → Network Settings switch on "Allow access for applications", then search again here.')}
      </Callout>
    );
  }
  const go = async () => {
    setBusy(true);
    try { await put('/router/login', { kind, base: k.manual ? base : k.base, user, pass, insecure: k.manual ? insecure : false }); toast.success('Signed in – Hostwerk now manages your router'); onDone(); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  return (
    <div className="stack router-gap-3">
      <div className="small muted">Sign in with your router user. The password is stored encrypted and only used for requests to the router.</div>
      {kinds.length > 1 && <Seg value={kind} onChange={pick} options={kinds.map((x) => ({ id: x.kind, label: x.label }))} />}
      {k && k.manual && (
        <div className="form-grid">
          <Field label="Router address" hint={kind === 'mikrotik' ? 'RouterOS 7 with the www-ssl service (IP → Services). The user needs the policies “rest-api”, “read” and “write”.' : 'Address of the UniFi gateway (Dream Machine, Cloud Gateway …). A local UniFi user with the role “Site Admin” – not the Ubiquiti account with 2FA.'}><input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://192.168.1.1" /></Field>
          <label className="check small router-check"><input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />Router has its own certificate (usual at home)</label>
        </div>
      )}
      <div className="form-grid">
        <Field label="User (optional)" hint={kind === 'tr064' ? 'FRITZ!Box: the name from System → FRITZ!Box Users. Leave empty if your router only asks for a password – Hostwerk then takes the last used user.' : kind === 'mikrotik' ? 'Empty = “admin”.' : kind === 'unifi' ? 'Name of a local UniFi user.' : 'Empty = “root”.'}>
          {k && k.users.length > 1 ? <select className="select" value={user} onChange={(e) => setUser(e.target.value)}>{k.users.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}</select>
            : <input className="input" value={user} onChange={(e) => setUser(e.target.value)} />}
        </Field>
        <Field label="Password"><input className="input" type="password" value={pass} autoComplete="current-password" onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} /></Field>
      </div>
      <div className="row-tight"><Btn className="primary" icon={KeyRound} busy={busy} disabled={!pass} onClick={go}>Sign in</Btn><span className="tiny muted">{k.label} · {k.manual ? base : k.base}</span></div>
    </div>
  );
}

function Devices() {
  const d = useApi('/router/devices', [], { live: false, poll: true });
  const [q, setQ] = useState('');
  const [show, setShow] = useState('online');
  if (d.error) return <Callout kind="warn">{d.error}</Callout>;
  if (!d.data) return <Loading text="Loading devices …" />;
  const list = d.data.filter((x) => (show === 'all' || x.active) && (!q.trim() || `${x.name} ${x.ip} ${x.mac}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  const wake = async (x) => { try { await post(`/router/devices/${encodeURIComponent(x.mac)}/wake`); toast.success(t('Wake-up call sent to {name}', { name: x.name })); } catch (e) { toast.error(e); } };
  const rename = async (x) => { const n = await promptDialog({ title: 'Rename device', label: 'Name in the router', value: x.name, confirm: 'Rename' }); if (!n) return; try { await put(`/router/devices/${encodeURIComponent(x.mac)}`, { name: n }); d.reload(); } catch (e) { toast.error(e); } };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Seg value={show} onChange={setShow} options={[{ id: 'online', label: t('Online · {n}', { n: d.data.filter((x) => x.active).length }) }, { id: 'all', label: t('All · {n}', { n: d.data.length }) }]} />
        <div className="input-icon grow" style={{ minWidth: 160 }}><Search /><input className="input sm" placeholder="Name, IP or MAC …" aria-label="Search devices" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button type="button" className="btn ghost sm icon" title="Reload" aria-label="Reload" onClick={d.reload}><RefreshCw /></button>
      </div>
      {list.length === 0 ? <Empty icon={MonitorSmartphone} title="No devices" /> : (
        <table className="table"><thead><tr><th>Device</th><th>IP</th><th>Connection</th><th /></tr></thead><tbody>
          {list.map((x) => (
            <tr key={x.mac || x.ip} style={{ opacity: x.active ? 1 : 0.55 }}>
              <td className="small"><span className={`dot ${x.active ? 'ok' : ''}`} style={{ display: 'inline-block', marginRight: 8 }} /><b>{x.name || t('unknown')}</b>{x.guest && <span className="badge" style={{ marginLeft: 6 }}>Guest</span>}<div className="tiny muted mono">{x.mac}</div></td>
              <td className="mono small">{x.ip}</td>
              <td className="small">{x.iface ? (/802|wlan/i.test(x.iface) ? t('Wi-Fi') : x.iface === 'Ethernet' ? t('LAN cable') : x.iface) : '–'}{x.speed ? ` · ${x.speed} Mbit/s` : ''}</td>
              <td className="actions">
                {!x.active && x.mac && <Btn className="ghost xs" icon={Zap} onClick={() => wake(x)} title="Wake-on-LAN: wake the device up">Wake</Btn>}
                {x.mac && <button type="button" className="btn ghost xs icon" title="Rename" aria-label="Rename" onClick={() => rename(x)}><Pencil /></button>}
              </td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

/** QR code to join a Wi-Fi (for guests): name and password from the router if it gives them out – else by hand. */
function WifiQr({ net, onClose }) {
  const [f, setF] = useState({ ssid: net.ssid || '', password: '', security: 'WPA' });
  const [show, setShow] = useState(false);
  const [svg, setSvg] = useState(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => { get(`/router/wifi/${encodeURIComponent(net.index)}/key`).then((k) => setF((x) => ({ ...x, ...k, ssid: k.ssid || x.ssid }))).catch(() => {}).finally(() => setBusy(false)); }, [net.index]);
  const make = async () => { try { setSvg((await post('/router/wifi-qr', f)).svg); } catch (e) { toast.error(e); } };
  return (
    <Modal title={t('QR code for “{ssid}”', { ssid: net.ssid || t('(no name)') })} onClose={onClose} footer={<><Btn onClick={onClose}>Close</Btn>{svg && <Btn icon={Printer} onClick={() => { document.body.classList.add('router-printing'); window.print(); document.body.classList.remove('router-printing'); }}>Print</Btn>}<Btn className="primary" icon={QrCode} disabled={busy || !f.ssid} onClick={make}>Show QR code</Btn></>}>
      <div className="stack">
        {busy ? <Loading text="Reading the Wi-Fi details …" /> : (
          <div className="form-grid">
            <Field label="Wi-Fi name"><input className="input" value={f.ssid} onChange={(e) => setF({ ...f, ssid: e.target.value })} /></Field>
            <Field label="Password" hint="Comes from the router where it gives it out – otherwise enter it here. Stays on this PC.">
              <div className="row-tight"><input className="input grow" type={show ? 'text' : 'password'} autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value, security: e.target.value ? 'WPA' : 'nopass' })} /><button type="button" className="btn ghost sm icon" title={show ? t('Hide password') : t('Show password')} aria-label={show ? t('Hide password') : t('Show password')} onClick={() => setShow((x) => !x)}>{show ? <EyeOff /> : <Eye />}</button></div>
            </Field>
          </div>
        )}
        {svg && <div className="router-qr" role="img" aria-label={t('QR code to join the Wi-Fi “{ssid}”', { ssid: f.ssid })} dangerouslySetInnerHTML={{ __html: svg }} />}
        {svg && <div className="small muted router-qr-text">{t('Guests point the phone camera at the code and join “{ssid}” – without typing the password.', { ssid: f.ssid })}</div>}
      </div>
    </Modal>
  );
}

function WifiList() {
  const w = useApi('/router/wifi', [], { live: false, poll: true });
  const [busy, setBusy] = useState(null);
  const [qr, setQr] = useState(null);
  if (w.error) return <Callout kind="warn">{String(w.error.message || w.error)} <button type="button" className="link-btn" onClick={() => w.reload()}>{t('Try again')}</button></Callout>;
  if (w.data && !w.data.length) return <div className="small muted">{t('This router does not manage Wi-Fi through Hostwerk.')}</div>;
  if (!w.data) return <Loading text="Loading Wi-Fi …" />;
  const band = (b) => (/^24|2\.4|2g/i.test(String(b)) ? t('2.4 GHz') : /^5|5g/i.test(String(b)) ? '5 GHz' : /^6|6g/i.test(String(b)) ? '6 GHz' : b);
  const set = async (x, v) => {
    if (!v && !x.guest && !(await confirmDialog({ title: t('Switch off Wi-Fi “{ssid}”?', { ssid: x.ssid }), text: 'If you are connected over Wi-Fi yourself, the connection is gone afterwards.', confirm: 'Switch off', danger: true }))) return;
    setBusy(x.index);
    try { w.setData(await put(`/router/wifi/${x.index}`, { enabled: v })); toast.success(x.guest ? (v ? 'Guest Wi-Fi switched on' : 'Guest Wi-Fi switched off') : (v ? 'Wi-Fi switched on' : 'Wi-Fi switched off')); } catch (e) { toast.error(e); }
    setBusy(null);
  };
  return (
    <div className="router-wifi">
      {w.data.map((x) => (
        <div key={x.index} className={`router-wifi-item ${x.enabled ? 'on' : ''}`}>
          <Wifi size={18} />
          <div className="grow router-min">
            <div className="bold ellipsis">{x.ssid || t('(no name)')}{x.guest && <span className="badge accent router-gap">Guest</span>}</div>
            <div className="tiny muted">{[x.band && band(x.band), x.channel && t('channel {c}', { c: x.channel }), x.enabled ? t(x.clients === 1 ? '{n} device' : '{n} devices', { n: x.clients }) : t('off')].filter(Boolean).join(' · ')}</div>
          </div>
          {x.enabled && <button type="button" className="btn ghost sm icon" title={t('QR code to join “{ssid}”', { ssid: x.ssid })} aria-label={t('QR code to join “{ssid}”', { ssid: x.ssid })} onClick={() => setQr(x)}><QrCode /></button>}
          <Switch checked={x.enabled} disabled={busy === x.index} onChange={(v) => set(x, v)} />
        </div>
      ))}
      {qr && <WifiQr net={qr} onClose={() => setQr(null)} />}
    </div>
  );
}

export default function RouterAccess({ onChange }) {
  const det = useApi('/router/detect', [], { live: false });
  const [tab, setTab] = useState('devices');
  const [m, setM] = useState(null);
  const [signIn, setSignIn] = useState(false);
  const logged = det.data && det.data.access && det.data.access.loggedIn;
  useEffect(() => { if (logged) get('/router/manage').then(setM).catch((e) => setM({ error: e.message })); }, [logged]);
  if (!det.data) return <div className="card"><div className="card-body"><Loading text="Checking router access …" /></div></div>;
  const a = det.data.access;
  // Nicht angemeldet: eine Statuszeile ganz oben, die Anmeldung selbst im Dialog – so steht „Anmelden“ immer im Bild
  if (!logged) {
    const can = (det.data.kinds || []).length > 0;
    return (
      <div className="card router-bar">
        <KeyRound size={16} aria-hidden="true" />
        <b>Router access</b>
        <span className="badge">Not signed in</span>
        <span className="tiny muted grow ellipsis">{can ? t('Sign in to manage devices, Wi-Fi and forwardings directly.') : t('This router cannot be managed directly')}</span>
        {can ? <Btn className="primary sm" icon={KeyRound} onClick={() => setSignIn(true)}>Sign in …</Btn> : <InfoTip pop title="This router cannot be managed directly">{det.data.gateway ? t('Hostwerk can sign in to FRITZ!Box routers (and others with TR-064) and OpenWrt. Your router uses UPnP for forwardings – everything else is in the router interface at http://{gw}/.', { gw: det.data.gateway }) : t('Hostwerk can sign in to FRITZ!Box routers (and others with TR-064) and OpenWrt. Your router uses UPnP for forwardings.')}{' '}{t('FRITZ!Box: under Home Network → Network → Network Settings switch on "Allow access for applications", then search again here.')}</InfoTip>}
        {signIn && (
          <Modal title="Sign in to the router" onClose={() => setSignIn(false)}>
            <Login det={det.data} onDone={() => { setSignIn(false); det.reload(); if (onChange) onChange(); }} />
          </Modal>
        )}
      </div>
    );
  }
  const logout = async () => { if (!(await confirmDialog({ title: 'Sign out of the router?', text: 'Hostwerk forgets user and password. Forwardings then go through UPnP again.', confirm: 'Sign out' }))) return; await del('/router/login'); setM(null); det.reload(); if (onChange) onChange(); };
  const reboot = async () => { if (!(await confirmDialog({ title: 'Restart the router?', text: 'Internet and Wi-Fi are gone for 2–4 minutes – for everyone in the house.', confirm: 'Restart', danger: true }))) return; try { await post('/router/reboot'); toast('The router is restarting …'); } catch (e) { toast.error(e); } };
  const reconnect = async () => { if (!(await confirmDialog({ title: 'Reconnect?', text: 'The internet connection drops briefly – usually you get a new public IP afterwards.', confirm: 'Reconnect' }))) return; try { await post('/router/reconnect'); toast('Reconnecting …'); setTimeout(() => { get('/router/manage').then(setM).catch(() => {}); if (onChange) onChange(); }, 8000); } catch (e) { toast.error(e); } };
  return (
    <div className="card">
      <div className="card-head"><KeyRound size={16} /><h3>Router access</h3>
        {logged ? <span className="badge ok"><ShieldCheck size={11} /> {t('signed in as {user}', { user: a.user || '–' })}</span> : <span className="badge">Not signed in</span>}
        {logged && <div className="right row-tight"><Btn className="ghost sm" icon={LogOut} onClick={logout}>Sign out</Btn></div>}
      </div>
      <div className="card-body stack router-gap-3">
        {!m ? <Loading /> : m.error ? <Callout kind="warn" title="Sign-in no longer works">{m.error} <button type="button" className="link-btn" onClick={async () => { await del('/router/login'); det.reload(); }}>Sign in again</button></Callout> : (
          <>
            <div className="router-facts">
              <div><span className="tiny muted">Model</span><b>{m.info.model}</b><span className="tiny muted">{m.info.firmware}</span></div>
              <div><span className="tiny muted">Running for</span><b>{fmtUp(m.info.uptime)}</b></div>
              {m.link && <div><span className="tiny muted">Internet</span><b>{m.link.connected ? t('connected') : t('disconnected')}</b><span className="tiny muted">{m.link.access || ''}{m.link.uptime ? ` · ${t('for {time}', { time: fmtUp(m.link.uptime) })}` : ''}</span></div>}
              {m.link && m.link.down > 0 && <div><span className="tiny muted"><Gauge size={11} /> {t('Line')}</span><b>↓ {mbit(m.link.down)}</b><span className="tiny muted">↑ {mbit(m.link.up)}</span></div>}
              {m.link && <div><span className="tiny muted">Public IP</span><b className="mono">{m.link.externalIp || '–'}</b></div>}
            </div>
            <div className="row-tight router-wrap">
              <Seg value={tab} onChange={setTab} options={[{ id: 'devices', label: 'Devices in the network', icon: MonitorSmartphone }, { id: 'wifi', label: 'Wi-Fi', icon: Wifi }]} />
              <div className="right row-tight">
                <Btn className="ghost sm" icon={RefreshCw} onClick={reconnect}>Get a new IP</Btn>
                <Btn className="ghost sm" icon={Power} onClick={reboot}>Restart router</Btn>
              </div>
            </div>
            {tab === 'devices' ? <Devices /> : <WifiList />}
            <div className="tiny muted"><RouterIcon size={11} /> {t('Hostwerk now creates port forwardings directly through this access – even if the router does not allow UPnP forwardings for this PC.')}</div>
          </>
        )}
      </div>
    </div>
  );
}
