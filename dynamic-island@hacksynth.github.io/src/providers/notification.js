import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { createActivity, _now } from '../activity.js';
import { gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from '../i18n.js';

export class NotificationProvider {
    constructor() {
        this.id = 'notification';
        this._manager = null;
        this._settings = null;
        this._tray = null;
        this._trayHandlers = [];
        this._sourceHandlers = new Map();         // source → handler id
        this._notificationHandlers = new Map();   // notification → handler id
        this._active = new Set();
    }

    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;
        this._tray = Main.messageTray;

        // MODIFICA LOCALE: sopprime i banner nativi di GNOME.
        //
        // Senza questo la notifica compariva DUE volte: il riquadro standard
        // sotto la barra, staccato, piu' il testo sull'isola. Due oggetti per
        // lo stesso evento, che e' esattamente cio' che l'isola dovrebbe
        // evitare.
        //
        // Il contenuto completo resta raggiungibile: il click sull'isola apre
        // la lista notifiche, quindi non si perde niente.
        this._bannerBlockedPrima = this._tray.bannerBlocked;
        this._tray.bannerBlocked = true;

        this._trayHandlers.push(
            this._tray.connect('source-added', (_t, source) => this._bindSource(source)),
            this._tray.connect('source-removed', (_t, source) => this._unbindSource(source)),
        );
        for (const src of this._tray.getSources()) this._bindSource(src);
    }

    disable() {
        if (!this._tray) return;

        // Ripristina i banner nativi: se l'estensione viene disattivata, le
        // notifiche devono tornare a comparire come prima.
        if (this._bannerBlockedPrima !== undefined) {
            this._tray.bannerBlocked = this._bannerBlockedPrima;
            this._bannerBlockedPrima = undefined;
        }

        for (const id of this._trayHandlers) this._tray.disconnect(id);
        this._trayHandlers = [];

        for (const [source, id] of this._sourceHandlers) {
            try { source.disconnect(id); } catch (_) {}
        }
        this._sourceHandlers.clear();

        for (const [notif, id] of this._notificationHandlers) {
            try { notif.disconnect(id); } catch (_) {}
        }
        this._notificationHandlers.clear();

        this._active.clear();
        this.ultima = null;
        this.ultimaApp = null;
        this._manager?.remove(`${this.id}:aggregate`);
        this._manager = null;
        this._tray = null;
    }

    // Apre cio' a cui la notifica si riferisce. Torna true se ha funzionato,
    // cosi' chi chiama sa se ha senso chiudere la scheda.
    //
    // Due strade, e l'ordine conta.
    //
    // 1. L'applicazione associata alla notifica. GNOME la ricava dal
    //    suggerimento 'desktop-entry' che il mittente allega, e la espone come
    //    source.app: lanciarla o metterla a fuoco e' cio' che l'utente si
    //    aspetta cliccando una notifica.
    //
    // 2. notification.activate(), che emette il segnale tradotto dal demone
    //    nell'azione predefinita della notifica. Funziona quando il mittente
    //    e' rimasto in ascolto — un'applicazione vera, di solito — ma cade nel
    //    vuoto con chi invia e se ne va, come notify-send.
    //
    // La prima e' piu' affidabile proprio perche' non dipende dal mittente:
    // l'associazione all'app resta anche quando il processo che ha inviato la
    // notifica non esiste piu'.
    attivaUltima() {
        const n = this.ultima;

        try {
            if (this.ultimaApp?.activate) { this.ultimaApp.activate(); return true; }
        } catch (_) { /* si prova l'altra strada */ }

        // Ripiego: l'azione predefinita della notifica, se e' ancora viva.
        try {
            if (n) { n.activate(); return true; }
        } catch (_) { /* niente da fare */ }

        return false;
    }

    _bindSource(source) {
        if (this._sourceHandlers.has(source)) return;
        const id = source.connect('notification-added', (_s, n) => {
            const excluded = this._settings?.get_strv('notification-excluded-apps') ?? [];
            if (source.app?.get_id && excluded.includes(source.app.get_id())) return;

            // MODIFICA LOCALE: si conserva l'oggetto notifica, non solo il testo.
            //
            // Serve per aprire davvero cio' a cui la notifica si riferisce:
            // notification.activate() lancia o mette a fuoco l'applicazione che
            // l'ha inviata, esattamente come cliccarla nel centro notifiche.
            // Prima si estraevano label e sublabel e l'oggetto veniva perso,
            // quindi il click non poteva portare da nessuna parte.
            // MODIFICA LOCALE (2): si conserva l'APPLICAZIONE, non la notifica.
            //
            // La sonda ha mostrato `haNotifica=false` al momento del click:
            // GNOME distrugge la notifica quasi subito, mentre la scheda che la
            // mostra e' ancora aperta e cliccabile. Tenere il riferimento non
            // servirebbe comunque — un oggetto distrutto non si puo' attivare.
            //
            // Quello che serve e' l'applicazione associata, che GNOME ricava dal
            // suggerimento 'desktop-entry'. E' un oggetto suo, vive quanto la
            // sessione, e sopravvive tranquillamente alla notifica che l'ha
            // fatta conoscere. Va letta ADESSO, finche' la sorgente esiste.
            this.ultima = n;
            try {
                this.ultimaApp = n.source?.app ?? null;
            } catch (_) {
                this.ultimaApp = null;
            }
            this._active.add(n);
            const destroyId = n.connect('destroy', () => {
                // Si azzera solo la notifica: l'applicazione resta, ed e' quella
                // che serve al click.
                if (this.ultima === n) this.ultima = null;
                this._notificationHandlers.delete(n);
                this._active.delete(n);
                // Nessun lampeggio quando una notifica viene solo chiusa:
                // sarebbe un'animazione per un evento che l'utente ha gia'
                // gestito lui.
                this._rebuild({ flash: false });
            });
            this._notificationHandlers.set(n, destroyId);
            this._rebuild({ flash: true });
        });
        this._sourceHandlers.set(source, id);
    }

    _unbindSource(source) {
        const id = this._sourceHandlers.get(source);
        if (id !== undefined) {
            try { source.disconnect(id); } catch (_) {}
            this._sourceHandlers.delete(source);
        }
    }

    // MODIFICA LOCALE: la notifica ora e' un lampo, non uno stato.
    //
    // Prima l'attivita' era 'persistent' e senza scadenza: spariva solo quando
    // TUTTE le notifiche venivano distrutte. Ma GNOME le tiene nel centro
    // notifiche finche' non le chiudi a mano, quindi in pratica l'isola restava
    // occupata a tempo indeterminato — il testo incollato li' e la pillola
    // bloccata in stato 'compact' invece di tornare al pallino.
    //
    // Ora e' 'transient' con expiresAt, come volume e tastiera: compare,
    // si legge, si ritira da sola. Il conteggio completo resta comunque nel
    // centro notifiche, che e' il posto giusto per conservarlo.
    _rebuild({ flash = false } = {}) {
        const n = this._active.size;
        if (n === 0) {
            this._manager?.remove(`${this.id}:aggregate`);
            return;
        }
        if (!flash) return;

        const threshold = this._settings?.get_int('notification-coalesce-threshold') ?? 3;
        let label, sublabel;
        if (n < threshold) {
            const latest = [...this._active].pop();
            // Fallback when the source provides no title — translatable.
            // Notification title/body itself comes from the source app and is
            // intentionally NOT translated here.
            label = latest.title ?? latest.source?.title ?? _('Notification');
            sublabel = latest.bannerBodyText ?? latest.body ?? '';
        } else {
            label = format(ngettext('%d new', '%d new', n), n);
            sublabel = _('Notifications');
        }

        // Una notifica va letta, non solo intravista: il minimo e' 5 secondi
        // anche se le transizioni generiche sono impostate piu' corte.
        //
        // MODIFICA LOCALE: da 3 a 5 secondi. Tre bastano a capire che e'
        // arrivato qualcosa, non a leggerlo e decidere se aprirlo — e
        // soprattutto non a portarci sopra il mouse, che e' il gesto con cui
        // si chiede alla scheda di restare. Un tempo troppo corto rende quel
        // gesto impossibile, e quindi inutile averlo previsto.
        const base = this._settings?.get_int('transient-duration-ms') ?? 1500;
        const durata = Math.max(base, 5000) * 1000;
        const adesso = _now();

        this._manager?.update(createActivity({
            id: `${this.id}:aggregate`,
            providerId: this.id,
            tier: 'transient',
            slot: 'trailing',
            label, sublabel,
            startedAt: adesso,
            expiresAt: adesso + durata,
        }));
    }
}
