import { EventEmitter } from 'events';
import { TaskExecutor } from './worker-pool/task-executor';
import { Task, TaskHandler, TaskResult, TaskStatus } from './types/task';
import { Message, MessageHandler } from './types/message';
import { RedisConfig, RedisThreadingConfig, WorkerPoolConfig } from './types/config';
import { Logger } from './utils/logger';
import { Serializer } from './utils/serialization';
/**
 * Classe principale qui regroupe toutes les fonctionnalités de la bibliothèque
 * Implémente le pattern Façade
 */
export declare class RedisThreading extends EventEmitter {
    private logger;
    private config;
    private workerPool;
    private queueManager;
    private messageBroker;
    private sharedState;
    private healthMonitor;
    private nodeId;
    private isInitialized;
    private isShuttingDown;
    constructor(config: RedisThreadingConfig);
    /**
     * Normalise la configuration
     */
    private normalizeConfig;
    /**
     * Initialise la bibliothèque
     */
    initialize(): Promise<void>;
    /**
     * Ping périodique pour maintenir la présence du nœud
     */
    private startPresencePing;
    /**
     * Initialise le worker pool
     */
    initializeWorkerPool(workerScriptPath: string, workerData?: any): Promise<void>;
    /**
     * Démarre la consommation de tâches depuis Redis
     */
    startQueueConsumer(concurrency?: number, queueNames?: string[]): void;
    /**
     * Enregistre un gestionnaire de tâche
     */
    registerTaskHandler<TInput = any, TOutput = any>(taskType: string, handler: TaskHandler<TInput, TOutput>): void;
    /**
     * Exécute une tâche en local
     */
    executeTask<TInput = any, TOutput = any>(taskType: string, data: TInput, options?: {
        timeout?: number;
    }): Promise<TaskResult<TOutput>>;
    /**
     * Enfile une tâche dans Redis
     */
    enqueueTask<TInput = any, TOutput = any>(taskType: string, data: TInput, options?: {
        queueName?: string;
        priority?: number;
        timeout?: number;
        retries?: number;
        delay?: number;
    }): Promise<TaskResult<TOutput>>;
    /**
     * S'abonne à un canal de message
     */
    subscribeToChannel<T = any>(channel: string, handler: (data: T) => void): () => void;
    /**
     * Publie un message sur un canal
     */
    publishToChannel<T = any>(channel: string, data: T): Promise<void>;
    /**
     * Envoie une requête et attend une réponse
     */
    sendRequest<TRequest = any, TResponse = any>(channel: string, data: TRequest, timeout?: number): Promise<TResponse>;
    /**
     * Stocke une valeur dans l'état partagé
     */
    setState<T = any>(key: string, value: T, options?: {
        ttl?: number;
        ifNotExists?: boolean;
    }): Promise<boolean>;
    /**
     * Récupère une valeur de l'état partagé
     */
    getState<T = any>(key: string): Promise<T | null>;
    /**
     * S'abonne aux changements d'une clé dans l'état partagé
     */
    onStateChange<T = any>(key: string, callback: (value: T | null) => void): () => void;
    /**
     * Supprime une clé de l'état partagé
     */
    deleteState(key: string): Promise<boolean>;
    /**
     * Acquiert un verrou distribué
     */
    acquireLock(lockName: string, ttl?: number): Promise<boolean>;
    /**
     * Relâche un verrou distribué
     */
    releaseLock(lockName: string): Promise<boolean>;
    /**
     * Obtient des métriques de santé
     */
    getHealthMetrics(): any;
    /**
     * Obtient des statistiques sur les workers et les files d'attente
     */
    getStats(): Promise<{
        nodeId: string;
        workers?: {
            total: number;
            busy: number;
            idle: number;
        };
        queues?: {
            [queueName: string]: {
                pending: number;
                processing: number;
                delayed: number;
            };
        };
        health: any;
    }>;
    /**
     * Arrête proprement tous les services
     */
    shutdown(): Promise<void>;
}
export { Task, TaskResult, TaskStatus, TaskHandler, Message, MessageHandler, TaskExecutor, RedisConfig, WorkerPoolConfig, RedisThreadingConfig, Logger, Serializer };
export default RedisThreading;
