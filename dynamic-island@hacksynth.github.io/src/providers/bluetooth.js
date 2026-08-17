// Dispositivi Bluetooth: connessione, disconnessione, batteria.
//
// E' il caso d'uso piu' riconoscibile della Dynamic Island di iOS — apri la
// custodia degli AirPods e l'isola mostra nome e carica — e su Linux non lo fa
// nessuno. E' la ragione per cui vale la pena scriverlo.
//
// COME FUNZIONA
//
// BlueZ, lo stack Bluetooth di Linux, espone i dispositivi sul bus di sistema
// come oggetti org.bluez.Device1. Invece di interrogarli uno per uno ci si
// iscrive a tutti insieme: un solo punto di ascolto per il sottosistema.
//
// Servono tre segnali, non uno:
//   PropertiesChanged   il dispositivo si collega o si scollega
//   InterfacesRemoved   il dispositivo sparisce del tutto (rimosso dalla lista,
//                       adattatore spento). Senza questo resterebbe scritto
//                       nell'isola un apparecchio che non esiste piu': se n'e'
//                       andato senza dirlo, perche' non c'era nessuna proprieta'
//                       da cambiare su un oggetto che non c'e'.
//   InterfacesAdded     un dispositivo che compare gia' collegato
//
// LA BATTERIA
//
// Nella maggior parte dei casi non arriva da BlueZ ma da UPower, che la espone
// come un dispositivo separato con il proprio percorso. I due mondi vanno messi
// in relazione a mano, e l'unico appiglio comune e' l'indirizzo: UPower lo
// include nel nome dell'oggetto, con i due punti sostituiti da underscore.
//
// E si ascolta, non si legge una volta sola: una carica letta all'aggancio e
// mai piu' aggiornata invecchia in silenzio, e un numero vecchio che sembra
// nuovo e' peggio di nessun numero.
//
// Non tutti i dispositivi la riportano. Quando manca si mostra solo il nome:
// un anello a zero direbbe "scarico", che e' falso — la verita' e' "non lo so".
//
// PERCHE' E' UN'ATTIVITA' DISCRETA
//
// Delle cuffie collegate restano collegate per ore. Se prendessero la pillola
// come fa un timer, se la terrebbero fino a sera scalzando la musica, cioe'
// proprio la cosa che ci stai ascoltando dentro. Entrano quindi in catena senza
// rubare il primo piano — le raggiungi col pallino quando ti servono. Il momento
// dell'aggancio invece e' un evento, e quello lo dice il lampo.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createActivity, _now } from '../activity.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from '../i18n.js';
import { BluetoothView } from '../views/bluetooth-view.js';

const BLUEZ = 'org.bluez';
const DEVICE_IFACE = 'org.bluez.Device1';
const UPOWER = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const UPOWER_DEV = 'org.freedesktop.UPower.Device';

export class BluetoothProvider {
    constructor() {
        this.id = 'bluetooth';
        this._manager = null;
        this._settings = null;
        this._sub = [];
        this._dispositivi = new Map();   // percorso BlueZ → dati del dispositivo
        this._vista = null;
    }

    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;
        const bus = Gio.DBus.system;

        this._sub.push(bus.signal_subscribe(
            BLUEZ, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            null, DEVICE_IFACE, Gio.DBusSignalFlags.NONE,
            (_c, _s, percorso, _i, _sig, params) => {
                const [, cambiate] = params.deepUnpack();
                if (!('Connected' in cambiate)) return;
                if (cambiate['Connected'].deepUnpack()) this._connesso(percorso);
                else this._disconnesso(percorso);
            }));

