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
exports.WorkerThread = void 0;
const worker_threads_1 = require("worker_threads");
const events_1 = require("events");
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
const path = __importStar(require("path"));
/**
 * Représente un worker thread individuel
 */
class WorkerThread extends events_1.EventEmitter {
    /**
     * Crée un nouveau worker thread
     * @param scriptPath Chemin vers le script worker
     * @param workerData Données à passer au worker
     * @param options Options du worker
     */
    constructor(scriptPath, workerData = {}, options = {}) {
        super();
        this.scriptPath = scriptPath;
        this.workerData = workerData;
        this.options = options;
        this.worker = null;
        this.taskTimeouts = new Map();
        this.busy = false;
        this.startTime = 0;
        this.lastActivityTime = Date.now();
        this.stats = {
            tasksProcessed: 0,
            errors: 0,
            totalExecutionTime: 0
        };
        this.id = (0, uuid_1.v4)();
        this.logger = new logger_1.Logger(`WorkerThread-${this.id.substr(0, 8)}`);
    }
    /**
     * Démarre le worker thread
     */
    start() {
        if (this.worker) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            try {
                // S'assurer que le chemin est absolu
                const workerPath = path.isAbsolute(this.scriptPath)
                    ? this.scriptPath
                    : path.resolve(process.cwd(), this.scriptPath);
                this.worker = new worker_threads_1.Worker(workerPath, {
                    ...this.options,
                    workerData: {
                        ...this.workerData,
                        workerId: this.id
                    }
                });
                this.worker.on('online', () => {
                    this.logger.info('Worker started successfully');
                    this.lastActivityTime = Date.now();
                    resolve();
                });
                this.worker.on('message', this.handleWorkerMessage.bind(this));
                this.worker.on('error', this.handleWorkerError.bind(this));
                this.worker.on('exit', this.handleWorkerExit.bind(this));
            }
            catch (error) {
                this.logger.error('Failed to start worker', error);
                reject(error);
            }
        });
    }
    /**
     * Exécute une tâche sur ce worker
     * @param task Tâche à exécuter
     * @param timeout Timeout en ms
     */
    executeTask(task, timeout = 30000) {
        if (!this.worker || this.busy) {
            return Promise.reject(new Error('Worker not available'));
        }
        this.busy = true;
        this.startTime = Date.now();
        this.lastActivityTime = this.startTime;
        return new Promise((resolve, reject) => {
            // Configurer le timeout
            const timeoutId = setTimeout(() => {
                this.taskTimeouts.delete(task.id);
                this.busy = false;
                const timeoutError = {
                    taskId: task.id,
                    error: {
                        name: 'TimeoutError',
                        message: `Task execution timed out after ${timeout}ms`
                    },
                    completedAt: Date.now(),
                    executionTime: Date.now() - this.startTime,
                    workerId: this.id
                };
                this.logger.warn(`Task ${task.id} timed out after ${timeout}ms`);
                this.stats.errors++;
                // Émettre l'événement de timeout
                this.emit('task:timeout', timeoutError);
                reject(timeoutError);
            }, timeout);
            this.taskTimeouts.set(task.id, timeoutId);
            // Handler de message pour cette tâche spécifique
            const messageHandler = (message) => {
                if (message.type === 'task:result' && message.taskId === task.id) {
                    const endTime = Date.now();
                    const executionTime = endTime - this.startTime;
                    // Nettoyer le timeout
                    clearTimeout(this.taskTimeouts.get(task.id));
                    this.taskTimeouts.delete(task.id);
                    this.busy = false;
                    this.lastActivityTime = endTime;
                    // Mettre à jour les statistiques
                    this.stats.tasksProcessed++;
                    this.stats.totalExecutionTime += executionTime;
                    if (message.error) {
                        this.stats.errors++;
                    }
                    // Construire le résultat
                    const result = {
                        taskId: task.id,
                        result: message.result,
                        error: message.error,
                        completedAt: endTime,
                        executionTime,
                        workerId: this.id
                    };
                    // Supprimer le listener spécifique à cette tâche
                    this.worker?.removeListener('message', messageHandler);
                    // Émettre l'événement de complétion
                    if (message.error) {
                        this.emit('task:error', result);
                        reject(result);
                    }
                    else {
                        this.emit('task:completed', result);
                        resolve(result);
                    }
                }
            };
            // Ajouter le handler temporaire
            this.worker?.on('message', messageHandler);
            // Envoyer la tâche au worker
            this.worker?.postMessage({
                type: 'task:execute',
                task
            });
            this.logger.debug(`Task ${task.id} sent to worker`);
        });
    }
    /**
     * Termine le worker thread
     */
    terminate() {
        if (!this.worker) {
            return Promise.resolve(0);
        }
        // Annuler tous les timeouts
        for (const [taskId, timeoutId] of this.taskTimeouts.entries()) {
            clearTimeout(timeoutId);
            this.taskTimeouts.delete(taskId);
        }
        return this.worker.terminate();
    }
    /**
     * Termine le worker s'il est inactif depuis trop longtemps
     * @param maxIdleTime Temps maximum d'inactivité en ms
     */
    terminateIfIdle(maxIdleTime) {
        if (this.busy)
            return false;
        const idleTime = Date.now() - this.lastActivityTime;
        if (idleTime > maxIdleTime) {
            this.logger.info(`Terminating idle worker (inactive for ${idleTime}ms)`);
            this.terminate().catch(err => {
                this.logger.error('Error terminating idle worker', err);
            });
            return true;
        }
        return false;
    }
    /**
     * Vérifie si le worker est en bonne santé
     */
    isHealthy() {
        return this.worker !== null && !this.worker;
    }
    /**
     * Gère les messages génériques du worker
     */
    handleWorkerMessage(message) {
        this.lastActivityTime = Date.now();
        if (message.type === 'log') {
            switch (message.level) {
                case 'error':
                    this.logger.error(`[Worker] ${message.message}`, message.data);
                    break;
                case 'warn':
                    this.logger.warn(`[Worker] ${message.message}`, message.data);
                    break;
                case 'info':
                    this.logger.info(`[Worker] ${message.message}`, message.data);
                    break;
                case 'debug':
                    this.logger.debug(`[Worker] ${message.message}`, message.data);
                    break;
                default:
                    this.logger.info(`[Worker] ${message.message}`, message.data);
            }
        }
        else if (message.type === 'health:report') {
            this.emit('health:report', {
                workerId: this.id,
                ...message.data
            });
        }
    }
    /**
     * Gère les erreurs du worker
     */
    handleWorkerError(error) {
        this.logger.error('Worker error', error);
        this.stats.errors++;
        this.emit('error', {
            workerId: this.id,
            error
        });
    }
    /**
     * Gère la sortie du worker
     */
    handleWorkerExit(code) {
        this.logger.info(`Worker exited with code ${code}`);
        this.worker = null;
        this.busy = false;
        // Nettoyer les timeouts
        for (const [taskId, timeoutId] of this.taskTimeouts.entries()) {
            clearTimeout(timeoutId);
            this.taskTimeouts.delete(taskId);
        }
        this.emit('exit', {
            workerId: this.id,
            code
        });
    }
}
exports.WorkerThread = WorkerThread;
//# sourceMappingURL=worker-thread.js.map