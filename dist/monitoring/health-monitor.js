"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthMonitor = void 0;
const events_1 = require("events");
const os = __importStar(require("os"));
const logger_1 = require("../utils/logger");
/**
 * Surveille la santé du système et collecte des métriques de base
 */
class HealthMonitor extends events_1.EventEmitter {
    constructor(checkFrequency = 10000, nodeId) {
        super();
        this.checkFrequency = checkFrequency;
        this.checkInterval = null;
        this.lastCpuUsage = { user: 0, system: 0, idle: 0 };
        this.metrics = {
            system: {
                cpu: [],
                memory: [],
                loadAvg: []
            },
            process: {
                cpu: [],
                memory: [],
                eventLoopDelay: [],
                activeHandles: [],
                activeRequests: []
            },
            lastUpdate: Date.now()
        };
        this.metricsHistorySize = 60; // 60 mesures
        this.sharedState = null;
        this.isShuttingDown = false;
        this.logger = new logger_1.Logger('HealthMonitor');
        this.nodeId = nodeId || `node-${Math.floor(Math.random() * 10000)}`;
        // Initialiser les mesures CPU
        this.lastCpuUsage = this.getCpuUsage();
    }
    /**
     * Connecte le moniteur à l'état partagé pour la synchronisation
     */
    connectToSharedState(sharedState) {
        this.sharedState = sharedState;
    }
    /**
     * Démarre la surveillance
     */
    start() {
        if (this.checkInterval) {
            this.logger.warn('Health monitor is already running');
            return;
        }
        this.logger.info(`Starting health monitoring with ${this.checkFrequency}ms interval`);
        this.checkInterval = setInterval(() => {
            this.collectMetrics();
        }, this.checkFrequency);
        // Collecter immédiatement une première fois
        this.collectMetrics();
    }
    /**
     * Collecte les métriques système et processus
     */
    async collectMetrics() {
        if (this.isShuttingDown)
            return;
        const now = Date.now();
        const timeDiff = now - this.metrics.lastUpdate;
        this.metrics.lastUpdate = now;
        try {
            // Métriques système
            const cpuUsage = this.getCpuUsage();
            const systemCpuPercent = this.calculateCpuPercent(cpuUsage);
            const memoryUsage = this.getMemoryUsage();
            const loadAvg = os.loadavg()[0]; // Charge moyenne sur 1 minute
            // Métriques processus
            const processMemory = process.memoryUsage();
            const processMemoryPercent = (processMemory.heapUsed / processMemory.heapTotal) * 100;
            // Utilisation CPU du processus
            const processCpuUsage = process.cpuUsage();
            const processCpuPercent = this.calculateProcessCpuPercent(processCpuUsage, timeDiff);
            // Délai de la boucle d'événements
            const eventLoopDelay = await this.measureEventLoopDelay();
            // Activité du processus
            const activeHandles = process._getActiveHandles?.().length || 0;
            const activeRequests = process._getActiveRequests?.().length || 0;
            // Mettre à jour les métriques
            this.updateMetrics({
                system: {
                    cpu: systemCpuPercent,
                    memory: memoryUsage,
                    loadAvg
                },
                process: {
                    cpu: processCpuPercent,
                    memory: processMemoryPercent,
                    eventLoopDelay,
                    activeHandles,
                    activeRequests
                }
            });
            // Publier les métriques dans l'état partagé si disponible
            if (this.sharedState) {
                await this.sharedState.set(`metrics:${this.nodeId}:latest`, {
                    timestamp: now,
                    system: {
                        cpu: systemCpuPercent,
                        memory: memoryUsage,
                        loadAvg
                    },
                    process: {
                        cpu: processCpuPercent,
                        memory: processMemoryPercent,
                        eventLoopDelay,
                        activeHandles,
                        activeRequests
                    }
                }, { ttl: 60 } // Expire après 60 secondes si pas de mise à jour
                );
            }
            // Émettre l'événement de mise à jour
            this.emit('metrics:update', this.getLatestMetrics());
            // Vérifier si des seuils sont dépassés
            this.checkThresholds();
        }
        catch (error) {
            this.logger.error('Error collecting metrics', error);
        }
    }
    /**
     * Obtient l'utilisation CPU du système
     */
    getCpuUsage() {
        const cpus = os.cpus();
        let user = 0, system = 0, idle = 0;
        for (const cpu of cpus) {
            user += cpu.times.user;
            system += cpu.times.sys;
            idle += cpu.times.idle;
        }
        return { user, system, idle };
    }
    /**
     * Calcule le pourcentage d'utilisation CPU
     */
    calculateCpuPercent(current) {
        const userDiff = current.user - this.lastCpuUsage.user;
        const systemDiff = current.system - this.lastCpuUsage.system;
        const idleDiff = current.idle - this.lastCpuUsage.idle;
        const totalDiff = userDiff + systemDiff + idleDiff;
        // Mettre à jour les dernières valeurs
        this.lastCpuUsage = current;
        if (totalDiff === 0)
            return 0;
        return Math.min(100, Math.max(0, ((userDiff + systemDiff) / totalDiff) * 100));
    }
    /**
     * Calcule le pourcentage d'utilisation CPU du processus
     */
    calculateProcessCpuPercent(cpuUsage, elapsedMs) {
        // La somme user + system en microsecondes
        const totalCpuTime = cpuUsage.user + cpuUsage.system;
        // Convertir en millisecondes
        const totalCpuTimeMs = totalCpuTime / 1000;
        // Le nombre de cœurs disponibles
        const numCpus = os.cpus().length;
        // Pourcentage d'utilisation
        const percent = (totalCpuTimeMs / (elapsedMs * numCpus)) * 100;
        return Math.min(100, Math.max(0, percent));
    }
    /**
     * Obtient le pourcentage d'utilisation mémoire du système
     */
    getMemoryUsage() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return (usedMem / totalMem) * 100;
    }
    /**
     * Mesure le délai de la boucle d'événements
     */
    measureEventLoopDelay() {
        return new Promise(resolve => {
            const start = process.hrtime();
            // Planifier une tâche immédiate et mesurer combien de temps il a fallu
            setImmediate(() => {
                const [seconds, nanoseconds] = process.hrtime(start);
                const delayMs = (seconds * 1000) + (nanoseconds / 1000000);
                resolve(delayMs);
            });
        });
    }
    /**
     * Met à jour les métriques historiques
     */
    updateMetrics(newMetrics) {
        // Système
        this.metrics.system.cpu.push(newMetrics.system.cpu);
        this.metrics.system.memory.push(newMetrics.system.memory);
        this.metrics.system.loadAvg.push(newMetrics.system.loadAvg);
        // Processus
        this.metrics.process.cpu.push(newMetrics.process.cpu);
        this.metrics.process.memory.push(newMetrics.process.memory);
        this.metrics.process.eventLoopDelay.push(newMetrics.process.eventLoopDelay);
        this.metrics.process.activeHandles.push(newMetrics.process.activeHandles);
        this.metrics.process.activeRequests.push(newMetrics.process.activeRequests);
        // Limiter la taille de l'historique
        if (this.metrics.system.cpu.length > this.metricsHistorySize) {
            this.metrics.system.cpu.shift();
            this.metrics.system.memory.shift();
            this.metrics.system.loadAvg.shift();
            this.metrics.process.cpu.shift();
            this.metrics.process.memory.shift();
            this.metrics.process.eventLoopDelay.shift();
            this.metrics.process.activeHandles.shift();
            this.metrics.process.activeRequests.shift();
        }
    }
    /**
     * Vérifie si certains seuils sont dépassés
     */
    checkThresholds() {
        // Dernières valeurs
        const latest = this.getLatestMetrics();
        // CPU système
        if (latest.system.cpu > 85) {
            this.emit('alert', {
                type: 'system:cpu:high',
                value: latest.system.cpu,
                threshold: 85,
                message: `System CPU usage is high: ${latest.system.cpu.toFixed(1)}%`
            });
        }
        // Mémoire système
        if (latest.system.memory > 90) {
            this.emit('alert', {
                type: 'system:memory:high',
                value: latest.system.memory,
                threshold: 90,
                message: `System memory usage is high: ${latest.system.memory.toFixed(1)}%`
            });
        }
        // Délai de la boucle d'événements
        if (latest.process.eventLoopDelay > 100) {
            this.emit('alert', {
                type: 'process:eventloop:delay',
                value: latest.process.eventLoopDelay,
                threshold: 100,
                message: `Event loop delay is high: ${latest.process.eventLoopDelay.toFixed(2)}ms`
            });
        }
        // Mémoire processus
        if (latest.process.memory > 85) {
            this.emit('alert', {
                type: 'process:memory:high',
                value: latest.process.memory,
                threshold: 85,
                message: `Process memory usage is high: ${latest.process.memory.toFixed(1)}%`
            });
        }
        // Charge système
        const numCpus = os.cpus().length;
        if (latest.system.loadAvg > numCpus * 0.8) {
            this.emit('alert', {
                type: 'system:load:high',
                value: latest.system.loadAvg,
                threshold: numCpus * 0.8,
                message: `System load average is high: ${latest.system.loadAvg.toFixed(2)} (threshold: ${(numCpus * 0.8).toFixed(2)})`
            });
        }
    }
    /**
     * Obtient les dernières métriques
     */
    getLatestMetrics() {
        const getLastOrZero = (arr) => arr.length > 0 ? arr[arr.length - 1] : 0;
        return {
            system: {
                cpu: getLastOrZero(this.metrics.system.cpu),
                memory: getLastOrZero(this.metrics.system.memory),
                loadAvg: getLastOrZero(this.metrics.system.loadAvg)
            },
            process: {
                cpu: getLastOrZero(this.metrics.process.cpu),
                memory: getLastOrZero(this.metrics.process.memory),
                eventLoopDelay: getLastOrZero(this.metrics.process.eventLoopDelay),
                activeHandles: getLastOrZero(this.metrics.process.activeHandles),
                activeRequests: getLastOrZero(this.metrics.process.activeRequests)
            },
            timestamp: this.metrics.lastUpdate
        };
    }
    /**
     * Obtient l'historique des métriques
     */
    getMetricsHistory() {
        return {
            system: { ...this.metrics.system },
            process: { ...this.metrics.process }
        };
    }
    /**
     * Arrête la surveillance
     */
    async stop() {
        if (this.isShuttingDown)
            return;
        this.isShuttingDown = true;
        this.logger.info('Stopping health monitor...');
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        // Supprimer les métriques de l'état partagé
        if (this.sharedState) {
            await this.sharedState.delete(`metrics:${this.nodeId}:latest`);
        }
        this.logger.info('Health monitor stopped');
    }
    /**
     * Vérifie si le moniteur est actif
     */
    isActive() {
        return this.checkInterval !== null;
    }
}
exports.HealthMonitor = HealthMonitor;
//# sourceMappingURL=health-monitor.js.map