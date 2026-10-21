## 1.2.0

- Public interface for other extensions: `router.forwards.add/remove/list/owned` with an owner (extension id). The automatic mode keeps these forwardings, the page shows the extension as their origin, a package only changes its own entries. File share and Bedrock bridge use it instead of writing the settings themselves. / Öffentliche Schnittstelle `router.forwards` mit Besitzer – die Automatik behält diese Freigaben, die Seite zeigt die Erweiterung als Herkunft.

## 1.1.0

- "Reachable from outside?" per forwarding – a public port check (ifconfig.co) tries to connect, only on click and only TCP. / „Von außen erreichbar?“ je Freigabe.
- Every forwarding shows where it comes from: Hostwerk, which extension (e.g. game servers, mail server), added by hand or another device. / Alle Freigaben mit Herkunft.
- MikroTik (RouterOS 7 REST) and UniFi (UniFi OS) can be signed in directly – forwardings, devices, and for UniFi also Wi-Fi. OPNsense keeps the hint (its API has no stable port forwarding yet). / MikroTik und UniFi direkt.
- Guest Wi-Fi with a QR code: name and password from the router (FRITZ!Box, OpenWrt, UniFi) or by hand, to print. / Gast-WLAN mit QR-Code.
- More tests: MikroTik, UniFi, TR-064 error codes and Wi-Fi keys, QR text, origins, outside check. / Mehr Tests.
- Sizes from the design scale, place in the sidebar, other extensions may add tabs. / Design-Skala, Seitenleiste.

## 1.0.1

- Same symbol in the sidebar and in the page header (with Hostwerk 2.11 or newer). / Gleiches Symbol in der Seitenleiste und im Seitenkopf (ab Hostwerk 2.11).

## 1.0.0

- First release as its own extension (before: built into Hostwerk). Data stays where it was. / Erste Fassung als eigene Erweiterung (vorher fest in Hostwerk). Daten bleiben, wo sie waren.
