"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskQueue = void 0;
const events_1 = require("events");
const uuid_1 = require("uuid");
const task_1 = require("../types/task");
const logger_1 = require("../utils/logger");
const redis_client_1 = require("../utils/redis-client");
const serialization_1 = require("../utils/serialization");
/**
 * File d'attente de tâches distribuée basée sur Redis
 * Implémente le pattern Repository
 */
class TaskQueue extends events_1.EventEmitter {
    constructor(redisConfig, queueName = 'default', namespace = 'rt') {
        super();
        this.redisConfig = redisConfig;
        this.queueName = queueName;
        this.namespace = namespace;
        this.processingTasks = new Map();
        this.isConsumerRunning = false;
        this.consumerActive = false;
        this.pollingInterval = 1000;
        this.shutdownRequested = false;
        this.logger = new logger_1.Logger(`TaskQueue:${queueName}`);
        // Obtenir les clients Redis
        const factory = redis_client_1.RedisClientFactory.getInstance();
        this.client = factory.getClient(redisConfig, `queue:${queueName}`);
        this.subscriberClient = factory.getSubscriberClient(redisConfig);
        // Configurer le subscriber pour les résultats
        this.setupResultSubscriber();
    }
    /**
     * Noms des clés Redis pour la file d'attente
     */
    get keys() {
        return {
            pendingList: `${this.namespace}:queue:${this.queueName}:pending`,
            processingList: `${this.namespace}:queue:${this.queueName}:processing`,
            taskHashKey: (taskId) => `${this.namespace}:task:${taskId}`,
            resultChannel: `${this.namespace}:results:${this.queueName}`,
            resultHashKey: (taskId) => `${this.namespace}:result:${taskId}`,
        };
    }
    /**
     * Mettre une tâche en file d'attente
     */
    async enqueue(taskType, data, options = {}) {
        // Créer une nouvelle tâche
        const task = {
            id: (0, uuid_1.v4)(),
            type: taskType,
            data,
            options,
            createdAt: Date.now(),
            status: task_1.TaskStatus.PENDING
        };
        this.logger.debug(`Enqueuing task ${task.id} of type ${taskType}`);
        // Stocker les données de la tâche dans un hash
        await this.client.hset(this.keys.taskHashKey(task.id), 'data', serialization_1.Serializer.serialize(task));
        // Configurer une expiration pour la tâche
        await this.client.expire(this.keys.taskHashKey(task.id), (options.timeout || 3600) + 60 // Ajouter une marge pour la gestion
        );
        // Ajouter à la file d'attente (à la fin)
        if (options.delay && options.delay > 0) {
            // Ajouter avec un délai à l'aide d'un set trié
            await this.client.zadd(`${this.namespace}:queue:${this.queueName}:delayed`, Date.now() + options.delay, task.id);
            this.logger.debug(`Task ${task.id} delayed for ${options.delay}ms`);
        }
        else {
            // Ajouter directement à la file d'attente
            await this.client.rpush(this.keys.pendingList, task.id);
        }
        // Retourner une promesse qui se résoudra lorsque la tâche sera terminée
        return new Promise((resolve, reject) => {
            const timeoutMs = options.timeout || 30000;
            // Configurer un timeout
            const timeoutId = setTimeout(() => {
                this.processingTasks.delete(task.id);
                const timeoutError = {
                    taskId: task.id,
                    error: {
                        name: 'TimeoutError',
                        message: `Task execution timed out after ${timeoutMs}ms`
                    },
                    completedAt: Date.now(),
                    executionTime: Date.now() - (task.createdAt || Date.now()),
                    workerId: 'unknown'
                };
                this.logger.warn(`Task ${task.id} timed out after ${timeoutMs}ms`);
                this.emit('task:timeout', timeoutError);
                reject(timeoutError);
            }, timeoutMs);
            // Stocker la promesse pour la résoudre plus tard
            this.processingTasks.set(task.id, {
                resolve,
                reject,
                timeout: timeoutId
            });
        });
    }
    /**
     * Démarrer la consommation des tâches
     */
    startConsumer(processTask, concurrency = 1) {
        if (this.isConsumerRunning) {
            this.logger.warn('Consumer is already running');
            return;
        }
        this.logger.info(`Starting consumer with concurrency ${concurrency}`);
        this.isConsumerRunning = true;
        this.consumerActive = true;
        // Traiter les tâches retardées
        this.startDelayedTasksProcessor();
        // Démarrer les workers de consommation
        for (let i = 0; i < concurrency; i++) {
            this.consumeTasks(processTask, i);
        }
    }
    /**
     * Traitement des tâches retardées
     */
    startDelayedTasksProcessor() {
        const checkInterval = setInterval(async () => {
            if (this.shutdownRequested) {
                clearInterval(checkInterval);
                return;
            }
            try {
                const now = Date.now();
                const delayedKey = `${this.namespace}:queue:${this.queueName}:delayed`;
                // Récupérer les tâches qui sont prêtes à être exécutées
                const taskIds = await this.client.zrangebyscore(delayedKey, 0, now);
                if (taskIds.length === 0)
                    return;
                this.logger.debug(`Moving ${taskIds.length} delayed tasks to pending queue`);
                // Pour chaque tâche, la déplacer vers la file d'attente
                const pipeline = this.client.pipeline();
                for (const taskId of taskIds) {
                    pipeline.rpush(this.keys.pendingList, taskId);
                    pipeline.zrem(delayedKey, taskId);
                }
                await pipeline.exec();
            }
            catch (error) {
                this.logger.error('Error processing delayed tasks', error);
            }
        }, 1000);
    }
    /**
     * Boucle de consommation des tâches
     */
    async consumeTasks(processTask, workerId) {
        const workerName = `consumer-${workerId}`;
        this.logger.debug(`${workerName} started`);
        while (this.consumerActive && !this.shutdownRequested) {
            try {
                // Récupérer une tâche de la file d'attente (bloquant avec timeout)
                const result = await this.client.blpop(this.keys.pendingList, this.pollingInterval / 1000);
                // Si pas de résultat, continuer
                if (!result)
                    continue;
                const taskId = result[1];
                this.logger.debug(`${workerName} processing task ${taskId}`);
                // Déplacer la tâche vers la liste des tâches en cours
                await this.client.rpush(this.keys.processingList, taskId);
                // Récupérer les données de la tâche
                const taskData = await this.client.hget(this.keys.taskHashKey(taskId), 'data');
                if (!taskData) {
                    this.logger.warn(`${workerName}: Task ${taskId} data not found`);
                    // Retirer de la liste des tâches en cours
                    await this.client.lrem(this.keys.processingList, 0, taskId);
                    continue;
                }
                const task = serialization_1.Serializer.deserialize(taskData);
                task.status = task_1.TaskStatus.PROCESSING;
                // Mettre à jour le statut
                await this.client.hset(this.keys.taskHashKey(taskId), 'data', serialization_1.Serializer.serialize(task));
                // Traiter la tâche
                const startTime = Date.now();
                try {
                    const result = await processTask(task);
                    // Créer le résultat
                    const taskResult = {
                        taskId: task.id,
                        result,
                        completedAt: Date.now(),
                        executionTime: Date.now() - startTime,
                        workerId: workerName
                    };
                    // Mettre à jour le statut
                    task.status = task_1.TaskStatus.COMPLETED;
                    await this.client.hset(this.keys.taskHashKey(taskId), 'data', serialization_1.Serializer.serialize(task));
                    // Stocker le résultat
                    await this.storeResult(taskResult);
                    this.logger.debug(`${workerName}: Task ${taskId} completed in ${taskResult.executionTime}ms`);
                }
                catch (error) {
                    // Créer le résultat d'erreur
                    const taskResult = {
                        taskId: task.id,
                        error: {
                            name: error.name || 'Error',
                            message: error.message || String(error),
                            stack: error.stack
                        },
                        completedAt: Date.now(),
                        executionTime: Date.now() - startTime,
                        workerId: workerName
                    };
                    // Mettre à jour le statut
                    task.status = task_1.TaskStatus.FAILED;
                    await this.client.hset(this.keys.taskHashKey(taskId), 'data', serialization_1.Serializer.serialize(task));
                    // Stocker le résultat
                    await this.storeResult(taskResult);
                    this.logger.warn(`${workerName}: Task ${taskId} failed: ${error.message}`);
                }
                // Retirer de la liste des tâches en cours
                await this.client.lrem(this.keys.processingList, 0, taskId);
            }
            catch (error) {
                this.logger.error(`${workerName}: Error consuming tasks`, error);
                // Attendre un peu avant de réessayer
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        this.logger.info(`${workerName} stopped`);
    }
    /**
     * Stocker le résultat d'une tâche et notifier les abonnés
     */
    async storeResult(result) {
        // Stocker le résultat
        await this.client.hset(this.keys.resultHashKey(result.taskId), 'data', serialization_1.Serializer.serialize(result));
        // Configurer une expiration pour le résultat
        await this.client.expire(this.keys.resultHashKey(result.taskId), 3600); // 1 heure
        // Publier le résultat pour notifier les abonnés
        await this.client.publish(this.keys.resultChannel, serialization_1.Serializer.serialize({ type: 'task:result', result }));
    }
    /**
     * Configurer le subscriber pour les résultats
     */
    setupResultSubscriber() {
        this.subscriberClient.subscribe(this.keys.resultChannel, (err) => {
            if (err) {
                this.logger.error('Error subscribing to result channel', err);
                return;
            }
            this.logger.debug(`Subscribed to result channel: ${this.keys.resultChannel}`);
        });
        this.subscriberClient.on('message', (channel, message) => {
            if (channel !== this.keys.resultChannel)
                return;
            try {
                const data = serialization_1.Serializer.deserialize(message);
                if (data.type === 'task:result') {
                    this.handleTaskResult(data.result);
                }
            }
            catch (error) {
                this.logger.error('Error handling result message', error);
            }
        });
    }
    /**
     * Gérer le résultat d'une tâche
     */
    handleTaskResult(result) {
        const taskId = result.taskId;
        const taskPromise = this.processingTasks.get(taskId);
        if (!taskPromise) {
            // Personne n'attend ce résultat
            return;
        }
        // Nettoyer le timeout
        clearTimeout(taskPromise.timeout);
        this.processingTasks.delete(taskId);
        // Résoudre la promesse
        if (result.error) {
            this.emit('task:error', result);
            taskPromise.reject(result);
        }
        else {
            this.emit('task:completed', result);
            taskPromise.resolve(result);
        }
    }
    /**
     * Obtenir l'état d'une tâche par son ID
     */
    async getTaskStatus(taskId) {
        const taskData = await this.client.hget(this.keys.taskHashKey(taskId), 'data');
        if (!taskData)
            return null;
        return serialization_1.Serializer.deserialize(taskData);
    }
    /**
     * Obtenir le résultat d'une tâche par son ID
     */
    async getTaskResult(taskId) {
        const resultData = await this.client.hget(this.keys.resultHashKey(taskId), 'data');
        if (!resultData)
            return null;
        return serialization_1.Serializer.deserialize(resultData);
    }
    /**
     * Obtenir des statistiques sur la file d'attente
     */
    async getStats() {
        const [pending, processing, delayed] = await Promise.all([
            this.client.llen(this.keys.pendingList),
            this.client.llen(this.keys.processingList),
            this.client.zcard(`${this.namespace}:queue:${this.queueName}:delayed`)
        ]);
        return {
            pending,
            processing,
            delayed
        };
    }
    /**
     * Récupérer les tâches bloquées (en cours depuis trop longtemps)
     */
    async recoverStaleTasks(maxAge = 300000) {
        const now = Date.now();
        const processingTasks = await this.client.lrange(this.keys.processingList, 0, -1);
        if (processingTasks.length === 0)
            return 0;
        let recoverCount = 0;
        const pipeline = this.client.pipeline();
        for (const taskId of processingTasks) {
            // Récupérer les données de la tâche
            const taskData = await this.client.hget(this.keys.taskHashKey(taskId), 'data');
            if (!taskData)
                continue;
            const task = serialization_1.Serializer.deserialize(taskData);
            // Vérifier si la tâche est bloquée
            if (task.status === task_1.TaskStatus.PROCESSING &&
                task.createdAt &&
                now - task.createdAt > maxAge) {
                // Remettre la tâche dans la file d'attente
                pipeline.lrem(this.keys.processingList, 0, taskId);
                pipeline.rpush(this.keys.pendingList, taskId);
                // Mettre à jour le statut
                task.status = task_1.TaskStatus.PENDING;
                pipeline.hset(this.keys.taskHashKey(taskId), 'data', serialization_1.Serializer.serialize(task));
                recoverCount++;
            }
        }
        if (recoverCount > 0) {
            await pipeline.exec();
            this.logger.info(`Recovered ${recoverCount} stale tasks`);
        }
        return recoverCount;
    }
    /**
     * Arrêter le consommateur
     */
    async shutdown(timeout = 10000) {
        if (!this.isConsumerRunning)
            return;
        this.logger.info('Shutting down task queue...');
        this.shutdownRequested = true;
        this.consumerActive = false;
        // Attendre que les tâches en cours se terminent
        const pendingPromises = Array.from(this.processingTasks.values()).map(({ timeout }) => clearTimeout(timeout));
        // Attendre un peu pour laisser le temps aux tâches de se terminer
        await Promise.race([
            Promise.all(pendingPromises),
            new Promise(resolve => setTimeout(resolve, timeout))
        ]);
        // Se désabonner du canal de résultats
        await this.subscriberClient.unsubscribe(this.keys.resultChannel);
        this.isConsumerRunning = false;
        this.logger.info('Task queue shutdown complete');
    }
}
exports.TaskQueue = TaskQueue;
//# sourceMappingURL=task-queue.js.map