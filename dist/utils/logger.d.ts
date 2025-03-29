export declare class Logger {
    private static logLevel;
    private moduleName;
    constructor(moduleName: string);
    /**
     * Configure le niveau de log global
     */
    static setLogLevel(level: 'error' | 'warn' | 'info' | 'debug' | 'trace'): void;
    private shouldLog;
    /**
     * Génère un préfixe de log avec timestamp et nom du module
     */
    private prefix;
    error(message: string, error?: Error | any): void;
    warn(message: string, data?: any): void;
    info(message: string, data?: any): void;
    debug(message: string, data?: any): void;
    trace(message: string, data?: any): void;
}
