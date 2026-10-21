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

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
