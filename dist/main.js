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
exports.Serializer = exports.Logger = exports.TaskExecutor = exports.TaskStatus = exports.RedisThreading = void 0;
const os_1 = require("os");
const events_1 = require("events");
const uuid_1 = require("uuid");
const worker_pool_1 = require("./worker-pool/worker-pool");
const task_executor_1 = require("./worker-pool/task-executor");
Object.defineProperty(exports, "TaskExecutor", { enumerable: true, get: function () { return task_executor_1.TaskExecutor; } });
const queue_manager_1 = require("./queue/queue-manager");
const message_broker_1 = require("./communication/message-broker");
const shared_state_1 = require("./communication/shared-state");
const health_monitor_1 = require("./monitoring/health-monitor");
const task_1 = require("./types/task");
Object.defineProperty(exports, "TaskStatus", { enumerable: true, get: function () { return task_1.TaskStatus; } });
const logger_1 = require("./utils/logger");
Object.defineProperty(exports, "Logger", { enumerable: true, get: function () { return logger_1.Logger; } });
const redis_client_1 = require("./utils/redis-client");
const serialization_1 = require("./utils/serialization");
Object.defineProperty(exports, "Serializer", { enumerable: true, get: function () { return serialization_1.Serializer; } });
const path = __importStar(require("path"));
/**
 * Classe principale qui regroupe toutes les fonctionnalités de la bibliothèque
 * Implémente le pattern Façade
 */