        this._sub.push(bus.signal_subscribe(
            BLUEZ, 'org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved',
            null, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [percorso, interfacce] = params.deepUnpack();
                if (interfacce.includes(DEVICE_IFACE)) this._disconnesso(percorso);
            }));

        this._sub.push(bus.signal_subscribe(
            BLUEZ, 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded',
            null, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [percorso, interfacce] = params.deepUnpack();
                const dev = interfacce[DEVICE_IFACE];
                if (dev?.['Connected']?.deepUnpack()) this._connesso(percorso);
            }));

        // La carica cambia mentre il dispositivo e' collegato: si ascolta
        // invece di leggerla una volta e darla per buona.
        this._sub.push(bus.signal_subscribe(
            UPOWER, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            null, UPOWER_DEV, Gio.DBusSignalFlags.NONE,
            (_c, _s, percorso, _i, _sig, params) => {
                const [, cambiate] = params.deepUnpack();
                if (!('Percentage' in cambiate)) return;
                this._aggiornaCarica(percorso,
                    Math.round(cambiate['Percentage'].deepUnpack()));
            }));

        // Dispositivi gia' collegati all'avvio dell'estensione: senza questo,
        // riabilitandola con le cuffie attaccate l'isola non saprebbe che
        // esistono finche' non le scolleghi.
        this._elencaEsistenti();
    }

    disable() {
        for (const s of this._sub) {
            try { Gio.DBus.system.signal_unsubscribe(s); } catch (_) {}
        }
        this._sub = [];
        this._dispositivi.clear();
        this._manager?.remove(`${this.id}:dispositivi`);
        this._manager?.remove(`${this.id}:flash`);
        this._vista?.destroy();
        this._vista = null;
        this._manager = null;
    }

    _elencaEsistenti() {
        Gio.DBus.system.call(
            BLUEZ, '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                let oggetti;
                try { oggetti = conn.call_finish(res).deepUnpack()[0]; }
                catch (_) { return; }        // BlueZ assente o Bluetooth spento
                for (const [percorso, interfacce] of Object.entries(oggetti)) {
                    const dev = interfacce[DEVICE_IFACE];
                    if (dev?.['Connected']?.deepUnpack()) this._connesso(percorso, true);
                }
            });
    }

    // silenzioso: alla partenza si registra lo stato senza annunciarlo. Un lampo
    // per ogni dispositivo gia' collegato, a ogni avvio della sessione, sarebbe
    // rumore per un'informazione che l'utente conosce gia'.
    _connesso(percorso, silenzioso = false) {
        if (this._dispositivi.has(percorso)) return;

        // Segnaposto immediato, prima della chiamata.
        //
        // Fra la richiesta e la risposta passano dei millisecondi, e i segnali
        // per lo stesso dispositivo arrivano appaiati — InterfacesAdded e
        // PropertiesChanged raccontano lo stesso aggancio. Senza il segnaposto
        // la guardia qui sopra non vedrebbe niente e il dispositivo verrebbe
        // registrato due volte, con due lampi e due cerchi identici.
        this._dispositivi.set(percorso,
            { nome: '', indirizzo: '', icona: '', batteria: null, upower: null });

        Gio.DBus.system.call(
            BLUEZ, percorso, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [DEVICE_IFACE]),
            null, Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                let props;
                try { props = conn.call_finish(res).deepUnpack()[0]; }
                catch (_) { this._dispositivi.delete(percorso); return; }
                // Scollegato mentre stavamo chiedendo: la voce e' gia' stata
                // tolta, e riscriverla la farebbe resuscitare per sempre.
                if (!this._dispositivi.has(percorso)) return;

                const nome = props['Alias']?.deepUnpack()
                          ?? props['Name']?.deepUnpack()
                          ?? _('Bluetooth device');
                const indirizzo = props['Address']?.deepUnpack() ?? '';
                // BlueZ classifica il dispositivo e ne suggerisce l'icona
                // ("audio-headset", "input-mouse", "phone"): sono nomi del tema
                // standard, quindi bastano cosi' come sono.
                const icona = props['Icon']?.deepUnpack() ?? '';

                this._dispositivi.set(percorso,
                    { nome, indirizzo, icona, batteria: null, upower: null });
                this._mostra();
                if (!silenzioso) this._flash(format(_('%s connected'), nome));

                this._cercaBatteria(percorso, indirizzo);
            });
    }

    _disconnesso(percorso) {
        const dev = this._dispositivi.get(percorso);
        if (!dev) return;
        this._dispositivi.delete(percorso);
        this._mostra();
        // Nome vuoto significa che si e' scollegato mentre leggevamo ancora le
        // sue proprieta': annunciare «" " disconnesso» sarebbe peggio di tacere.
        if (dev.nome) this._flash(format(_('%s disconnected'), dev.nome));
    }

    // La batteria vive in UPower, non in BlueZ. L'unico legame fra i due mondi
    // e' l'indirizzo del dispositivo, che UPower infila nel nome dell'oggetto
    // con i due punti trasformati in underscore.
    _cercaBatteria(percorso, indirizzo) {
        if (!indirizzo) return;
        const atteso = indirizzo.replace(/:/g, '_');

        Gio.DBus.system.call(
            UPOWER, UPOWER_PATH, UPOWER, 'EnumerateDevices',
            null, null, Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                let percorsi;
                try { percorsi = conn.call_finish(res).deepUnpack()[0]; }
                catch (_) { return; }

                const trovato = percorsi.find(p => p.includes(atteso));
                if (!trovato) return;                    // non riporta la carica

                const dev = this._dispositivi.get(percorso);
                if (!dev) return;                        // scollegato nel frattempo
                dev.upower = trovato;

                Gio.DBus.system.call(
                    UPOWER, trovato, 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', [UPOWER_DEV, 'Percentage']),
                    null, Gio.DBusCallFlags.NONE, 3000, null,
                    (c2, r2) => {
                        try {
                            this._aggiornaCarica(trovato,
                                Math.round(c2.call_finish(r2).deepUnpack()[0].deepUnpack()));
                        } catch (_) { /* sparito nel frattempo */ }
                    });
            });
    }

    _aggiornaCarica(percorsoUPower, pct) {
        let toccato = false;
        for (const dev of this._dispositivi.values()) {
            if (dev.upower !== percorsoUPower || dev.batteria === pct) continue;
            dev.batteria = pct;
            toccato = true;
        }
        if (toccato) this._mostra();
    }

    // La pillola si dimensiona sul contenuto: un nome come "WH-1000XM4 Wireless
    // Headphones" la stenderebbe su mezza barra. Nella scheda c'e' posto e il
    // nome si legge intero; qui basta riconoscerlo.
    _corto(nome) {
        return nome.length > 18 ? `${nome.slice(0, 17)}…` : nome;
    }

    // Nomi in cascata: il tema prende il primo che possiede. Se BlueZ non dice
    // niente, o dice un nome che il tema non conosce, si finisce comunque sul
    // simbolo generico del Bluetooth invece che su un riquadro vuoto.
    _icona(nome) {
        const nomi = nome ? [`${nome}-symbolic`, nome] : [];
        nomi.push('bluetooth-active-symbolic');
        return Gio.ThemedIcon.new_from_names(nomi);
    }

    _mostra() {
        if (!this._manager) return;

        // Si contano solo quelli di cui sappiamo gia' il nome: gli altri sono
        // segnaposto in attesa della risposta di BlueZ, e disegnarli darebbe un
        // cerchio vuoto senza etichetta per una frazione di secondo.
        const elenco = [...this._dispositivi.entries()]
            .filter(([, d]) => d.nome)
            .map(([percorso, d]) => ({
                percorso, nome: d.nome, batteria: d.batteria, icona: this._icona(d.icona),
            }));

        if (elenco.length === 0) {
            this._manager.remove(`${this.id}:dispositivi`);
            this._vista?.destroy();
            this._vista = null;
            return;
        }

        this._vista ??= new BluetoothView();
        this._vista.aggiorna(elenco);

        // Nella pillola c'e' posto per una cosa sola, e quella utile e' il
        // dispositivo messo peggio: gli altri li guardi aprendo la scheda.
        // Se nessuno riporta la carica si ripiega sul primo, che almeno dice
        // COSA e' collegato.
        const conCarica = elenco.filter(d => Number.isFinite(d.batteria));
        const scelto = conCarica.length > 0
            ? conCarica.reduce((a, b) => (a.batteria <= b.batteria ? a : b))
            : elenco[0];

        this._manager.update(createActivity({
            id: `${this.id}:dispositivi`,
            providerId: this.id,
            tier: 'persistent',
            slot: 'either',
            quiet: true,          // vedi l'intestazione: non ruba il primo piano
            label: elenco.length === 1
                ? elenco[0].nome
                : format(_('%d devices'), elenco.length),
            sublabel: Number.isFinite(scelto.batteria)
                ? format(_('Battery %d%%'), scelto.batteria) : null,
            glyph: {
                icon: scelto.icona,
                testo: Number.isFinite(scelto.batteria)
                    ? `${scelto.batteria}%`
                    : (elenco.length === 1
                        ? this._corto(scelto.nome) : `${elenco.length}`),
            },
            expandedView: this._vista.actor,
        }));
    }

    _flash(label) {
        if (!this._manager) return;
        // Piu' lungo del lampo generico: un nome di dispositivo va letto, e
        // arriva mentre stai facendo altro — ti sei appena messo le cuffie.
        const durata = Math.max(
            this._settings?.get_int('transient-duration-ms') ?? 1500, 2500) * 1000;
        const ora = _now();
        this._manager.push(createActivity({
            id: `${this.id}:flash`,
            providerId: this.id,
            tier: 'transient',
            slot: 'either',
            label,
            startedAt: ora,
            expiresAt: ora + durata,
        }));
    }
}
