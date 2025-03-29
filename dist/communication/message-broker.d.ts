import { EventEmitter } from 'events';
import { RedisConfig } from '../types/config';
import { Message, MessageHandler } from '../types/message';
/**
 * Broker de messages pour la communication entre processus
 * Implémente le pattern Observer et Pub/Sub
 */
export declare class MessageBroker extends EventEmitter {
    private redisConfig;
    private namespace;
    private static instance;
    private publisherClient;
    private subscriberClient;
    private logger;
    private handlers;
    private replyHandlers;
    private nodeId;
    private isShuttingDown;
    private constructor();
    /**
     * Obtient l'instance unique du broker
     */
    static getInstance(redisConfig?: RedisConfig, namespace?: string): MessageBroker;
    /**
     * Configure le client subscriber
     */
    private setupSubscriber;
    /**
     * Gère un message entrant
     */
    private handleIncomingMessage;
    /**
     * Gère un message de réponse
     */
    private handleReplyMessage;
    /**
     * S'abonne à un canal
     */
    subscribe(channel: string, handler: MessageHandler): () => void;
    /**
     * Publie un message sur un canal
     */
    publish<T = any>(channel: string, data: T): Promise<void>;
    /**
     * Envoie une requête et attend une réponse
     */
    request<TRequest = any, TResponse = any>(channel: string, data: TRequest, timeout?: number): Promise<TResponse>;
    /**
     * Répond à une requête
     */
    reply<T = any>(message: Message, data: T): Promise<void>;
    /**
     * Arrête le broker
     */
    shutdown(): Promise<void>;
}
