![Router & Portfreigaben](banner.svg)

# Router & Portfreigaben

Macht deine Server aus dem Internet erreichbar: Portfreigaben über UPnP/NAT-PMP oder direkt über FRITZ!Box (TR-064) und OpenWrt, IPv6 und DS-Lite, DynDNS.

[English](README.md) · Offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public)-Erweiterung (SDK 2.7, native Erweiterung)

![Bildschirmfoto](docs/screenshot.de.png)

## Was sie kann

- Findet den Router selbst, gibt Ports mit einem Klick frei (UPnP/NAT-PMP)
- FRITZ!Box (TR-064) und OpenWrt direkt – Geräte, WLAN, neue IP-Adresse und Neustart
- IPv6 und DS-Lite, DynDNS
- „Für Freunde im Internet“ an jedem Minecraft-Server
- Reiter „Router“ unter Livebetrieb

## Installieren

In Hostwerk unter **Erweiterungen → Entdecken** auf „Installieren“ klicken. Wer die Funktion schon in Hostwerk 2.8 benutzt hat, bekommt die Erweiterung beim Update automatisch – mit allen Daten.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Darum installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`settings.router` – genau dort, wo Hostwerk sie schon immer abgelegt hat. Entfernen der Erweiterung löscht nichts.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # Prüfung wie im Katalog (sdk/check.js)
```

Quelltext der Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
