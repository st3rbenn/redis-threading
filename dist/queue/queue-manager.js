"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueueManager = void 0;
const events_1 = require("events");
const task_queue_1 = require("./task-queue");
const logger_1 = require("../utils/logger");
/**
 * Gestionnaire de files d'attente
 * Implémente le pattern Façade
 */
class QueueManager extends events_1.EventEmitter {
    constructor(redisConfig, namespace = 'rt') {
        super();
        this.redisConfig = redisConfig;
        this.namespace = namespace;
        this.queues = new Map();
        this.taskHandlers = new Map();
        this.isConsumerRunning = false;
        this.consumerConcurrency = 1;
        this.staleTasks = {
            checkInterval: 60000, // 1 minute
            maxAge: 300000, // 5 minutes
            intervalId: null
        };
        this.logger = new logger_1.Logger('QueueManager');
    }
    /**
     * Obtient l'instance unique du gestionnaire
     */
    static getInstance(redisConfig, namespace) {
        if (!QueueManager.instance) {
            if (!redisConfig) {
                throw new Error('Redis config is required for first initialization');
            }
            QueueManager.instance = new QueueManager(redisConfig, namespace);
        }
        return QueueManager.instance;
    }
    /**
     * Obtient ou crée une file d'attente
     */
    getQueue(queueName = 'default') {
        if (this.queues.has(queueName)) {
            return this.queues.get(queueName);
        }
        const queue = new task_queue_1.TaskQueue(this.redisConfig, queueName, this.namespace);
        // Configurer les événements
        queue.on('task:completed', this.handleTaskCompleted.bind(this));
        queue.on('task:error', this.handleTaskError.bind(this));
        queue.on('task:timeout', this.handleTaskTimeout.bind(this));
        this.queues.set(queueName, queue);
        return queue;
    }
    /**
     * Enfile une tâche et attend son résultat
     */
    async enqueue(taskType, data, options = {}) {
        const queueName = options.queueName || 'default';
        const queue = this.getQueue(queueName);
        return queue.enqueue(taskType, data, {
            priority: options.priority,
            timeout: options.timeout,
            retries: options.retries,
            delay: options.delay
        });
    }
    /**
     * Enregistre un gestionnaire de tâche
     */
    registerTaskHandler(taskType, handler) {
        this.taskHandlers.set(taskType, handler);
        this.logger.debug(`Registered handler for task type: ${taskType}`);
    }
    /**
     * Démarre le consommateur de tâches
     */
    startConsumer(concurrency = 1, queueNames = ['default']) {
        if (this.isConsumerRunning) {
            this.logger.warn('Consumer is already running');
            return;
        }
        this.logger.info(`Starting consumer with concurrency ${concurrency} for queues: ${queueNames.join(', ')}`);
        this.consumerConcurrency = concurrency;
        this.isConsumerRunning = true;
        // Démarrer le consommateur pour chaque file d'attente
        for (const queueName of queueNames) {
            const queue = this.getQueue(queueName);
            queue.startConsumer(this.processTask.bind(this), concurrency);
        }
        // Démarrer la vérification des tâches bloquées
        this.startStaleTasksCheck();
    }
    /**
     * Traite une tâche
     */
    async processTask(task) {
        const handler = this.taskHandlers.get(task.type);
        if (!handler) {
            throw new Error(`No handler registered for task type: ${task.type}`);
        }
        this.logger.debug(`Processing task ${task.id} of type ${task.type}`);
        return handler(task.data, { id: task.id, type: task.type });
    }
    /**
     * Démarre la vérification des tâches bloquées
     */
    startStaleTasksCheck() {
        if (this.staleTasks.intervalId) {
            clearInterval(this.staleTasks.intervalId);
        }
        this.staleTasks.intervalId = setInterval(async () => {
            try {
                let totalRecovered = 0;
                for (const [queueName, queue] of this.queues.entries()) {
                    const recovered = await queue.recoverStaleTasks(this.staleTasks.maxAge);
                    totalRecovered += recovered;
                }
                if (totalRecovered > 0) {
                    this.logger.info(`Recovered ${totalRecovered} stale tasks across all queues`);
                }
            }
            catch (error) {
                this.logger.error('Error checking for stale tasks', error);
            }
        }, this.staleTasks.checkInterval);
    }
    /**
     * Gère la complétion d'une tâche
     */
    handleTaskCompleted(result) {
        this.logger.debug(`Task ${result.taskId} completed by worker ${result.workerId}`);
        this.emit('task:completed', result);
    }
    /**
     * Gère les erreurs de tâche
     */
    handleTaskError(result) {
        this.logger.warn(`Task ${result.taskId} failed with error:`, result.error);
        this.emit('task:error', result);
    }
    /**
     * Gère les timeouts de tâche
     */
    handleTaskTimeout(result) {
        this.logger.warn(`Task ${result.taskId} timed out after ${result.executionTime}ms`);
        this.emit('task:timeout', result);
    }
    /**
     * Obtient des statistiques sur toutes les files d'attente
     */
    async getStats() {
        const queueStats = {};
        for (const [queueName, queue] of this.queues.entries()) {
            queueStats[queueName] = await queue.getStats();
        }
        return {
            queues: queueStats,
            handlers: Array.from(this.taskHandlers.keys())
        };
    }
    /**
     * Arrête tous les consommateurs
     */
    async shutdown(timeout = 10000) {
        if (!this.isConsumerRunning)
            return;
        this.logger.info('Shutting down queue manager...');
        // Arrêter la vérification des tâches bloquées
        if (this.staleTasks.intervalId) {
            clearInterval(this.staleTasks.intervalId);
            this.staleTasks.intervalId = null;
        }
        // Arrêter tous les consommateurs
        const shutdownPromises = [];
        for (const [queueName, queue] of this.queues.entries()) {
            shutdownPromises.push(queue.shutdown(timeout));
        }
        await Promise.all(shutdownPromises);
        this.isConsumerRunning = false;
        this.logger.info('Queue manager shutdown complete');
    }
}
exports.QueueManager = QueueManager;
//# sourceMappingURL=queue-manager.js.map