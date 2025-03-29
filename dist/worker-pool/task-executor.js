"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskExecutor = void 0;
const worker_threads_1 = require("worker_threads");
const uuid_1 = require("uuid");
/**
 * Classe utilitaire pour l'exécution des tâches dans un worker
 * Implémente le pattern Command
 */
class TaskExecutor {
    constructor() {
        this.taskHandlers = new Map();
        this.workerId = worker_threads_1.workerData?.workerId || (0, uuid_1.v4)();
        this.setupMessageHandling();
    }
    /**
     * Configure la gestion des messages
     */
    setupMessageHandling() {
        if (!worker_threads_1.parentPort) {
            this.log('error', 'TaskExecutor must be used in a worker thread');
            return;
        }
        worker_threads_1.parentPort.on('message', async (message) => {
            if (message.type === 'task:execute') {
                await this.executeTask(message.task);
            }
        });
        // Indiquer que le worker est prêt
        this.log('info', `Worker ${this.workerId} initialized`);
    }
    /**
     * Enregistre un gestionnaire de tâche
     * @param taskType Type de tâche
     * @param handler Fonction de traitement
     */
    registerTaskHandler(taskType, handler) {
        this.taskHandlers.set(taskType, handler);
        this.log('debug', `Registered handler for task type: ${taskType}`);
    }
    /**
     * Exécute une tâche
     * @param task Tâche à exécuter
     */
    async executeTask(task) {
        if (!worker_threads_1.parentPort)
            return;
        this.log('debug', `Executing task ${task.id} of type ${task.type}`);
        try {
            // Vérifier si un handler existe pour ce type de tâche
            const handler = this.taskHandlers.get(task.type);
            if (!handler) {
                throw new Error(`No handler registered for task type: ${task.type}`);
            }
            // Exécuter le handler
            const result = await handler(task.data, { id: task.id, type: task.type });
            // Envoyer le résultat
            worker_threads_1.parentPort.postMessage({
                type: 'task:result',
                taskId: task.id,
                result
            });
            this.log('debug', `Task ${task.id} completed successfully`);
        }
        catch (error) {
            this.log('error', `Task ${task.id} failed: ${error.message}`, error);
            // Envoyer l'erreur
            worker_threads_1.parentPort.postMessage({
                type: 'task:result',
                taskId: task.id,
                error: {
                    name: error.name || 'Error',
                    message: error.message || String(error),
                    stack: error.stack
                }
            });
        }
    }
    /**
     * Envoie un message de log au thread principal
     */
    log(level, message, data) {
        if (!worker_threads_1.parentPort)
            return;
        worker_threads_1.parentPort.postMessage({
            type: 'log',
            level,
            message,
            data,
            timestamp: Date.now(),
            workerId: this.workerId
        });
    }
    /**
     * Envoie un rapport de santé au thread principal
     */
    sendHealthReport(data) {
        if (!worker_threads_1.parentPort)
            return;
        worker_threads_1.parentPort.postMessage({
            type: 'health:report',
            data: {
                ...data,
                timestamp: Date.now()
            },
            workerId: this.workerId
        });
    }
}
exports.TaskExecutor = TaskExecutor;
//# sourceMappingURL=task-executor.js.map