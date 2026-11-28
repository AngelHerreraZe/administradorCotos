// Huella del código sin git (AGENTS.md §8): el auditor la firma en el dictamen y CI la recalcula sobre el PR.
// Uso: node scripts/huella.ts [--comparar <manifiesto.json>] [--guardar <manifiesto.json>]
//   Primera línea: "Huella: <sha256>". Con --comparar, después una línea "A|M|D <ruta>" por diferencia.
import crypto from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..');
// auditorias/ queda fuera: ahí viven la entrega, el dictamen y los manifiestos.
const SIEMPRE_FUERA = new Set(['.git', 'node_modules', 'auditorias']);

interface Regla {
  niega: boolean;
  soloDir: boolean;
  anclada: boolean;
  patron: string;
}

// ponytail: subconjunto de la sintaxis de .gitignore (globs, `/` final, `!`, anclada si lleva `/`); basta para este repo.
// Diferencia conocida: `*` no casa nombres que empiezan con punto. Solo puede sumar un archivo de más (CI lo
// reporta como diferencia), nunca dejar código fuera. Si estorba: reglas explícitas para esos archivos.
export function leerReglas(texto: string): Regla[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const niega = l.startsWith('!');
      let patron = niega ? l.slice(1) : l;
      const soloDir = patron.endsWith('/');
      if (soloDir) patron = patron.slice(0, -1);
      const anclada = patron.includes('/');
      if (patron.startsWith('/')) patron = patron.slice(1);
      return { niega, soloDir, anclada, patron };
    });
}

export function ignorado(rel: string, esDir: boolean, reglas: Regla[]): boolean {
  let fuera = false;
  for (const r of reglas) {
    if (r.soloDir && !esDir) continue;
    const objetivo = r.anclada ? rel : path.posix.basename(rel);
    if (path.posix.matchesGlob(objetivo, r.patron)) fuera = !r.niega;
  }
  return fuera;
}

const sha256 = (datos: string | Buffer) => crypto.createHash('sha256').update(datos).digest('hex');

/** CRLF → LF: Windows con autocrlf y el checkout de CI deben dar la misma huella. latin1 conserva cada byte. */
export function hashArchivo(datos: Buffer): string {
  return sha256(Buffer.from(datos.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'));
}

export function manifiesto(raiz = RAIZ): Record<string, string> {
  const reglas = leerReglas(readFileSync(path.join(raiz, '.gitignore'), 'utf8'));
  const archivos: Record<string, string> = {};
  const recorrer = (dir: string) => {
    for (const e of readdirSync(path.join(raiz, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (SIEMPRE_FUERA.has(rel) || ignorado(rel, e.isDirectory(), reglas)) continue;
      if (e.isDirectory()) recorrer(rel);
      else if (e.isFile()) archivos[rel] = hashArchivo(readFileSync(path.join(raiz, rel)));
    }
  };
  recorrer('');
  return Object.fromEntries(
    Object.keys(archivos)
      .sort()
      .map((k) => [k, archivos[k] as string]),
  );
}

export function huella(m: Record<string, string>): string {
  return sha256(
    Object.entries(m)
      .map(([ruta, hash]) => `${hash}  ${ruta}\n`)
      .join(''),
  );
}

export function diferencias(antes: Record<string, string>, ahora: Record<string, string>): string[] {
  const rutas = [...new Set([...Object.keys(antes), ...Object.keys(ahora)])].sort();
  return rutas.flatMap((r) => {
    if (!(r in antes)) return [`A ${r}`];
    if (!(r in ahora)) return [`D ${r}`];
    return antes[r] === ahora[r] ? [] : [`M ${r}`];
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valor = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const actual = manifiesto();
  const lineas = [`Huella: ${huella(actual)}`];
  const comparar = valor('--comparar');
  if (comparar) lineas.push(...diferencias(JSON.parse(readFileSync(comparar, 'utf8')), actual));
  const guardar = valor('--guardar');
  if (guardar) writeFileSync(guardar, `${JSON.stringify(actual, null, 2)}\n`);
  process.stdout.write(`${lineas.join('\n')}\n`);
}
