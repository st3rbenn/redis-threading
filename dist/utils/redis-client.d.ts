import { Redis } from 'ioredis';
import { RedisConfig } from '../types/config';
/**
 * Factory et gestionnaire de clients Redis
 * Utilise le pattern Singleton pour éviter de créer trop de connexions
 */
export declare class RedisClientFactory {
    private static instance;
    private clients;
    private logger;
    private events;
    private constructor();
    /**
     * Obtenir l'instance unique de la factory
     */
    static getInstance(): RedisClientFactory;
    /**
     * Crée ou récupère un client Redis
     * @param config Configuration Redis
     * @param clientName Nom du client (pour réutilisation)
     */
    getClient(config: RedisConfig, clientName?: string): Redis;
    /**
     * Obtient un client dédié à la publication
     */
    getPublisherClient(config: RedisConfig): Redis;
    /**
     * Obtient un client dédié à l'abonnement
     */
    getSubscriberClient(config: RedisConfig): Redis;
    /**
     * Ferme tous les clients Redis
     */
    closeAll(): Promise<void>;
    /**
     * S'abonne aux événements Redis
     */
    on(event: 'connect' | 'error' | 'reconnecting' | 'close', listener: (data: any) => void): void;
}
