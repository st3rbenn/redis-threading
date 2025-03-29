export class Logger {
  private static logLevel: string = 'info';
  private moduleName: string;

  constructor(moduleName: string) {
    this.moduleName = moduleName;
  }

  /**
   * Configure le niveau de log global
   */
  public static setLogLevel(level: 'error' | 'warn' | 'info' | 'debug' | 'trace'): void {
    Logger.logLevel = level;
  }

  private shouldLog(level: string): boolean {
    const levels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
    return levels[level as keyof typeof levels] <= levels[Logger.logLevel as keyof typeof levels];
  }

  /**
   * Génère un préfixe de log avec timestamp et nom du module
   */
  private prefix(): string {
    const now = new Date();
    return `[${now.toISOString()}] [${this.moduleName}]`;
  }

  public error(message: string, error?: Error | any): void {
    if (this.shouldLog('error')) {
      console.error(`${this.prefix()} ERROR: ${message}`, error || '');
    }
  }

  public warn(message: string, data?: any): void {
    if (this.shouldLog('warn')) {
      console.warn(`${this.prefix()} WARN: ${message}`, data || '');
    }
  }

  public info(message: string, data?: any): void {
    if (this.shouldLog('info')) {
      console.info(`${this.prefix()} INFO: ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  public debug(message: string, data?: any): void {
    if (this.shouldLog('debug')) {
      console.debug(`${this.prefix()} DEBUG: ${message}`, data ? JSON.stringify(data) : '');
    }
  }

  public trace(message: string, data?: any): void {
    if (this.shouldLog('trace')) {
      console.log(`${this.prefix()} TRACE: ${message}`, data ? JSON.stringify(data) : '');
    }
  }
}
