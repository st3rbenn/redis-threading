"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
class Logger {
    constructor(moduleName) {
        this.moduleName = moduleName;
    }
    /**
     * Configure le niveau de log global
     */
    static setLogLevel(level) {
        Logger.logLevel = level;
    }
    shouldLog(level) {
        const levels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
        return levels[level] <= levels[Logger.logLevel];
    }
    /**
     * Génère un préfixe de log avec timestamp et nom du module
     */
    prefix() {
        const now = new Date();
        return `[${now.toISOString()}] [${this.moduleName}]`;
    }
    error(message, error) {
        if (this.shouldLog('error')) {
            console.error(`${this.prefix()} ERROR: ${message}`, error || '');
        }
    }
    warn(message, data) {
        if (this.shouldLog('warn')) {
            console.warn(`${this.prefix()} WARN: ${message}`, data || '');
        }
    }
    info(message, data) {
        if (this.shouldLog('info')) {
            console.info(`${this.prefix()} INFO: ${message}`, data ? JSON.stringify(data) : '');
        }
    }
    debug(message, data) {
        if (this.shouldLog('debug')) {
            console.debug(`${this.prefix()} DEBUG: ${message}`, data ? JSON.stringify(data) : '');
        }
    }
    trace(message, data) {
        if (this.shouldLog('trace')) {
            console.log(`${this.prefix()} TRACE: ${message}`, data ? JSON.stringify(data) : '');
        }
    }
}
exports.Logger = Logger;
Logger.logLevel = 'info';
//# sourceMappingURL=logger.js.map