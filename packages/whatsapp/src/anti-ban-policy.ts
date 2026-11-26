/**
 * Políticas anti-baneo para WhatsApp: retrasos con variación aleatoria y límites de calentamiento.
 */

/** Tiempo que el bot se muestra "escribiendo…": proporcional al texto, entre 1.5 s y 5.5 s. */
export function calculateTypingTime(messageLength: number): number {
  const charsPerSecond = 25; // velocidad de escritura humana promedio
  const baseMs = (messageLength / charsPerSecond) * 1000;
  const jitter = Math.floor(Math.random() * 1200) - 600; // ±600 ms
  return Math.min(Math.max(baseMs + jitter, 1500), 5500);
}

/** Retardo uniforme entre 2.5 s y 7 s entre mensajes: evita cadencias regulares detectables. */
export function calculateInterMessageDelay(): number {
  return Math.floor(Math.random() * (7000 - 2500 + 1)) + 2500;
}

/** Límite diario seguro según la antigüedad del chip (protocolo de calentamiento, plan §8.2). */
export function checkWarmupLimit(
  antiguedadDias: number,
  mensajesEnviadosHoy: number,
): { permitido: boolean; limiteMaximo: number } {
  const limiteMaximo = antiguedadDias > 21 ? 400 : antiguedadDias > 14 ? 150 : antiguedadDias > 7 ? 50 : 15;
  return { permitido: mensajesEnviadosHoy < limiteMaximo, limiteMaximo };
}
