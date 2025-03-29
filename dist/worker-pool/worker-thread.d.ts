import { WorkerOptions } from 'worker_threads';
import { EventEmitter } from 'events';
import { Task, TaskResult } from '../types/task';
/**
 * Représente un worker thread individuel
 */
export declare class WorkerThread extends EventEmitter {
    private scriptPath;
    private workerData;
    private options;
    private worker;
    private taskTimeouts;
    private logger;
    id: string;
    busy: boolean;
    startTime: number;
    lastActivityTime: number;
    stats: {
        tasksProcessed: number;
        errors: number;
        totalExecutionTime: number;
    };
    /**
     * Crée un nouveau worker thread
     * @param scriptPath Chemin vers le script worker
     * @param workerData Données à passer au worker
     * @param options Options du worker
     */
    constructor(scriptPath: string, workerData?: any, options?: WorkerOptions);
    /**
     * Démarre le worker thread
     */
    start(): Promise<void>;
    /**
     * Exécute une tâche sur ce worker
     * @param task Tâche à exécuter
     * @param timeout Timeout en ms
     */
    executeTask<TInput = any, TOutput = any>(task: Task<TInput, TOutput>, timeout?: number): Promise<TaskResult<TOutput>>;
    /**
     * Termine le worker thread
     */
    terminate(): Promise<number>;
    /**
     * Termine le worker s'il est inactif depuis trop longtemps
     * @param maxIdleTime Temps maximum d'inactivité en ms
     */
    terminateIfIdle(maxIdleTime: number): boolean;
    /**
     * Vérifie si le worker est en bonne santé
     */
    isHealthy(): boolean;
    /**
     * Gère les messages génériques du worker
     */
    private handleWorkerMessage;
    /**
     * Gère les erreurs du worker
     */
    private handleWorkerError;
    /**
     * Gère la sortie du worker
     */
    private handleWorkerExit;
}
