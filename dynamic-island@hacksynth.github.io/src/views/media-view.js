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
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { anima } from '../anima.js';
import { Barra } from './barra.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

export class MediaView {
    constructor(busName, proxy) {
        this._busName = busName;
        this._proxy = proxy;
        this._pollId = 0;
        this._durata = 0;          // µs
        this._riferimento = 0;     // istante dell'ultima lettura, µs monotoni
        this._stato = null;
        this._fermaScorrimento = null;
        this._larghezzaScritta = -1;
        this._artUrl = null;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
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
        // Stessa ragione degli altri: si agisce sulla pressione.
        this._btnPlay.connect('button-press-event', () => {
            this._chiama('PlayPause');
            return Clutter.EVENT_STOP;
        });

        // MODIFICA LOCALE: due comandi agli angoli, come nei lettori veri.
        //
        // Non un "mi piace" e un AirPlay: il primo non esiste in MPRIS — nessun
        // lettore lo espone in modo standard — e il secondo e' commutazione di
        // uscita audio, che sta in PipeWire e non ha niente a che vedere con il
        // brano. Due pulsanti che non fanno niente sono peggio di due pulsanti
        // che non ci sono.
        //
        // Shuffle e LoopStatus invece sono proprieta' MPRIS vere, leggibili e
        // scrivibili, e Spotify le espone entrambe. Occupano le stesse due
        // posizioni e fanno una cosa.
        this._btnCasuale = this._bottoneStato('media-playlist-shuffle-symbolic',
            _('Shuffle'), () => this._alternaCasuale());
        this._btnRipeti = this._bottoneStato('media-playlist-repeat-symbolic',
            _('Repeat'), () => this._alternaRipeti());

        controlli.add_child(this._btnCasuale);
        controlli.add_child(this._btnPrec);
        controlli.add_child(this._btnPlay);
        controlli.add_child(this._btnSucc);
        controlli.add_child(this._btnRipeti);

        // --- barra di avanzamento ---
        // Disegnata a mano: St non ha una progress bar.
        //
        // MODIFICA LOCALE: ora e' anche cliccabile.
        //
        // Il commento originale diceva che un St.Slider "richiederebbe gestire
        // il seek", e per questo la barra era di sola lettura. Ma una barra di
        // avanzamento che non risponde al click e' peggio di nessuna barra:
        // sembra un controllo, quindi la si preme, e non succede niente. Un
        // elemento che ha l'aspetto di un comando deve comportarsi come tale.
        // MODIFICA LOCALE (2): contenitore orizzontale invece di BinLayout.
        //
        // Con BinLayout il riempimento restava centrato qualunque allineamento
        // gli si desse: quel gestore impila i figli uno sopra l'altro e li
        // centra, e l'allineamento vale sullo spazio in eccesso, non sul lato
        // da cui partire. La barra cresceva quindi da meta' verso i due bordi.
        //
        // Un BoxLayout orizzontale impacchetta i figli dall'inizio per natura:
        // il riempimento parte dal bordo sinistro senza doverglielo chiedere.
        // Cambiare contenitore e' piu' semplice che combattere l'allineamento
        // di quello sbagliato.
        // MODIFICA LOCALE: la barra e' un disegno, non tre attori.
        //
        // Erano traccia, riempimento e pallino dentro un contenitore, con la
        // larghezza animata riscrivendo lo stile in linea. Il contenitore si
        // alzava per contenere il pallino — una linea da quattro pixel diventava
        // una fascia grigia da quattordici — l'avanzamento procedeva a salti da
        // un pixel, e ogni fotogramma rimisurava la scheda intera.
        //
        // Le ragioni per esteso stanno in views/barra.js.
        this._barra = new Barra({
            anteprima: f => {
                if (!this._durata) return;
                this._tCorrente.text = this._formatta(this._durata * f);
            },
            salta: f => { if (this._durata) this._saltaA(this._durata * f); },
        });

        this._tempi = new St.BoxLayout({ style_class: 'dynisland-media-times' });
        this._tCorrente = new St.Label({
            style_class: 'dynisland-media-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tTotale = new St.Label({
            style_class: 'dynisland-media-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tempi.add_child(this._tCorrente);
        this._tempi.add_child(this._barra.actor);
        this._tempi.add_child(this._tTotale);

        // Barra sopra, comandi sotto: e' l'ordine di lettura naturale — prima
        // dove sei, poi cosa puoi fare.
        this.actor.add_child(this._tempi);
        this.actor.add_child(controlli);
    }




    // Salto a una posizione del brano. Riceve i microsecondi gia' calcolati:
    // la conversione da pixel a frazione la fa la barra, che e' l'unica a sapere
    // dove sono i suoi bordi.
    _saltaA(bersaglio) {
        if (!this._durata || this._durata <= 0) return;
        const scostamento = Math.round(bersaglio) - (this._posizione ?? 0);

        this._proxy?.call(
            'Seek',
            new GLib.Variant('(x)', [scostamento]),
            Gio.DBusCallFlags.NONE, -1, null,
            (p, res) => {
                try { p.call_finish(res); }
                catch (e) { log(`DYNMEDIA Seek: ${e}`); }
            });

        // Riscontro immediato: la barra si sposta senza aspettare che il
        // lettore confermi. Se il salto non riuscisse, il prossimo
        // aggiornamento la rimetterebbe al posto giusto — meglio un riscontro
        // istantaneo occasionalmente da correggere che mezzo secondo di
        // apparente immobilita' a ogni click.
        this._applicaPosizione(bersaglio);
    }

    _bottone(iconName, metodo) {
        const b = new St.Button({
            style_class: 'dynisland-media-button',
            child: new St.Icon({ icon_name: iconName, icon_size: 20 }),
            can_focus: true,
            reactive: true,
        });
        // MODIFICA LOCALE: si agisce sulla PRESSIONE, non sul click.
        //
        // Le sonde hanno mostrato questa sequenza premendo un pulsante:
        //
        //     pressed=true
        //     press ricevuto
        //     pressed=false      <- si sblocca PRIMA del rilascio
        //     release ricevuto
        //
        // St.Button emette 'clicked' solo se pressione e rilascio avvengono
        // entrambi su di lui restando premuto nel frattempo. Qui lo stato di
        // premuto si azzera prima: il pulsante riceve un 'leave' fra i due
        // eventi, perche' si SPOSTA sotto il puntatore. La barra di
        // avanzamento si aggiorna ogni secondo e rimisura il contenuto della
        // scheda: basta uno scostamento di un pixel.
        //
        // Si potrebbe congelare la geometria della scheda mentre e' aperta, ma
        // significherebbe rinunciare a una barra che avanza. Agire sulla
        // pressione elimina il problema alla radice: non c'e' piu' nessuna
        // coppia di eventi da tenere insieme.
        //
        // Per un comando di riproduzione e' anche piu' corretto — sono azioni
        // immediate e ripetibili, non scelte da confermare rilasciando.
        if (metodo) {
            b.connect('button-press-event', () => {
                this._chiama(metodo);
                return Clutter.EVENT_STOP;
            });
        }
        return b;
    }

    // Pulsante di stato: acceso o spento, non un comando che parte e finisce.
    //
    // Casuale e ripeti non "fanno" qualcosa, la commutano: il pulsante deve
    // quindi mostrare in che stato si trova, altrimenti l'unico modo di sapere
    // se la riproduzione casuale e' attiva sarebbe ascoltare tre brani.
    _bottoneStato(icona, nome, azione) {
        const b = new St.Button({
            style_class: 'dynisland-media-button',
            can_focus: true,
            accessible_name: nome,
            child: new St.Icon({ icon_name: icona, icon_size: 14 }),
        });
        // Sulla pressione come tutti gli altri: la scheda si rimisura mentre la
        // barra avanza e il pulsante scivola sotto il puntatore.
        b.connect('button-press-event', () => { azione(); return Clutter.EVENT_STOP; });
        return b;
    }

    _scriviProprieta(nome, valore) {
        if (!this._proxy) return;
        this._proxy.get_connection().call(
            this._busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, nome, valore]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (c, r) => {
                // Come per i comandi: un errore ingoiato costa piu' di uno
                // rumoroso, perche' il pulsante sembrerebbe soltanto non
                // funzionare e non ci sarebbe modo di sapere perche'.
                try { c.call_finish(r); }
                catch (e) { log(`DYNMEDIA Set ${nome} su ${this._busName}: ${e}`); }
            });
    }

    _leggi(nome) {
        return this._proxy?.get_cached_property(nome)?.deepUnpack?.();
    }

    _alternaCasuale() {
        const ora = this._leggi('Shuffle');
        if (ora === undefined) return;
        this._scriviProprieta('Shuffle', GLib.Variant.new_boolean(!ora));
    }

    // MPRIS ha tre stati, non due: nessuna ripetizione, tutta la scaletta, il
    // brano singolo. Si girano in tondo, come fa qualunque lettore.
    _alternaRipeti() {
        const giro = { 'None': 'Playlist', 'Playlist': 'Track', 'Track': 'None' };
        const ora = this._leggi('LoopStatus');
        if (ora === undefined) return;
        this._scriviProprieta('LoopStatus', GLib.Variant.new_string(giro[ora] ?? 'Playlist'));
    }

    // Un lettore che non espone la proprieta' non ha il pulsante: mostrarlo
    // spento sarebbe una bugia — non e' spento, non esiste.
    _aggiornaStato() {
        const casuale = this._leggi('Shuffle');
        this._btnCasuale.visible = casuale !== undefined;
        this._btnCasuale.opacity = casuale ? 255 : 110;

        const ripeti = this._leggi('LoopStatus');
        this._btnRipeti.visible = ripeti !== undefined;
        this._btnRipeti.opacity = (ripeti && ripeti !== 'None') ? 255 : 110;
        this._btnRipeti.child.icon_name = ripeti === 'Track'
            ? 'media-playlist-repeat-song-symbolic'
            : 'media-playlist-repeat-symbolic';
    }

    // MODIFICA LOCALE: gli errori non si ingoiano piu'.
    //
    // Qui il callback era `null`, cioe' "spara e dimentica". Se la chiamata
    // fallisce — lettore che non risponde, metodo non supportato, nome del bus
    // sbagliato — non succede niente e non resta traccia da nessuna parte.
    // Il pulsante sembra semplicemente non funzionare, e non c'e' modo di
    // sapere perche'.
    //
    // Un errore ingoiato costa piu' di un errore rumoroso: il secondo si
    // corregge, il primo si cerca.
    _chiama(metodo) {
        if (!this._proxy) {
            log(`DYNMEDIA ${metodo}: nessun proxy per ${this._busName}`);
            return;
        }
        this._proxy.call(metodo, null, Gio.DBusCallFlags.NONE, -1, null,
            (p, res) => {
                try {
                    p.call_finish(res);
                } catch (e) {
                    log(`DYNMEDIA ${metodo} su ${this._busName}: ${e}`);
                }
            });
    }

    // Aggiorna icona play/pausa, durata e copertina.
    update(metadata, status) {
        this._stato = status;
        this._btnPlay.child.icon_name = status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        const len = metadata['mpris:length'];
        this._durata = Number(len?.deepUnpack?.() ?? len ?? 0);
        this._tTotale.text = this._formatta(this._durata);
        const haDurata = this._durata > 0;
        this._tempi.visible = haDurata;   // contiene anche la barra

        const art = metadata['mpris:artUrl']?.deepUnpack?.() ?? metadata['mpris:artUrl'] ?? null;
        this._artUrl = typeof art === 'string' ? art : null;

        this._aggiornaStato();
    }

    // L'indirizzo grezzo della copertina: il provider decide cosa farne —
    // scaricarla, ripiegare sull'icona del lettore — perche' e' lui a possedere
    // l'attivita' e a poterla ripubblicare quando il file arriva.
    get artUrl() { return this._artUrl; }

    // Resta per i file locali, dove non serve scaricare niente.
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
        this._avviaScorrimento();
    }

