import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ActivityManager } from './src/activity-manager.js';
import { _now } from './src/activity.js';
import { IslandView } from './src/island-view.js';
import { PanelIntegration } from './src/panel-integration.js';
import { InteractionController } from './src/interaction-controller.js';
import { ExpandedIsland } from './src/expanded-island.js';
import { Satellite } from './src/satellite.js';
import { KeyboardProvider } from './src/providers/keyboard.js';
import { PowerProvider } from './src/providers/power.js';
import { VolumeBrightnessProvider } from './src/providers/volume-brightness.js';
import { MediaProvider } from './src/providers/media.js';
import { NotificationProvider } from './src/providers/notification.js';
import { DBusProvider } from './src/providers/dbus.js';
import { BluetoothProvider } from './src/providers/bluetooth.js';
import { TimerProvider } from './src/providers/timer.js';
import { TransfersProvider } from './src/providers/transfers.js';
import { ScreencastProvider } from './src/providers/screencast.js';

// Quanto resta cliccabile l'ultima notifica dopo che la scheda si e' chiusa.
//
// Oltre questo tempo la pillola torna al suo comportamento di base: il click
// riapre il menu data/ora. Una memoria che non scade diventa un'incognita —
// a distanza di ore non ricordi piu' quale notifica ti si riaprirebbe, e un
// gesto di cui non sai prevedere l'effetto e' peggio di un gesto che non c'e'.
//
// Il conto parte da quando la scheda si chiude, non da quando arriva la
// notifica: sono i secondi in cui puo' ancora venirti in mente di riguardarla.
const MEMORIA_MS = 10000;

