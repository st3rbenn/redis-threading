import { EventEmitter } from 'events';
import { Task, TaskResult } from '../types/task';
import { WorkerPoolConfig } from '../types/config';
/**
 * Gère un pool de workers pour l'exécution des tâches
 * Implémente le pattern Pool d'objets et Singleton
 */
export declare class WorkerPool extends EventEmitter {
    private workerScriptPath;
    private config;
    private workerData;
    private static instance;
    private workers;
    private taskQueue;
    private idleCheckInterval;
    private logger;
    private isShuttingDown;
    private constructor();
    /**
     * Obtient l'instance unique du pool de workers
     */
    static getInstance(workerScriptPath?: string, config?: WorkerPoolConfig, workerData?: any): WorkerPool;
    /**
     * Initialise les workers au démarrage
     */
    private initializeWorkers;
    /**
     * Vérifie périodiquement les workers inactifs
     */
    private startIdleCheck;
    /**
     * Crée un nouveau worker thread
     */
    private createWorker;
    /**
     * Exécute une tâche sur un worker disponible
     * @param task Tâche à exécuter
     */
    executeTask<TInput = any, TOutput = any>(task: Task<TInput, TOutput>): Promise<TaskResult<TOutput>>;
    /**
     * Traite les tâches en file d'attente
     */
    private processQueue;
    /**
     * Trouve un worker disponible
     */
    private findAvailableWorker;
    /**
     * Gère les erreurs de worker
     */
    private handleWorkerError;
    /**
     * Gère la sortie d'un worker
     */
    private handleWorkerExit;
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
     * Gère les rapports de santé des workers
     */
    private handleHealthReport;
    /**
     * Arrête proprement le pool de workers
     */
    shutdown(timeout?: number): Promise<void>;
    /**
     * Obtient les statistiques du pool
     */
    getStats(): any;
}
