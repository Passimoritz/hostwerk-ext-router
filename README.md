![Router & port forwarding](banner.svg)

# Router & port forwarding

Makes your servers reachable from the internet: port forwarding via UPnP/NAT-PMP or directly through FRITZ!Box (TR-064) and OpenWrt, IPv6 and DS-Lite, DynDNS.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

![Screenshot](docs/screenshot.png)

## What it does

- Finds the router by itself, forwards ports with one click (UPnP/NAT-PMP)
- FRITZ!Box (TR-064) and OpenWrt directly – devices, Wi-Fi, new IP address and reboot
- MikroTik (RouterOS 7) and UniFi (UniFi OS) directly – forwardings and devices, on UniFi also Wi-Fi
- Every forwarding shows where it comes from (Hostwerk, which extension, by hand, another device) and can be checked “from outside” (public port check ifconfig.co, only on click)
- Guest Wi-Fi with a QR code to join – print it and put it on the fridge
- IPv6 and DS-Lite, DynDNS
- “For friends on the internet” on every Minecraft server
- Forwardings of other extensions (file share, Bedrock bridge …) with their owner – the automatic mode keeps them
- Tab “Router” under Go live

## Install

In Hostwerk: **Extensions → Discover** and click “Install”. If you already used this feature in Hostwerk 2.8, the update installs the extension by itself – with all your data.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`settings.router` – exactly where Hostwerk always kept it. Removing the extension deletes nothing.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

MikroTik and UniFi drivers are also checked against simulated routers (RouterOS 7 REST, UniFi OS with CSRF token, self-signed certificate) in Hostwerk: `node scripts/real-probes.js --only sim`.

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

For other extensions (`host.use('router')` or `ctx.router`, check with `typeof router.forwards === 'object'` – since 1.2):

```js
await router.forwards.add({ port: 2022, protocol: 'TCP', label: 'SFTP' }, host.id);   // forwards now and remembers it
await router.forwards.remove({ port: 2022, protocol: 'TCP' }, host.id);               // only own entries
router.forwards.list();                                                                // [{ port, protocol, label, owner }]
```

## License

MIT
