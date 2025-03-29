import { EventEmitter } from 'events';
import { TaskQueue } from './task-queue';
import { TaskHandler, TaskResult } from '../types/task';
import { RedisConfig } from '../types/config';
/**
 * Gestionnaire de files d'attente
 * Implémente le pattern Façade
 */
export declare class QueueManager extends EventEmitter {
    private redisConfig;
    private namespace;
    private static instance;
    private queues;
    private taskHandlers;
    private logger;
    private isConsumerRunning;
    private consumerConcurrency;
    private staleTasks;
    private constructor();
    /**
     * Obtient l'instance unique du gestionnaire
     */
    static getInstance(redisConfig?: RedisConfig, namespace?: string): QueueManager;
    /**
     * Obtient ou crée une file d'attente
     */
    getQueue(queueName?: string): TaskQueue;
    /**
     * Enfile une tâche et attend son résultat
     */
    enqueue<TInput = any, TOutput = any>(taskType: string, data: TInput, options?: {
        queueName?: string;
        priority?: number;
        timeout?: number;
        retries?: number;
        delay?: number;
    }): Promise<TaskResult<TOutput>>;
    /**
     * Enregistre un gestionnaire de tâche
     */
    registerTaskHandler<TInput = any, TOutput = any>(taskType: string, handler: TaskHandler<TInput, TOutput>): void;
    /**
     * Démarre le consommateur de tâches
     */
    startConsumer(concurrency?: number, queueNames?: string[]): void;
    /**
     * Traite une tâche
     */
    private processTask;
    /**
     * Démarre la vérification des tâches bloquées
     */
    private startStaleTasksCheck;
    /**
     * Gère la complétion d'une tâche
     */
    private handleTaskCompleted;
    /**
     * Gère les erreurs de tâche
     */
    private handleTaskError;
    /**
     * Gère les timeouts de tâche
     */
    private handleTaskTimeout;
    /**
     * Obtient des statistiques sur toutes les files d'attente
     */
    getStats(): Promise<{
        queues: {
            [queueName: string]: {
                pending: number;
                processing: number;
                delayed: number;
            };
        };
        handlers: string[];
    }>;
    /**
     * Arrête tous les consommateurs
     */
    shutdown(timeout?: number): Promise<void>;
}
