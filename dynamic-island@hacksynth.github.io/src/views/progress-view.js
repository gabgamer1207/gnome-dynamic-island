// Barra di avanzamento generica per le attivita' spinte via D-Bus.
//
// Serve a tutto cio' che ha una percentuale: un backup, una trascrizione,
// un download, una compilazione. Volutamente minima: chi spinge l'attivita'
// mette il testo, qui c'e' solo la barra e la percentuale.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class ProgressView {
    constructor() {
        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dynisland-progress',
            x_expand: true,
        });

        this._barra = new St.Widget({
            style_class: 'dynisland-media-bar',      // stesso stile della musica
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._riempimento = new St.Widget({
            style_class: 'dynisland-media-bar-fill',
            x_align: Clutter.ActorAlign.START,
        });
        this._barra.add_child(this._riempimento);

        this._percentuale = new St.Label({
            style_class: 'dynisland-media-time',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });

        this.actor.add_child(this._barra);
        this.actor.add_child(this._percentuale);

        this._frazione = 0;
    }

    setProgress(frazione) {
        this._frazione = Math.max(0, Math.min(1, Number(frazione) || 0));
        this._percentuale.text = `${Math.round(this._frazione * 100)}%`;

        const larghezza = this._barra.get_width();
        if (larghezza <= 0) return;   // non ancora allocata: si aggiorna al giro dopo

        this._riempimento.ease({
            width: Math.round(larghezza * this._frazione),
            // Abbastanza lenta da leggersi come progresso, abbastanza rapida
            // da non restare indietro se gli aggiornamenti sono fitti.
            duration: 400,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
    }
}
