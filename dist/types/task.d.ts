export type Task<TInput = any, TOutput = any> = {
    id: string;
    type: string;
    data: TInput;
    options?: {
        priority?: number;
        timeout?: number;
        retries?: number;
        delay?: number;
    };
    createdAt?: number;
    status?: TaskStatus;
};
export declare enum TaskStatus {
    PENDING = "pending",
    PROCESSING = "processing",
    COMPLETED = "completed",
    FAILED = "failed",
    TIMEOUT = "timeout",
    CANCELLED = "cancelled"
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
    executionTime: number;
    workerId: string;
};
export type TaskHandler<TInput = any, TOutput = any> = (data: TInput, taskInfo: {
    id: string;
    type: string;
}) => Promise<TOutput>;
