// Proprieta' condivisa del nome sul bus di sessione.
//
// Piu' provider espongono metodi D-Bus (dbus.js, timer.js) e tutti devono
// essere raggiungibili con lo stesso nome, quello che gli utenti scrivono:
//
//     gdbus call --session --dest org.gnome.Shell.Extensions.DynamicIsland ...
//
// Ma un nome si possiede una volta sola, e i provider si accendono e si
// spengono in modo indipendente: se ognuno lo prendesse per conto suo, il
// primo che si disabilita lo toglierebbe anche agli altri.
//
// Si tiene quindi un conteggio: il nome viene richiesto quando il primo
// provider lo chiede e rilasciato quando l'ultimo lo lascia.
//
// PERCHE' UN CONTATORE E NON UN BOOLEANO
//
// Con un booleano, due provider attivi e uno solo che si spegne porterebbero
// a rilasciare il nome mentre l'altro lo sta ancora usando: i suoi metodi
// resterebbero esportati ma irraggiungibili per nome. Il baco si vedrebbe solo
// disabilitando i provider in un certo ordine — cioe' raramente, e tardi.

import Gio from 'gi://Gio';

export const NOME_BUS = 'org.gnome.Shell.Extensions.DynamicIsland';
export const PERCORSO_BASE = '/org/gnome/Shell/Extensions/DynamicIsland';

let riferimenti = 0;
let idProprieta = 0;

export function acquisisciNome() {
    if (riferimenti++ > 0) return;
    idProprieta = Gio.bus_own_name(
        Gio.BusType.SESSION, NOME_BUS,
        Gio.BusNameOwnerFlags.REPLACE, null, null, null);
}

export function rilasciaNome() {
    if (riferimenti === 0) return;          // rilascio non appaiato: si ignora
    if (--riferimenti > 0) return;
    if (idProprieta) { Gio.bus_unown_name(idProprieta); idProprieta = 0; }
}
