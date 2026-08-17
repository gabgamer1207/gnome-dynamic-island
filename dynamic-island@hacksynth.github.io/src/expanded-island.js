// La scheda espansa: quello che il pannello di GNOME non puo' contenere.
//
// #panel ha un'altezza fissa (2.2em) e NON cresce per contenere i figli.
// Qualunque cosa viva dentro Main.panel._centerBox puo' allargarsi ma mai
// diventare piu' alta. La Dynamic Island vera pero' non si allarga nel
// pannello: scende sotto. Per farlo serve un attore che dal pannello esca.
//
// Questa scheda vive quindi in Main.layoutManager (top chrome), posizionata
// a mano sotto il centro del pannello, senza vincoli di dimensione.
//
// Il trucco che rende credibile il morph: la scheda NON compare sotto la
// pillola. Nasce esattamente sopra di essa, con la sua stessa geometria e lo
// stesso raggio, e da li' cresce. L'occhio legge un oggetto solo che cambia
// forma invece di due elementi che si danno il cambio.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { mollaApertura, mollaChiusura, applicaMolla } from './spring.js';
import { anima } from './anima.js';

// Piu' larga di prima (erano 420): il nastro di scelta del timer vive di
// margine — piu' pixel significano piu' minuti visibili ai due lati dell'indice,
// cioe' meno trascinamento per arrivare dove vuoi. E' un massimo, non una
// misura fissa: le schede che non hanno bisogno di tanto restano piccole.
const LARGHEZZA_MAX = 480;
const MARGINE_SCHERMO = 24;
const RAGGIO_SCHEDA = 22;

// Margine dopo che il puntatore lascia la scheda, prima che si richiuda.
// Uscire dalla scheda e' spesso un movimento di passaggio, non una decisione.
const RAFFREDDAMENTO = 2000;

// MODIFICA LOCALE: tempi allungati.
//
// Erano 400 ms in apertura e 320 in chiusura. Con una molla servono di piu':
// il sorpasso e il rientro sono parte del movimento, e comprimerli in 400 ms
// li rende un guizzo invece di un assestamento. iOS sta intorno al mezzo
// secondo, ed e' lo stesso ordine di grandezza scelto qui.
const DURATA_APERTURA = 540;
const DURATA_CHIUSURA = 420;

