// La copertina dell'album, anche quando sta su internet.
//
// MPRIS espone mpris:artUrl, ma quasi nessun lettore ci mette un file locale:
// Spotify manda un indirizzo https, e un'icona GIO costruita su quello non si
// disegna. Il risultato e' che l'attivita' della musica resta senza glyph — e
// senza glyph l'isola ripiega su un'icona generica, che nel pallino diventa tre
// puntini.
//
// Qui la copertina si scarica e si tiene da parte. Il file resta nella cache
// dell'utente col nome derivato dall'indirizzo, quindi lo stesso album non si
// riscarica mai due volte, nemmeno fra una sessione e l'altra.
//
// PERCHE' NON SI PASSA L'INDIRIZZO DIRETTAMENTE A GIO
//
// Gio.File.new_for_uri('https://…') funziona solo se gvfs ha il supporto http
// installato e montato, cosa che non si puo' dare per scontata; e quando manca,
// St non mostra un ripiego ma l'icona "immagine mancante", cioe' un difetto
// visibile al posto di uno invisibile. Scaricando noi, l'errore lo gestiamo:
// se non arriva, si resta sull'icona dell'applicazione.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

const CARTELLA = 'dynamic-island/copertine';

let sessione = null;
const inCorso = new Set();       // indirizzi gia' richiesti, per non doppiare

function cartella() {
    const d = GLib.build_filenamev([GLib.get_user_cache_dir(), CARTELLA]);
    GLib.mkdir_with_parents(d, 0o755);
    return d;
}

function percorsoPer(url) {
    // L'indirizzo per intero non puo' fare da nome di file: contiene barre ed
    // e' lungo. L'impronta e' corta, stabile e univoca quanto basta.
    const impronta = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
    return GLib.build_filenamev([cartella(), impronta]);
}

// Ritorna subito il percorso se la copertina c'e' gia'; altrimenti la scarica e
// chiama pronta(percorso). Su errore non chiama niente: chi ha chiesto resta
// con quello che aveva.
export function copertina(url, pronta) {
    if (typeof url !== 'string') return null;

    if (url.startsWith('file://')) {
        const p = GLib.filename_from_uri(url)[0];
        return GLib.file_test(p, GLib.FileTest.EXISTS) ? p : null;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;

    const dest = percorsoPer(url);
    if (GLib.file_test(dest, GLib.FileTest.EXISTS)) return dest;

    // Una richiesta per indirizzo: i metadati si ripubblicano a ogni battito e
    // senza questa guardia partirebbero decine di scaricamenti dello stesso
    // file, tutti a scrivere sullo stesso percorso.
    if (inCorso.has(url)) return null;
    inCorso.add(url);

    sessione ??= new Soup.Session({ timeout: 15 });
    const msg = Soup.Message.new('GET', url);
    if (!msg) { inCorso.delete(url); return null; }

    sessione.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, res) => {
        inCorso.delete(url);
        let dati;
        try { dati = s.send_and_read_finish(res); }
        catch (_) { return; }
        if (msg.get_status() !== Soup.Status.OK || !dati) return;

        try {
            // replace_contents scrive in un colpo solo: nessun momento in cui
            // il file esiste ma e' a meta', che e' esattamente il momento in cui
            // qualcuno proverebbe a disegnarlo.
            Gio.File.new_for_path(dest).replace_contents(
                dati.get_data(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (_) { return; }

        pronta?.(dest);
    });
    return null;
}

// Icona in cascata per un lettore, quando la copertina non c'e'.
//
// L'ordine va dal preciso al generico: il file .desktop dichiarato dal lettore,
// poi i nomi che i pacchettizzatori usano di solito (Spotify su Arch si
// installa come "spotify-launcher", su altre distribuzioni come
// "spotify-client"), infine la nota musicale, che c'e' sempre.
export function iconaLettore(desktopEntry) {
    if (desktopEntry) {
        try {
            const app = Gio.DesktopAppInfo.new(`${desktopEntry}.desktop`);
            const ic = app?.get_icon();
            if (ic) return ic;
        } catch (_) { /* voce inesistente: si passa ai nomi */ }
    }
    const nomi = [];
    if (desktopEntry) {
        nomi.push(desktopEntry,
                  `${desktopEntry}-client`,
                  `${desktopEntry}-launcher`);
    }
    nomi.push('audio-x-generic-symbolic');
    return Gio.ThemedIcon.new_from_names(nomi);
}
