import { parentPort, workerData } from 'worker_threads';
import { Task, TaskHandler } from '../types/task';
import { v4 as uuidv4 } from 'uuid';

/**
 * Classe utilitaire pour l'exécution des tâches dans un worker
 * Implémente le pattern Command
 */
export class TaskExecutor {
  private taskHandlers: Map<string, TaskHandler> = new Map();
  private workerId: string;

  constructor() {
    this.workerId = workerData?.workerId || uuidv4();
    this.setupMessageHandling();
  }

  /**
   * Configure la gestion des messages
   */
  private setupMessageHandling(): void {
    if (!parentPort) {
      this.log('error', 'TaskExecutor must be used in a worker thread');
      return;
    }

    parentPort.on('message', async (message) => {
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
  public registerTaskHandler<TInput = any, TOutput = any>(
    taskType: string,
    handler: TaskHandler<TInput, TOutput>
  ): void {
    this.taskHandlers.set(taskType, handler as TaskHandler);
    this.log('debug', `Registered handler for task type: ${taskType}`);
  }

  /**
   * Exécute une tâche
   * @param task Tâche à exécuter
   */
  private async executeTask(task: Task): Promise<void> {
    if (!parentPort) return;

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
      parentPort.postMessage({
        type: 'task:result',
        taskId: task.id,
        result
      });

      this.log('debug', `Task ${task.id} completed successfully`);
    } catch (error: any) {
      this.log('error', `Task ${task.id} failed: ${error.message}`, error);

      // Envoyer l'erreur
      parentPort.postMessage({
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
  public log(level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: any): void {
    if (!parentPort) return;

    parentPort.postMessage({
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
  public sendHealthReport(data: any): void {
    if (!parentPort) return;

    parentPort.postMessage({
      type: 'health:report',
      data: {
        ...data,
        timestamp: Date.now()
      },
      workerId: this.workerId
    });
  }
}
