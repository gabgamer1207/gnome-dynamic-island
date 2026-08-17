// Trasferimenti: download e copie in corso.
//
// iOS mostra i download nella Dynamic Island con l'avanzamento a colpo d'occhio.
// Su Linux non esiste un servizio unico che dica "sta arrivando un file": ogni
// browser fa per se', wget e curl non parlano con nessuno, e le copie del file
// manager vivono dentro il file manager. Non c'e' un'API da interrogare.
//
// C'e' pero' una cosa che tutti hanno in comune, ed e' quella che si osserva
// qui: un file che cresce nella cartella dei download.
//
// COME SI RICONOSCE UN TRASFERIMENTO
//
// Due segnali, in ordine di affidabilita':
//
//   1. Il suffisso temporaneo. Firefox scrive .part, i browser Chromium
//      .crdownload, altri .download o .partial. Se compare uno di questi, e'
//      un download in corso con certezza: si mostra subito.
//
//   2. La crescita. Un file senza suffisso noto potrebbe essere qualsiasi cosa
//      — anche uno spostamento, che compare gia' completo. Si aspetta quindi un
//      giro di orologio: se nel frattempo e' cresciuto sta arrivando, se e'
//      rimasto fermo non lo era e si lascia perdere in silenzio.
//
// Il secondo segnale e' cio' che fa funzionare wget, curl, scp, i torrent e le
// copie da chiavetta senza che nessuno di questi sappia dell'isola.
//
// PERCHE' NON C'E' LA PERCENTUALE
//
// Perche' la dimensione finale non e' scritta da nessuna parte. Il .part di
// Firefox non la contiene, e il protocollo la conosce solo dentro al browser.
// Si mostrano quindi quanti byte sono arrivati e a che velocita': due dati veri
// invece di una percentuale inventata. Chi guarda vuole sapere se sta andando
// avanti, e quello si vede.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { createActivity, _now } from '../activity.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { format } from '../i18n.js';

// In coda al nome: sono i suffissi che i browser tolgono a scaricamento finito.
const SUFFISSI = ['.part', '.crdownload', '.download', '.partial', '.opdownload'];

const INTERVALLO = 1;          // secondi fra due misure
const GIRI_PER_FINE = 3;       // quanti giri fermo prima di dire "finito"
const LISCIATURA = 0.35;       // peso della misura nuova nella media della velocita'

export class TransfersProvider {
    constructor() {
        this.id = 'transfers';
        this._manager = null;
        this._settings = null;
        this._monitor = [];
        this._attivi = new Map();   // percorso → stato del trasferimento
        this._tickId = 0;
    }

