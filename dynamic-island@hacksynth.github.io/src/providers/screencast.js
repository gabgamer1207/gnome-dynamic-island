// Registrazione e condivisione dello schermo.
//
// Su iOS l'isola diventa rossa mentre registri, con il tempo che scorre. E' il
// caso in cui l'isola non serve a comandare qualcosa ma a ricordartelo: la
// registrazione e' la cosa piu' facile del mondo da dimenticare accesa, e la
// condivisione dello schermo e' quella che ti fa mostrare a una riunione cose
// che non volevi mostrare.
//
// DOVE SI PRENDE L'INFORMAZIONE
//
// Non da D-Bus, anche se registratore e portale ci passano. Mutter tiene un
// registro unico di chi sta guardando lo schermo — MetaRemoteAccessController —
// e lo espone alla shell:
//
//     global.backend.get_remote_access_controller()
//
// Ogni volta che qualcosa inizia a leggere lo schermo nasce un "handle", e alla
// fine quell'handle emette `stopped`. E' la stessa fonte da cui la shell accende
// il proprio indicatore rosso: un solo punto per il registratore interno, per la
// condivisione nelle videochiamate, per il desktop remoto e per qualunque
// programma usi il portale.
//
// LA DIFFERENZA FRA LE DUE COSE
//
// La proprieta' `is-recording` distingue "sto scrivendo un file" da "qualcuno
// sta guardando". Sono due preoccupazioni diverse — la prima e' occupare disco,
// la seconda e' la privacy — e meritano due scritte diverse.

import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createActivity, _now } from '../activity.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { ScreencastView } from '../views/screencast-view.js';
import { QuickScreencast } from '../quick-screencast.js';

// Il servizio che registra davvero. Fermare si puo' anche dall'handle di
// Mutter — ed e' la via giusta, perche' vale per qualunque sorgente, compresa
// la condivisione dello schermo. Avviare invece no: l'handle e' il registro di
// chi sta guardando, non il registratore. Per far partire una registrazione
// serve chiedere a chi la sa fare.
const SC_NOME = 'org.gnome.Shell.Screencast';
const SC_PERCORSO = '/org/gnome/Shell/Screencast';

// Lo stesso modello di nome che usa GNOME per le sue registrazioni: i file
// finiscono dove l'utente li cerca, con il nome che si aspetta.
const MODELLO = 'Screencast From %d %t.webm';

export class ScreencastProvider {
    constructor() {
        this.id = 'screencast';
        this._manager = null;
        this._settings = null;
        this._controller = null;
        this._idNuovo = 0;
        this._sessioni = new Map();   // handle → { registrazione, inizio, idStop, chiave }
        this._tickId = 0;
        this._contatore = 0;
        this._quick = null;
    }

    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;

        // global.backend esiste da GNOME 45; il ripiego serve solo a non morire
        // su versioni piu' vecchie, dove il provider semplicemente non parte.
        const backend = globalThis.global?.backend ?? Meta.get_backend?.();
        this._controller = backend?.get_remote_access_controller?.() ?? null;
        if (!this._controller) return;

        this._idNuovo = this._controller.connect(
            'new-handle', (_c, handle) => this._nuova(handle));