export default class DynamicIslandExtension extends Extension {
    enable() {
        const settings = this.getSettings();
        this._settings = settings;

        this._manager = new ActivityManager();
        this._view = new IslandView();
        this._view.setSettings(settings);

        // Il pallino delle altre attivita'. Non sa niente della catena: chiede
        // al gestore di ruotare e si limita a mostrare cio' che gli arriva.
        this._satellite = new Satellite(() => this._manager.ruotaIndietro());
        this._panel = new PanelIntegration(this._view, this._satellite.actor);
        this._panel.mount();

        // La scheda espansa vive fuori dal pannello: va costruita dopo il
        // mount, perche' si posiziona misurando dove sta la pillola.
        this._expanded = new ExpandedIsland(this._view);
        this._expanded.setAzioneApri(() => this._apriUltimaNotifica());

        this._unsub = this._manager.subscribe(vm => {
            this._view.setViewModel(vm);
            this._satellite.setAttivita(vm.satellite);
            // Mentre la scheda e' aperta il contenuto resta aggiornato: se la
            // canzone cambia, cambia sotto gli occhi invece di richiedere una
            // riapertura.
            if (this._expanded?.isOpen)
                this._expanded.setActivity(vm.flashing ?? vm.leading ?? vm.trailing);

            this._forseApriPerNotifica(vm);
        });

        this._interaction = new InteractionController(
            this._view, this._manager, this, this._expanded);

        // 250ms ticker to expire transients.
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._manager.tick();
            return GLib.SOURCE_CONTINUE;
        });

        this._tuttiIProvider = {
            'keyboard': KeyboardProvider,
            'power': PowerProvider,
            'volume-brightness': VolumeBrightnessProvider,
            'media': MediaProvider,
            'notification': NotificationProvider,
            'dbus': DBusProvider,
            'bluetooth': BluetoothProvider,
            'timer': TimerProvider,
            'transfers': TransfersProvider,
            'screencast': ScreencastProvider,
        };

        this._providers = [];
        this._accendiProvider(settings);

        this._settingsHandler = settings.connect('changed::providers-enabled', () => {
            this._spegniProvider();
            this._accendiProvider(settings);
        });
    }

    // Un provider che esplode all'accensione non deve portarsi dietro gli altri.
    //
    // Ognuno parla con un pezzo di sistema che puo' mancare o comportarsi in
    // modo diverso: BlueZ non installato, un Mutter senza il controllore degli
    // accessi remoti, un nome D-Bus gia' occupato. Senza isolamento, una sola
    // installazione insolita lascerebbe l'utente con l'isola morta e nessun
    // indizio su quale pezzo l'abbia uccisa — e' esattamente il modo in cui
    // un'estensione si guadagna la fama di essere rotta.
    _accendiProvider(settings) {
        const attivi = new Set(settings.get_strv('providers-enabled'));
        for (const [id, Classe] of Object.entries(this._tuttiIProvider)) {
            if (!attivi.has(id)) continue;
            try {
                const p = new Classe();
                p.enable(this._manager, settings);
                this._providers.push(p);
            } catch (e) {
                logError(e, `DynamicIsland: provider "${id}" non avviato`);
            }
        }
    }

    _spegniProvider() {
        for (const p of this._providers) {
            try { p.disable(); }
            catch (e) { logError(e, `DynamicIsland: provider "${p.id}" non spento`); }
        }
        this._providers = [];
    }

    // MODIFICA LOCALE: la notifica apre la scheda, non solo la pillola.
    //
    // Prima l'unico modo di aprire la scheda era il click, quindi una notifica
    // si riduceva a del testo dentro la pillola. Sulla Dynamic Island vera un
    // evento in arrivo fa aprire la sagoma e poi la fa richiudere: e' quello
    // il gesto, non una scritta che cambia.
    //
    // Solo le notifiche, pero'. Volume, luminosita' e tastiera restano nella
    // pillola: sono correzioni di un valore che stai gia' controllando tu, e
    // aprire una scheda a ogni tacca di volume sarebbe insopportabile.
    _forseApriPerNotifica(vm) {
        const f = vm.flashing;
        if (!f || f.providerId !== 'notification') return;

        // L'id dell'attivita' notifica e' sempre lo stesso ('...:aggregate'),
        // percio' da solo non distingue una notifica nuova da quella di prima:
        // serve anche startedAt. Senza questo, il ticker da 250 ms
        // riaprirebbe la scheda quattro volte al secondo.
        const chiave = `${f.id}@${f.startedAt}`;
        if (chiave === this._ultimaNotifica) return;
        this._ultimaNotifica = chiave;

        // La scheda resta aperta quanto dura il lampo sulla pillola, cosi' i
        // due elementi si spengono insieme invece che a distanza.
        const restanti = f.expiresAt !== undefined
            ? Math.round((f.expiresAt - _now()) / 1000)
            : 4000;

        // La pillola si allarga per prima: la scheda nasce sulla sua geometria,
        // quindi eredita una forma gia' in movimento invece di espandersi da un
        // punto fermo. E' quello che rende il passaggio un morph solo.
        // L'ultima notifica resta in memoria: cliccando la pillola si riapre,
        // anche molto dopo che si e' richiusa da sola.
        this._ultimaAttivita = f;

        this._view?.espandiPerNotifica?.(true);
        this._expanded?.peek(f, restanti);
        this._programmaScadenzaMemoria(restanti);

        // La pillola torna alla misura di riposo quando la scheda si e' gia'
        // richiusa sopra di lei: se rientrasse prima, si vedrebbe rimpicciolire
        // sotto la scheda ancora aperta.
        if (this._rientroId) GLib.source_remove(this._rientroId);
        this._rientroId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(1500, restanti) + 300, () => {
                this._rientroId = 0;
                this._view?.espandiPerNotifica?.(false);
                return GLib.SOURCE_REMOVE;
            });
    }

    // MODIFICA LOCALE: la pillola riapre l'ultima notifica.
    //
    // Sostituisce l'apertura del menu data/ora, che restava un gesto ereditato
    // dall'orologio di GNOME e non aveva niente a che fare con l'isola. Il
    // calendario resta comunque raggiungibile: l'orologio nativo e' li' nella
    // barra, spostato a sinistra da panel-integration.
    //
    // La scheda si riapre con la stessa animazione, come se il contenuto fosse
    // rimasto immagazzinato dentro la pillola — che nel frattempo e' tornata
    // piccola e vuota, senza traccia della notifica.
    riapriUltima() {
        if (!this._ultimaAttivita || !this._expanded) return false;

        this._view?.espandiPerNotifica?.(true);
        // Riaperta a mano: nessuna scadenza legata al lampo, resta il tempo di
        // leggerla. Se ci passi sopra col mouse non si chiude affatto.
        this._expanded.peek(this._ultimaAttivita, 5000);
        this._programmaScadenzaMemoria(5000);

        if (this._rientroId) GLib.source_remove(this._rientroId);
        this._rientroId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5300, () => {
            this._rientroId = 0;
            this._view?.espandiPerNotifica?.(false);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    // La memoria della notifica scade, e ogni riapertura fa ripartire il conto:
    // se la stai ancora consultando e' evidentemente ancora rilevante.
    _programmaScadenzaMemoria(dopoChiusuraMs) {
        if (this._memoriaId) GLib.source_remove(this._memoriaId);
        this._memoriaId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, dopoChiusuraMs + MEMORIA_MS, () => {
                this._memoriaId = 0;
                this._ultimaAttivita = null;
                return GLib.SOURCE_REMOVE;
            });
    }

    // Apre cio' a cui la notifica si riferisce, delegando al provider che
    // possiede l'oggetto notifica.
    _apriUltimaNotifica() {
        const p = (this._providers ?? []).find(x => x.id === 'notification');
        return p?.attivaUltima?.() ?? false;
    }

    disable() {
        this._ultimaAttivita = null;
        this._ultimaNotifica = null;
        if (this._memoriaId) { GLib.source_remove(this._memoriaId); this._memoriaId = 0; }
        if (this._rientroId) { GLib.source_remove(this._rientroId); this._rientroId = 0; }
        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
        if (this._settingsHandler) {
            this._settings?.disconnect(this._settingsHandler);
            this._settingsHandler = 0;
        }
        this._settings = null;
        this._spegniProvider();
        this._tuttiIProvider = null;

        // L'ordine conta, e in due punti.
        //
        // Il pallino si smonta DOPO il pannello: distruggerne l'attore mentre e'
        // ancora figlio del box centrale lascerebbe a unmount() un riferimento a
        // un oggetto gia' deallocato, e la prima chiamata su di lui — anche solo
        // get_parent() — finisce nel registro come uso di memoria liberata.
        //
        // E DOPO lo sganciamento dal gestore: finche' la sottoscrizione e' viva
        // ogni aggiornamento chiama setAttivita() sul pallino, e una notifica
        // in arrivo durante lo smontaggio lo troverebbe distrutto.
        //
        // E' la stessa ragione per cui la pillola era gia' l'ultima della fila.
        this._interaction?.destroy(); this._interaction = null;
        this._expanded?.destroy(); this._expanded = null;
        this._panel?.destroy(); this._panel = null;
        this._unsub?.(); this._unsub = null;
        this._view?.destroy(); this._view = null;
        this._satellite?.destroy(); this._satellite = null;
        this._manager?.destroy(); this._manager = null;
    }
}
