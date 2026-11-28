import { expect, test } from 'vitest';
import { diferencias, hashArchivo, huella, ignorado, leerReglas, manifiesto } from './huella.ts';

const reglas = leerReglas(
  'node_modules/\n.env\n.env.*\n!.env.example\n*.pem\n**/src/generated/\n.vscode/*\n!.vscode/settings.json\n',
);

test('respeta .gitignore: deja fuera lo ignorado y nunca el código', () => {
  expect(ignorado('apps/api/src/app.ts', false, reglas)).toBe(false);
  expect(ignorado('apps/api/node_modules', true, reglas)).toBe(true);
  expect(ignorado('packages/db/src/generated', true, reglas)).toBe(true);
  expect(ignorado('.env', false, reglas)).toBe(true);
  expect(ignorado('.env.local', false, reglas)).toBe(true);
  expect(ignorado('.env.example', false, reglas)).toBe(false);
  expect(ignorado('infra/certs/ca.pem', false, reglas)).toBe(true);
  expect(ignorado('.vscode/extra.json', false, reglas)).toBe(true);
  expect(ignorado('.vscode/settings.json', false, reglas)).toBe(false);
});

test('CRLF y LF dan la misma huella; un cambio de contenido la altera', () => {
  expect(hashArchivo(Buffer.from('a\r\nb\r\n'))).toBe(hashArchivo(Buffer.from('a\nb\n')));
  expect(huella({ x: hashArchivo(Buffer.from('a')) })).not.toBe(huella({ x: hashArchivo(Buffer.from('b')) }));
});

test('diferencias lista altas, cambios y bajas', () => {
  expect(diferencias({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' })).toEqual(['M b', 'D c', 'A d']);
});

test('el manifiesto del repo incluye el código y excluye auditorias, node_modules y lo generado', () => {
  const rutas = Object.keys(manifiesto());
  expect(rutas).toContain('package.json');
  expect(rutas).toContain('apps/api/src/app.ts');
  expect(rutas).toContain('packages/db/prisma/schema.prisma');
  expect(
    rutas.some((r) => r.startsWith('auditorias/') || r.includes('node_modules/') || r.includes('/generated/')),
  ).toBe(false);
});