    enable(manager, settings) {
        this._manager = manager;
        this._settings = settings;

        for (const percorso of this._cartelle()) {
            const dir = Gio.File.new_for_path(percorso);
            let m;
            try { m = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null); }
            catch (_) { continue; }        // cartella inesistente: si salta
            m.connect('changed', (_m, file, _altro, evento) => this._evento(file, evento));
            this._monitor.push(m);
        }
    }

    disable() {
        for (const m of this._monitor) { try { m.cancel(); } catch (_) {} }
        this._monitor = [];
        this._fermaOrologio();
        for (const p of this._attivi.keys()) this._manager?.remove(`${this.id}:${p}`);
        this._attivi.clear();
        this._manager?.remove(`${this.id}:fine`);
        this._manager = null;
    }

    // La cartella dei download secondo XDG, che in italiano si chiama
    // "Scaricati" e in tedesco "Downloads": va chiesta, non indovinata.
    // Le impostazioni possono aggiungerne altre (una cartella di lavoro, un
    // punto di montaggio) senza toccare il codice.
    _cartelle() {
        const fuori = this._settings?.get_strv('transfers-watch-dirs') ?? [];
        const xdg = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        const tutte = [...fuori.map(p => p.replace(/^~/, GLib.get_home_dir()))];
        if (xdg) tutte.push(xdg);
        return [...new Set(tutte)];
    }

    _evento(file, evento) {
        const percorso = file.get_path();
        if (!percorso) return;
        const nome = GLib.path_get_basename(percorso);
        if (nome.startsWith('.')) return;        // file nascosti: roba di servizio

        const E = Gio.FileMonitorEvent;
        if (evento === E.CREATED || evento === E.CHANGED) {
            if (!this._attivi.has(percorso)) this._inizia(percorso, nome);
        } else if (evento === E.DELETED || evento === E.MOVED_OUT) {
            this._sparito(percorso);
        } else if (evento === E.MOVED_IN || evento === E.RENAMED) {
            // Il .part rinominato nel nome definitivo: e' il momento esatto in
            // cui il download finisce.
            if (!this._attivi.has(percorso)) this._inizia(percorso, nome);
        }
    }

    _inizia(percorso, nome) {
        const parziale = SUFFISSI.some(s => nome.endsWith(s));
        this._attivi.set(percorso, {
            nome: this._pulisci(nome),
            parziale,
            dimensione: -1,       // -1: mai misurato ancora, vedi _misura()
            velocita: 0,
            fermoDa: 0,
            mostrato: false,
            ultimoT: GLib.get_monotonic_time(),
        });
        this._avviaOrologio();
    }

    // Il nome che vede l'utente e' quello del file, non quello del temporaneo:
    // "relazione.pdf", non "relazione.pdf.part".
    _pulisci(nome) {
        for (const s of SUFFISSI) if (nome.endsWith(s)) return nome.slice(0, -s.length);
        return nome;
    }

    _sparito(percorso) {
        const t = this._attivi.get(percorso);
        if (!t) return;
        this._attivi.delete(percorso);
        this._manager?.remove(`${this.id}:${percorso}`);
        this._forseFermaOrologio();

        // Un .part che sparisce puo' voler dire due cose opposte: scaricamento
        // finito (rinominato nel nome vero) oppure annullato (cancellato). Le
        // distingue l'esistenza del file definitivo.
        if (!t.mostrato) return;
        if (t.parziale) {
            const finale = GLib.build_filenamev(
                [GLib.path_get_dirname(percorso), t.nome]);
            if (GLib.file_test(finale, GLib.FileTest.EXISTS))
                this._fine(t.nome, t.dimensione);
        }
    }

    // ---- orologio ----------------------------------------------------------
    // Acceso solo mentre c'e' qualcosa da misurare: un'estensione che si sveglia
    // ogni secondo tutto il giorno per non trovare mai nulla e' un difetto, non
    // una funzionalita'.

    _avviaOrologio() {
        if (this._tickId) return;
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVALLO, () => {
            this._giro();
            if (this._attivi.size === 0) { this._tickId = 0; return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _fermaOrologio() {
        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
    }

    _forseFermaOrologio() {
        if (this._attivi.size === 0) this._fermaOrologio();
    }

    _giro() {
        for (const [percorso, t] of [...this._attivi]) {
            // Asincrono: leggere la dimensione di un file e' un accesso al disco,
            // e il ciclo principale della shell disegna anche l'animazione
            // dell'isola. Un blocco qui si vedrebbe come uno scatto.
            Gio.File.new_for_path(percorso).query_info_async(
                'standard::size', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, null,
                (file, res) => {
                    let info;
                    try { info = file.query_info_finish(res); }
                    catch (_) { this._sparito(percorso); return; }
                    this._misura(percorso, info.get_size());
                });
        }
    }

    _misura(percorso, dimensione) {
        const t = this._attivi.get(percorso);
        if (!t) return;

        const ora = GLib.get_monotonic_time();

        // La prima misura fissa solo il punto di partenza.
        //
        // Senza questo, un file che compare gia' intero verrebbe letto come una
        // crescita da zero alla sua dimensione: uno spostamento dentro la
        // cartella sembrerebbe un download velocissimo. Il caso si vede sempre,
        // perche' capita a ogni download che finisce — il .part rinominato nel
        // nome definitivo e' esattamente un file che compare gia' completo, e
        // l'isola annunciava due volte lo stesso scaricamento.
        //
        // Con un suffisso di download noto non c'e' nulla da indovinare: e' un
        // trasferimento per definizione, e si mostra subito.
        if (t.dimensione < 0) {
            t.dimensione = dimensione;
            t.ultimoT = ora;
            if (t.parziale) { t.mostrato = true; this._mostra(percorso, t); }
            return;
        }

        const dt = (ora - t.ultimoT) / 1000000;
        const cresciuto = dimensione - t.dimensione;
        t.ultimoT = ora;

        if (cresciuto > 0 && dt > 0) {
            // Media mobile: la velocita' istantanea di un download oscilla
            // troppo per essere leggibile, e un numero che cambia dieci volte
            // al secondo non lo legge nessuno.
            const istantanea = cresciuto / dt;
            t.velocita = t.velocita
                ? t.velocita * (1 - LISCIATURA) + istantanea * LISCIATURA
                : istantanea;
            t.fermoDa = 0;
            t.dimensione = dimensione;
            t.mostrato = true;
            this._mostra(percorso, t);
            return;
        }

        t.dimensione = dimensione;
        t.fermoDa++;

        // Fermo da qualche giro. Se era un file con suffisso di download
        // aspettiamo la sua sparizione, che e' il segnale vero. Se non lo era,
        // o non era un trasferimento (uno spostamento arriva gia' completo),
        // oppure e' finito.
        if (t.fermoDa >= GIRI_PER_FINE) {
            if (!t.parziale) {
                this._attivi.delete(percorso);
                this._manager?.remove(`${this.id}:${percorso}`);
                this._forseFermaOrologio();
                if (t.mostrato) this._fine(t.nome, t.dimensione);
            }
            return;
        }
        if (t.mostrato) this._mostra(percorso, t);
    }

    _mostra(percorso, t) {
        if (!this._manager) return;
        const quanto = GLib.format_size(t.dimensione);
        const quanto_al_secondo = t.velocita > 0
            ? format(_('%s/s'), GLib.format_size(Math.round(t.velocita)))
            : null;

        this._manager.update(createActivity({
            id: `${this.id}:${percorso}`,
            providerId: this.id,
            tier: 'persistent',
            slot: 'leading',
            label: t.nome,
            sublabel: quanto_al_secondo ? `${quanto} · ${quanto_al_secondo}` : quanto,
            // Nella pillola l'icona e i byte, non il nome del file: i nomi sono
            // lunghi e di lunghezza imprevedibile, e la pillola si allargherebbe
            // a ogni download diverso. Il nome sta nella scheda, dove c'e' posto.
            glyph: {
                icon: new Gio.ThemedIcon({ name: 'folder-download-symbolic' }),
                testo: quanto,
            },
        }));
    }

    _fine(nome, dimensione) {
        if (!this._manager) return;
        const durata = Math.max(
            this._settings?.get_int('transient-duration-ms') ?? 1500, 3000) * 1000;
        const ora = _now();
        this._manager.push(createActivity({
            id: `${this.id}:fine`,
            providerId: this.id,
            tier: 'transient',
            slot: 'either',
            label: format(_('%s downloaded'), nome),
            sublabel: dimensione > 0 ? GLib.format_size(dimensione) : null,
            startedAt: ora,
            expiresAt: ora + durata,
        }));
    }
}
