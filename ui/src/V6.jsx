import { useEffect, useState } from 'react';
import { Network, Globe, Copy, PowerOff } from 'lucide-react';
import { get, post, put } from '@hostwerk/api';
import { Btn, Switch, SettingRow, toast } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * IPv6 and DS-Lite: detect the connection type and open ports for IPv6 too. A fixed name on the changing address
 * (DynDNS) lives in the extension "DNS management" since 1.5.0 – it has more providers, checks the name from outside and
 * takes an old router name over by itself. Names still set up here keep working until they are moved or switched off.
 */
const copy = (x) => navigator.clipboard.writeText(x).then(() => toast.success('Copied'));

/** Fixed name (DynDNS): pointer to DNS management; an old name from this extension with "take over" and "switch off". */
function DynDnsMoved({ d, setData }) {
  const [dns, setDns] = useState(undefined); // undefined = asking, null = DNS management not installed
  const [busy, setBusy] = useState('');
  useEffect(() => { get('/dns/names').then((x) => setDns(x || null)).catch(() => setDns(null)); }, []);
  const old = d.dyndns && d.dyndns.provider && d.dyndns.domain ? d.dyndns : null;
  const takeOver = async () => {
    setBusy('take');
    try { const r = await post('/dns/names-router/take-over'); toast.success(t('{name} is now kept up to date in DNS management.', { name: r.host.name })); setData(await get('/router')); } catch (e) { toast.error(e); }
    setBusy('');
  };
  const off = async () => {
    setBusy('off');
    try { const r = await put('/router/dyndns', { provider: '' }); setData(r.status); toast.success('Switched off'); } catch (e) { toast.error(e); }
    setBusy('');
  };
  return (
    <div className="stack router-gap-3">
      <div className="small"><b>Fixed name (DynDNS)</b> <span className="muted">– a name like “myserver.dynv6.net” that always points to your current address. You set it up in DNS management: more providers, IPv4 and IPv6, a check from outside and notifications.</span></div>
      {old && (
        <div className="tiny">
          {t('{name} is still kept up to date here (old setting).', { name: old.domain })}{' '}
          {old.last && <span className={old.last.ok ? 'muted' : 'err'}>{old.last.ok ? t('Last update: {ips} ({when})', { ips: [old.last.ip4, old.last.ip6].filter(Boolean).join(' · '), when: new Date(old.last.t).toLocaleString() }) : t('The provider reports: {text}', { text: old.last.answer })}</span>}
        </div>
      )}
      <div className="row-tight">
        {dns && old && old.provider !== 'custom' && <Btn className="primary sm" icon={Globe} busy={busy === 'take'} onClick={takeOver}>Move to DNS management</Btn>}
        {dns ? <a className="btn sm" href="#/live/dns"><Globe size={14} aria-hidden="true" />{t('Open DNS management')}</a> : dns === null && <a className="btn sm" href="#/ext"><Globe size={14} aria-hidden="true" />{t('Install DNS management')}</a>}
        {old && <Btn className="sm ghost" icon={PowerOff} busy={busy === 'off'} onClick={off}>Switch off here</Btn>}
      </div>
    </div>
  );
}

export default function RouterV6({ d, setData }) {
  const kind = d.dslite ? 'DS-Lite (only IPv6 public)' : d.cgnat ? 'Carrier NAT (IPv4 shared)' : d.ipv6.address ? 'Dual stack (IPv4 and IPv6)' : 'IPv4 only';
  return (
    <section className="stack router-gap-3" aria-label={t('IPv6 & connection type')}>
      <h4 className="row-tight router-h"><Network size={16} aria-hidden="true" />{t('IPv6 & connection type')}<span className={`badge ${d.dslite || d.cgnat ? 'warn' : 'ok'}`}>{t(kind)}</span></h4>
      <div className="stack router-gap-3">
        <div className="stack small router-tight">
          <div className="row"><span className="muted">IPv4 from outside</span><b className="mono">{(d.net && d.net.v4public) || '–'}</b>{d.dslite && <span className="tiny muted">(shared – cannot be reached)</span>}</div>
          <div className="row"><span className="muted">IPv6 of this PC</span><b className="mono ellipsis router-v6">{d.ipv6.address || t('none')}</b>{d.ipv6.address && <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(d.ipv6.address)}><Copy /></button>}</div>
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
        <DynDnsMoved d={d} setData={setData} />
      </div>
    </section>
  );
}