export class ExpandedIsland {
    constructor(pill) {
        this._pill = pill;
        this._aperta = false;
        this._chiusuraId = 0;

        // Fondale trasparente a tutto schermo: intercetta i click fuori dalla
        // scheda per richiuderla. Preferito a un grab modale, che ruba la
        // tastiera a tutto il sistema e puo' fallire.
        this._fondale = new St.Widget({
            reactive: true,
            visible: false,
            style_class: 'dynisland-backdrop',
        });
        this._fondale.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });

        this._scheda = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: true,
            visible: false,
            style_class: 'dynisland-card',
        });
        this._scheda.set_pivot_point(0.5, 0.0);   // cresce verso il basso

        // MODIFICA LOCALE: la scheda e' cliccabile e trattiene il puntatore.
        //
        //   click  -> apre cio' a cui la notifica si riferisce, poi si chiude
        //   sopra  -> la chiusura automatica si sospende: stai leggendo
        //   via    -> riparte, ma con un margine di 2 secondi
        //
        // Il margine serve perche' uscire dalla scheda e' spesso un movimento
        // di passaggio, non una decisione: chiudere all'istante costringe a
        // rincorrerla col mouse.
        this._scheda.track_hover = true;
        this._scheda.connect('button-press-event', (_a, ev) => {
            // MODIFICA LOCALE: i comandi dentro la scheda vengono prima.
            //
            // Rendere cliccabile tutta la scheda ha un effetto collaterale: i
            // pulsanti che vivono al suo interno — riproduzione, avanti,
            // indietro della vista musica — stanno DENTRO l'area cliccabile.
            // Premendone uno, l'evento raggiungeva anche questo gestore, che
            // apriva il lettore e chiudeva la scheda. Il comando partiva
            // davvero, ma sembrava non funzionare perche' nel frattempo tutto
            // spariva.
            //
            // Se il click e' nato su un pulsante, o dentro qualcosa che ne
            // contiene uno, non e' un click "sulla scheda": e' un comando, e
            // va lasciato a chi lo gestisce.
            let a = ev.get_source();
            while (a && a !== this._scheda) {
                if (a instanceof St.Button) return Clutter.EVENT_PROPAGATE;
                a = a.get_parent();
            }

            if (this._onAttiva?.()) this.close();
            return Clutter.EVENT_STOP;
        });
        this._scheda.connect('enter-event', () => {
            this._sospesa = true;
            if (this._chiusuraId) { GLib.source_remove(this._chiusuraId); this._chiusuraId = 0; }
            return Clutter.EVENT_PROPAGATE;
        });
        this._scheda.connect('leave-event', () => {
            this._sospesa = false;
            if (this._aperta) this._programmaChiusura(RAFFREDDAMENTO);
            return Clutter.EVENT_PROPAGATE;
        });

        this._scheda.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // --- riga principale: icona + testi ---
        this._riga = new St.BoxLayout({ style_class: 'dynisland-card-row' });

        this._icona = new St.Icon({
            style_class: 'dynisland-card-icon',
            icon_name: 'application-x-executable-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._riga.add_child(this._icona);

        const testi = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'dynisland-card-text',
        });
        this._titolo = new St.Label({ style_class: 'dynisland-card-title' });
        this._sottotitolo = new St.Label({ style_class: 'dynisland-card-subtitle' });
        this._titolo.clutter_text.ellipsize = 3;        // PANGO_ELLIPSIZE_END
        this._sottotitolo.clutter_text.ellipsize = 3;
        testi.add_child(this._titolo);
        testi.add_child(this._sottotitolo);
        this._riga.add_child(testi);

        this._scheda.add_child(this._riga);

        // Contenitore per la vista che il provider puo' fornire (activity.expandedView).
        this._slotProvider = new St.Bin({ x_expand: true, visible: false });
        this._scheda.add_child(this._slotProvider);

        this._vistaProvider = null;

        // MODIFICA LOCALE: rimosso { affectsInputRegion: true }.
        //
        // GNOME Shell 50 non accetta piu' quel parametro: Params.parse solleva
        // "Unrecognized parameter" e l'eccezione interrompe enable(), quindi
        // l'estensione restava in stato ERROR e l'isola non compariva affatto.
        //
        // Nelle versioni in cui l'opzione esisteva il suo valore predefinito
        // era comunque true, percio' ometterla non cambia il comportamento:
        // gli attori restano cliccabili come prima.
        Main.layoutManager.addTopChrome(this._fondale);
        Main.layoutManager.addTopChrome(this._scheda);
    }

    get isOpen() { return this._aperta; }

    // Chi possiede la scheda decide cosa significhi "aprire" la notifica.
    // La scheda non deve sapere niente di provider ne' di message tray.
    setAzioneApri(fn) { this._onAttiva = fn; }

    // --------------------------------------------------------------- contenuto
    setActivity(act) {
        this._attivita = act ?? null;

        if (!act) {
            this._titolo.text = _('Nothing happening');
            this._sottotitolo.text = '';
            this._sottotitolo.visible = false;
            this._icona.icon_name = 'preferences-system-time-symbolic';
            this._riga.visible = true;
            this._staccaVistaProvider();
            return;
        }

        // MODIFICA LOCALE: una vista puo' dichiarare di presentarsi da sola.
        //
        // La riga standard — icona, titolo, sottotitolo — va bene per una
        // notifica, dove il contenuto E' testo. Non va bene per il timer e per
        // la registrazione, che nella loro vista mostrano gia' nome e tempo, in
        // grande e colorati: la riga sopra scriverebbe le stesse due cose una
        // seconda volta, in piccolo e in grigio.
        //
        // La convenzione e' la stessa dei due hook qui sotto: un campo
        // sull'attore, che chi non lo conosce semplicemente non imposta. La
        // vista della musica non lo imposta, e per lei non cambia niente.
        this._riga.visible = !act.expandedView?._dynIslandRigaPropria;

        this._titolo.text = act.label ?? '';
        this._sottotitolo.text = act.sublabel ?? '';
        this._sottotitolo.visible = !!act.sublabel;

        if (act.glyph?.icon) this._icona.gicon = act.glyph.icon;
        else this._icona.icon_name = 'view-more-symbolic';

        // Vista personalizzata del provider, se c'e'. Non la distruggiamo mai:
        // e' roba sua, noi la ospitiamo e basta.
        if (act.expandedView === this._vistaProvider) return;   // gia' montata

        this._staccaVistaProvider();
        if (act.expandedView) {
            this._vistaProvider = act.expandedView;
            this._slotProvider.set_child(act.expandedView);
            this._slotProvider.visible = true;
            // Convenzione: la vista puo' esporre due hook per sapere quando e'
            // davvero sullo schermo. Serve a non far girare timer e polling
            // quando la scheda e' chiusa e nessuno guarda.
            if (this._aperta) act.expandedView._dynIslandShow?.();
        }
    }

    _staccaVistaProvider() {
        if (this._vistaProvider) {
            // La vista appartiene al provider, che puo' averla gia' distrutta
            // quando la sua attivita' e' finita — un timer che scade, delle
            // cuffie scollegate. Il riferimento qui resta valido come oggetto
            // JavaScript ma l'attore sotto non c'e' piu', e chiamarne l'aggancio
            // di chiusura tocca campi di memoria liberata: nel registro compare
            // "already deallocated", e nei casi peggiori la scheda non si apre
            // piu' per il resto della sessione.
            //
            // Non e' un caso raro da manuale: succede ogni volta che un'attivita'
            // con vista propria termina mentre la scheda e' chiusa.
            try { this._vistaProvider._dynIslandHide?.(); }
            catch (_) { /* attore gia' andato: non c'e' niente da fermare */ }
            this._slotProvider.set_child(null);
            this._vistaProvider = null;
        }
        this._slotProvider.visible = false;
    }

    // ------------------------------------------------------------- geometria
    _rettangoloPillola() {
        const [x, y] = this._pill.get_transformed_position();
        const [w, h] = this._pill.get_transformed_size();
        return { x, y, w: Math.max(w, 1), h: Math.max(h, 1) };
    }

    _rettangoloScheda() {
        const monitor = Main.layoutManager.primaryMonitor;
        const pill = this._rettangoloPillola();

        // MODIFICA LOCALE: la larghezza la decide il contenuto.
        //
        // Era sempre e comunque il massimo. Per una notifica andava bene, ma il
        // timer in corsa ha dentro due pulsanti, un anello e quattro cifre: su
        // 480 pixel restava una voragine nera in mezzo, e la scheda sembrava
        // rotta invece che spaziosa. Allargare il massimo per far respirare il
        // nastro del timer aveva peggiorato proprio questo caso.
        //
        // Il minimo serve perche' una scheda strettissima non si legge come la
        // stessa cosa da cui e' nata la pillola: sotto una certa larghezza
        // sembrerebbe un tooltip.
        const [, wNaturale] = this._scheda.get_preferred_width(-1);
        const w = Math.max(300, Math.min(
            LARGHEZZA_MAX, wNaturale, monitor.width - MARGINE_SCHERMO * 2));
        const [, hNaturale] = this._scheda.get_preferred_height(w);
        const h = Math.max(hNaturale, 96);

        // Centrata sulla pillola, ma senza uscire dallo schermo.
        let x = pill.x + pill.w / 2 - w / 2;
        x = Math.max(monitor.x + MARGINE_SCHERMO,
                     Math.min(x, monitor.x + monitor.width - w - MARGINE_SCHERMO));

        // Parte leggermente sovrapposta al pannello: la scheda deve sembrare
        // uscita da li', non comparsa piu' sotto.
        const y = pill.y + pill.h - 6;

        return { x, y, w, h };
    }

    // ------------------------------------------------------------- apertura
    // MODIFICA LOCALE: niente piu' fondale, nemmeno all'apertura manuale.
    //
    // Il fondale e' un attore trasparente grande quanto lo schermo, che serviva
    // a chiudere la scheda cliccando fuori. Il costo pero' e' che intercetta
    // OGNI click: con la scheda aperta non si poteva piu' cliccare nessuna
    // finestra sottostante finche' non la si chiudeva. Per una cosa che si apre
    // da sola all'arrivo di una notifica, e' inaccettabile — blocca il computer
    // per un elemento che nessuno ha chiesto.
    //
    // Non serve piu' comunque: la scheda si chiude gia' da sola quando il
    // puntatore la lascia, dopo il raffreddamento, e con Escape. Cliccare fuori
    // per chiudere era un terzo modo, il piu' costoso dei tre.
    open() { this._apri({ fondale: false, focus: true }); }

    // MODIFICA LOCALE: apertura automatica, per le notifiche.
    //
    // Stessa animazione del click — la scheda nasce dalla pillola e ci rientra
    // — ma con due differenze che contano quando non l'hai chiesta tu:
    //
    //   - niente fondale. Un rettangolo invisibile a tutto schermo che si mangia
    //     il primo click e' accettabile se la scheda l'hai aperta tu, e' un
    //     furto se e' comparsa da sola mentre stavi lavorando.
    //   - niente grab della tastiera, per lo stesso motivo.
    //
    // Se ne arriva un'altra mentre e' gia' aperta, aggiorna il contenuto e
    // rimanda la chiusura invece di chiudere e riaprire: due animazioni
    // consecutive sullo stesso oggetto si leggono come un difetto.
    peek(act, durataMs) {
        if (act) this.setActivity(act);
        if (!this._aperta) this._apri({ fondale: false, focus: false });
        this._programmaChiusura(durataMs ?? 4000);
    }

    _programmaChiusura(ms) {
        if (this._chiusuraId) { GLib.source_remove(this._chiusuraId); this._chiusuraId = 0; }
        // Se il puntatore e' sulla scheda, la stai leggendo: nessun timer.
        // Ripartira' da solo al leave-event.
        if (this._sospesa) return;
        this._chiusuraId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(1500, Math.round(ms)), () => {
                this._chiusuraId = 0;
                this.close();
                return GLib.SOURCE_REMOVE;
            });
    }

    _apri({ fondale = true, focus = true } = {}) {
        if (this._aperta) return;
        this._aperta = true;

        if (this._chiusuraId) {
            GLib.source_remove(this._chiusuraId);
            this._chiusuraId = 0;
        }

        if (fondale) {
            const monitor = Main.layoutManager.primaryMonitor;
            this._fondale.set_position(monitor.x, monitor.y);
            this._fondale.set_size(monitor.width, monitor.height);
            this._fondale.show();
        } else {
            // MODIFICA LOCALE (12): un'apertura automatica spegne sempre il
            // fondale, anche se non e' stata lei ad accenderlo.
            //
            // Il fondale e' trasparente ma reattivo, e copre tutto lo schermo:
            // se resta acceso da un'apertura manuale precedente, si mangia
            // ogni click senza che si veda niente. Un difetto invisibile per
            // definizione, ed e' il peggior tipo.
            this._fondale.hide();
        }

        const p = this._rettangoloPillola();

        this._scheda.remove_all_transitions();
        this._scheda.opacity = 0;
        // Lo stile va azzerato PRIMA di misurare: se restasse il min/max
        // height dell'animazione precedente, l'altezza naturale misurata
        // sarebbe quella imposta allora e la scheda non crescerebbe mai.
        this._scheda.style = null;
        this._scheda.show();

        // Va misurata da visibile, altrimenti l'altezza naturale e' zero.
        const a = this._rettangoloScheda();

        // La scheda nasce con la geometria esatta della pillola e ci cresce
        // fuori: e' questo che fa leggere un oggetto solo che cambia forma
        // invece di due elementi che si danno il cambio.
        this._animaScheda(
            { x: p.x, y: p.y - p.h, w: p.w, h: p.h, r: Math.round(p.h / 2), op: 0, pillOp: 255 },
            { x: a.x, y: a.y, w: a.w, h: a.h, r: RAGGIO_SCHEDA, op: 255, pillOp: 0 },
            DURATA_APERTURA, mollaApertura,
        );

        // Il contenuto entra in ritardo sulla forma. E' il dettaglio che
        // separa "si e' aperto qualcosa" da "quella cosa e' diventata questa".
        // Il ritardo e' cresciuto con la durata: deve cadere quando la scheda
        // ha gia' preso quasi tutto lo spazio, non mentre si sta ancora
        // allargando, o il testo sembra trascinato.
        this._riga.opacity = 0;
        this._riga.translation_y = 12;
        this._riga.ease({
            opacity: 255, translation_y: 0,
            duration: 340, delay: 170,
            mode: this._mode('EASE_OUT_CUBIC'),
        });

        this._vistaProvider?._dynIslandShow?.();
        if (focus) this._scheda.grab_key_focus();
    }

    close() {
        if (!this._aperta) return;
        this._aperta = false;

        if (this._chiusuraId) { GLib.source_remove(this._chiusuraId); this._chiusuraId = 0; }

        const p = this._rettangoloPillola();
        const [x, y] = this._scheda.get_position();
        const [w, h] = this._scheda.get_size();

        this._scheda.remove_all_transitions();
        // Il contenuto esce per primo e in fretta: la scheda deve poter
        // rimpicciolire su se stessa, non su del testo che si accartoccia.
        this._riga.ease({
            opacity: 0, translation_y: 8,
            duration: 140,
            mode: this._mode('EASE_IN_QUAD'),
        });

        // Si parte da dove la scheda si trova ADESSO, non dalla misura piena:
        // se la chiusura arriva mentre l'apertura e' ancora in corso, partire
        // dal bersaglio teorico farebbe un salto.
        this._animaScheda(
            { x, y, w, h, r: RAGGIO_SCHEDA, op: this._scheda.opacity, pillOp: this._pill.opacity },
            { x: p.x, y: p.y - p.h, w: p.w, h: p.h, r: Math.round(p.h / 2), op: 0, pillOp: 255 },
            DURATA_CHIUSURA, mollaChiusura,
            () => {
                this._scheda.hide();
                this._scheda.style = null;
                this._fondale.hide();
                this._staccaVistaProvider();
            },
        );
    }

    toggle() { this._aperta ? this.close() : this.open(); }

    // MODIFICA LOCALE (7): tutta la geometria interpolata a mano.
    //
    // Le sonde hanno mostrato la scheda ferma sulla geometria iniziale:
    // size=469x25 pos=823,-24 opacity=21, cioe' altezza di partenza, posizione
    // di partenza (sopra il bordo dello schermo, dietro la barra) e quasi
    // trasparente. Le transizioni di ease() su x, y, width, height e opacity
    // non avanzavano — lo stesso difetto gia' trovato sulla pillola, dove la
    // larghezza restava inchiodata a 82.
    //
    // Su St non ci si puo' affidare a ease() per la geometria: la dimensione
    // la decidono CSS e contenuto, e la richiesta di Clutter viene scartata al
    // layout. L'unica leva affidabile e' lo stile, imposto fotogramma per
    // fotogramma. min e max insieme perche' uno solo dei due lascerebbe al
    // contenuto la liberta' di decidere l'altro.
    //
    // Un solo timer per tutto: posizione, dimensione, opacita' e raggio si
    // muovono nello stesso istante e con la stessa curva. Prima il raggio
    // aveva un timer suo, e bastava quello a farlo sfasare rispetto al bordo.
    _animaScheda(da, a, durata, curva, allaFine) {
        // MODIFICA LOCALE (12): l'animazione interrotta esegue comunque la sua
        // pulizia.
        //
        // Ogni nuova animazione sostituiva il timer della precedente, e la
        // funzione finale di quella interrotta non veniva mai eseguita. Se a
        // essere interrotta era una chiusura, la scheda restava sullo schermo
        // alle dimensioni raggiunte fino a quel momento — un rettangolo opaco
        // appeso sopra tutto, che copriva le finestre sotto.
        //
        // Ora la pulizia in sospeso viene eseguita prima di partire: chi
        // subentra decide lo stato finale, ma nessuno resta a meta'.
        if (this._fermaAnim) { this._fermaAnim(); this._fermaAnim = null; }
        if (this._animId) { GLib.source_remove(this._animId); this._animId = 0; }
        if (this._pulizia) { const f = this._pulizia; this._pulizia = null; f(); }
        this._pulizia = allaFine ?? null;

        const applica = t => {
            const e = curva(t);
            const fra = (d, arr) => d + (arr - d) * e;

            const w = Math.max(1, Math.round(fra(da.w, a.w)));
            const h = Math.max(1, Math.round(fra(da.h, a.h)));
            const r = Math.max(0, Math.round(fra(da.r, a.r)));

            this._scheda.set_position(Math.round(fra(da.x, a.x)), Math.round(fra(da.y, a.y)));
            this._scheda.style =
                `min-width: ${w}px; max-width: ${w}px; ` +
                `min-height: ${h}px; max-height: ${h}px; ` +
                `border-radius: ${r}px;`;

            // L'opacita' corre piu' della forma: la scheda deve essere gia'
            // leggibile mentre finisce di aprirsi, non materializzarsi alla
            // fine. In chiusura vale il contrario, e lo decide chi chiama.
            const to = Math.min(1, t * (a.op > da.op ? 1.8 : 1));
            this._scheda.opacity = Math.max(0, Math.min(255,
                Math.round(da.op + (a.op - da.op) * to)));

            // MODIFICA LOCALE (10): la pillola sparisce mentre la scheda cresce.
            //
            // Finora restavano visibili entrambe: una pillola piccola nella
            // barra e, staccata sotto, una scheda larga. Due oggetti, quindi
            // nessun morph — si leggeva come "e' comparso un riquadro", non
            // come "quella cosa e' diventata questa".
            //
            // Sull'isola vera non esiste una pillola accanto alla scheda: e'
            // la stessa forma che si e' allargata. Siccome la scheda nasce
            // esattamente sulla geometria della pillola, basta spegnere la
            // pillola perche' l'occhio le legga come un oggetto solo.
            //
            // Si spegne in fretta all'inizio dell'apertura e si riaccende
            // tardi in chiusura: in entrambi i casi mentre la scheda la
            // copre, cosi' il passaggio di consegne non si vede mai.
            if (da.pillOp !== undefined) {
                const spegne = a.pillOp < da.pillOp;
                const tp = spegne
                    ? Math.min(1, t / 0.3)
                    : Math.max(0, (t - 0.55) / 0.45);
                this._pill.opacity = Math.max(0, Math.min(255,
                    Math.round(da.pillOp + (a.pillOp - da.pillOp) * tp)));
            }
        };

        applica(0);
        this._fermaAnim = anima(this._scheda, durata, applica, () => {
            this._fermaAnim = null;
            const f = this._pulizia;
            this._pulizia = null;
            f?.();
        });
    }

    // Interpolazione manuale del raggio: St non anima le proprieta' di stile.
    //
    // MODIFICA LOCALE: due difetti corretti.
    //
    // 1. Erano 12 passi fissi. Su 400 ms fanno 33 ms l'uno, cioe' circa 30
    //    fotogrammi al secondo mentre il resto ne fa 60: gli angoli avanzavano
    //    a scatti visibili sopra un bordo che si muoveva liscio. Ora il numero
    //    di passi si ricava dalla durata per stare a un passo ogni 16 ms.
    //
    // 2. La curva era una cubica fissa mentre la forma usa la molla. Ora
    //    riceve la stessa funzione, quindi raggio e bordo restano in fase per
    //    tutta l'animazione — sorpasso compreso.
    _animaRaggio(da, a, durata, curva) {
        if (this._raggioId) { GLib.source_remove(this._raggioId); this._raggioId = 0; }

        const passi = Math.max(12, Math.round(durata / 16));
        const intervallo = Math.max(16, Math.round(durata / passi));
        const avanzamento = curva ?? (t => 1 - Math.pow(1 - t, 3));

        let i = 0;
        this._raggioId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervallo, () => {
            i++;
            const t = Math.min(1, i / passi);
            // Il raggio non puo' andare sotto zero nemmeno durante il sorpasso
            // della molla: un valore negativo in CSS invalida la regola e per
            // un fotogramma la scheda tornerebbe squadrata.
            const r = Math.max(0, Math.round(da + (a - da) * avanzamento(t)));
            this._scheda.style = `border-radius: ${r}px;`;
            if (t >= 1) { this._raggioId = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _mode(nome) {
        return Clutter.AnimationMode[nome] ?? Clutter.AnimationMode.EASE_OUT_CUBIC;
    }

    destroy() {
        if (this._animId) { GLib.source_remove(this._animId); this._animId = 0; }
        this._pulizia = null;
        // La pillola potrebbe essere a meta' dissolvenza: se l'estensione
        // viene disattivata proprio adesso, va restituita visibile.
        if (this._pill) this._pill.opacity = 255;
        this._fondale?.hide();
        if (this._raggioId) { GLib.source_remove(this._raggioId); this._raggioId = 0; }
        if (this._chiusuraId) { GLib.source_remove(this._chiusuraId); this._chiusuraId = 0; }
        this._staccaVistaProvider();
        Main.layoutManager.removeChrome(this._scheda);
        Main.layoutManager.removeChrome(this._fondale);
        this._scheda.destroy();
        this._fondale.destroy();
        this._scheda = null;
        this._fondale = null;
    }
}
