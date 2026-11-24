/**
 * Motor de Políticas Anti-Baneo para WhatsApp
 * Calcula retrasos aleatorios con distribución gaussiana y gestiona el warm-up.
 */

export interface AntiBanTiming {
  typingDurationMs: number;
  preMessageDelayMs: number;
}

export class AntiBanPolicyEngine {
  /**
   * Calcula el tiempo que el bot debe mostrarse como "Escribiendo..."
   * Proporcional a la longitud del texto con variación aleatoria humana.
   */
  static calculateTypingTime(messageLength: number): number {
    const charsPerSecond = 25; // Velocidad de escritura humana promedio
    const baseMs = (messageLength / charsPerSecond) * 1000;
    const jitter = Math.floor(Math.random() * 1200) - 600; // +/- 600ms
    const total = baseMs + jitter;

    // Nunca menos de 1.5s ni más de 5.5s
    return Math.min(Math.max(total, 1500), 5500);
  }

  /**
   * Genera un retardo entre mensajes sucesivos (Jitter gaussiano)
   * Evita patrones regulares que los algoritmos de detección de Meta identifican.
   */
  static calculateInterMessageDelay(): number {
    // Genera un retardo entre 2,500ms y 7,000ms
    return Math.floor(Math.random() * (7000 - 2500 + 1)) + 2500;
  }

  /**
   * Valida si un chip nuevo excede el límite seguro del protocolo de calentamiento
   */
  static checkWarmupLimit(antiguedadDias: number, mensajesEnviadosHoy: number): { permitido: boolean; limiteMaximo: number } {
    let limiteMaximo = 15; // Semana 1

    if (antiguedadDias > 21) {
      limiteMaximo = 400; // Mes 1+
    } else if (antiguedadDias > 14) {
      limiteMaximo = 150; // Semana 3
    } else if (antiguedadDias > 7) {
      limiteMaximo = 50;  // Semana 2
    }

    return {
      permitido: mensajesEnviadosHoy < limiteMaximo,
      limiteMaximo,
    };
  }
}
