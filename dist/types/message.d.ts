export type Message<T = any> = {
    id: string;
    channel: string;
    data: T;
    timestamp: number;
    sender?: string;
    replyTo?: string;
};
export type MessageHandler<T = any> = (message: Message<T>) => Promise<void> | void;