        // L'interruttore nel menu di stato. Se la shell non lo accetta si perde
        // il pulsante, non il provider.
        try {
            this._quick = new QuickScreencast({ alterna: () => this._alterna() });
        } catch (e) {
            logError(e, 'DynamicIsland: interruttore registrazione non aggiunto');
            this._quick = null;
        }
    }

    disable() {
        if (this._controller && this._idNuovo) {
            this._controller.disconnect(this._idNuovo);
            this._idNuovo = 0;
        }
        this._controller = null;

        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
        for (const [handle, s] of this._sessioni) {
            if (s.idStop) { try { handle.disconnect(s.idStop); } catch (_) {} }
            this._manager?.remove(s.chiave);
            s.vista?.destroy();
        }
        this._sessioni.clear();
        this._manager?.remove(`${this.id}:fine`);
        this._quick?.destroy();
        this._quick = null;
        this._manager = null;
    }

    _nuova(handle) {
        if (this._sessioni.has(handle)) return;

        const registrazione = !!handle.is_recording;
        const chiave = `${this.id}:${++this._contatore}`;
        const sessione = {
            registrazione,
            inizio: GLib.get_monotonic_time(),
            chiave,
            idStop: 0,
            vista: new ScreencastView({
                // Si ferma dall'handle e non dal servizio: l'handle e' l'unico
                // appiglio che vale anche per una condivisione dello schermo,
                // che il registratore non conosce.
                ferma: () => { try { handle.stop(); } catch (_) {} },
                nuova: () => this._riavvia(handle),
            }),
        };
        sessione.idStop = handle.connect('stopped', () => this._finita(handle));
        this._sessioni.set(handle, sessione);

        this._aggiorna(sessione);
        // L'orologio serve solo alle registrazioni, che mostrano il tempo che
        // scorre. Una condivisione mostra una scritta ferma e non ha nulla da
        // aggiornare ogni secondo.
        if (registrazione) this._avviaOrologio();
    }

    _finita(handle) {
        const s = this._sessioni.get(handle);
        if (!s) return;
        if (s.idStop) { try { handle.disconnect(s.idStop); } catch (_) {} }
        this._sessioni.delete(handle);
        this._manager?.remove(s.chiave);
        if (s.registrazione && !this._registrazioneInCorso()[0])
            this._quick?.aggiorna(false, '');
        // Dopo la remove(), non prima: finche' l'attivita' esiste la scheda
        // tiene un riferimento all'attore, e distruggerlo sotto di lei
        // lascerebbe la scheda con un figlio morto.
        s.vista?.destroy();

        if (![...this._sessioni.values()].some(x => x.registrazione)
            && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }

        const durata = Math.max(
            this._settings?.get_int('transient-duration-ms') ?? 1500, 3000) * 1000;
        const ora = _now();
        this._manager?.push(createActivity({
            id: `${this.id}:fine`,
            providerId: this.id,
            tier: 'transient',
            slot: 'either',
            label: s.registrazione
                ? _('Recording stopped')
                : _('Screen sharing ended'),
            sublabel: s.registrazione ? this._durata(s) : null,
            startedAt: ora,
            expiresAt: ora + durata,
        }));
    }

    _avviaOrologio() {
        if (this._tickId) return;
        // Un secondo pieno, non allineato all'orologio di sistema: vedi la nota
        // in timer.js — timeout_add_seconds accorcia il primo intervallo, e su
        // un cronometro che si legge quello si vede.
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            for (const s of this._sessioni.values())
                if (s.registrazione) this._aggiorna(s);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // La sessione di registrazione in corso, se ce n'e' una. La condivisione
    // dello schermo non conta: l'interruttore dice "sto registrando", e fermare
    // una videochiamata da li' sarebbe una sorpresa spiacevole.
    _registrazioneInCorso() {
        for (const [handle, s] of this._sessioni)
            if (s.registrazione) return [handle, s];
        return [null, null];
    }

    _alterna() {
        const [handle] = this._registrazioneInCorso();
        if (handle) { try { handle.stop(); } catch (_) {} }
        else this._avviaRegistrazione();
    }

    _avviaRegistrazione() {
        Gio.DBus.session.call(
            SC_NOME, SC_PERCORSO, SC_NOME, 'Screencast',
            new GLib.Variant('(sa{sv})', [MODELLO, {
                'draw-cursor': GLib.Variant.new_boolean(true),
            }]),
            null, Gio.DBusCallFlags.NONE, 5000, null,
            (c, r) => {
                try { c.call_finish(r); }
                catch (e) { logError(e, 'DynamicIsland: avvio registrazione'); }
            });
    }

    // Ferma quella in corso e ne avvia un'altra.
    //
    // L'avvio va incatenato allo stop, non lanciato subito dopo: il servizio
    // rifiuta di partire finche' la sessione precedente non e' chiusa, e le due
    // chiamate sono asincrone — sparate insieme, la seconda arriverebbe quasi
    // sempre troppo presto e la registrazione nuova semplicemente non partirebbe,
    // senza un errore visibile da nessuna parte.
    _riavvia(handle) {
        try { handle.stop(); } catch (_) {}
        Gio.DBus.session.call(
            SC_NOME, SC_PERCORSO, SC_NOME, 'StopScreencast',
            null, null, Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                try { conn.call_finish(res); } catch (_) { /* gia' ferma */ }
                this._avviaRegistrazione();
            });
    }

    _aggiorna(s) {
        if (!this._manager) return;
        const durata = s.registrazione ? this._durata(s) : null;
        s.vista?.aggiorna({
            testo: durata,
            nome: s.registrazione ? _('Recording') : _('Screen shared'),
            registrazione: s.registrazione,
        });
        this._manager.update(createActivity({
            id: s.chiave,
            providerId: this.id,
            tier: 'persistent',
            slot: 'leading',
            // Sopra tutto il resto: la musica puo' aspettare, sapere che lo
            // schermo e' visibile a qualcun altro no.
            priority: 20,
            label: s.registrazione ? _('Recording') : _('Screen shared'),
            sublabel: durata,
            // Il pallino rosso al posto di un'icona: e' il segno che tutti
            // riconoscono come "sta registrando", e non ha bisogno della parola
            // accanto. Per la condivisione invece serve l'icona, perche' li'
            // non esiste un simbolo altrettanto stabilito.
            glyph: s.registrazione
                ? { punto: true, testo: durata }
                : { icon: new Gio.ThemedIcon({ name: 'screen-shared-symbolic' }) },
            expandedView: s.vista?.actor ?? null,
        }));
        if (s.registrazione) this._quick?.aggiorna(true, durata ?? '');
    }

    // Niente format(): quel formattatore conosce solo %s e %d, non la larghezza
    // fissa. Un orologio senza zeri iniziali salterebbe da "1:9" a "1:10".
    _durata(s) {
        const sec = Math.floor((GLib.get_monotonic_time() - s.inizio) / 1000000);
        const m = Math.floor(sec / 60);
        const r = String(sec % 60).padStart(2, '0');
        if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${r}`;
        return `${m}:${r}`;
    }
}
