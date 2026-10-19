import { useState } from 'react';
import { Network, Globe, Copy, ExternalLink } from 'lucide-react';
import { put, openExternal } from '@hostwerk/api';
import { Btn, Field, Switch, SettingRow, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * IPv6 and DS-Lite: detect the connection type, open ports for IPv6 too and keep a fixed name on the changing address
 * with DynDNS.
 */
const PROVIDERS = [
  { id: '', label: '– off –' },
  { id: 'dynv6', label: 'dynv6 (free, IPv6-friendly)', url: 'https://dynv6.com', tokenLabel: 'HTTP token' },
  { id: 'duckdns', label: 'DuckDNS (free)', url: 'https://www.duckdns.org', tokenLabel: 'Token' },
  { id: 'desec', label: 'deSEC (free, non-profit)', url: 'https://desec.io', tokenLabel: 'Token' },
  { id: 'custom', label: 'Own provider (address with {ip4} {ip6})' },
];
const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Copied'));

export default function RouterV6({ d, setData }) {
  const [f, setF] = useState(() => ({ provider: d.dyndns.provider || '', domain: d.dyndns.domain || '', token: '', url: '' }));
  const [busy, setBusy] = useState(false);
  const p = PROVIDERS.find((x) => x.id === f.provider) || PROVIDERS[0];
  const kind = d.dslite ? 'DS-Lite (only IPv6 public)' : d.cgnat ? 'Carrier NAT (IPv4 shared)' : d.ipv6.address ? 'Dual stack (IPv4 and IPv6)' : 'IPv4 only';
  const save = async () => {
    setBusy(true);
    try {
      const r = await put('/router/dyndns', f);
      setData(r.status);
      if (r.error) toast.error(r.error); else if (r.result) toast.success(t('{name} now points to {ips}', { name: f.domain, ips: [r.result.ip4, r.result.ip6].filter(Boolean).join(` ${t('and')} `) })); else toast.success('Saved');
      setF({ ...f, token: '' });
    } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const last = d.dyndns.last;
  return (
    <div className="card">
      <div className="card-head"><Network size={16} /><h3>IPv6 &amp; connection type</h3><span className={`badge ${d.dslite || d.cgnat ? 'warn' : 'ok'}`}>{kind}</span></div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="stack small" style={{ gap: 6 }}>
          <div className="row"><span className="muted">IPv4 from outside</span><b className="mono">{(d.net && d.net.v4public) || '–'}</b>{d.dslite && <span className="tiny muted">(shared – cannot be reached)</span>}</div>
          <div className="row"><span className="muted">IPv6 of this PC</span><b className="mono ellipsis" style={{ maxWidth: 300 }}>{d.ipv6.address || t('none')}</b>{d.ipv6.address && <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(d.ipv6.address)}><Copy /></button>}</div>
        </div>
        {d.ipv6.address && (
          <SettingRow title="Open ports for IPv6 too" text={d.ipv6.auto ? 'Hostwerk opens the same ports in the IPv6 firewall of the router (when syncing and every 30 minutes).' : 'Your router does not offer this automatically – see the note below.'}>
            <Switch checked={d.ipv6.enabled} onChange={async (v) => { try { setData(await put('/router/ipv6', { enabled: v })); } catch (e) { toast.error(e); } }} />
          </SettingRow>
        )}
        {d.ipv6.address && d.ipv6.pinholes.length > 0 && <div className="tiny muted">{t('Open for IPv6: {ports}', { ports: d.ipv6.pinholes.map((x) => `${x.port}/${x.protocol}`).join(', ') })}</div>}
        {d.ipv6.address && !d.ipv6.auto && (
          <div className="tiny muted">IPv6 forwarding by hand: FRITZ!Box → Internet → Permit Access → edit the device of this PC → switch on “IPv6 permit access” and enter the ports. On OpenWrt: sign in under “Router access”, then Hostwerk does it.</div>
        )}
        <div className="divider" />
        <div className="small"><b>Fixed name (DynDNS)</b> <span className="muted">– the IPv6 of your connection changes; a name like “myserver.dynv6.net” always points to the current one.</span></div>
        <div className="form-grid">
          <Field label="Provider"><select className="select" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{PROVIDERS.map((x) => <option key={x.id} value={x.id}>{t(x.label)}</option>)}</select></Field>
          {f.provider && <Field label="Name"><input className="input mono" placeholder={f.provider === 'duckdns' ? 'myserver' : 'myserver.dynv6.net'} value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} /></Field>}
          {f.provider && f.provider !== 'custom' && <Field label={p.tokenLabel || 'Token'}><input className="input mono" type="password" placeholder={d.dyndns.hasToken ? t('•••••••• (saved)') : ''} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>}
          {f.provider === 'custom' && <Field label="Update address" className="span-2"><input className="input mono" placeholder="https://provider.example/update?host={domain}&ip6={ip6}&key={token}" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>}
        </div>
        <div className="row-tight">
          <Btn className="primary sm" icon={Globe} busy={busy} onClick={save}>{f.provider ? 'Save and update' : 'Save'}</Btn>
          {p.url && <Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal(p.url)}>Sign up for free</Btn>}
        </div>
        {last && <div className={`tiny ${last.ok ? 'muted' : 'err'}`}>{last.ok ? t('Last update: {ips} ({when})', { ips: [last.ip4, last.ip6].filter(Boolean).join(' · '), when: new Date(last.t).toLocaleString() }) : t('The provider reports: {text}', { text: last.answer })}</div>}
      </div>
    </div>
  );
}
