import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from './i18n.js';
import { resolveIdleText } from './idle-content.js';
import { mollaApertura, mollaChiusura, applicaMolla } from './spring.js';
import { anima } from './anima.js';
import { Anello } from './views/anello.js';

// MODIFICA LOCALE (8): molla piu' rigida e piu' smorzata per la pillola.
//
// I valori predefiniti (8.5 / 0.72) danno un sorpasso del 3,84%. Su una scheda
// larga 420 pixel sono 16 pixel: elasticita'. Su una pillola da 90 sono 3,5
// pixel avanti e indietro in un quarto di secondo, e a quella scala non si
// legge piu' come materia — si legge come tremolio.
//
// 9.5 / 0.82 porta il sorpasso circa all'1%: si sente che l'oggetto si assesta
// invece di fermarsi di colpo, senza che il rimbalzo diventi visibile.
const mollaPillola = t => mollaApertura(t, 9.5, 0.82);

export const IslandView = GObject.registerClass(
class IslandView extends St.Widget {
    _init() {
        super._init({
            style_class: 'dynisland-pill state-idle',
            // BinLayout stacks base + flash overlay; each child's y_align
            // handles vertical centering inside the pill's content box.
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.accessible_role = 2; // ATK_ROLE_PUSH_BUTTON
        this.can_focus = false;

        // Underlying content (compact/split/expanded) stays mounted.
        this._baseLabel = new St.Label({
            style_class: 'dynisland-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._baseLabel);

        // Overlay child for transient flashes. While it is visible, the base
        // label is hidden so stacked text does not overlap.
        this._flashLabel = new St.Label({
            style_class: 'dynisland-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            visible: false,
        });
        this.add_child(this._flashLabel);

        // MODIFICA LOCALE: presentazione compatta per la musica.
        //
        // Su iOS, con la musica in riproduzione, l'isola non mostra testo:
        // mostra la copertina dell'album da un lato e le barre animate della
        // forma d'onda dall'altro. Il titolo si legge toccando.
        //
        // Sull'iPhone quei due elementi stanno ai lati del ritaglio della
        // fotocamera, e il nero fra loro e' l'isola. Qui non c'e' nessun
        // ritaglio — la pillola E' l'isola — quindi vanno alle sue estremita':
        // il risultato visivo e' lo stesso.
        //
        // Perche' e' meglio del testo: un titolo lungo allargava la pillola su
        // mezza barra, e la larghezza cambiava a ogni cambio di brano. Cosi'
        // invece la dimensione resta costante, e l'informazione "sta suonando
        // qualcosa" arriva da un colpo d'occhio invece che da una lettura.
        this._rigaMedia = new St.BoxLayout({
            style_class: 'dynisland-media-compatta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._copertina = new St.Icon({
            style_class: 'dynisland-copertina',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rigaMedia.add_child(this._copertina);

        // Spaziatore: tiene i due elementi alle estremita' opposte.
        this._rigaMedia.add_child(new St.Widget({ x_expand: true }));

        this._onda = new St.BoxLayout({
            style_class: 'dynisland-onda',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._barre = [];
        for (let i = 0; i < 4; i++) {
            const b = new St.Widget({
                style_class: 'dynisland-onda-barra',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._barre.push(b);
            this._onda.add_child(b);
        }
        this._rigaMedia.add_child(this._onda);
        this.add_child(this._rigaMedia);

        this._ondaId = 0;

        // MODIFICA LOCALE: presentazione compatta per tutto il resto.
        //
        // La musica aveva la sua riga; ogni altro provider scriveva soltanto
        // testo, e una pillola con dentro "dispensa.pdf" o "Recording" non
        // assomiglia a un'isola: assomiglia a un'etichetta.
        //
        // Qui c'e' un indicatore a sinistra e un testo breve a destra, che e' la
        // grammatica dell'isola vera — un simbolo che dice DI COSA si tratta e
        // un numero che dice A CHE PUNTO e'. L'indicatore cambia forma secondo
        // cio' che l'attivita' fornisce nel suo glyph:
        //
        //   { frazione }  anello che si svuota      (timer)
        //   { punto }     pallino rosso pulsante    (registrazione)
        //   { icon }      icona                     (bluetooth, download, D-Bus)
        //   { testo }     cosa scrivere accanto, se diverso dall'etichetta
        //
        // Nessuno di questi campi e' obbligatorio: senza glyph si torna al
        // vecchio comportamento, cioe' solo testo.
        this._rigaStato = new St.BoxLayout({
            style_class: 'dynisland-stato-compatto',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._anello = new Anello({ dimensione: 16, spessore: 2.5 });
        this._rigaStato.add_child(this._anello.actor);

        this._punto = new St.Widget({
            style_class: 'dynisland-punto-rec',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._rigaStato.add_child(this._punto);

        this._iconaStato = new St.Icon({
            style_class: 'dynisland-icona-stato',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._rigaStato.add_child(this._iconaStato);

        this._testoStato = new St.Label({
            style_class: 'dynisland-testo-stato',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rigaStato.add_child(this._testoStato);
        this.add_child(this._rigaStato);

        this._pulsazioneFerma = null;
        this._statoId = null;

        this._currentFlashId = null;
        this._settings = null;
        this._settingsHandlers = [];
        this._lastVM = null;

        // MODIFICA LOCALE: teniamo traccia dello stato per animare solo i
        // cambi veri, e mettiamo il perno al centro cosi' lo "schiacciamento"
        // parte dal mezzo della pillola e non dall'angolo.
        this._currentState = null;
        this.set_pivot_point(0.5, 0.5);

        // MODIFICA LOCALE: riscontro al passaggio del mouse.
        //
        // Prima l'hover cambiava lo stato in 'expanded': la pillola triplicava
        // di larghezza e si illuminava. Troppo, e per un gesto che spesso non
        // e' nemmeno intenzionale — ci passi sopra andando altrove.
        //
        // Ora e' un allungamento orizzontale del 5%: si sente che l'oggetto e'
        // vivo e cliccabile, ma non si riorganizza la barra. E' scala e non
        // larghezza, quindi non tocca il layout del pannello e niente si
        // sposta intorno.
        //
        // Hover e _morph() animano entrambi 'width', quindi condividono il
        // fattore di dilatazione: se una notifica arriva mentre il puntatore
        // e' sopra, la pillola si rimisura tenendone conto invece di tornare
        // al naturale sotto il mouse fermo.
        this._fattoreHover = 1;
        // MODIFICA LOCALE (2): enter/leave invece di notify::hover.
        // Sono gli stessi eventi che interaction-controller usa da sempre per
        // setHover, quindi sappiamo per certo che scattano su questo attore.
        this.connect('enter-event', () => { this._animaHover(true); return Clutter.EVENT_PROPAGATE; });
        this.connect('leave-event', () => { this._animaHover(false); return Clutter.EVENT_PROPAGATE; });

        // MODIFICA LOCALE: riscontro alla pressione.
        //
        // Su iOS l'isola cede sotto il dito e poi rimbalza: e' quel cedimento
        // a dire "ho ricevuto il tocco", e arriva prima di qualunque cosa
        // succeda dopo. Senza, il click sembra non registrato finche' non si
        // apre qualcosa — e se quel qualcosa e' un menu, l'isola sembra
        // inerte.
        //
        // EVENT_PROPAGATE e' obbligatorio: interaction-controller e' connesso
        // allo stesso segnale su questo stesso attore e deve continuare a
        // ricevere il click. Questo gestore aggiunge l'animazione, non
        // sostituisce il comportamento.
        this.connect('button-press-event', () => {
            this._animaPressione();
            return Clutter.EVENT_PROPAGATE;
        });

    }

    // MODIFICA LOCALE (2): effetto portato a una misura percepibile.
    //
    // Il 5% iniziale era un errore di aritmetica, non di gusto: su una pillola
    // a riposo larga 52 pixel fa 2,6 pixel in tutto, poco piu' di un pixel per
    // lato. Sotto la soglia di percezione — infatti sembrava che non
    // succedesse nulla.
    //
    // 12% in orizzontale e 8% in verticale: si vede, resta discreto, e la
    // prevalenza orizzontale lo fa leggere come allungamento invece che come
    // ingrandimento.
    // MODIFICA LOCALE (4): hover e pressione passano da 'scale' a 'width'.
    //
    // Le diagnostiche hanno escluso tutte le altre ipotesi: gli eventi
    // arrivano, la pillola e' visibile e reattiva, e la molla riceve argomenti
    // corretti (argomenti=3, trascorso=0, totale=260) — quindi la transizione
    // su scale-x veniva davvero eseguita. Semplicemente non si vedeva.
    //
    // Il motivo era sotto gli occhi da subito: il contenitore che ospita la
    // pillola misura 82x28, cioe' esattamente quanto la pillola. La scala e'
    // una trasformazione di disegno, non cambia l'allocazione: tutto cio' che
    // eccede viene tagliato dal pannello. Ecco perche' aumentare la
    // percentuale non serviva a niente — il 25% veniva ritagliato come il 5%.
    //
    // 'width' invece e' una proprieta' di layout: il contenitore si riadatta e
    // il disegno la segue. E' anche l'unica prova che avevamo gia': quando
    // l'hover cambiava stato, l'allargamento si vedeva benissimo, e quello era
    // width.
    //
    // Il fattore vive in una variabile sola perche' _morph() deve usare lo
    // stesso: se arriva una notifica mentre il puntatore e' sopra, la pillola
    // deve rimisurarsi tenendo conto della dilatazione, non tornare al
    // naturale sotto il mouse fermo.
    // MODIFICA LOCALE (5): si misura SEMPRE a stile pulito.
    //
    // Il campionamento ha mostrato bersagli che si degradavano a ogni
    // passaggio del mouse: 100, poi 59, poi 48. Il motivo e' che la misura
    // veniva presa mentre era ancora attaccato il 'min-width' in linea
    // lasciato dall'animazione precedente, quindi ogni giro partiva da una
    // larghezza naturale piu' piccola di quella vera e la rimpiccioliva
    // ancora. Un ciclo che si mangia da solo.
    //
    // Togliendo lo stile prima di misurare, la larghezza naturale e' sempre
    // quella decisa da CSS e contenuto, indipendente da cosa e' successo prima.
    // MODIFICA LOCALE (7): si misura senza toccare lo stile. E' il lampeggio.
    //
    // Le due funzioni di misura azzeravano temporaneamente this.style — una a
    // null, l'altra a 'min-width: 0px' — per leggere la larghezza preferita e
    // poi rimettevano tutto a posto. Ma leggere la larghezza preferita forza
    // un ricalcolo dello stile, e per un fotogramma la pillola veniva
    // disegnata alla misura naturale, senza il min-width dell'animazione in
    // corso. Da qui il guizzo dopo il click: il lampeggio ERA la misurazione.
    //
    // StThemeNode espone gli stessi numeri direttamente, senza mutare niente:
    // padding, spessore dei bordi e il min-width del CSS si leggono e basta.
    // La larghezza totale si ricompone con la regola di St:
    //
    //     totale = max(min-width, contenuto) + padding + bordi
    _misure() {
        const tn = this.get_theme_node();
        const bordi = tn.get_border_width(St.Side.LEFT) + tn.get_border_width(St.Side.RIGHT);
        const margine = tn.get_horizontal_padding() + bordi;

        // MODIFICA LOCALE (9): il min-width di riposo va ricordato, non riletto.
        //
        // get_min_width() restituisce il valore effettivo del nodo di stile, e
        // quindi comprende anche il min-width in linea che l'animazione ha
        // appena scritto. Rimisurando durante un'animazione si otteneva la
        // larghezza gia' dilatata, la si moltiplicava di nuovo per il fattore,
        // e la pillola cresceva a ogni passaggio del mouse senza tornare mai
        // indietro: un ciclo che si autoalimenta.
        //
        // Il valore buono e' solo quello letto a riposo, cioe' quando non c'e'
        // stile in linea. Lo si memorizza allora e lo si riusa durante le
        // animazioni. Si aggiorna da solo al cambio di stato, perche' appena
        // l'animazione finisce lo stile torna nullo e la lettura riprende.
        let minCss;
        if (this.style == null) {
            minCss = Math.max(0, tn.get_min_width());
            this._minCssBase = minCss;
        } else {
            minCss = this._minCssBase ?? 0;
        }
        const larghezzaEtichetta = et =>
            (et && et.visible) ? (et.get_preferred_width(-1)[1] ?? 0) : 0;
        const contenuto = Math.max(
            larghezzaEtichetta(this._baseLabel),
            larghezzaEtichetta(this._flashLabel),
            // In modalita' compatta il contenuto e' la riga con copertina e
            // onda, non le etichette: senza questo la pillola si stringerebbe
            // fino a tagliarle.
            (this._rigaMedia && this._rigaMedia.visible)
                ? Math.max(96, this._rigaMedia.get_preferred_width(-1)[1] ?? 0)
                : 0);

        return { margine, naturale: Math.max(minCss, contenuto) + margine };
    }

    // MODIFICA LOCALE (5): la larghezza si anima dal CSS, non da ease().
    //
    // Il campionamento ha chiuso la questione: con ease({width: 100}) la
    // larghezza reale restava 82 per tutti i 284 ms misurati. Non e' un
    // problema di curva o di durata — la proprieta' non si muove affatto.
    //
    // St.Widget calcola la propria larghezza da CSS e contenuto e ignora la
    // richiesta di dimensione di Clutter. ease({width}) crea una transizione
    // regolare, che infatti gira e riceve i suoi tick, ma il valore che scrive
    // viene scartato al momento del layout. Vale anche per _morph(): quel
    // codice non ha mai animato niente, e gli unici allargamenti visibili
    // erano i min-width del CSS che cambiano insieme alla classe di stato.
    //
    // L'unica leva vera e' quindi il CSS, interpolato a mano come si fa gia'
    // per il raggio degli angoli.
    //
    // min-width si applica alla scatola del contenuto: per ottenere una
    // larghezza totale A bisogna chiedere A meno bordi e padding. Quel margine
    // lo misuriamo una volta sola azzerando temporaneamente min-width e
    // leggendo la larghezza preferita che ne risulta.
    // Margine = padding + bordi, SENZA il contenuto.
    //
    // In St la larghezza totale e' max(min-width, contenuto) + padding + bordi:
    // min-width si riferisce alla scatola del contenuto, non a tutto l'attore.
    // Lo si vede dai numeri dello stato a riposo: min-width 52 piu' padding
    // 2x14 piu' bordi 2 fanno esattamente gli 82 pixel misurati.
    //
    // MODIFICA LOCALE (6): qui prima si restituiva la larghezza preferita
    // intera, che comprende anche il testo. Con la pillola vuota il conto
    // tornava per caso, perche' il contenuto era zero. Appena dentro c'e'
    // l'orario il margine risulta gonfiato di una quarantina di pixel, il
    // bersaglio finisce sotto la larghezza attuale e la pillola si RIMPICCIOLISCE
    // al passaggio del mouse invece di allargarsi.
    //
    // Il contenuto va quindi sottratto, chiedendolo alle etichette.
    //
    // Non si mette in cache: padding e bordi cambiano con la classe di stato
    // (state-idle ha padding 2px 14px, state-compact 4px 12px), quindi un
    // valore misurato una volta sola sarebbe sbagliato negli altri stati.
    _animaLarghezza(bersaglio, margine, durata, curva, liberaAllaFine) {
        if (this._fermaLargh) { this._fermaLargh(); this._fermaLargh = null; }
        if (this._larghId) { GLib.source_remove(this._larghId); this._larghId = 0; }

        const da = Math.max(0, this.get_width() - margine);
        const a = Math.max(0, bersaglio - margine);
        if (Math.abs(a - da) < 1) return;

        this._fermaLargh = anima(this, durata,
            t => {
                const v = Math.round(da + (a - da) * curva(t));
                this.style = `min-width: ${Math.max(0, v)}px;`;
            },
            () => {
                this._fermaLargh = null;
                // Tolto lo stile in linea, torna a comandare il CSS: cosi' la
                // pillola riprende ad adattarsi al testo che cambia.
                if (liberaAllaFine) this.style = null;
            });
    }

    // MODIFICA LOCALE (6): due gradini, non uno.
    //
    //   riposo  1.00   |   sfiorata  1.10   |   premuta  1.20
    //
    // 1.22 al passaggio era gia' il massimo dell'espansione: non restava
    // margine per far sentire il click, e la pressione doveva per forza
    // andare nell'altra direzione — da cui il rimpicciolimento che leggevi
    // come lampeggio.
    //
    // Con l'hover a 1.10 restano dieci punti liberi sopra: il click puo'
    // crescere ancora, che e' quello che il gesto suggerisce. Premere una cosa
    // per farla rimpicciolire e' un'idea da pulsante fisico, non da vetro.
    // MODIFICA LOCALE (8): gradini ridotti.
    //   riposo 1.00  |  sfiorata 1.07  |  premuta 1.14
    // Su una pillola da 82 pixel fanno +6 e +11: si sentono entrambi, e il
    // secondo resta distinguibile dal primo senza che la barra si riorganizzi.
    // MODIFICA LOCALE: la forma d'onda.
    //
    // Quattro barre che cambiano altezza. Non e' un'analisi reale dello
    // spettro — quella richiederebbe di intercettare il flusso audio, cosa che
    // MPRIS non espone e che costerebbe molto piu' di quanto renda: l'occhio
    // non verifica se le barre corrispondono al suono, verifica che si muovano
    // in modo plausibile.
    //
    // Le altezze si muovono per passi indipendenti, con un minimo che non
    // scende mai a zero: barre che si azzerano sembrano rotte, non silenziose.
    _avviaOnda() {
        if (this._ondaId) return;
        const passo = () => {
            for (const b of this._barre) {
                const h = 4 + Math.random() * 10;
                b.remove_all_transitions();
                b.ease({
                    height: Math.round(h),
                    duration: 180,
                    mode: this._mode('EASE_IN_OUT_QUAD'),
                });
            }
        };
        passo();
        this._ondaId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            passo();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _fermaOnda() {
        if (this._ondaId) { GLib.source_remove(this._ondaId); this._ondaId = 0; }
        for (const b of this._barre ?? []) {
            b.remove_all_transitions();
            b.height = 4;
        }
    }

    // Il pallino della registrazione respira invece di lampeggiare.
    //
    // Un lampeggio a onda quadra e' la spia di un allarme: strappa lo sguardo e
    // non lo restituisce. Qui serve il contrario — devi poterlo dimenticare
    // mentre lavori e ritrovarlo quando ci pensi. Una sinusoide fra piena e
    // mezza opacita' resta percepibile con la coda dell'occhio senza chiamarla.
    //
    // Non si spegne mai del tutto: un indicatore di registrazione che sparisce,
    // anche solo per un istante, e' un indicatore su cui non puoi contare.
    _avviaPulsazione() {
        if (this._pulsazioneFerma) return;
        const CICLO = 2200;
        const giro = () => {
            this._pulsazioneFerma = anima(this._punto, CICLO, t => {
                const s = (1 + Math.cos(t * Math.PI * 2)) / 2;    // 1 → 0 → 1
                this._punto.opacity = Math.round(255 * (0.55 + 0.45 * s));
            }, () => { this._pulsazioneFerma = null; giro(); });
        };
        giro();
    }

    _fermaPulsazione() {
        this._pulsazioneFerma?.();
        this._pulsazioneFerma = null;
        if (this._punto) this._punto.opacity = 255;
    }

    // Monta la riga di stato secondo il glyph dell'attivita', o la ritira.
    _applicaStato(att) {
        if (!att) {
            this._rigaStato.hide();
            this._fermaPulsazione();
            return;
        }

        const g = att.glyph ?? {};
        const conAnello = Number.isFinite(g.frazione);
        const conPunto = !!g.punto;
        const conIcona = !conAnello && !conPunto && !!g.icon;

        this._anello.actor.visible = conAnello;
        // Un timer che riparte non deve mostrare l'anello che corre all'indietro
        // fino al valore nuovo: il salto e' voluto, e va mostrato come salto.
        if (conAnello) this._anello.setFrazione(g.frazione, att.id === this._statoId);

        this._punto.visible = conPunto;
        if (conPunto) this._avviaPulsazione();
        else this._fermaPulsazione();

        this._iconaStato.visible = conIcona;
        if (conIcona) this._iconaStato.gicon = g.icon;

        this._testoStato.text = g.testo ?? att.label ?? '';
        // Il colore lo decide chi produce l'attivita': il timer si tinge d'ambra
        // come l'anello, tutto il resto resta bianco. Sull'isola vera e' il
        // colore a dire di che si tratta prima ancora del testo.
        this._testoStato.style = g.colore ? `color: ${g.colore};` : null;
        this._statoId = att.id;
        this._rigaStato.show();
    }

    _animaHover(dentro) {
        this._fattoreHover = dentro ? 1.07 : 1;
        const { margine, naturale } = this._misure();
        // MODIFICA LOCALE (4): tempi accorciati.
        //
        // 260/220 ms erano giusti per un cambio di contenuto, sbagliati per un
        // riscontro al puntatore: un feedback deve arrivare mentre il gesto e'
        // ancora in corso, altrimenti si legge come lentezza del sistema e non
        // come risposta. Qui serve immediatezza, non eleganza.
        this._animaLarghezza(
            Math.round(naturale * this._fattoreHover),
            margine,
            dentro ? 190 : 170,
            dentro ? mollaPillola : mollaChiusura,
            !dentro,
        );
    }

    // Cedimento e rimbalzo, in due tempi.
    //
    // Andata secca e corta (90 ms): la pressione e' istantanea, non ha una
    // molla da caricare. Ritorno lungo e con la molla: e' il rilascio, ed e'
    // li' che l'elasticita' si vede.
    //
    // Non aspetta il button-release: se il click apre un menu che prende il
    // grab del puntatore, il rilascio puo' non arrivare mai a questo attore e
    // la pillola resterebbe schiacciata per sempre. Il rimbalzo parte da solo
    // a fine andata.
    // MODIFICA LOCALE (10): la pillola si allarga all'arrivo della notifica.
    //
    // La scheda nasce sulla geometria della pillola: se la pillola resta della
    // misura di riposo, la scheda parte da un punto e si espande, e si legge
    // come un riquadro che compare. Se invece la pillola si allarga prima, la
    // scheda eredita una forma gia' in movimento e il passaggio di consegne
    // diventa un morph solo.
    //
    // Nessun testo dentro: il contenuto lo mostra la scheda. Qui si muove solo
    // la forma — che e' esattamente cio' che fa il ritaglio dell'iPhone
    // nell'istante prima di aprirsi.
    espandiPerNotifica(attiva) {
        this._fattoreNotifica = attiva ? 1.55 : 1;
        const { margine, naturale } = this._misure();
        const bersaglio = Math.round(
            naturale * this._fattoreNotifica * (this._fattoreHover ?? 1));

        this._animaLarghezza(
            bersaglio, margine,
            attiva ? 240 : 280,
            attiva ? mollaPillola : mollaChiusura,
            !attiva && this._fattoreHover === 1,
        );
    }

    _animaPressione() {
        const { margine, naturale } = this._misure();
        const picco = Math.round(naturale * 1.14);
        const ritorno = Math.round(naturale * (this._fattoreHover ?? 1));

        // Andata corta e decisa fino al picco, poi ritorno alla misura
        // dell'hover. Il ritorno e' piu' lungo dell'andata: e' il rilascio, e
        // se dura quanto la spinta il gesto si legge come un lampeggio invece
        // che come una risposta.
        this._animaLarghezza(picco, margine, 130, mollaPillola, false);

        // MODIFICA LOCALE (11): il bersaglio del ritorno si ricalcola adesso.
        //
        // Prima era quello catturato al momento del click. Ma cliccando si
        // apre un menu che prende il grab del puntatore, e GNOME manda subito
        // un leave-event: la pillola rientra a 82. Poi, 145 ms dopo, questo
        // ritorno la riportava a 88 — verso una misura decisa quando il mouse
        // era ancora sopra, ormai scaduta.
        //
        // Erano i due allungamenti: la spinta del click, e il ritorno che
        // rimetteva in fuori qualcosa che nel frattempo era gia' rientrato.
        // Ricalcolando qui, se il puntatore se n'e' andato si torna a 1.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 145, () => {
            const m = this._misure();
            const bersaglio = Math.round(
                m.naturale * (this._fattoreHover ?? 1) * (this._fattoreNotifica ?? 1));
            this._animaLarghezza(bersaglio, m.margine, 320, mollaChiusura,
                this._fattoreHover === 1 && (this._fattoreNotifica ?? 1) === 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    // MODIFICA LOCALE: alcune curve potrebbero non esserci su versioni
    // diverse di Clutter; in quel caso si ripiega su una decelerazione
    // normale invece di far esplodere l'estensione.
    _mode(nome) {
        return Clutter.AnimationMode[nome] ?? Clutter.AnimationMode.EASE_OUT_CUBIC;
    }

    // MODIFICA LOCALE: rientro animato del testo di base (orario o attivita').
    _entraBase() {
        this._baseLabel.remove_all_transitions();
        this._baseLabel.opacity = 0;
        this._baseLabel.translation_y = 5;
        this._baseLabel.show();
        this._baseLabel.ease({
            opacity: 255,
            translation_y: 0,
            duration: 220,
            mode: this._mode('EASE_OUT_CUBIC'),
        });
    }

    // MODIFICA LOCALE: rete di sicurezza. Riporta il testo di base allo stato
    // pieno e visibile senza animazioni, qualunque cosa sia successo prima.
    // Serve perche' l'orario a riposo non deve MAI poter restare invisibile.
    //
    // MODIFICA LOCALE (2): non interrompere un rientro in corso.
    //
    // setViewModel() viene richiamata dal ticker ogni 250 ms. Il rientro del
    // testo dura 220 ms, quindi il primo tick utile arrivava quasi sempre a
    // meta' animazione e la troncava con remove_all_transitions(): il testo
    // scattava invece di sfumare. Era una delle due cause dell'effetto
    // "robotico".
    //
    // Se c'e' gia' una transizione di opacita' viva, la lasciamo finire: sta
    // andando verso lo stato che questa funzione vorrebbe imporre comunque.
    _resetBase() {
        if (this._baseLabel.get_transition('opacity')) return;

        this._baseLabel.remove_all_transitions();
        this._baseLabel.opacity = 255;
        this._baseLabel.translation_y = 0;
        this._baseLabel.show();
        this._flashLabel.translation_y = 0;
    }

    // MODIFICA LOCALE
    // La Dynamic Island vera non usa una curva di easing: usa una molla.
    // Parte decisa, supera di poco la misura finale e si assesta. Per questo
    // in apertura serve EASE_OUT_BACK, che quel sorpasso ce l'ha.
    // In chiusura invece si usa EASE_OUT_QUINT: un rimbalzo mentre l'oggetto
    // si richiude non sembra elastico, sembra un errore.
    _morph() {
        const da = this.get_width();
        const { margine, naturale: a } = this._misure();
        if (!da || !a || Math.abs(a - da) < 2) return;

        const espande = a > da;

        this.remove_transition('scale-y');

        // MODIFICA LOCALE (2): durata UNICA per larghezza e schiacciamento.
        //
        // Prima erano 340/380 ms per la larghezza e 300 per lo scale_y: i due
        // movimenti si fermavano in istanti diversi, e l'occhio li leggeva come
        // due animazioni separate incollate insieme invece che come un solo
        // oggetto elastico. Era l'altra causa dell'effetto "robotico".
        //
        // Un corpo fisico ha un tempo di assestamento solo: qui il sorpasso lo
        // porta la larghezza in apertura (EASE_OUT_BACK), mentre in chiusura si
        // decelera senza rimbalzo — un rimbalzo mentre l'oggetto si richiude
        // sembra un errore, non elasticita'.
        // MODIFICA LOCALE (3): tempi allungati e curva a molla.
        // 380/340 erano ancora troppo svelti perche' il sorpasso si leggesse
        // come assestamento invece che come guizzo.
        const durata = espande ? 460 : 400;
        const curva = espande ? mollaPillola : mollaChiusura;

        // MODIFICA LOCALE (5): anche qui la larghezza passa dal CSS.
        //
        // Qui c'era ease({width: a}), che su St.Widget non muove niente: la
        // transizione gira, ma il valore viene scartato al layout perche' la
        // larghezza la decidono CSS e contenuto. Il cambio di forma che si
        // vedeva era solo il min-width della nuova classe di stato, applicato
        // di scatto — cioe' proprio l'effetto "robotico" da cui siamo partiti.
        //
        // Il fattore dell'hover entra nel bersaglio: se una notifica arriva
        // mentre il puntatore e' sopra, la pillola si rimisura restando
        // dilatata invece di sgonfiarsi sotto il mouse fermo.
        this._animaLarghezza(
            Math.round(a * (this._fattoreHover ?? 1)),
            margine,
            durata,
            curva,
            this._fattoreHover === 1,
        );

        // Micro schiacciamento verticale: e' quello che fa percepire materia
        // elastica invece di un rettangolo che cambia numero. Attenuato da
        // 0.92/1.05 a 0.95/1.03: la molla porta gia' il suo sorpasso, e
        // sommato alla deformazione precedente diventava un sobbalzo.
        // Lo schiacciamento verticale resta su scale_y. E' un effetto di pochi
        // punti percentuali su 25 pixel di altezza: anche se il pannello ne
        // ritaglia una parte, quel poco che passa basta a dare l'elasticita'.
        // La larghezza invece deve restare una proprieta' di layout, o viene
        // tagliata (vedi MODIFICA LOCALE (4)).
        this.scale_y = espande ? 0.95 : 1.03;
        this.ease({
            scale_y: 1,
            duration: durata,
            mode: this._mode('EASE_OUT_BACK'),
        });
        applicaMolla(this, ['scale-y'], curva);
    }

    setSettings(settings) {
        this._disconnectSettings();
        this._settings = settings;
        if (!settings) return;

        this._settingsHandlers = [
            settings.connect('changed::idle-content', () => this._refreshIdleContent()),
            settings.connect('changed::idle-custom-text', () => this._refreshIdleContent()),
        ];
        this._refreshIdleContent();
    }

    setViewModel(vm) {
        this._lastVM = vm;

        const states = ['idle', 'compact', 'split', 'expanded'];
        for (const s of states) this.remove_style_class_name(`state-${s}`);
        this.add_style_class_name(`state-${vm.baseState}`);

        // MODIFICA LOCALE: la musica prende la presentazione compatta.
        //
        // Copertina a sinistra, onda a destra, nessun testo. Vale solo per il
        // provider 'media': un titolo di brano e' informazione da consultare,
        // non da leggere di continuo, e tenerlo nella pillola la faceva
        // cambiare larghezza a ogni cambio di traccia.
        const media = [vm.leading, vm.trailing].find(a => a?.providerId === 'media') ?? null;
        const inMedia = !!media && !vm.flashing;

        if (inMedia) {
            if (media.glyph?.icon) this._copertina.gicon = media.glyph.icon;
            else this._copertina.icon_name = 'audio-x-generic-symbolic';
            this._rigaMedia.show();
            this._avviaOnda();
        } else {
            this._rigaMedia.hide();
            this._fermaOnda();
        }

        // Presentazione compatta per i provider che descrivono come mostrarsi.
        // Si applica solo fuori dalla musica e fuori dai lampi: un lampo scrive
        // gia' per conto suo, e sovrapporgli una riga darebbe due testi insieme.
        const primaria = inMedia ? null : (vm.leading ?? vm.trailing);
        const stato = (!vm.flashing && primaria?.glyph) ? primaria : null;
        this._applicaStato(stato);

        // Base content always reflects the underlying slots (never cleared by a flash).
        // Quando la riga di stato e' in scena, il testo semplice tace: scriverebbero
        // entrambi la stessa cosa, uno sopra l'altro.
        const basePrimary = (inMedia || stato) ? null : primaria;
        const idleText = (basePrimary || stato) ? '' : this._idleText();
        this._baseLabel.text = basePrimary ? this._formatBase(vm, basePrimary) : idleText;
        this.accessible_name = (basePrimary ?? stato)?.label
            ?? (idleText || _('Dynamic Island (idle)'));

        // MODIFICA LOCALE: la geometria non passa piu' dal CSS (St ignora le
        // timing function e faceva scattare la pillola da una misura all'altra).
        // Va DOPO l'aggiornamento del testo: _morph misura la larghezza
        // naturale, e con il testo vecchio misurerebbe la larghezza sbagliata.
        // Al primo giro non animiamo: non c'e' uno stato da cui partire.
        if (this._currentState !== vm.baseState) {
            const primoGiro = this._currentState === null;
            this._currentState = vm.baseState;
            if (!primoGiro) this._morph();
        }

        // Transient overlay lifecycle.
        // MODIFICA LOCALE: il testo entra da sotto e esce verso l'alto, invece
        // di apparire e sparire sul posto. Una dissolvenza secca si legge come
        // "lo schermo e' cambiato"; uno scorrimento si legge come "l'oggetto si
        // e' mosso", ed e' quella la differenza che rende viva l'animazione.
        // MODIFICA LOCALE (7): le notifiche non scrivono nella pillola.
        //
        // Una notifica apre la scheda, che ne mostra titolo e corpo. Se anche
        // la pillola ne stampava il testo, lo stesso messaggio compariva due
        // volte — e siccome la pillola si allarga per contenerlo, una notifica
        // con un corpo lungo la faceva stendere su mezza barra, sopra la
        // scheda che diceva gia' la stessa cosa.
        //
        // Sull'isola vera il contenuto sta nella forma espansa; il ritaglio
        // resta piccolo sotto. Volume, luminosita' e tastiera invece scrivono
        // ancora nella pillola: quelli la scheda non la aprono, e senza testo
        // non comunicherebbero niente.
        const flashInScheda = vm.flashing?.providerId === 'notification';

        if (vm.flashing && !flashInScheda) {
            this._baseLabel.hide();
            // MODIFICA LOCALE: la chiave comprende l'istante, non solo l'id.
            //
            // L'attivita' del volume ha SEMPRE lo stesso identificativo
            // ('volume-brightness:flash'), perche' e' la stessa cosa che si
            // aggiorna. Confrontando il solo id, dalla seconda variazione in
            // poi il testo non veniva piu' riscritto: l'isola continuava a
            // mostrare la percentuale della volta precedente.
            //
            // Da qui la sensazione di ritardo — non era lentezza, era un
            // valore vecchio. Aggiungendo startedAt ogni aggiornamento diventa
            // distinguibile dal precedente.
            const chiaveFlash = `${vm.flashing.id}@${vm.flashing.startedAt}`;
            if (chiaveFlash !== this._currentFlashId) {
                this._currentFlashId = chiaveFlash;
                this._flashLabel.text = vm.flashing.sublabel
                    ? `${vm.flashing.label} — ${vm.flashing.sublabel}`
                    : vm.flashing.label;
                this._flashLabel.remove_all_transitions();
                this._flashLabel.opacity = 0;
                this._flashLabel.translation_y = 7;
                this._flashLabel.show();
                this._flashLabel.ease({
                    opacity: 255,
                    translation_y: 0,
                    duration: 260,
                    mode: this._mode('EASE_OUT_BACK'),
                });
                this.add_style_class_name('flashing');
                this.accessible_description = format(_('Flash: %s'), vm.flashing.label);
            }
        } else if (this._currentFlashId) {
            this._currentFlashId = null;
            this._flashLabel.remove_all_transitions();
            this._flashLabel.ease({
                opacity: 0,
                translation_y: -7,
                // L'uscita e' piu' rapida dell'entrata: cosi' la pillola
                // sembra reattiva invece che lenta a liberarsi.
                duration: 180,
                mode: this._mode('EASE_IN_QUAD'),
                onStopped: () => { if (!this._currentFlashId) this._flashLabel.hide(); },
            });
            // MODIFICA LOCALE: il testo di base rientra SUBITO, in dissolvenza
            // incrociata con l'uscita del flash, invece di aspettarne la fine.
            // Prima dipendeva da onComplete: se arrivava una seconda notifica
            // mentre la prima usciva, quella transizione veniva annullata, la
            // callback non scattava piu' e l'orario spariva per sempre.
            this._entraBase();
            this.remove_style_class_name('flashing');
            this.accessible_description = '';
        } else {
            this._flashLabel.hide();
            this._resetBase();
        }
    }

    _formatBase(vm, primary) {
        if (vm.baseState === 'split' && vm.leading && vm.trailing)
            return `${vm.leading.label} · ${vm.trailing.label}`;
        if (vm.baseState === 'expanded' && primary.sublabel)
            return `${primary.label} — ${primary.sublabel}`;
        return primary.label;
    }

    _idleText() {
        const mode = this._settings?.get_string('idle-content') ?? 'clock';
        const customText = this._settings?.get_string('idle-custom-text') ?? '';
        return resolveIdleText(mode, customText, this._clockText());
    }

    _clockText() {
        return GLib.DateTime.new_now_local().format('%H:%M') ?? '';
    }

    _refreshIdleContent() {
        if (this._lastVM && !(this._lastVM.leading ?? this._lastVM.trailing))
            this.setViewModel(this._lastVM);
    }

    _disconnectSettings() {
        if (!this._settings) return;
        for (const handler of this._settingsHandlers) this._settings.disconnect(handler);
        this._settingsHandlers = [];
        this._settings = null;
    }

    destroy() {
        this._fermaOnda();
        this._fermaPulsazione();
        // L'anello ha una propria animazione agganciata al frame clock: se
        // restasse in corsa dopo che l'attore e' sparito, chiederebbe di
        // ridipingere qualcosa che non esiste piu'.
        this._anello?.destroy();
        this._anello = null;
        this._disconnectSettings();
        super.destroy();
    }
});
