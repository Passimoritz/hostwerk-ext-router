## 1.4.1

- New animated icon and banner in the common Hostwerk style (isometric block). / Neues animiertes Symbol und Banner im gemeinsamen Hostwerk-Stil (isometrischer Block).

## 1.4.0

- “Connection details …” opens as a side sheet with newer Hostwerk versions (the page stays visible next to it), as a dialog before / „Anschluss-Details …“ öffnet mit neueren Hostwerk-Versionen als Seitenblatt (die Seite bleibt daneben sichtbar), sonst als Dialog
- Fits on one screen: “Sign in” is a status line at the very top (sign-in in a dialog), the overview uses Hostwerk’s own figures, one card “Forward automatically” with the ways as chips, Hostwerk’s ports and all router forwardings share one card with a switch, router facts plus IPv6 & DynDNS moved into “Connection details …”; explanations behind an ⓘ / Passt auf einen Bildschirm: „Anmelden“ als Statuszeile ganz oben (Anmeldung im Dialog), der Überblick nutzt Hostwerks eigene Kennzahlen, eine Karte „Automatisch freigeben“ mit den Wegen als Chips, Ports von Hostwerk und alle Router-Freigaben teilen sich eine Karte mit Umschalter, Router-Eckdaten samt IPv6 & DynDNS stehen unter „Anschluss-Details …“; Erklärungen hinter einem ⓘ

## 1.3.2

- German texts use Hostwerk’s words: “Passwort” instead of “Kennwort”, “Router-Anmeldung” instead of “Router-Login”. / Deutsche Texte mit Hostwerks Wörtern: „Passwort“ statt „Kennwort“, „Router-Anmeldung“ statt „Router-Login“.
- No forwardings yet: Hostwerk’s empty tile instead of a grey sentence. / Noch keine Freigaben: Hostwerks Leer-Kachel statt eines grauen Satzes.

## 1.3.1

- Lives where it belongs: Go live → Make reachable → Router and the dashboard tile – no own sidebar entry any more (Hostwerk 3.0+); the full page stays under Extensions → Open and can be pinned in the sidebar settings. / Steckt jetzt dort, wo sie hingehört: Livebetrieb → Erreichbar machen → Router und Übersichtskachel – kein eigener Seitenleisten-Eintrag mehr (Hostwerk 3.0+); die ganze Seite bleibt unter Erweiterungen → Öffnen und lässt sich in den Seitenleisten-Einstellungen anheften.
- The page is back in the manifest (with "nav": false) – “Open” works again in Extensions, the puzzle mark and Settings → Extensions; older Hostwerk versions show the sidebar entry again. / Die Seite steht wieder im Manifest (mit "nav": false) – „Öffnen“ geht wieder unter Erweiterungen, am Puzzle-Zeichen und in Einstellungen → Erweiterungen; ältere Hostwerk-Versionen zeigen den Seitenleisten-Eintrag wieder.

## 1.3.0

- No own sidebar entry any more: the router lives in Go live (Make reachable → Router), plus a dashboard tile; the full page stays reachable from Extensions → Open. / Kein eigener Seitenleisten-Eintrag mehr: Router im Livebetrieb (Erreichbar machen → Router) plus Übersichtskachel; die volle Seite bleibt über Erweiterungen → Öffnen erreichbar.
- Overview at the top: router found with UPnP state, forwardings, reachable from outside (all forwarded TCP ports checked at once, result remembered), public IPv4 and IPv6. / Überblick oben: Router mit UPnP-Zustand, Freigaben, von außen erreichbar (gesammelt geprüft), öffentliche IPv4/IPv6.
- Conflicts recognised: port given to another device, port wanted twice, forwarding no longer needed. / Konflikte: Port an anderem Gerät, doppelt gebraucht, nicht mehr gebraucht.
- Carrier NAT and double NAT explained honestly with the way out (tunnel, VPN without forwarding). / Carrier-NAT und doppeltes NAT ehrlich erklärt, mit Ausweg (Tunnel, VPN ohne Freigabe).
- Errors as sentences (timeout, router off, NAT-PMP, raw status codes); a wrong router password never answers 401 (that would sign you out of Hostwerk). / Fehler als Sätze; falsches Router-Kennwort antwortet nie mit 401.
- Column "Set up by" for every forwarding; MikroTik and UniFi drivers tested against Hostwerk's router replicas. / Spalte „Angelegt von“; MikroTik- und UniFi-Treiber gegen Hostwerks Router-Nachbildungen getestet.

## 1.2.1

- UniFi: removing the UDP (or TCP) part of a forwarding for "TCP and UDP" deleted the whole rule – now only that protocol goes, the other stays. / UniFi: Beim Entfernen des UDP- (oder TCP-)Teils einer Freigabe für „TCP und UDP“ verschwand die ganze Regel – jetzt nur dieses Protokoll.
- UniFi: accounts with two-factor sign-in (499) and the lockout after wrong attempts (429) get a clear message; a renewed session cookie is used. / UniFi: Konten mit Zwei-Faktor-Anmeldung (499) und die Sperre nach Fehlversuchen (429) mit klarer Meldung; ein erneuertes Sitzungs-Cookie wird übernommen.
- MikroTik without the interface list "WAN": clear hint instead of "input does not match …" (no rule without interface – it would also redirect traffic from the home network). / MikroTik ohne Schnittstellen-Liste „WAN“: klarer Hinweis.
- Router off or wrong address: "The router does not answer." instead of ECONNRESET/ECONNREFUSED. / Router aus oder falsche Adresse: klare Meldung.

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
