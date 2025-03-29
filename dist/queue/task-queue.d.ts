import { EventEmitter } from 'events';
import { Task, TaskResult } from '../types/task';
import { RedisConfig } from '../types/config';
/**
 * File d'attente de tâches distribuée basée sur Redis
 * Implémente le pattern Repository
 */
export declare class TaskQueue extends EventEmitter {
    private redisConfig;
    private queueName;
    private namespace;
    private client;
    private subscriberClient;
    private logger;
    private processingTasks;
    private isConsumerRunning;
    private consumerActive;
    private pollingInterval;
    private shutdownRequested;
    constructor(redisConfig: RedisConfig, queueName?: string, namespace?: string);
    /**
     * Noms des clés Redis pour la file d'attente
     */
    private get keys();
    /**
     * Mettre une tâche en file d'attente
     */
    enqueue<TInput = any, TOutput = any>(taskType: string, data: TInput, options?: {
        priority?: number;
        timeout?: number;
        retries?: number;
        delay?: number;
    }): Promise<TaskResult<TOutput>>;
    /**
     * Démarrer la consommation des tâches
     */
    startConsumer(processTask: (task: Task) => Promise<any>, concurrency?: number): void;
    /**
     * Traitement des tâches retardées
     */
    private startDelayedTasksProcessor;
    /**
     * Boucle de consommation des tâches
     */
    private consumeTasks;
    /**
     * Stocker le résultat d'une tâche et notifier les abonnés
     */
    private storeResult;
    /**
     * Configurer le subscriber pour les résultats
     */
    private setupResultSubscriber;
    /**
     * Gérer le résultat d'une tâche
     */
    private handleTaskResult;
    /**
     * Obtenir l'état d'une tâche par son ID
     */
    getTaskStatus(taskId: string): Promise<Task | null>;
    /**
     * Obtenir le résultat d'une tâche par son ID
     */
    getTaskResult(taskId: string): Promise<TaskResult | null>;
    /**
     * Obtenir des statistiques sur la file d'attente
     */
    getStats(): Promise<{
        pending: number;
        processing: number;
        delayed: number;
    }>;
    /**
     * Récupérer les tâches bloquées (en cours depuis trop longtemps)
     */
    recoverStaleTasks(maxAge?: number): Promise<number>;
    /**
     * Arrêter le consommateur
     */
    shutdown(timeout?: number): Promise<void>;
}