class RedisThreading extends events_1.EventEmitter {
    constructor(config) {
        super();
        this.workerPool = null;
        this.queueManager = null;
        this.messageBroker = null;
        this.sharedState = null;
        this.healthMonitor = null;
        this.isInitialized = false;
        this.isShuttingDown = false;
        this.config = this.normalizeConfig(config);
        this.nodeId = (0, uuid_1.v4)();
        this.logger = new logger_1.Logger('RedisThreading');
        // Configurer le niveau de log global
        logger_1.Logger.setLogLevel(this.config.logLevel || 'info');
    }
    /**
     * Normalise la configuration
     */
    normalizeConfig(config) {
        return {
            ...config,
            workerPool: {
                minWorkers: config.workerPool?.minWorkers || Math.max(1, (0, os_1.cpus)().length - 1),
                maxWorkers: config.workerPool?.maxWorkers || (0, os_1.cpus)().length * 2,
                idleTimeout: config.workerPool?.idleTimeout || 60000,
                taskTimeout: config.workerPool?.taskTimeout || 30000,
                ...(config.workerPool || {})
            },
            namespace: config.namespace || 'rt',
            logLevel: config.logLevel || 'info',
            shutdownTimeout: config.shutdownTimeout || 10000
        };
    }
    /**
     * Initialise la bibliothèque
     */
    async initialize() {
        if (this.isInitialized) {
            this.logger.warn('RedisThreading is already initialized');
            return;
        }
        this.logger.info(`Initializing RedisThreading (Node ID: ${this.nodeId})`);
        try {
            // Initialiser le gestionnaire d'état partagé
            this.sharedState = shared_state_1.SharedState.getInstance(this.config.redis, this.config.namespace);
            // Initialiser le broker de messages
            this.messageBroker = message_broker_1.MessageBroker.getInstance(this.config.redis, this.config.namespace);
            // Initialiser le gestionnaire de files d'attente
            this.queueManager = queue_manager_1.QueueManager.getInstance(this.config.redis, this.config.namespace);
            // Initialiser le moniteur de santé
            this.healthMonitor = new health_monitor_1.HealthMonitor(10000, this.nodeId);
            this.healthMonitor.connectToSharedState(this.sharedState);
            // Configurer le moniteur de santé
            this.healthMonitor.on('alert', (alert) => {
                this.logger.warn(`Health alert: ${alert.message}`);
                this.emit('health:alert', alert);
            });
            this.healthMonitor.on('metrics:update', (metrics) => {
                this.emit('metrics:update', metrics);
            });
            // Enregistrer la présence du nœud
            await this.sharedState.set(`nodes:${this.nodeId}:info`, {
                id: this.nodeId,
                hostname: require('os').hostname(),
                pid: process.pid,
                startTime: Date.now(),
                version: require('../package.json').version
            }, { ttl: 60 } // Expire après 60 secondes si pas de mise à jour
            );
            // Démarrer le ping de présence
            this.startPresencePing();
            // Démarrer le moniteur de santé
            this.healthMonitor.start();
            this.isInitialized = true;
            this.logger.info('RedisThreading initialized successfully');
        }
        catch (error) {
            this.logger.error('Error initializing RedisThreading', error);
            throw error;
        }
    }
    /**
     * Ping périodique pour maintenir la présence du nœud
     */
    startPresencePing() {
        setInterval(async () => {
            if (this.isShuttingDown || !this.sharedState)
                return;
            // Renouveler la présence du nœud
            await this.sharedState.expire(`nodes:${this.nodeId}:info`, 60);
        }, 30000); // Ping toutes les 30 secondes
    }
    /**
     * Initialise le worker pool
     */
    async initializeWorkerPool(workerScriptPath, workerData) {
        if (!this.isInitialized) {
            throw new Error('RedisThreading must be initialized first');
        }
        if (this.workerPool) {
            this.logger.warn('Worker pool is already initialized');
            return;
        }
        // S'assurer que le chemin est absolu
        const absolutePath = path.isAbsolute(workerScriptPath)
            ? workerScriptPath
            : path.resolve(process.cwd(), workerScriptPath);
        this.logger.info(`Initializing worker pool with script: ${absolutePath}`);
        this.workerPool = worker_pool_1.WorkerPool.getInstance(absolutePath, this.config.workerPool, {
            ...workerData,
            nodeId: this.nodeId,
            redisConfig: this.config.redis,
            namespace: this.config.namespace
        });
        // Configurer les événements du worker pool
        this.workerPool.on('worker:error', (data) => {
            this.logger.error(`Worker ${data.workerId} error:`, data.error);
            this.emit('worker:error', data);
        });
        this.workerPool.on('task:completed', (result) => {
            this.logger.debug(`Task ${result.taskId} completed successfully`);
            this.emit('task:completed', result);
        });
        this.workerPool.on('task:error', (result) => {
            this.logger.warn(`Task ${result.taskId} failed:`, result.error);
            this.emit('task:error', result);
        });
        this.workerPool.on('task:timeout', (result) => {
            this.logger.warn(`Task ${result.taskId} timed out`);
            this.emit('task:timeout', result);
        });
    }
    /**
     * Démarre la consommation de tâches depuis Redis
     */
    startQueueConsumer(concurrency = 2, queueNames = ['default']) {
        if (!this.isInitialized) {
            throw new Error('RedisThreading must be initialized first');
        }
        if (!this.queueManager) {
            throw new Error('Queue manager is not initialized');
        }
        this.logger.info(`Starting queue consumer with concurrency ${concurrency} for queues: ${queueNames.join(', ')}`);
        // Configurer les événements du queue manager
        this.queueManager.on('task:completed', (result) => {
            this.emit('task:completed', result);
        });
        this.queueManager.on('task:error', (result) => {
            this.emit('task:error', result);
        });
        this.queueManager.on('task:timeout', (result) => {
            this.emit('task:timeout', result);
        });
        // Démarrer le consommateur
        this.queueManager.startConsumer(concurrency, queueNames);
    }
    /**
     * Enregistre un gestionnaire de tâche
     */
    registerTaskHandler(taskType, handler) {
        if (!this.queueManager) {
            throw new Error('Queue manager is not initialized');
        }
        this.logger.info(`Registering handler for task type: ${taskType}`);
        this.queueManager.registerTaskHandler(taskType, handler);
    }
    /**
     * Exécute une tâche en local
     */
    async executeTask(taskType, data, options) {
        if (!this.workerPool) {
            throw new Error('Worker pool is not initialized');
        }
        const task = {
            id: (0, uuid_1.v4)(),
            type: taskType,
            data,
            options: {
                timeout: options?.timeout
            },
            createdAt: Date.now(),
            status: task_1.TaskStatus.PENDING
        };
        this.logger.debug(`Executing task ${task.id} of type ${taskType} locally`);
        return this.workerPool.executeTask(task);
    }
    /**
     * Enfile une tâche dans Redis
     */
    async enqueueTask(taskType, data, options) {
        if (!this.queueManager) {
            throw new Error('Queue manager is not initialized');
        }
        this.logger.debug(`Enqueuing task of type ${taskType} to queue ${options?.queueName || 'default'}`);
        return this.queueManager.enqueue(taskType, data, options);
    }
    /**
     * S'abonne à un canal de message
     */
    subscribeToChannel(channel, handler) {
        if (!this.messageBroker) {
            throw new Error('Message broker is not initialized');
        }
        this.logger.debug(`Subscribing to channel: ${channel}`);
        return this.messageBroker.subscribe(channel, (message) => {
            handler(message.data);
        });
    }
    /**
     * Publie un message sur un canal
     */
    async publishToChannel(channel, data) {
        if (!this.messageBroker) {
            throw new Error('Message broker is not initialized');
        }
        this.logger.debug(`Publishing message to channel: ${channel}`);
        await this.messageBroker.publish(channel, data);
    }
    /**
     * Envoie une requête et attend une réponse
     */
    async sendRequest(channel, data, timeout = 30000) {
        if (!this.messageBroker) {
            throw new Error('Message broker is not initialized');
        }
        this.logger.debug(`Sending request to channel: ${channel}`);
        return this.messageBroker.request(channel, data, timeout);
    }
    /**
     * Stocke une valeur dans l'état partagé
     */
    async setState(key, value, options) {
        if (!this.sharedState) {
            throw new Error('Shared state is not initialized');
        }
        return this.sharedState.set(key, value, options);
    }
    /**
     * Récupère une valeur de l'état partagé
     */
    async getState(key) {
        if (!this.sharedState) {
            throw new Error('Shared state is not initialized');
        }
        return this.sharedState.get(key);
    }
    /**
     * S'abonne aux changements d'une clé dans l'état partagé
     */
    onStateChange(key, callback) {
        if (!this.sharedState) {
            throw new Error('Shared state is not initialized');
        }
        // Obtenir la valeur initiale
        this.sharedState.get(key).then(value => {
            callback(value);
        });
        return this.sharedState.onChange(key, async () => {
            const value = await this.sharedState.get(key);
            callback(value);
        });
    }
    /**
     * Supprime une clé de l'état partagé
     */
    async deleteState(key) {
        if (!this.sharedState) {
            throw new Error('Shared state is not initialized');
        }
        return this.sharedState.delete(key);
    }
    /**
     * Acquiert un verrou distribué
     */
    async acquireLock(lockName, ttl = 30) {
        if (!this.sharedState) {
            throw new Error('Shared state is not initialized');
        }
        return this.sharedState.acquireLock(lockName, ttl);
    }
    /**
     * Relâche un verrou distribué
     */
    async releaseLock(lockName) {
        if (!this.sharedState) {
            throw new Error('Shared state is not initialized');
        }
        return this.sharedState.releaseLock(lockName);
    }
    /**
     * Obtient des métriques de santé
     */
    getHealthMetrics() {
        if (!this.healthMonitor) {
            throw new Error('Health monitor is not initialized');
        }
        return this.healthMonitor.getLatestMetrics();
    }
    /**
     * Obtient des statistiques sur les workers et les files d'attente
     */
    async getStats() {
        const stats = {
            nodeId: this.nodeId,
            health: this.healthMonitor ? this.healthMonitor.getLatestMetrics() : null
        };
        // Stats du worker pool
        if (this.workerPool) {
            const workerStats = this.workerPool.getStats();
            stats.workers = workerStats.workers;
        }
        // Stats des files d'attente
        if (this.queueManager) {
            const queueStats = await this.queueManager.getStats();
            stats.queues = queueStats.queues;
            stats.handlers = queueStats.handlers;
        }
        return stats;
    }
    /**
     * Arrête proprement tous les services
     */
    async shutdown() {
        if (this.isShuttingDown) {
            this.logger.warn('Shutdown already in progress');
            return;
        }
        this.isShuttingDown = true;
        this.logger.info('Shutting down RedisThreading...');
        // Stopper le moniteur de santé
        if (this.healthMonitor) {
            await this.healthMonitor.stop();
        }
        // Supprimer l'info du nœud
        if (this.sharedState) {
            await this.sharedState.delete(`nodes:${this.nodeId}:info`);
        }
        // Arrêter les workers
        if (this.workerPool) {
            await this.workerPool.shutdown(this.config.shutdownTimeout);
        }
        // Arrêter le gestionnaire de files d'attente
        if (this.queueManager) {
            await this.queueManager.shutdown(this.config.shutdownTimeout);
        }
        // Arrêter le broker de messages
        if (this.messageBroker) {
            await this.messageBroker.shutdown();
        }
        // Arrêter le gestionnaire d'état partagé
        if (this.sharedState) {
            await this.sharedState.shutdown();
        }
        // Fermer toutes les connexions Redis
        const factory = redis_client_1.RedisClientFactory.getInstance();
        await factory.closeAll();
        this.logger.info('RedisThreading shutdown complete');
    }
}
exports.RedisThreading = RedisThreading;
// Export default
exports.default = RedisThreading;
//# sourceMappingURL=main.js.map