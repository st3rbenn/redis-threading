import { TaskHandler } from '../types/task';
/**
 * Classe utilitaire pour l'exécution des tâches dans un worker
 * Implémente le pattern Command
 */
export declare class TaskExecutor {
    private taskHandlers;
    private workerId;
    constructor();
    /**
     * Configure la gestion des messages
     */
    private setupMessageHandling;
    /**
     * Enregistre un gestionnaire de tâche
     * @param taskType Type de tâche
     * @param handler Fonction de traitement
     */
    registerTaskHandler<TInput = any, TOutput = any>(taskType: string, handler: TaskHandler<TInput, TOutput>): void;
    /**
     * Exécute une tâche
     * @param task Tâche à exécuter
     */
    private executeTask;
    /**
     * Envoie un message de log au thread principal
     */
    log(level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: any): void;
    /**
     * Envoie un rapport de santé au thread principal
     */
    sendHealthReport(data: any): void;
}