    stopPolling() {
        if (this._pollId) { GLib.source_remove(this._pollId); this._pollId = 0; }
        this._fermaScorrimento?.();
        this._fermaScorrimento = null;
    }

    // MODIFICA LOCALE: la barra scorre fra una lettura e l'altra.
    //
    // La posizione si puo' interrogare solo a richiesta — i lettori non
    // emettono PropertiesChanged per Position — e interrogarla piu' di una volta
    // al secondo sarebbe uno spreco. Ma disegnare solo cio' che si e' letto
    // significa muovere la barra a scatti, uno per secondo: su un brano di tre
    // minuti sono un paio di pixel per volta, abbastanza per vedersi e non
    // abbastanza per sembrare voluti.
    //
    // Qui la lettura resta un affare da un secondo; fra una e l'altra la barra
    // avanza da sola contando il tempo vero, e a ogni lettura si riallinea.
    // L'orologio e' monotono: se il lettore risponde tardi la barra non salta
    // indietro, si limita a correggersi.
    _avviaScorrimento() {
        if (this._fermaScorrimento) return;
        const giro = () => {
            this._fermaScorrimento = anima(this._barra.actor, 1000, () => this._scorri(),
                () => { this._fermaScorrimento = null; giro(); });
        };
        giro();
    }

    _scorri() {
        if (this._barra.trascinando || !this._durata || !this._riferimento) return;
        if (this._stato !== 'Playing') return;      // in pausa non avanza niente
        const passato = GLib.get_monotonic_time() - this._riferimento;
        const pos = Math.min(this._durata, (this._posizione ?? 0) + passato);
        this._disegnaAvanzamento(pos / this._durata);
        this._tCorrente.text = this._formatta(pos);
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

    // MODIFICA LOCALE: la larghezza del riempimento passa dal CSS.
    //
    // Qui c'era ease({width}), che su un attore St non muove niente: la
    // dimensione la decidono CSS e contenuto, e la richiesta di Clutter viene
    // scartata al momento del layout. La transizione veniva creata ed eseguita,
    // ma il valore che scriveva finiva nel vuoto — e la barra restava ferma o
    // si muoveva a scatti imprevedibili.
    //
    // E' lo stesso difetto trovato sulla pillola e sulla scheda espansa, terza
    // occorrenza nello stesso programma: chi l'ha scritto non poteva saperlo,
    // perche' l'API non da' alcun segnale di non aver funzionato.
    //
    // min-width e max-width insieme: uno solo dei due lascerebbe al contenitore
    // la liberta' di decidere l'altro, e il riempimento tornerebbe elastico.
    _applicaPosizione(pos) {
        // L'istante della lettura: da qui in poi la barra conta da sola, e
        // questo e' il punto da cui riparte il conto.
        this._riferimento = GLib.get_monotonic_time();
        // Mentre trascini, la posizione letta dal lettore va ignorata:
        // riporterebbe il pallino indietro sotto le dita.
        if (this._barra.trascinando) return;
        this._posizione = pos;
        this._disegnaAvanzamento(Math.max(0, Math.min(1, pos / this._durata)));
        this._tCorrente.text = this._formatta(pos);
    }

    // Riempimento e pallino si muovono insieme: sono lo stesso valore mostrato
    // in due modi, e disegnarli da punti diversi del codice li farebbe prima o
    // poi divergere.
    _disegnaAvanzamento(frazione) {
        this._barra.setFrazione(frazione);
    }

    _formatta(microsecondi) {
        const s = Math.max(0, Math.floor(microsecondi / 1000000));
        const m = Math.floor(s / 60);
        return `${m}:${String(s % 60).padStart(2, '0')}`;
    }

    destroy() {
        this.stopPolling();
        // Prima la barra: ha un'animazione propria agganciata al suo attore, e
        // lasciarla viva mentre l'albero sopra sparisce vorrebbe dire chiedere
        // di ridipingere qualcosa che non c'e' piu'.
        this._barra?.destroy();
        this._barra = null;
        this.actor.destroy();
        this.actor = null;
        this._proxy = null;
    }
}
