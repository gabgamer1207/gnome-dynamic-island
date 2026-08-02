// Vista espansa per la musica: copertina, controlli, avanzamento.
//
// Viene passata come activity.expandedView e ospitata dalla scheda espansa.
// Il provider ne tiene UNA per player e la riusa: se la ricreassimo a ogni
// aggiornamento di metadati (che arrivano di continuo) perderemmo lo stato e
// faremmo sfarfallare la copertina.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

export class MediaView {
    constructor(busName, proxy) {
        this._busName = busName;
        this._proxy = proxy;
        this._pollId = 0;
        this._durata = 0;          // µs
        this._artUrl = null;

        this.actor = new St.BoxLayout({
            vertical: true,
            style_class: 'dynisland-media',
            x_expand: true,
        });

        // --- riga controlli ---
        const controlli = new St.BoxLayout({
            style_class: 'dynisland-media-controls',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._btnPrec = this._bottone('media-skip-backward-symbolic', 'Previous');
        this._btnPlay = this._bottone('media-playback-pause-symbolic', null);
        this._btnSucc = this._bottone('media-skip-forward-symbolic', 'Next');

        // Play/pausa non e' un metodo fisso: dipende dallo stato corrente.
        this._btnPlay.connect('clicked', () => this._chiama('PlayPause'));

        controlli.add_child(this._btnPrec);
        controlli.add_child(this._btnPlay);
        controlli.add_child(this._btnSucc);

        // --- barra di avanzamento ---
        // Disegnata a mano: St non ha una progress bar, e un St.Slider
        // sarebbe interattivo, il che richiederebbe gestire il seek.
        this._barra = new St.Widget({
            style_class: 'dynisland-media-bar',
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._riempimento = new St.Widget({
            style_class: 'dynisland-media-bar-fill',
            x_align: Clutter.ActorAlign.START,
        });
        this._barra.add_child(this._riempimento);

        this._tempi = new St.BoxLayout({ style_class: 'dynisland-media-times' });
        this._tCorrente = new St.Label({ style_class: 'dynisland-media-time' });
        this._tTotale = new St.Label({
            style_class: 'dynisland-media-time',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this._tempi.add_child(this._tCorrente);
        this._tempi.add_child(this._tTotale);

        this.actor.add_child(controlli);
        this.actor.add_child(this._barra);
        this.actor.add_child(this._tempi);
    }

    _bottone(iconName, metodo) {
        const b = new St.Button({
            style_class: 'dynisland-media-button',
            child: new St.Icon({ icon_name: iconName, icon_size: 20 }),
            can_focus: true,
        });
        if (metodo) b.connect('clicked', () => this._chiama(metodo));
        return b;
    }

    _chiama(metodo) {
        this._proxy?.call(metodo, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    // Aggiorna icona play/pausa, durata e copertina.
    update(metadata, status) {
        this._btnPlay.child.icon_name = status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        const len = metadata['mpris:length'];
        this._durata = Number(len?.deepUnpack?.() ?? len ?? 0);
        this._tTotale.text = this._formatta(this._durata);
        const haDurata = this._durata > 0;
        this._barra.visible = haDurata;
        this._tempi.visible = haDurata;

        const art = metadata['mpris:artUrl']?.deepUnpack?.() ?? metadata['mpris:artUrl'] ?? null;
        this._artUrl = typeof art === 'string' ? art : null;
    }

    // La copertina la espone il provider, che la mette nell'icona della scheda:
    // solo file locali, un URL remoto andrebbe scaricato e non ne vale la pena.
    get gicon() {
        if (!this._artUrl?.startsWith('file://')) return null;
        try { return new Gio.FileIcon({ file: Gio.File.new_for_uri(this._artUrl) }); }
        catch (_) { return null; }
    }

    // L'avanzamento si legge solo a richiesta: Position cambia in continuazione
    // e i player non emettono PropertiesChanged per lei. Quindi si interroga,
    // ma solo mentre la scheda e' aperta: fuori di li' sarebbe spreco puro.
    startPolling() {
        this.stopPolling();
        this._leggiPosizione();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._leggiPosizione();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopPolling() {
        if (this._pollId) { GLib.source_remove(this._pollId); this._pollId = 0; }
    }

    _leggiPosizione() {
        if (!this._durata) return;
        Gio.DBus.session.call(
            this._busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            null, Gio.DBusCallFlags.NONE, 1000, null,
            (conn, res) => {
                let pos = 0;
                try { pos = Number(conn.call_finish(res).deepUnpack()[0].deepUnpack()); }
                catch (_) { return; }          // player che non espone Position
                this._applicaPosizione(pos);
            });
    }

    _applicaPosizione(pos) {
        const frazione = Math.max(0, Math.min(1, pos / this._durata));
        const larghezza = this._barra.get_width();
        if (larghezza > 0) {
            this._riempimento.ease({
                width: Math.round(larghezza * frazione),
                duration: 900,                  // poco meno del polling: scorre liscia
                mode: Clutter.AnimationMode.LINEAR,
            });
        }
        this._tCorrente.text = this._formatta(pos);
    }

    _formatta(microsecondi) {
        const s = Math.max(0, Math.floor(microsecondi / 1000000));
        const m = Math.floor(s / 60);
        return `${m}:${String(s % 60).padStart(2, '0')}`;
    }

    destroy() {
        this.stopPolling();
        this.actor.destroy();
        this.actor = null;
        this._proxy = null;
    }
}
