export type Task<TInput = any, TOutput = any> = {
  id: string;           // Identifiant unique de la tâche
  type: string;         // Type de tâche (utilisé pour le routage)
  data: TInput;         // Données d'entrée
  options?: {
    priority?: number;  // Priorité (plus élevé = traité en premier)
    timeout?: number;   // Délai d'expiration de la tâche
    retries?: number;   // Nombre de tentatives en cas d'échec
    delay?: number;     // Délai avant exécution (ms)
  };
  createdAt?: number;   // Timestamp de création
  status?: TaskStatus;  // Statut actuel de la tâche
}

export enum TaskStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled'
}

export type TaskResult<TOutput = any> = {
  taskId: string;
  result?: TOutput;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  completedAt: number;
  executionTime: number; // Temps d'exécution en ms
  workerId: string;      // ID du worker qui a exécuté la tâche
}


export type TaskHandler<TInput = any, TOutput = any> = (
  data: TInput,
  taskInfo: { id: string; type: string }
) => Promise<TOutput>;
