import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import { createActivity, _now } from '../activity.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from '../i18n.js';

// GvcMixerControl has no 'default-sink-volume-changed' signal. Subscribe to the
// default sink's notify::volume / notify::is-muted and rebind when the default
// sink itself changes.

export class VolumeBrightnessProvider {
    constructor() {
        this.id = 'volume-brightness';
        this._manager = null;
        this._settings = null;
        this._origShow = null;
        this._volControl = null;
        this._controlHandler = 0;
        this._sink = null;
        this._sinkHandlers = [];
    }

    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;

        // MODIFICA LOCALE: una sola sorgente, e con la firma giusta.
        //
        // Qui c'erano DUE percorsi che scattavano allo stesso evento:
        //
        //   1. l'ascolto diretto di notify::volume sul canale audio;
        //   2. la sostituzione di osdWindowManager.show, l'indicatore di GNOME.
        //
        // Il secondo pero' leggeva il livello da args[2], mentre la firma reale
        // e' show(monitor, icona, etichetta, livello, massimo): args[2] e'
        // l'ETICHETTA. Number.isFinite di una stringa e' falso, quindi quel
        // percorso non mostrava mai niente — ma sostituendo la funzione
        // sopprimeva comunque l'indicatore nativo, senza rimpiazzarlo.
        //
        // Restava solo il primo percorso, che ascolta il canale audio: arriva
        // quando PipeWire propaga la modifica, non quando premi il tasto. Da
        // qui il ritardo. E la luminosita' non compariva mai, perche' non passa
        // da nessun canale audio: passa solo dall'indicatore.
        //
        // Ora si usa solo l'indicatore, con gli argomenti giusti. E' il punto
        // in cui GNOME stesso decide che serve un riscontro visivo: usare lo
        // stesso momento significa comparire quando l'utente se lo aspetta, e
        // coprire volume e luminosita' con un percorso solo.
        // MODIFICA LOCALE (2): la sostituzione dell'indicatore e' morta.
        //
        // La sonda ha dato la risposta definitiva: osdWindowManager.show NON
        // VIENE MAI CHIAMATA in GNOME 50. Sostituirla non intercetta niente —
        // e infatti, appena tolto l'ascolto del canale audio, il volume e'
        // sparito del tutto invece di comparire meglio.
        //
        // Era una correzione basata su un'ipotesi (la firma sbagliata) che
        // sembrava spiegare il ritardo. La firma ERA sbagliata, ma non era
        // quella la causa: quel percorso non era mai stato attivo.
        //
        // Resta quindi l'unica strada che funziona davvero: ascoltare il
        // canale audio. Arriva quando PipeWire propaga la modifica, quindi con
        // un ritardo minimo — ma arriva, ed e' meglio di un percorso elegante
        // che non viene mai eseguito.
        this._volControl = Volume.getMixerControl();
        this._controlHandler = this._volControl.connect('default-sink-changed', (_c, id) => {
            this._rebindSink(this._volControl.lookup_stream_id(id));
        });
        this._rebindSink(this._volControl.get_default_sink());
    }

    disable() {
        this._unbindSink();
        if (this._volControl && this._controlHandler) {
            try { this._volControl.disconnect(this._controlHandler); } catch (_) {}
        }
        this._volControl = null;
        this._controlHandler = 0;
        if (this._origShow) { Main.osdWindowManager.show = this._origShow; this._origShow = null; }
        this._manager?.remove(`${this.id}:flash`);
        this._manager = null;
    }

    _unbindSink() {
        if (this._sink) {
            for (const h of this._sinkHandlers) {
                try { this._sink.disconnect(h); } catch (_) {}
            }
        }
        this._sinkHandlers = [];
        this._sink = null;
    }

    _rebindSink(sink) {
        this._unbindSink();
        if (!sink) return;
        this._sink = sink;
        this._sinkHandlers.push(
            sink.connect('notify::volume', () => this._flashVolume(sink)),
            sink.connect('notify::is-muted', () => this._flashVolume(sink)),
        );
    }

    _flashVolume(sink) {
        if (!sink || !this._volControl) return;
        const pct = Math.round((sink.volume / this._volControl.get_vol_max_norm()) * 100);
        this._flashGeneric(sink.is_muted ? _('Muted') : _('Volume'), pct);
    }

    _flashGeneric(name, pct) {
        if (!this._manager) return;
        const duration = (this._settings?.get_int('transient-duration-ms') ?? 1500) * 1000;
        const now = _now();
        this._manager.push(createActivity({
            id: `${this.id}:flash`,
            providerId: this.id,
            tier: 'transient',
            slot: 'either',
            label: format('%s %d%%', name, pct),
            startedAt: now,
            expiresAt: now + duration,
        }));
    }
}
